/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test, vi} from 'vitest';
import {ZipReader} from '../ext/lib/zip.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * @param {number} banks
 * @returns {Promise<ArrayBuffer>}
 */
async function archive(banks) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Cancelled source', revision: '1', format: 3})));
    for (let index = 0; index < banks; ++index) {
        await writer.add(`term_bank_${index + 1}.json`, new TextReader(JSON.stringify([
            [`term-${index}`, '', '', '', 1, ['definition'], index, ''],
        ])));
    }
    return new Uint8Array(await writer.close()).buffer;
}

function database() {
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'source-cancel-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => {}),
    };
}

describe('ordinary term-bank ZIP cancellation', () => {
    test.each([
        {banks: 1, delayedAbort: false},
        {banks: 2, delayedAbort: false},
        {banks: 3, delayedAbort: false},
        {banks: 2, delayedAbort: true},
    ])('aborts and joins $banks pending reads before rollback (delayed abort: $delayedAbort)', async ({banks, delayedAbort}) => {
        const bytes = await archive(banks);
        const admitted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const manualCleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const decoderCleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        if (!delayedAbort) { decoderCleanup.resolve(); }
        /** @type {AbortSignal[]} */
        const signals = [];
        /** @type {string[]} */
        const events = [];
        const getEntries = ZipReader.prototype.getEntries;
        vi.spyOn(ZipReader.prototype, 'getEntries').mockImplementation(
            /**
             * @this {import('@zip.js/zip.js').ZipReader<unknown>}
             * @param {...unknown} args
             * @returns {Promise<import('@zip.js/zip.js').Entry[]>}
             */
            async function getEntriesForCancellation(...args) {
                const entries = /** @type {import('@zip.js/zip.js').Entry[]} */ (await Reflect.apply(getEntries, this, args));
                for (const entry of entries) {
                    if (!/^term_bank_\d+\.json$/.test(entry.filename)) { continue; }
                    Reflect.set(entry, 'getData', (/** @type {unknown} */ _writer, /** @type {{signal?: AbortSignal}} */ options) => {
                        const signal = options.signal;
                        if (!(signal instanceof AbortSignal)) { throw new Error('Expected owned ZIP read signal'); }
                        signals.push(signal);
                        return new Promise((resolve, reject) => {
                            const onAbort = () => {
                                events.push(`abort:${entry.filename}`);
                                void decoderCleanup.promise.then(() => {
                                    events.push(`settled:${entry.filename}`);
                                    signal.removeEventListener('abort', onAbort);
                                    reject(signal.reason);
                                });
                            };
                            signal.addEventListener('abort', onAbort, {once: true});
                            if (signal.aborted) { onAbort(); }
                            // Release the unfixed implementation after its red assertion.
                            void manualCleanup.promise.then(() => {
                                signal.removeEventListener('abort', onAbort);
                                reject(new Error('Manual source-read test cleanup'));
                            });
                        });
                    });
                }
                return entries;
            },
        );
        const readBatch = TermBankSourcePipeline.prototype.readBatch;
        vi.spyOn(TermBankSourcePipeline.prototype, 'readBatch').mockImplementation(
            /**
             * @this {TermBankSourcePipeline}
             * @param {Parameters<TermBankSourcePipeline['readBatch']>} args
             * @returns {ReturnType<TermBankSourcePipeline['readBatch']>}
             */
            async function readBatchForCancellation(...args) {
                admitted.resolve();
                return await readBatch.apply(this, args);
            },
        );
        const close = ZipReader.prototype.close;
        const closeSpy = vi.spyOn(ZipReader.prototype, 'close').mockImplementation(/** @this {import('@zip.js/zip.js').ZipReader<unknown>} */ async function closeCancelledArchive() {
            events.push('archive-close');
            await Reflect.apply(close, this, []);
        });
        const db = database();
        db.abortBulkImport.mockImplementation(async () => { events.push('rollback'); });
        let cancelled = false;
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => cancelled);
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        let settled = false;
        const pending = importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
            bytes,
            /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false}),
        ).then((result) => {
            settled = true;
            return result;
        });
        try {
            await admitted.promise;
            expect(db.startBulkImport).toHaveBeenCalledOnce();
            expect(signals).toHaveLength(banks);
            cancelled = true;
            await vi.advanceTimersByTimeAsync(100);
            expect(signals.every((signal) => signal.aborted)).toBe(true);
            if (delayedAbort) {
                expect(settled).toBe(false);
                expect(db.abortBulkImport).not.toHaveBeenCalled();
                expect(closeSpy).not.toHaveBeenCalled();
                decoderCleanup.resolve();
            }
            const result = await pending;
            expect(result.result).toBeNull();
            expect(result.errors.some((error) => error.message === 'Dictionary import was cancelled')).toBe(true);
            expect(events.filter((event) => event.startsWith('settled:'))).toHaveLength(banks);
            expect(db.abortBulkImport).toHaveBeenCalledOnce();
            expect(db.abortBulkImport).toHaveBeenCalledWith('source-cancel-session');
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            expect(db.bulkAdd).not.toHaveBeenCalled();
            expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledWith(1);
            expect(closeSpy).toHaveBeenCalledOnce();
            let lastReadSettlement = -1;
            for (const [index, event] of events.entries()) {
                if (event.startsWith('settled:')) { lastReadSettlement = index; }
            }
            expect(events.lastIndexOf('rollback')).toBeGreaterThan(lastReadSettlement);
            expect(events.indexOf('archive-close')).toBeGreaterThan(lastReadSettlement);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            cancelled = true;
            manualCleanup.resolve();
            decoderCleanup.resolve();
            await pending;
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.restoreAllMocks();
        }
    });
});

