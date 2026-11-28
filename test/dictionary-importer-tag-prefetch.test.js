/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {ZipReader} from '../ext/lib/zip.js';
import {BoundedZipTextWriter} from '../ext/js/dictionary/bounded-zip-text-writer.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {{tags?: string[], terms?: boolean, level?: 0|6}} [options]
 * @returns {Promise<Uint8Array>}
 */
async function archive({tags = ['[["名詞","partOfSpeech",0,"noun",0]]'], terms = true, level = 0} = {}) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Tag prefetch', revision: '1', format: 3})), options);
    if (terms) {
        await writer.add('term_bank_1.json', new TextReader(JSON.stringify([
            ['日本語', '', '', '', 0, ['Japanese'], 1, ''],
        ])), options);
    }
    for (const [index, tagsJson] of tags.entries()) {
        await writer.add(`tag_bank_${index + 1}.json`, new TextReader(tagsJson), options);
    }
    return Uint8Array.from(await writer.close());
}

function database() {
    const bulkAdd = vi.fn(/** @type {(store: string, entries: unknown[]) => Promise<void>} */ (async (_store, _entries) => {}));
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'tag-import-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => {}),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd,
    };
}

/**
 * @param {DictionaryImporter} importer
 * @param {ReturnType<typeof database>} db
 * @param {Uint8Array} bytes
 * @returns {Promise<import('dictionary-importer').ImportResult>}
 */
async function run(importer, db, bytes) {
    return await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
        new Blob([bytes]),
        /** @type {import('dictionary-importer').ImportDetails} */ ({
            skipMediaImport: true,
            zipUseWebWorkers: false,
            disableTermBankWasmFastPath: true,
        }),
    );
}

/**
 * @param {(entry: import('@zip.js/zip.js').Entry) => void} observe
 */
function observeTags(observe) {
    const getEntries = ZipReader.prototype.getEntries;
    vi.spyOn(ZipReader.prototype, 'getEntries').mockImplementation(
        /**
         * @this {import('@zip.js/zip.js').ZipReader<unknown>}
         * @returns {Promise<import('@zip.js/zip.js').Entry[]>}
         */ async function getObservedEntries() {
            const entries = /** @type {import('@zip.js/zip.js').Entry[]} */ (await Reflect.apply(getEntries, this, []));
            for (const entry of entries) {
                if (entry.filename.startsWith('tag_bank_')) { observe(entry); }
            }
            return entries;
        },
    );
}

