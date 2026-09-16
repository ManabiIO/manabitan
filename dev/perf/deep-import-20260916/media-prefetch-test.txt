/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const state = vi.hoisted(() => ({
    events: /** @type {string[]} */ ([]),
    readGate: /** @type {((path: string) => Promise<void>)|null} */ (null),
    sizeOverride: /** @type {number|undefined|null} */ (null),
    cancelled: false,
}));

// Substitute only the archive I/O provider. ZIP parsing and decompression, the
// complete importer, requirement resolution and session ownership are real.
vi.mock('../ext/lib/zip.js', async (importOriginal) => {
    const original = /** @type {typeof import('@zip.js/zip.js')} */ (await importOriginal());
    /** @augments {original.ZipReader<unknown>} */
    class ObservedZipReader extends original.ZipReader {
        /** @returns {Promise<import('@zip.js/zip.js').Entry[]>} */
        async getEntries() {
            const entries = await super.getEntries();
            return entries.map((entry) => {
                if (!entry.filename.endsWith('.png') || entry.directory || typeof entry.getData !== 'function') { return entry; }
                const getData = entry.getData;
                const observed = {...entry};
                if (state.sizeOverride !== null) { Reflect.set(observed, 'uncompressedSize', state.sizeOverride); }
                Reflect.set(observed, 'getData', async (/** @type {unknown[]} */ ...args) => {
                    state.events.push(`read:${entry.filename}`);
                    try {
                        await state.readGate?.(entry.filename);
                        return await Reflect.apply(getData, entry, args);
                    } finally {
                        state.events.push(`settled:${entry.filename}`);
                    }
                });
                return observed;
            });
        }

        /** @returns {Promise<void>} */
        async close() {
            state.events.push('archive-close');
            await super.close();
        }
    }
    return {...original, ZipReader: ObservedZipReader};
});

/** @returns {{promise: Promise<void>, release: () => void}} */
function gate() {
    /** @type {() => void} */
    let release = () => {};
    const promise = new Promise((resolve) => { release = () => resolve(void 0); });
    return {promise, release};
}

/**
 * @param {{missing?: boolean, imageCount?: number, duplicate?: boolean}} [options]
 * @returns {Promise<ArrayBuffer>}
 */
async function archive({missing = false, imageCount = 2, duplicate = false} = {}) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Media test', revision: '1', format: 3})));
    for (let i = 0; i < imageCount; ++i) {
        const image = duplicate ? 0 : i;
        const row = [`term${i}`, '', '', '', 0, [{type: 'image', path: `image${image}.png`}], i, ''];
        await writer.add(`term_bank_${i + 1}.json`, new TextReader(JSON.stringify([row])));
        if (!missing && (!duplicate || i === 0)) {
            await writer.add(`image${i}.png`, new Uint8ArrayReader(Uint8Array.of(i & 255, 17, 255)));
        }
    }
    if (missing) { await writer.add('unused.png', new Uint8ArrayReader(Uint8Array.of(0))); }
    const bytes = await writer.close();
    return new Uint8Array(bytes).buffer;
}

/**
 * @typedef {{
 * isPrepared: () => boolean,
 * setImportOptimizationFlags: () => void,
 * setTermEntryContentDedupEnabled: () => void,
 * setImportDebugLogging: () => void,
 * dictionaryExists: () => Promise<boolean>,
 * addWithResult: () => Promise<number>,
 * startBulkImport: import('vitest').Mock<() => Promise<void>>,
 * finishBulkImport: import('vitest').Mock<() => Promise<object>>,
 * abortBulkImport: import('vitest').Mock<() => Promise<void>>,
 * deleteDictionaryImportPlaceholder: import('vitest').Mock<() => Promise<void>>,
 * getLastBulkAddTermsMetrics: () => null,
 * queuePendingTermContentImportWrites: () => Promise<void>,
 * bulkAdd: import('vitest').Mock<(store: string, entries: unknown[]) => Promise<void>>,
 * }} TestDatabase
 */

/** @returns {TestDatabase} */
function database() {
    return {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => {}),
        finishBulkImport: vi.fn(async () => { state.events.push('commit'); return {}; }),
        abortBulkImport: vi.fn(async () => { state.events.push('abort'); }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(/**
                        * @param {string} store
                        * @param {unknown[]} entries
                        */ async (store, entries) => {
                state.events.push(`${store}:${entries.length}`);
            },
        ),
    };
}

/**
 * @param {ArrayBuffer} bytes
 * @param {ReturnType<typeof database>} db
 * @param {Partial<import('dictionary-importer').ImportDetails>} [options]
 * @returns {Promise<import('dictionary-importer').ImportResult>}
 */
async function run(bytes, db, options = {}) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => state.cancelled);
    return await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
        bytes,
        /** @type {import('dictionary-importer').ImportDetails} */ ({
            skipImageMetadata: true,
            zipUseWebWorkers: false,
            enableTermEntryContentDedup: false,
            disableTermBankWasmFastPath: true,
            ...options,
        }),
    );
}

beforeEach(() => {
    state.events = [];
    state.readGate = null;
    state.sizeOverride = null;
    state.cancelled = false;
});

