/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {crc32} from 'node:zlib';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
// eslint-disable-next-line @stylistic/semi
import {DenseZipFileMap} from '../ext/js/dictionary/dense-zip-file-map.js'
// eslint-disable-next-line @stylistic/semi
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {createGenerationMediaIndex} from '../ext/js/dictionary/dictionary-generation-media-store.js';
import {startSourceZipMediaPreparation} from '../ext/js/dictionary/source-zip-media-preparation.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @typedef {import('../ext/js/dictionary/source-zip-media-preparation.js').SpeculativeSourceMedia} PreparedMedia */
/** @typedef {import('../ext/js/dictionary/dictionary-generation-media-store.js').GenerationMediaIndex} MediaIndex */
/** @typedef {import('dictionary-database').MediaDataArrayBufferContent} MediaRow */

const state = vi.hoisted(() => ({
    available: true,
    cancelled: false,
    events: /** @type {string[]} */ ([]),
    prepared: /** @type {Promise<PreparedMedia|null>} */ (Promise.resolve(null)),
    settle: /** @type {(value: PreparedMedia|null) => void} */ (() => {}),
}));

// The archive adapter, speculative worker and database are external boundaries.
// The complete importer, requirement classification, selection and cleanup run.
vi.mock('../ext/js/dictionary/source-zip-media-preparation.js', () => ({
    startSourceZipMediaPreparation: vi.fn(() => {
        if (!state.available) { return null; }
        return {
            result: state.prepared,
            cancel() {
                state.events.push('worker-cancel');
                state.settle(null);
            },
        };
    }),
}));

const IMAGE_COUNT = 8192;
const encoder = new TextEncoder();

class LargeArchive extends Blob {
    /** @override */
    get size() { return 129 * 1024 * 1024; }
}