for (const mode of ['read', 'unknown-size batch']) {
    test(`joins all prefetched reads and preserves an unknown cancellation failure: ${mode}`, async () => {
        const resume = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const files = Array.from({length: 4}, (_, index) => ({filename: `term_bank_${index + 1}.json`, getData: async () => new Uint8Array(0)}));
        /** @type {AbortSignal[]} */
        const signals = [];
        const pipeline = new TermBankSourcePipeline({
            termFiles: files,
            enabled: true,
            read: async (_file, signal) => {
                signals.push(signal);
                await new Promise((resolve) => { signal.addEventListener('abort', resolve, {once: true}); });
                await resume.promise;
                throw signal.reason;
            },
        });
        let cancelled = false;
        const checkCancellation = () => {
            if (cancelled) { throw void 0; }
        };
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        pipeline.prefetchNext(0);
        let settled = false;
        /** @type {unknown} */
        let failure = 'not rejected';
        const pending = (mode === 'read' ? pipeline.read(files[0], checkCancellation) : pipeline.readBatch(files, checkCancellation)).then(
            () => { settled = true; },
            (error) => {
                settled = true;
                failure = error;
            },
        );
        try {
            expect(signals).toHaveLength(4);
            cancelled = true;
            await vi.advanceTimersByTimeAsync(100);
            expect(signals.every((signal) => signal.aborted)).toBe(true);
            expect(settled).toBe(false);
            resume.resolve();
            await pending;
            expect(settled).toBe(true);
            expect(failure).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            resume.resolve();
            await pipeline.dispose();
            await pending;
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });
}

test('deferred parallel source plans retain their parser cancellation owner', async () => {
    const files = Array.from({length: 4}, (_, index) => ({filename: `term_bank_${index + 1}.json`, uncompressedSize: 2, getData: async () => new Uint8Array(0)}));
    const pipeline = new TermBankSourcePipeline({termFiles: files, enabled: true, read: async () => new TextEncoder().encode('[]')});
    const checkCancellation = vi.fn();
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
    try {
        const batch = await pipeline.readBatch(files, checkCancellation);
        expect(batch).toMatchObject({promises: expect.any(Array), estimatedByteLengths: [2, 2, 2, 2]});
        expect(checkCancellation).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        await pipeline.dispose();
        vi.useRealTimers();
    }
});