describe('bounded referenced-media prefetch', () => {
    test('reads referenced media before all terms finish and writes it before commit', async () => {
        const db = database();
        const result = await run(await archive(), db);
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(2);
        expect(state.events.indexOf('read:image0.png')).toBeLessThan(state.events.lastIndexOf('terms:1'));
        expect(state.events.indexOf('media:2')).toBeLessThan(state.events.indexOf('commit'));
        expect(state.events.filter((event) => event === 'archive-close')).toHaveLength(1);
        const media = db.bulkAdd.mock.calls.filter(([store]) => store === 'media').flatMap(([, entries]) => entries);
        expect(media).toHaveLength(2);
        for (const entry of media) {
            const value = /** @type {{path: string, content: ArrayBuffer}} */ (entry);
            const index = Number(value.path.replace(/\D/g, ''));
            expect(new Uint8Array(value.content)).toEqual(Uint8Array.of(index, 17, 255));
        }
    });

    test.each([void 0, -1, 0.5, Number.NaN, 9 * 1024 * 1024])('defers unsupported or over-budget size %s', async (size) => {
        state.sizeOverride = size;
        const result = await run(await archive(), database());
        expect(result.errors).toEqual([]);
        expect(state.events.indexOf('read:image0.png')).toBeGreaterThan(state.events.lastIndexOf('terms:1'));
    });

    test('deduplicates referenced paths across term banks', async () => {
        const result = await run(await archive({duplicate: true}), database());
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(1);
        expect(state.events.filter((event) => event === 'read:image0.png')).toHaveLength(1);
    });

    test('missing media aborts without publishing', async () => {
        const db = database();
        const result = await run(await archive({missing: true}), db);
        expect(result.result).toBeNull();
        expect(result.errors.length).toBeGreaterThan(0);
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
    });
    test('a prefetched read failure aborts and preserves its error', async () => {
        const failure = new Error('media read failed');
        state.readGate = async () => { throw failure; };
        const db = database();
        const result = await run(await archive(), db);
        expect(result.result).toBeNull();
        expect(result.errors).toContain(failure);
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(state.events.indexOf('archive-close')).toBeGreaterThan(state.events.indexOf('settled:image0.png'));
    });

    test('joins a started media read before closing an archive after a term write failure', async () => {
        const started = gate();
        const release = gate();
        const termFailed = gate();
        const failure = new Error('term write failed');
        state.readGate = async () => {
            started.release();
            await release.promise;
        };
        const db = database();
        db.bulkAdd.mockImplementation(async (store) => {
            if (store !== 'terms') { return; }
            await started.promise;
            termFailed.release();
            throw failure;
        });
        const operation = run(await archive(), db);
        try {
            await termFailed.promise;
            expect(state.events).not.toContain('archive-close');
            expect(db.finishBulkImport).not.toHaveBeenCalled();
        } finally {
            release.release();
        }
        const result = await operation;
        expect(result.result).toBeNull();
        expect(result.errors).toContain(failure);
        expect(state.events.indexOf('archive-close')).toBeGreaterThan(state.events.indexOf('settled:image0.png'));
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
    });

    test('cancellation drains started media and prevents publication', async () => {
        const started = gate();
        const release = gate();
        state.readGate = async () => {
            started.release();
            await release.promise;
        };
        const db = database();
        const operation = run(await archive(), db);
        try {
            await started.promise;
            state.cancelled = true;
            expect(state.events).not.toContain('archive-close');
        } finally {
            release.release();
        }
        const result = await operation;
        expect(result.result).toBeNull();
        expect(result.errors.some(({message}) => message.includes('cancelled'))).toBe(true);
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(state.events.indexOf('archive-close')).toBeGreaterThan(state.events.indexOf('settled:image0.png'));
        expect(state.events).not.toContain('read:image1.png');
    });

    test('preserves both media failure and term failure before resource disposal', async () => {
        const started = gate();
        const release = gate();
        const termFailed = gate();
        const mediaFailure = new Error('concurrent media failure');
        const termFailure = new Error('concurrent term failure');
        state.readGate = async () => {
            started.release();
            await release.promise;
            throw mediaFailure;
        };
        const db = database();
        db.bulkAdd.mockImplementation(async (store) => {
            if (store !== 'terms') { return; }
            await started.promise;
            termFailed.release();
            throw termFailure;
        });
        const operation = run(await archive(), db);
        try {
            await termFailed.promise;
            expect(state.events).not.toContain('archive-close');
        } finally {
            release.release();
        }
        const result = await operation;
        expect(result.result).toBeNull();
        expect(result.errors).toEqual(expect.arrayContaining([mediaFailure, termFailure]));
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(state.events.indexOf('archive-close')).toBeGreaterThan(state.events.indexOf('settled:image0.png'));
    });

    test('bounds cumulative admitted bytes rather than only individual image sizes', async () => {
        state.sizeOverride = 3 * 1024 * 1024;
        const result = await run(await archive(), database());
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(2);
        expect(state.events.indexOf('read:image0.png')).toBeLessThan(state.events.lastIndexOf('terms:1'));
        expect(state.events.indexOf('read:image1.png')).toBeGreaterThan(state.events.lastIndexOf('terms:1'));
    });

    test('keeps metadata decoding on the existing eager path', async () => {
        const db = database();
        const result = await run(await archive(), db, {skipImageMetadata: false});
        expect(result.errors).toEqual([]);
        expect(state.events.indexOf('media:1')).toBeLessThan(state.events.indexOf('terms:1'));
        const media = db.bulkAdd.mock.calls.filter(([store]) => store === 'media').flatMap(([, entries]) => entries);
        for (const entry of media) { expect(entry).toMatchObject({width: 100, height: 100}); }
    });

    test('does not load media when media import is disabled', async () => {
        const result = await run(await archive(), database(), {skipMediaImport: true});
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(0);
        expect(state.events.some((event) => event.startsWith('read:'))).toBe(false);
    });
});