function fixture(/** @type {{dense?: boolean, missing?: boolean, failSeal?: boolean, rejectWrite?: boolean, onTerms?: () => void}} */ {dense = false, missing = false, failSeal = false, rejectWrite = false, onTerms = () => {}} = {}) {
    /** @type {import('../ext/js/dictionary/dictionary-generation-media-store.js').SourceMediaRange[]} */
    const records = [];
    /** @type {Uint8Array<ArrayBuffer>[]} */
    const images = [];
    /** @type {MediaRow[]} */
    const storedMedia = [];
    /** @type {MediaIndex[]} */
    const selectedPlans = [];
    const readImage = vi.fn(/** @type {(index: number) => Uint8Array<ArrayBuffer>} */ ((index) => {
        state.events.push('image-read');
        return Uint8Array.from(images[index]);
    }));
    /* eslint-disable @stylistic/semi */
    const paths = Array.from({length: IMAGE_COUNT}, (_, index) => `img/card${index + 1}.webp`)
    /**
     * @this {import('../ext/js/dictionary/dense-zip-directory.js').DenseZipEntry}
     * @returns {Promise<Uint8Array<ArrayBuffer>>}
     */
    async function readDenseImage() { return readImage(Number(this.filename.slice(8, -5)) - 1) }
    /** @type {import('dictionary-importer').ArchiveFileMap} */
    const fileMap = dense ? new DenseZipFileMap(IMAGE_COUNT, encoder.encode(paths.join('')), readDenseImage) : new Map()
    let filenameOffset = 0
    // This archive adapter supplies getData payloads, not physical ZIP bytes.
    // Keep deferred fallback on those same adapter reads for both catalog types.
    if (dense) { vi.spyOn(RawZipPayloadReader.prototype, 'supportsBatchReads').mockReturnValue(false) }
    /* eslint-enable @stylistic/semi */
    const rows = [];
    for (let index = 0; index < IMAGE_COUNT; ++index) {
        const path = `img/card${index + 1}.webp`;
        const content = Uint8Array.of(index & 255, (index >>> 8) & 255, 255);
        images.push(content);
        records.push({path, packedOffset: index * 3, packedLength: 3, compressionMethod: 0, uncompressedLength: 3, signature: crc32(content)});
        /* eslint-disable @stylistic/semi */
        if (fileMap instanceof DenseZipFileMap) {
            fileMap.addDirectoryEntry(index, path, filenameOffset, index * 128, content.length, content.length, 0, crc32(content))
            filenameOffset += path.length
        } else {
            fileMap.set(path, /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({
                filename: path,
                uncompressedSize: content.length,
                async getData() { return readImage(index) },
            })))
        }
        /* eslint-enable @stylistic/semi */
        rows.push([
            `term${index + 1}`,
            `reading${index + 1}`,
            '',
            '',
            0,
            [{type: 'image', path: missing && index === IMAGE_COUNT - 1 ? 'img/missing.webp' : path}],
            index,
            '',
        ]);
    }
    for (const [filename, data] of [
        ['index.json', {title: 'Speculative media test', revision: '1', format: 3}],
        ['term_bank_1.json', rows],
    ]) {
        fileMap.set(/** @type {string} */ (filename), {filename: /** @type {string} */ (filename), bytes: encoder.encode(JSON.stringify(data))});
    }
    const blob = new Blob(images);
    const plan = createGenerationMediaIndex(records, blob.size);
    if (plan === null) { throw new Error('Media fixture was not admitted'); }
    const prepared = {
        blob,
        plan,
        metrics: {readMs: 1, validationMs: 1, rangeReadCount: 1, rangeReadBytes: blob.size, compressedBytes: blob.size, uncompressedBytes: blob.size},
    };
    const staged = {
        seal: vi.fn(async (/** @type {MediaIndex} */ selected) => {
            if (failSeal) { throw new Error('Staged media write failed'); }
            selectedPlans.push(selected);
            state.events.push('seal');
        }),
        discard: vi.fn(async () => { state.events.push('discard'); }),
    };
    const database = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: vi.fn(async () => 'media-import-session'),
        finishBulkImport: vi.fn(async () => { state.events.push('commit'); return {}; }),
        abortBulkImport: vi.fn(async () => { state.events.push('abort'); }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        canWriteGenerationMedia: () => true,
        stageGenerationMediaPayload: vi.fn(() => staged),
        writeGenerationMedia: vi.fn(async (/** @type {Blob} */ payload, /** @type {MediaIndex} */ selected) => {
            if (rejectWrite) { return false; }
            expect(payload).toBe(blob);
            selectedPlans.push(selected);
            return true;
        }),
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ entries, /** @type {number} */ start, /** @type {number} */ count) => {
            state.events.push(store);
            if (store === 'terms') { onTerms(); }
            if (store === 'media') { storedMedia.push(...(/** @type {MediaRow[]} */ (entries.slice(start, start + count)))); }
        }),
    };
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), void 0, () => state.cancelled);
    Reflect.set(importer, '_disableTermBankWasmFastPath', true);
    const close = vi.fn(async () => { state.events.push('archive-close'); });
    vi.spyOn(importer, '_getFilesFromArchive').mockResolvedValue({
        fileMap,
        zipReader: /** @type {Awaited<ReturnType<DictionaryImporter['_getFilesFromArchive']>>['zipReader']} */ (/** @type {unknown} */ ({close})),
        catalog: 'dense-zip',
    });
    const run = async () => await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)),
        new LargeArchive([new Uint8Array(30)]),
        {skipImageMetadata: true, enableTermEntryContentDedup: false, zipUseWebWorkers: false},
    );
    // eslint-disable-next-line @stylistic/semi
    return {run, prepared, database, staged, selectedPlans, storedMedia, images, readImage, close, fileMap}
}

/** @param {ReturnType<typeof fixture>} f */
function verifyFallback(f) {
    expect(f.storedMedia).toHaveLength(IMAGE_COUNT);
    expect(f.readImage).toHaveBeenCalledTimes(IMAGE_COUNT);
    expect(new Set(f.storedMedia.map(({path}) => path)).size).toBe(IMAGE_COUNT);
    for (let i = 0; i < IMAGE_COUNT; ++i) {
        const row = f.storedMedia[i];
        expect(row.path).toBe(`img/card${i + 1}.webp`);
        expect(new Uint8Array(row.content)).toEqual(f.images[i]);
    }
}

