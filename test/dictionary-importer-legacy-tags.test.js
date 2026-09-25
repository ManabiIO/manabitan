/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * @param {number} bankCount
 * @param {boolean} embedded
 * @param {number} format
 * @returns {Promise<ArrayBuffer>}
 */
async function archive(bankCount, embedded, format) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    const tagMeta = embedded ? {legacy: {category: 'partOfSpeech', order: 2, notes: 'Legacy tag', score: 1}} : void 0;
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Legacy tags', revision: '1', format, tagMeta})));
    for (let i = 0; i < bankCount; ++i) {
        await writer.add(`tag_bank_${i + 1}.json`, new TextReader(JSON.stringify([[`bank${i}`, 'misc', i, `Bank ${i}`, 0]])));
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
        startBulkImport: vi.fn(async () => 'legacy-tags-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(/** @type {(store: string, entries: unknown[], start: number, count: number) => Promise<void>} */ (async () => {})),
    };
}

describe('embedded legacy dictionary tags', () => {
    test.each([
        {format: 1, bankCount: 0},
        {format: 1, bankCount: 1},
        {format: 1, bankCount: 3},
        {format: 3, bankCount: 0},
        {format: 3, bankCount: 1},
        {format: 3, bankCount: 3},
    ])('format $format with $bankCount tag banks imports embedded tags exactly once', async ({format, bankCount}) => {
        const db = database();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const result = await importer.importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
            await archive(bankCount, true, format),
            /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false}),
        );
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.tagMeta.total).toBe(bankCount + 1);
        const tags = db.bulkAdd.mock.calls.filter(([store]) => store === 'tagMeta').flatMap(([, entries, start, count]) => entries.slice(start, start + count));
        expect(tags).toHaveLength(bankCount + 1);
        expect(tags.filter((tag) => Reflect.get(/** @type {object} */ (tag), 'name') === 'legacy')).toEqual([
            {dictionary: 'Legacy tags', name: 'legacy', category: 'partOfSpeech', order: 2, notes: 'Legacy tag', score: 1},
        ]);
        expect(db.finishBulkImport).toHaveBeenCalledOnce();
        expect(db.abortBulkImport).not.toHaveBeenCalled();
    });

    test('bank-only dictionaries retain their existing tags and count', async () => {
        const db = database();
        const result = await new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
            await archive(3, false, 3),
            /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false}),
        );
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.tagMeta.total).toBe(3);
    });


    test('a finalization progress failure still aborts the owned import session', async () => {
        const db = database();
        const progressFailure = new Error('progress sink failed');
        let now = 1_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
            now += 100;
            return now;
        });
        const importer = new DictionaryImporter(
            new DictionaryImporterMediaLoader(),
            (progress) => {
                if (progress.count === 20) { throw progressFailure; }
            },
        );
        try {
            const result = await importer.importDictionary(
                /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                await archive(0, true, 3),
                /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false}),
            );

            expect(result.result).toBeNull();
            expect(result.errors).toContain(progressFailure);
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            expect(db.abortBulkImport).toHaveBeenCalledWith('legacy-tags-session');
            expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledWith(1);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('an embedded-tag write failure aborts rather than publishing a tagless dictionary', async () => {
        const db = database();
        const failure = new Error('tag storage failed');
        db.bulkAdd.mockRejectedValueOnce(failure);
        const result = await new DictionaryImporter(new DictionaryImporterMediaLoader()).importDictionary(
            /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
            await archive(0, true, 3),
            /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false}),
        );
        expect(result.errors).toContain(failure);
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledWith('legacy-tags-session');
        expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledWith(1);
    });
});