describe('bounded tag-bank text prefetch', () => {
    test.each([0, 6])('reads only the first tag during a pending term write, then publishes both banks in order (level %s)', async (level) => {
        const bytes = await archive({tags: ['[["名詞","partOfSpeech",0,"noun",0]]', '[["v","partOfSpeech",1,"verb",0]]'], level: /** @type {0|6} */ (level)});
        const termPending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const releaseTerm = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const tagSettled = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        /** @type {string[]} */
        const reads = [];
        observeTags((entry) => {
            const getData = entry.getData;
            Reflect.set(entry, 'getData', async (/** @type {unknown[]} */ ...args) => {
                reads.push(entry.filename);
                try {
                    return await Reflect.apply(/** @type {Function} */ (getData), entry, args);
                } finally {
                    if (entry.filename === 'tag_bank_1.json') { tagSettled.resolve(); }
                }
            });
        });
        const db = database();
        db.bulkAdd.mockImplementation(async (store) => {
            if (store === 'terms') {
                termPending.resolve();
                await releaseTerm.promise;
            }
        });
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const pending = run(importer, db, bytes);
        try {
            await termPending.promise;
            await tagSettled.promise;
            expect(reads).toEqual(['tag_bank_1.json']);
            expect(db.bulkAdd.mock.calls.filter(([store]) => store === 'tagMeta')).toEqual([]);
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            releaseTerm.resolve();
            const result = await pending;
            expect(result.errors).toEqual([]);
            expect(result.result).not.toBeNull();
            expect(reads).toEqual(['tag_bank_1.json', 'tag_bank_2.json']);
            const tagWrites = db.bulkAdd.mock.calls.filter(([store]) => store === 'tagMeta');
            expect(tagWrites.map(([, rows]) => rows)).toEqual([
                [{name: '名詞', category: 'partOfSpeech', order: 0, notes: 'noun', score: 0, dictionary: 'Tag prefetch'}],
                [{name: 'v', category: 'partOfSpeech', order: 1, notes: 'verb', score: 0, dictionary: 'Tag prefetch'}],
            ]);
            expect(db.finishBulkImport).toHaveBeenCalledOnce();
        } finally {
            releaseTerm.resolve();
            await pending;
        }
    });

    test.each(['broken JSON', '[["x","category","bad-order","notes",0]]'])('reports invalid tags at the ordinary tag phase: %s', async (tags) => {
        const db = database();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const result = await run(importer, db, await archive({tags: [tags]}));
        expect(result.result).toBeNull();
        expect(result.errors.some((error) => error.message.includes('tag_bank_1.json'))).toBe(true);
        expect(db.bulkAdd.mock.calls.some(([store]) => store === 'terms')).toBe(true);
        expect(db.bulkAdd.mock.calls.some(([store]) => store === 'tagMeta')).toBe(false);
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
    });

    test.each(['cancel', 'sink-failure'])('aborts and joins a pending tag decoder before archive close and rollback on %s', async (mode) => {
        const bytes = await archive();
        const admitted = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const cleanup = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const termPending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const releaseTerm = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        /** @type {AbortSignal|undefined} */
        let signal;
        /** @type {string[]} */
        const events = [];
        observeTags((entry) => {
            Reflect.set(entry, 'getData', async (/** @type {unknown} */ _writer, /** @type {{signal?: AbortSignal}} */ options) => {
                signal = options.signal;
                admitted.resolve();
                await new Promise((resolve) => { signal?.addEventListener('abort', resolve, {once: true}); });
                events.push('decoder-abort');
                await cleanup.promise;
                events.push('decoder-joined');
                throw signal?.reason;
            });
        });
        const close = ZipReader.prototype.close;
        const closeSpy = vi.spyOn(ZipReader.prototype, 'close').mockImplementation(/** @this {import('@zip.js/zip.js').ZipReader<unknown>} */ async function observedClose() {
            events.push('archive-close');
            await Reflect.apply(close, this, []);
        });
        const failure = new Error('Term sink failed during tag read');
        const db = database();
        db.bulkAdd.mockImplementation(async (store) => {
            if (store !== 'terms') { return; }
            termPending.resolve();
            await releaseTerm.promise;
            if (mode === 'sink-failure') { throw failure; }
        });
        db.abortBulkImport.mockImplementation(async () => { events.push('rollback'); });
        let cancelled = false;
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => cancelled);
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
        const pending = run(importer, db, bytes);
        try {
            await admitted.promise;
            await termPending.promise;
            if (mode === 'cancel') { cancelled = true; }
            releaseTerm.resolve();
            await vi.advanceTimersByTimeAsync(100);
            expect(signal?.aborted).toBe(true);
            expect(closeSpy).not.toHaveBeenCalled();
            expect(db.abortBulkImport).not.toHaveBeenCalled();
            cleanup.resolve();
            const result = await pending;
            expect(result.result).toBeNull();
            expect(result.errors.some((error) => error.message === (mode === 'cancel' ? 'Dictionary import was cancelled' : failure.message))).toBe(true);
            expect(events.indexOf('archive-close')).toBeGreaterThan(events.indexOf('decoder-joined'));
            expect(events.indexOf('rollback')).toBeGreaterThan(events.indexOf('decoder-joined'));
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            cancelled = true;
            releaseTerm.resolve();
            cleanup.resolve();
            await pending;
            vi.useRealTimers();
        }
    });

    test.each([undefined, -1, Number.NaN, 0.5, 65_537])('keeps unknown or unsafe declared sizes on the late path: %s', (size) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const getData = vi.fn();
        for (const field of ['uncompressedSize', 'compressedSize']) {
            const entry = {filename: 'tag_bank_1.json', uncompressedSize: 16, compressedSize: 16, [field]: size, getData};
            expect(importer._prefetchSmallTagBank(/** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (entry)))).toBeNull();
        }
        expect(getData).not.toHaveBeenCalled();
    });

    test('does not prefetch preloaded entries or dictionaries without terms', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const prefetch = vi.spyOn(importer, '_prefetchSmallTagBank');
        const getData = vi.fn();
        const file = {filename: 'tag_bank_1.json', bytes: new TextEncoder().encode('[]'), uncompressedSize: 2, compressedSize: 2, getData};
        expect(importer._prefetchSmallTagBank(/** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (file)))).toBeNull();
        expect(getData).not.toHaveBeenCalled();
        prefetch.mockClear();
        const db = database();
        const result = await run(importer, db, await archive({terms: false}));
        expect(result.errors).toEqual([]);
        expect(prefetch).not.toHaveBeenCalled();
        expect(db.bulkAdd.mock.calls.some(([store]) => store === 'tagMeta')).toBe(true);
    });
});

describe('bounded speculative ZIP text output', () => {
    test('preserves UTF-8 sequences split across decoder chunks', async () => {
        const bytes = new TextEncoder().encode('名詞');
        const writer = new BoundedZipTextWriter('tag_bank_1.json', bytes.byteLength);
        for (const byte of bytes) { await writer.writeUint8Array(Uint8Array.of(byte)); }
        await expect(writer.getData()).resolves.toBe('名詞');
    });

    test('rejects decoder overflow before retaining the oversized chunk, and rejects underflow', async () => {
        const writer = new BoundedZipTextWriter('tag_bank_1.json', 2);
        await writer.writeUint8Array(Uint8Array.of(91));
        await expect(writer.writeUint8Array(new Uint8Array(1024 * 1024))).rejects.toBeInstanceOf(DictionarySourceIntegrityError);
        await expect(writer.getData()).rejects.toThrow("ZIP decoded size mismatch in 'tag_bank_1.json'");
        expect(Reflect.get(writer, '_bytes')).toHaveLength(2);
        expect(Reflect.get(writer, '_offset')).toBe(1);
    });

    test('applies actual output bounds to a real compressed entry', async () => {
        const bytes = await archive({tags: [JSON.stringify([['x', '', 0, 'x'.repeat(100_000), 0]])], level: 6});
        observeTags((entry) => { Reflect.set(entry, 'uncompressedSize', 2); });
        const db = database();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const result = await run(importer, db, bytes);
        expect(result.result).toBeNull();
        expect(result.errors.some((error) => error instanceof DictionarySourceIntegrityError && error.message.includes('tag_bank_1.json')), result.errors.map((error) => `${error.name}: ${error.message}`).join('\n')).toBe(true);
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
    });

    test.each([0, 6])('still rejects a wrong CRC for a prefetched entry (level %s)', async (level) => {
        const bytes = await archive({level: /** @type {0|6} */ (level)});
        const view = new DataView(bytes.buffer);
        const endOffset = bytes.byteLength - 22;
        expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
        let offset = view.getUint32(endOffset + 16, true);
        let damaged = false;
        for (let index = 0; index < view.getUint16(endOffset + 10, true); ++index) {
            const nameLength = view.getUint16(offset + 28, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            if (name === 'tag_bank_1.json') {
                view.setUint32(offset + 16, (view.getUint32(offset + 16, true) ^ 1) >>> 0, true);
                damaged = true;
                break;
            }
            offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
        }
        expect(damaged).toBe(true);
        const db = database();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const result = await run(importer, db, bytes);
        expect(result.result).toBeNull();
        expect(result.errors.length).toBeGreaterThan(0);
        expect(db.bulkAdd.mock.calls.some(([store]) => store === 'tagMeta')).toBe(false);
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
    });
});
