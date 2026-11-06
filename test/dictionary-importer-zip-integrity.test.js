/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BlobWriter, TextWriter, Uint8ArrayReader as BundledUint8ArrayReader, Uint8ArrayWriter as BundledUint8ArrayWriter, ZipReader} from '../ext/lib/zip.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js';
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {0|6} level
 * @returns {Promise<Uint8Array>}
 */
async function archive(level) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: '日本語 size fixture', revision: '1', format: 3})), options);
    await writer.add('term_bank_1.json', new TextReader(JSON.stringify([
        ['日本語', '', '', '', 1, ['日本語の意味', {type: 'image', path: 'image.png'}], 1, ''],
    ])), options);
    await writer.add('image.png', new Uint8ArrayReader(Uint8Array.of(0xff, 0x80, 0)), options);
    return Uint8Array.from(await writer.close());
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {'zero'|'smaller'|'larger'} size
 * @returns {Uint8Array}
 */
function changeDeclaredSize(bytes, filename, size) {
    const result = Uint8Array.from(bytes);
    const view = new DataView(result.buffer);
    const endOffset = result.byteLength - 22;
    if (view.getUint32(endOffset, true) !== 0x06054b50) { throw new Error('Missing fixture end record'); }
    let offset = view.getUint32(endOffset + 16, true);
    for (let i = 0; i < view.getUint16(endOffset + 10, true); ++i) {
        if (view.getUint32(offset, true) !== 0x02014b50) { throw new Error('Missing fixture central entry'); }
        const nameLength = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(result.subarray(offset + 46, offset + 46 + nameLength));
        if (name === filename) {
            const original = view.getUint32(offset + 24, true);
            view.setUint32(offset + 24, size === 'zero' ? 0 : original + (size === 'smaller' ? -1 : 1), true);
            return result;
        }
        offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    throw new Error(`Missing fixture entry ${filename}`);
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
        startBulkImport: vi.fn(async () => 'size-session'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { pending.terms = 0; pending.media = 0; }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {unknown[]} */ _items, /** @type {number} */ _start, /** @type {number} */ count) => {
            if (store === 'terms') { pending.terms += count; }
            if (store === 'media') { pending.media += count; }
        }),
    };
}

/**
 * @param {DictionaryImporter} importer
 * @param {ReturnType<typeof database>} db
 * @param {Uint8Array} bytes
 * @returns {Promise<import('dictionary-importer').ImportResult>}
 */
async function importArchive(importer, db, bytes) {
    return await importer.importDictionary(
        /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (db)),
        new Blob([bytes]),
        /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata: true, zipUseWebWorkers: false}),
    );
}

describe('decoded dictionary ZIP sizes', () => {
    for (const level of /** @type {const} */ ([0, 6])) {
        test(`healthy Unicode dictionary publishes through decoded fallback (level ${level})`, async () => {
            const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
            Reflect.set(importer, '_disableTermBankWasmFastPath', true);
            const db = database();
            const result = await importArchive(importer, db, await archive(level));
            expect(result.result).not.toBeNull();
            expect(result.errors).toEqual([]);
            expect(db.pending).toEqual({terms: 1, media: 1});
            expect(db.finishBulkImport).toHaveBeenCalledOnce();
        });

        for (const filename of ['index.json', 'term_bank_1.json', 'image.png']) {
            test.each(['zero', 'smaller', 'larger'])(`rejects ${filename} with %s decoded size before publication (level ${level})`, async (size) => {
                const bytes = changeDeclaredSize(await archive(level), filename, /** @type {'zero'|'smaller'|'larger'} */ (size));
                const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                Reflect.set(importer, '_disableTermBankWasmFastPath', true);
                const db = database();
                const close = vi.spyOn(ZipReader.prototype, 'close');
                const result = await importArchive(importer, db, bytes);
                expect(result.result).toBeNull();
                expect(result.errors.some((error) => error instanceof DictionarySourceIntegrityError && /size mismatch/u.test(error.message))).toBe(true);
                expect(db.finishBulkImport).not.toHaveBeenCalled();
                expect(db.abortBulkImport).toHaveBeenCalledTimes(filename === 'index.json' ? 0 : 1);
                expect(db.pending).toEqual({terms: 0, media: 0});
                expect(close).toHaveBeenCalledOnce();
            });
        }
    }

    test.each(['text', 'bytes', 'blob'])('uses actual decoder bytes with a %s writer', async (kind) => {
        const reader = new ZipReader(new BundledUint8ArrayReader(await archive(6)));
        try {
            const entry = (/** @type {import('@zip.js/zip.js').Entry[]} */ (await reader.getEntries())).find((file) => file.filename === 'image.png');
            if (typeof entry === 'undefined') { throw new Error('Missing image fixture'); }
            const writer = kind === 'text' ? new TextWriter() : (kind === 'bytes' ? new BundledUint8ArrayWriter() : new BlobWriter());
            const typedWriter = /** @type {import('@zip.js/zip.js').Writer<unknown>} */ (/** @type {unknown} */ (writer));
            const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
            Reflect.set(importer, '_zipUseWebWorkers', false);
            await expect(importer._getData(
                /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (entry)),
                typedWriter,
            )).resolves.toBeDefined();
            expect(Reflect.get(typedWriter.writable, 'size')).toBe(3);
        } finally {
            await reader.close();
        }
    });
});