beforeEach(() => {
    state.available = true;
    state.cancelled = false;
    state.events = [];
    state.prepared = new Promise((resolve) => { state.settle = resolve; });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe('speculative packed media import ownership', () => {
    /* eslint-disable @stylistic/semi */
    test('keeps dense media entries compact when the speculative plan publishes', async () => {
        const f = fixture({dense: true, onTerms() { state.settle(f.prepared) }})
        const get = vi.spyOn(f.fileMap, 'get')
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toEqual(f.prepared.plan.descriptor)
        expect(get.mock.calls.filter(([path]) => path.startsWith('img/'))).toEqual([])
        expect(f.readImage).not.toHaveBeenCalled()
        expect(f.selectedPlans).toHaveLength(1)
        expect(f.selectedPlans[0].index).toBe(f.prepared.plan.index)
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce()
        expect(f.close).toHaveBeenCalledOnce()
    })

    test.each(['unavailable', 'declined'])('materializes dense entries for complete fallback when speculative work is %s', async (mode) => {
        state.available = mode !== 'unavailable'
        const f = fixture({dense: true, onTerms() { state.settle(null) }})
        const get = vi.spyOn(f.fileMap, 'get')
        const result = await f.run()
        expect(result.errors).toEqual([])
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT)
        expect(result.result?.generationMedia).toBeUndefined()
        expect(get.mock.calls.some(([path]) => path.startsWith('img/'))).toBe(true)
        verifyFallback(f)
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce()
        expect(f.close).toHaveBeenCalledOnce()
    })
    /* eslint-enable @stylistic/semi */

    test('publishes every verified reference without duplicate decoding or SQLite media', async () => {
        const f = fixture({onTerms() { state.settle(f.prepared); }});
        const result = await f.run();
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT);
        expect(result.result?.generationMedia).toEqual(f.prepared.plan.descriptor);
        expect(startSourceZipMediaPreparation).toHaveBeenCalledOnce();
        expect(f.readImage).not.toHaveBeenCalled();
        expect(f.storedMedia).toEqual([]);
        expect(f.selectedPlans).toHaveLength(1);
        expect(f.selectedPlans[0].index).toBe(f.prepared.plan.index);
        expect(f.staged.seal).toHaveBeenCalledOnce();
        expect(f.database.writeGenerationMedia).not.toHaveBeenCalled();
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce();
        expect(f.close).toHaveBeenCalledOnce();
    });

    test('retains individual prefetch when a speculative worker cannot start', async () => {
        state.available = false;
        const f = fixture();
        const result = await f.run();
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT);
        expect(result.result?.generationMedia).toBeUndefined();
        expect(state.events.indexOf('image-read')).toBeLessThan(state.events.indexOf('terms'));
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled();
        verifyFallback(f);
    });

    test('drains every deferred reference when the worker declines its source', async () => {
        const f = fixture({onTerms() { state.settle(null); }});
        const result = await f.run();
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT);
        expect(result.result?.generationMedia).toBeUndefined();
        expect(state.events.indexOf('terms')).toBeLessThan(state.events.indexOf('image-read'));
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled();
        verifyFallback(f);
    });

    test('rereads all payloads when retrying after a deferred media write fails', async () => {
        const f = fixture();
        state.settle(null);
        const write = f.database.bulkAdd.getMockImplementation();
        if (typeof write === 'undefined') { throw new Error('Missing database fixture'); }
        let failOnce = true;
        f.database.bulkAdd.mockImplementation(async (...args) => {
            if (args[0] === 'media' && failOnce) {
                failOnce = false;
                throw new Error('Deferred media write failed');
            }
            await write(...args);
        });
        const first = await f.run();
        expect(first.result).toBeNull();
        expect(first.errors.map(({message}) => message)).toEqual(['Deferred media write failed']);
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce();
        expect(f.readImage).toHaveBeenCalled();
        f.readImage.mockClear();
        const retry = await f.run();
        expect(retry.errors).toEqual([]);
        expect(retry.result?.counts?.media.total).toBe(IMAGE_COUNT);
        expect(f.database.finishBulkImport).toHaveBeenCalledOnce();
        verifyFallback(f);
    });

    /* eslint-disable @stylistic/semi */
    test.each([false, true])('preserves every payload if staged and ordinary packed publication both fail (dense=%s)', async (dense) => {
        const f = fixture({failSeal: true, rejectWrite: true, dense})
        /* eslint-enable @stylistic/semi */
        state.settle(f.prepared);
        const result = await f.run();
        expect(result.errors).toEqual([]);
        expect(result.result?.counts?.media.total).toBe(IMAGE_COUNT);
        expect(result.result?.generationMedia).toBeUndefined();
        expect(f.staged.seal).toHaveBeenCalledOnce();
        expect(f.staged.discard).toHaveBeenCalledOnce();
        expect(f.database.writeGenerationMedia).toHaveBeenCalledOnce();
        verifyFallback(f);
    });

    /* eslint-disable @stylistic/semi */
    test.each([false, true])('does not hide a missing reference behind the speculative index (dense=%s)', async (dense) => {
        const f = fixture({missing: true, dense})
        /* eslint-enable @stylistic/semi */
        state.settle(f.prepared);
        const result = await f.run();
        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toEqual([
            'Could not find image at path "img/missing.webp" for term8192 (reading8192) in Speculative media test',
        ]);
        expect(f.staged.seal).not.toHaveBeenCalled();
        expect(f.database.writeGenerationMedia).not.toHaveBeenCalled();
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce();
        expect(f.database.finishBulkImport).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledOnce();
    });

    /* eslint-disable @stylistic/semi */
    test.each([false, true])('cancels pending speculative preparation before aborting a failed term sink (dense=%s)', async (dense) => {
        const f = fixture({dense, onTerms() { throw new Error('Term sink failed') }})
        /* eslint-enable @stylistic/semi */
        const result = await f.run();
        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toEqual(['Term sink failed']);
        expect(f.readImage).not.toHaveBeenCalled();
        expect(f.database.stageGenerationMediaPayload).not.toHaveBeenCalled();
        expect(f.database.finishBulkImport).not.toHaveBeenCalled();
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce();
        expect(state.events.indexOf('worker-cancel')).toBeLessThan(state.events.indexOf('archive-close'));
        expect(state.events.indexOf('archive-close')).toBeLessThan(state.events.indexOf('abort'));
        expect(f.close).toHaveBeenCalledOnce();
    });

    /* eslint-disable @stylistic/semi */
    test.each([false, true])('discards staged media when the user cancels after preparation (dense=%s)', async (dense) => {
        const f = fixture({dense, onTerms() { state.cancelled = true }})
        /* eslint-enable @stylistic/semi */
        state.settle(f.prepared);
        const result = await f.run();
        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toEqual(['Dictionary import was cancelled']);
        expect(f.database.stageGenerationMediaPayload).toHaveBeenCalledOnce();
        expect(f.staged.seal).not.toHaveBeenCalled();
        expect(f.staged.discard).toHaveBeenCalledOnce();
        expect(f.readImage).not.toHaveBeenCalled();
        expect(f.database.finishBulkImport).not.toHaveBeenCalled();
        expect(f.database.abortBulkImport).toHaveBeenCalledOnce();
        expect(state.events.indexOf('discard')).toBeLessThan(state.events.indexOf('archive-close'));
        expect(state.events.indexOf('archive-close')).toBeLessThan(state.events.indexOf('abort'));
        expect(f.close).toHaveBeenCalledOnce();
    });
});
