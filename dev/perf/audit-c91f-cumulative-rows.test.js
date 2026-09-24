/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
beforeEach(() => {
    // Node has no browser Worker. Exercise the production ZIP batching and
    // synchronous WASM parser; real-browser benchmarks cover worker transport.
    vi.spyOn(TermBankSourcePipeline.prototype, 'createCompressedImportRunPlan').mockReturnValue(null);
    vi.spyOn(TermBankSourcePipeline.prototype, 'createImportRunPlan').mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {number} bankCount
 * @returns {Promise<ArrayBuffer>}
 */
async function archive(bankCount) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Cumulative rows', revision: '1', format: 3})));
    for (let i = 0; i < bankCount; ++i) {
        await writer.add(`term_bank_${i + 1}.json`, new TextReader(JSON.stringify([[`term${i}`, '', '', '', 0, [`definition ${i}`], i, '']])));
    }
    return new Uint8Array(await writer.close()).buffer;
}

function database() {
    /** @type {{rowCount: number, totalRows: number|undefined}[]} */
    const chunks = [];
    return {
        chunks,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'row-count-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async () => { throw new Error('Expected the direct column import path'); }),
        /** @param {{rowCount: number, dictionaryTotalRows?: number}} chunk */
        async bulkAddArtifactTermsChunk(chunk) {
            chunks.push({rowCount: chunk.rowCount, totalRows: chunk.dictionaryTotalRows});
        },
    };
}

/**
 * @param {DictionaryImporter} importer
 * @param {ReturnType<typeof database>} db
 * @param {number} bankCount
 * @returns {Promise<void>}
 */
async function importBanks(importer, db, bankCount) {
    const result = await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
        await archive(bankCount),
        /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false, termContentStorageMode: 'raw-bytes'}),
    );
    expect(result.errors).toEqual([]);
    expect(result.result?.counts?.terms.total).toBe(bankCount);
    expect(db.bulkAdd).not.toHaveBeenCalled();
    expect(db.finishBulkImport).toHaveBeenCalledOnce();
    expect(db.abortBulkImport).not.toHaveBeenCalled();
}

describe('dictionary row hints across bounded source batches', () => {
    test.each([1, 80, 81, 161])('%i banks retain the cumulative dictionary size at the write boundary', async (bankCount) => {
        vi.spyOn(TermBankSourcePipeline, 'getDeviceMemory').mockReturnValue(4);
        const db = database();
        await importBanks(new DictionaryImporter(new DictionaryImporterMediaLoader()), db, bankCount);
        if (bankCount > 80) { expect(db.chunks.length).toBeGreaterThan(1); }
        let observedRows = 0;
        for (const chunk of db.chunks) {
            observedRows += chunk.rowCount;
            expect(chunk.totalRows).toBeGreaterThanOrEqual(observedRows);
        }
        expect(observedRows).toBe(bankCount);
        expect(db.chunks.at(-1)?.totalRows).toBe(bankCount);
    });

    test('preserves the complete parser total for a single source batch', async () => {
        vi.spyOn(TermBankSourcePipeline, 'getDeviceMemory').mockReturnValue(8);
        const db = database();
        await importBanks(new DictionaryImporter(new DictionaryImporterMediaLoader()), db, 80);
        expect(db.chunks.every(({totalRows}) => totalRows === 80)).toBe(true);
    });

    test('a reused importer does not carry row totals into the next dictionary', async () => {
        vi.spyOn(TermBankSourcePipeline, 'getDeviceMemory').mockReturnValue(4);
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        await importBanks(importer, database(), 81);
        const next = database();
        await importBanks(importer, next, 1);
        expect(next.chunks).toEqual([{rowCount: 1, totalRows: 1}]);
    });
});
