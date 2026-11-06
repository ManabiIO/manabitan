/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {crc32} from 'node:zlib';
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {Uint8ArrayReader as BundledUint8ArrayReader, ZipReader} from '../ext/lib/zip.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {inflateCompressedTermBankSourcesWasm, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {0|6} level
 * @param {number} [banks]
 * @returns {Promise<Uint8Array>}
 */
async function archive(level, banks = 1) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'CRC fixture', revision: '1', format: 3})), options);
    for (let bank = 1; bank <= banks; ++bank) {
        await writer.add(`term_bank_${bank}.json`, new TextReader(JSON.stringify([
            [`term-${bank}`, '', '', '', 1, ['definition', {type: 'image', path: 'image.png'}], bank, ''],
        ])), options);
    }
    await writer.add('image.png', new Uint8ArrayReader(Uint8Array.of(1, 2, 3)), options);
    return Uint8Array.from(await writer.close());
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<import('@zip.js/zip.js').Entry[]>}
 */
async function entries(bytes) {
    const reader = new ZipReader(new BundledUint8ArrayReader(bytes));
    try {
        return /** @type {import('@zip.js/zip.js').Entry[]} */ (await reader.getEntries());
    } finally {
        await reader.close();
    }
}

/**
 * Change a stored payload without breaking its JSON, or change a DEFLATE
 * entry's declared CRC without changing its decodable compressed bytes.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {0|6} level
 * @returns {Promise<Uint8Array>}
 */
async function corrupt(bytes, filename, level) {
    const damaged = Uint8Array.from(bytes);
    const entry = (await entries(bytes)).find((item) => item.filename === filename);
    if (typeof entry === 'undefined') { throw new Error(`Missing fixture entry ${filename}`); }
    const view = new DataView(damaged.buffer);
    if (level === 0) {
        expect(entry.compressionMethod).toBe(0);
        const offset = entry.offset;
        const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
        const payload = damaged.subarray(start, start + entry.uncompressedSize);
        const marker = filename === 'index.json' ? 'CRC fixture' : 'definition';
        const index = filename.endsWith('.png') ? 0 : new TextDecoder().decode(payload).indexOf(marker);
        expect(index).toBeGreaterThanOrEqual(0);
        payload[index] ^= 0x20;
        expect(crc32(payload)).not.toBe(entry.signature);
    } else {
        expect(entry.compressionMethod).toBe(8);
        const end = damaged.byteLength - 22;
        expect(view.getUint32(end, true)).toBe(0x06054b50);
        let offset = view.getUint32(end + 16, true);
        let changed = false;
        for (let i = 0; i < view.getUint16(end + 10, true); ++i) {
            expect(view.getUint32(offset, true)).toBe(0x02014b50);
            const nameLength = view.getUint16(offset + 28, true);
            const name = new TextDecoder().decode(damaged.subarray(offset + 46, offset + 46 + nameLength));
            if (name === filename) {
                view.setUint32(offset + 16, (entry.signature ^ 1) >>> 0, true);
                changed = true;
                break;
            }
            offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
        }
        expect(changed).toBe(true);
    }
    return damaged;
}

function database() {
    const pending = {terms: 0, media: 0};
    return {
        pending,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'crc-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { pending.terms = 0; pending.media = 0; }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ _items, /** @type {number} */ _start, /** @type {number} */ count) => {
            if (store === 'terms') { pending.terms += count; }
            if (store === 'media') { pending.media += count; }
        }),
        bulkAddArtifactTermsChunk: vi.fn(async (/** @type {{rowCount: number}} */ chunk) => { pending.terms += chunk.rowCount; }),
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
        /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata: true, zipUseWebWorkers: false}),
    );
}

describe('decoded ZIP entry CRC verification', () => {
    for (const level of /** @type {const} */ ([0, 6])) {
        test(`healthy ZIP publishes its term and image (compression level ${level})`, async () => {
            const bytes = await archive(level);
            const close = vi.spyOn(ZipReader.prototype, 'close');
            const db = database();
            const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
            Reflect.set(importer, '_disableTermBankWasmFastPath', true);
            const result = await run(importer, db, bytes);
            expect(result.result).not.toBeNull();
            expect(result.errors).toEqual([]);
            expect(db.pending).toEqual({terms: 1, media: 1});
            expect(db.finishBulkImport).toHaveBeenCalledOnce();
            expect(db.abortBulkImport).not.toHaveBeenCalled();
            expect(close).toHaveBeenCalledOnce();
        });

        for (const filename of ['index.json', 'term_bank_1.json', 'image.png']) {
            test(`rejects CRC-invalid ${filename} before publication (compression level ${level})`, async () => {
                const bytes = await corrupt(await archive(level), filename, level);
                const close = vi.spyOn(ZipReader.prototype, 'close');
                const db = database();
                const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                Reflect.set(importer, '_disableTermBankWasmFastPath', true);
                const result = await run(importer, db, bytes);
                expect(result.result).toBeNull();
                expect(result.errors.some((error) => /signature/i.test(error.message))).toBe(true);
                expect(db.finishBulkImport).not.toHaveBeenCalled();
                expect(db.abortBulkImport).toHaveBeenCalledTimes(filename === 'index.json' ? 0 : 1);
                expect(db.deleteDictionaryImportPlaceholder).toHaveBeenCalledTimes(filename === 'index.json' ? 0 : 1);
                expect(db.pending).toEqual({terms: 0, media: 0});
                expect(close).toHaveBeenCalledOnce();
            });
        }
    }

    test.each([false, true])('decoded fallback preserves raw CRC validation (corrupt source: %s)', async (damaged) => {
        const healthy = await archive(0, 4);
        const bytes = damaged ? await corrupt(healthy, 'term_bank_1.json', 0) : healthy;
        const termEntries = (await entries(bytes)).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename));
        const rawReader = new RawZipPayloadReader(new Blob([bytes]));
        const sources = await Promise.all(termEntries.map(async (entry) => ({
            bytes: await rawReader.read(entry, new AbortController().signal),
            compressionMethod: /** @type {0|8} */ (entry.compressionMethod),
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            signature: entry.signature,
            filename: entry.filename,
        })));
        const close = vi.spyOn(ZipReader.prototype, 'close');
        const db = database();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        /** @type {unknown} */
        let rawFailure = null;
        // Keep real archive I/O, raw payload validation and importer fallback;
        // substitute only worker admission so this control needs no worker shim.
        const fast = vi.spyOn(importer, '_readTermBankFileFast').mockImplementationOnce(async () => {
            try {
                await inflateCompressedTermBankSourcesWasm(sources);
            } catch (error) {
                rawFailure = error;
                throw error;
            }
            throw new Error('Worker admission declined after source validation');
        });
        const result = await run(importer, db, bytes);
        expect(fast.mock.calls.length).toBeGreaterThan(1);
        if (damaged) {
            expect(rawFailure).toBeInstanceOf(Error);
            expect(/** @type {Error} */ (rawFailure).message).toContain('ZIP CRC32');
            expect(result.result).toBeNull();
            expect(db.finishBulkImport).not.toHaveBeenCalled();
            expect(db.abortBulkImport).toHaveBeenCalledOnce();
            expect(db.pending).toEqual({terms: 0, media: 0});
        } else {
            expect(rawFailure).toBeNull();
            expect(result.result).not.toBeNull();
            expect(result.errors).toEqual([]);
            expect(db.finishBulkImport).toHaveBeenCalledOnce();
            expect(db.abortBulkImport).not.toHaveBeenCalled();
            expect(db.pending).toEqual({terms: 4, media: 1});
        }
        expect(close).toHaveBeenCalledOnce();
    });
});