describe('source validation versus parser admission fallback', () => {
    test('healthy ZIP keeps the decoded fallback when fast parser admission fails', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const fast = vi.spyOn(importer, '_readTermBankFileFast').mockRejectedValue(new Error('Parser worker unavailable'));
        const db = database();
        const result = await importArchive(importer, db, await archive(6));
        expect(fast).toHaveBeenCalledTimes(2);
        expect(result.result).not.toBeNull();
        expect(result.errors).toEqual([]);
        expect(db.pending).toEqual({terms: 1, media: 1});
        expect(db.finishBulkImport).toHaveBeenCalledOnce();
    });

    test('streaming source-header failure cannot publish through the decoded fallback', async () => {
        const bytes = await archive(6);
        const reader = new ZipReader(new BundledUint8ArrayReader(bytes));
        let entry;
        try {
            entry = (/** @type {import('@zip.js/zip.js').Entry[]} */ (await reader.getEntries())).find((file) => file.filename === 'term_bank_1.json');
        } finally {
            await reader.close();
        }
        if (typeof entry === 'undefined') { throw new Error('Missing term fixture'); }
        bytes[entry.offset + 30] ^= 1;
        const raw = new RawZipPayloadReader(new Blob([bytes]));
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        // Keep real ZIP I/O, header validation and importer fallback. Substitute
        // only parser admission, which otherwise depends on browser workers.
        const fast = vi.spyOn(importer, '_readTermBankFileFast').mockImplementation(async () => {
            await raw.read(/** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (entry)), new AbortController().signal);
            throw new Error('Corrupt local filename unexpectedly accepted');
        });
        const db = database();
        const result = await importArchive(importer, db, bytes);
        expect(result.result).toBeNull();
        expect(result.errors.some((error) => error instanceof DictionarySourceIntegrityError && /local filename/u.test(error.message))).toBe(true);
        expect(fast).toHaveBeenCalledOnce();
        expect(db.finishBulkImport).not.toHaveBeenCalled();
        expect(db.abortBulkImport).toHaveBeenCalledOnce();
        expect(db.pending).toEqual({terms: 0, media: 0});
    });

    test('single-bank source failures preserve the integrity type without rereading through zip.js', async () => {
        const reader = new ZipReader(new BundledUint8ArrayReader(await archive(6)));
        try {
            const entry = (/** @type {import('@zip.js/zip.js').Entry[]} */ (await reader.getEntries())).find((file) => file.filename === 'term_bank_1.json');
            if (typeof entry === 'undefined') { throw new Error('Missing term fixture'); }
            const failure = new DictionarySourceIntegrityError('ZIP source failed validation');
            const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
            vi.spyOn(importer, '_readTermBankFileFast').mockRejectedValue(failure);
            const read = vi.spyOn(importer, '_getData');
            await expect(importer._readTermBankFile(
                /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (entry)),
                3,
                'integrity fixture',
                false,
                false,
                true,
                'baseline',
            )).rejects.toBe(failure);
            expect(read).not.toHaveBeenCalled();
        } finally {
            await reader.close();
        }
    });
});
