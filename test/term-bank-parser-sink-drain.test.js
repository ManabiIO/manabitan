/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {beforeAll, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const encoder = new TextEncoder();
const producerFailure = /Term expression or reading exceeds the binary record limit/;
beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});

/**
 * @param {string} expression
 * @returns {unknown[]}
 */
function row(expression) {
    return [expression, '', '', '', 0, ['definition'], 1, ''];
}

/** @returns {Promise<void>} */
async function flushTasks() {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

for (const kind of ['row', 'column']) {
    for (const sinkFails of [false, true]) {
        test(`${kind} materialization failure drains the active sink and retires queued callbacks (sink failure: ${sinkFails})`, async () => {
            const sink = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
            const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
            const sinkFailure = new Error('later sink rejection');
            const source = kind === 'column' ?
                encoder.encode(JSON.stringify([row('first'), row('queued'), row('x'.repeat(0x10000))])) :
                encoder.encode(`[${JSON.stringify(row('first'))},${JSON.stringify(row('queued'))},["bad","","","",1e309,["definition"],1,""]]`);
            /** @type {number[]} */
            const calls = [];
            let settled = false;
            const onChunk = async (/** @type {unknown} */ _chunk, /** @type {{chunkIndex: number}} */ progress) => {
                calls.push(progress.chunkIndex);
                entered.resolve();
                await sink.promise;
                if (sinkFails) { throw sinkFailure; }
            };
            const options = {maxPendingChunks: 3, copyContentBytes: true, emitContentSlab: true, emitTokenBinaryContent: true};
            const parsing = kind === 'column' ?
                parseTermBankWithWasmColumnChunks(source, 3, onChunk, 1, options) :
                parseTermBankWithWasmChunks(source, 3, onChunk, 1, options);
            const observed = parsing.then(
                () => { settled = true; return null; },
                (/** @type {unknown} */ error) => { settled = true; return error; },
            );
            try {
                await entered.promise;
                await flushTasks();
                expect(calls).toEqual([1]);
                expect(settled).toBe(false);
            } finally {
                sink.resolve();
                const error = await observed;
                await flushTasks();
                expect(error).toBeInstanceOf(Error);
                expect(/** @type {Error} */ (error).message).toMatch(kind === 'column' ? producerFailure : /Term-bank number must be finite/);
                expect(error).not.toBe(sinkFailure);
                expect(calls).toEqual([1]);
            }
        });
    }

    test(`${kind} backpressure failure settles the ordered tail without starting queued sinks`, async () => {
        const sink = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const failure = new Error('backpressure sink rejection');
        const source = encoder.encode(JSON.stringify([row('first'), row('queued'), row('later')]));
        const onChunk = vi.fn(async () => {
            entered.resolve();
            await sink.promise;
            throw failure;
        });
        const options = {maxPendingChunks: 2, copyContentBytes: true, emitContentSlab: true, emitTokenBinaryContent: true};
        const parsing = kind === 'column' ?
            parseTermBankWithWasmColumnChunks(source, 3, onChunk, 1, options) :
            parseTermBankWithWasmChunks(source, 3, onChunk, 1, options);
        const observed = parsing.catch((/** @type {unknown} */ error) => error);
        try {
            await entered.promise;
        } finally {
            sink.resolve();
        }
        expect(await observed).toBe(failure);
        await flushTasks();
        expect(onChunk).toHaveBeenCalledOnce();
    });
}

test('ordinary ZIP import keeps its session until a sink admitted before a later key failure settles', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Sink drain', revision: '1', format: 3})), {useWebWorkers: false});
    const rows = Array.from({length: 12000}, () => row('first'));
    rows.push(row('x'.repeat(0x10000)));
    await writer.add('term_bank_1.json', new TextReader(JSON.stringify(rows)), {useWebWorkers: false});
    const archive = new Blob([await writer.close()]);
    const sink = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    /** @type {string[]} */
    const events = [];
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: async () => 'sink-drain-session',
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { events.push('abort'); }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => { events.push('placeholder'); }),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAddArtifactTermsChunk: vi.fn(async () => {
            events.push('sink-start');
            entered.resolve();
            await sink.promise;
            events.push('sink-end');
        }),
    };
    let settled = false;
    const importing = new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        archive,
        {zipUseWebWorkers: false},
    );
    void importing.then(
        () => { settled = true; },
        () => { settled = true; },
    );
    try {
        await entered.promise;
        await flushTasks();
        expect(settled).toBe(false);
        expect(database.abortBulkImport).not.toHaveBeenCalled();
        expect(events).toEqual(['sink-start']);
    } finally {
        sink.resolve();
        const result = await importing;
        expect(result.result).toBeNull();
        expect(result.errors.some((error) => producerFailure.test(error.message))).toBe(true);
        expect(database.finishBulkImport).not.toHaveBeenCalled();
        expect(database.abortBulkImport).toHaveBeenCalledOnce();
        expect(events).toEqual(['sink-start', 'sink-end', 'abort', 'placeholder']);
    }
});
