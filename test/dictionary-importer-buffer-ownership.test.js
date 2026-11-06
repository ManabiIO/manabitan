/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/** @typedef {import('dictionary-database').DatabaseTermEntry} Row */
/** @typedef {{expression: string, offset: number, length: number, expected: Uint8Array<ArrayBuffer>}} StoredRecord */
/** @typedef {{seek: (position: number) => Promise<void>, write: (data: Blob|Uint8Array) => Promise<void>, close: () => Promise<void>, abort: () => Promise<void>}} MemoryWritable */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const contentFileName = 'manabitan-term-content.bin';

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url));
    setTermBankWasmModule(await WebAssembly.compile(bytes));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * The adapter snapshots data at write(), as OPFS does. Production buffering,
 * overlays, append offsets, and finalization remain unchanged.
 * @returns {{root: FileSystemDirectoryHandle, files: Map<string, Uint8Array<ArrayBuffer>>, write: ReturnType<typeof vi.fn>}}
 */
function createFileSystem() {
    /** @type {Map<string, Uint8Array<ArrayBuffer>>} */
    const files = new Map();
    const write = vi.fn();
    const root = {
        /**
         * @param {string} name
         * @param {{create?: boolean}} [options]
         * @returns {Promise<{kind: string, name: string, getFile: () => Promise<File>, createWritable: (options?: {keepExistingData?: boolean}) => Promise<MemoryWritable>}>}
         */
        async getFileHandle(name, {create = false} = {}) {
            if (!files.has(name)) {
                if (!create) { throw new DOMException(name, 'NotFoundError'); }
                files.set(name, new Uint8Array());
            }
            return {
                kind: 'file',
                name,
                async getFile() { return new File([files.get(name) ?? new Uint8Array()], name); },
                /**
                 * @param {{keepExistingData?: boolean}} [options]
                 * @returns {Promise<MemoryWritable>}
                 */
                async createWritable({keepExistingData = false} = {}) {
                    let bytes = keepExistingData ? Uint8Array.from(files.get(name) ?? []) : new Uint8Array();
                    let position = 0;
                    return {
                        /** @param {number} value */
                        async seek(value) { position = value; },
                        /** @param {Blob|Uint8Array} data */
                        async write(data) {
                            write();
                            const owned = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : Uint8Array.from(data);
                            const next = new Uint8Array(Math.max(bytes.length, position + owned.length));
                            next.set(bytes);
                            next.set(owned, position);
                            bytes = next;
                            position += owned.length;
                        },
                        async close() { files.set(name, bytes); },
                        async abort() {},
                    };
                },
            };
        },
        async *entries() {
            for (const name of files.keys()) { yield [name, await this.getFileHandle(name)]; }
        },
    };
    return {root: /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ (root)), files, write};
}

/**
 * Stub only SQLite and record persistence. Both deduplicated and ordinary
 * term writers retain their real parser/content-store ownership boundaries.
 * @param {'baseline'|'raw-bytes'} storageMode
 * @param {boolean} dedup
 * @returns {{database: DictionaryDatabase, importer: DictionaryImporter, store: import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore, filesystem: ReturnType<typeof createFileSystem>, records: StoredRecord[], appendRows: (rows: Row[]) => Promise<void>}}
 */
function createHarness(storageMode, dedup) {
    const filesystem = createFileSystem();
    vi.stubGlobal('navigator', {deviceMemory: 4, storage: {getDirectory: async () => filesystem.root}});
    const database = new DictionaryDatabase();
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const store = /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (Reflect.get(database, '_termContentStore'));
    const recordStore = /** @type {import('../ext/js/dictionary/term-record-opfs-store.js').TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
    database.setImportOptimizationFlags({termContentStorageMode: storageMode, queueTermContentWrites: true});
    database.setTermEntryContentDedupEnabled(dedup);
    Reflect.set(database, '_db', {exec() {}});
    Reflect.set(database, '_bulkImportTransactionOpen', true);
    Reflect.set(database, '_deferTermsVirtualTableSync', true);
    Reflect.set(database, '_termContentZstdInitialized', true);
    /** @type {StoredRecord[]} */
    const records = [];
    /**
     * @param {Row[]} rows
     * @param {number} start
     * @param {number} count
     * @param {number[]|Float64Array} offsets
     * @param {number[]|Uint32Array} lengths
     */
    const captureRecords = (rows, start, count, offsets, lengths) => {
        for (let i = start; i < start + count; ++i) {
            const bytes = rows[i].termEntryContentBytes;
            if (!(bytes instanceof Uint8Array)) { throw new Error('Expected native parser content'); }
            records.push({expression: rows[i].expression, offset: offsets[i], length: lengths[i], expected: Uint8Array.from(bytes)});
        }
    };
    vi.spyOn(database, '_insertResolvedImportTermEntries').mockImplementation(async (rows, offsets, lengths, _dictNames, start, count) => {
        captureRecords(rows, start, count, offsets, lengths);
        return {termRecordAppendMs: 0, termRecordEncodeMs: 0, termRecordWriteMs: 0, termsVtabInsertMs: 0};
    });
    vi.spyOn(recordStore, 'appendBatchFromImportTermEntriesResolvedContent').mockImplementation(async (rows, start, count, offsets, lengths) => {
        captureRecords(/** @type {Row[]} */ (rows), start, count, offsets, lengths);
        return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0};
    });
    const appendRows = async (/** @type {Row[]} */ rows) => {
        await Reflect.get(database, '_bulkAddTerms').call(database, rows, 0, rows.length);
    };
    return {database, importer, store, filesystem, records, appendRows};
}

/**
 * Two definitions per source make the dedup-on/off writers observably distinct.
 * Same-size banks deliberately reuse the native parser's previous allocation.
 * @param {string} definition
 * @returns {string}
 */
function sourceBank(definition) {
    return JSON.stringify(['猫', '犬'].map((expression) => [expression, expression, 'noun', 'v1', 1, [definition], 1, 'common']));
}

/**
 * @param {Uint8Array|null} bytes
 * @returns {{bytes: Uint8Array|null, hash: [number, number]|null}}
 */
function contentIdentity(bytes) {
    return {bytes, hash: bytes === null ? null : hashTermEntryContentBytesPair(bytes)};
}

describe('streamed term-bank content ownership', () => {
    test.each([
        {storageMode: /** @type {const} */ ('baseline'), dedup: true},
        {storageMode: /** @type {const} */ ('baseline'), dedup: false},
        {storageMode: /** @type {const} */ ('raw-bytes'), dedup: true},
    ])('retains exact buffered content across native parses: $storageMode, dedup=$dedup', async ({storageMode, dedup}) => {
        const {importer, store, filesystem, records, appendRows} = createHarness(storageMode, dedup);
        /** @type {Uint8Array|null} */
        let firstSourceView = null;
        try {
            await store.prepare();
            await store.beginImportSession();
            for (const [index, definition] of ['first', 'later'].entries()) {
                const file = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: `term_bank_${index + 1}.json`}));
                await importer._readTermBankFileFast(file, 3, 'Buffer ownership', false, storageMode === 'raw-bytes', dedup, storageMode, async (rows, requirements) => {
                    // The raw-byte control uses the real media row path with
                    // ordinary text, which retains borrowed parser views.
                    expect(requirements ?? []).toEqual([]);
                    for (const row of rows) {
                        const bytes = row.termEntryContentBytes;
                        if (!(bytes instanceof Uint8Array)) { throw new Error('Expected native parser content'); }
                        expect(JSON.parse(decoder.decode(bytes))).toStrictEqual({rules: 'v1', definitionTags: 'noun', termTags: 'common', glossary: [definition]});
                    }
                    if (index === 0) { firstSourceView = rows[0].termEntryContentBytes ?? null; }
                    await appendRows(rows);
                }, encoder.encode(sourceBank(definition)));
                expect(filesystem.write).not.toHaveBeenCalled();
            }
            expect(records).toHaveLength(4);
            expect(records[0].offset === records[1].offset).toBe(dedup);
            const overlays = await Promise.all(records.map(({offset, length}) => store.readSlice(offset, length)));
            await store.endImportSession();
            const persisted = filesystem.files.get(contentFileName);
            if (typeof persisted === 'undefined') { throw new Error('Expected persisted content'); }
            for (const [index, {offset, length, expected}] of records.entries()) {
                expect({
                    overlay: contentIdentity(overlays[index]),
                    persisted: contentIdentity(persisted.subarray(offset, offset + length)),
                }).toStrictEqual({overlay: contentIdentity(expected), persisted: contentIdentity(expected)});
            }
            if (storageMode === 'raw-bytes') {
                // Prove the control did not accidentally copy parser output;
                // owned storage slabs must survive this genuine source reuse.
                expect(firstSourceView).not.toEqual(records[0].expected);
            }
        } finally {
            await store.endImportSession();
        }
    });

    test.each([true, false])('publishes original definitions across source ZIP batches, dedup=%s', async (dedup) => {
        const {database, importer, store, filesystem, records, appendRows} = createHarness('baseline', dedup);
        const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
        await writer.add('index.json', new TextReader(JSON.stringify({title: 'Buffer ownership', format: 3, revision: '1'})), {useWebWorkers: false});
        for (let i = 0; i < 161; ++i) {
            await writer.add(`term_bank_${i + 1}.json`, new TextReader(sourceBank(i === 0 ? 'start' : (i <= 80 ? 'first' : 'later'))), {useWebWorkers: false});
        }
        const archive = new Uint8Array(await writer.close()).buffer;
        vi.spyOn(database, 'isPrepared').mockReturnValue(true);
        vi.spyOn(database, 'dictionaryExists').mockResolvedValue(false);
        vi.spyOn(database, 'addWithResult').mockResolvedValue(1);
        vi.spyOn(database, 'startBulkImport').mockImplementation(async () => {
            await store.beginImportSession();
            return 'buffer-ownership-session';
        });
        vi.spyOn(database, 'finishBulkImport').mockImplementation(async () => {
            await store.endImportSession();
            return {published: true, housekeepingErrors: []};
        });
        const abort = vi.spyOn(database, 'abortBulkImport').mockImplementation(async () => { await store.endImportSession(); });
        vi.spyOn(database, 'deleteDictionaryImportPlaceholder').mockResolvedValue();
        vi.spyOn(database, 'bulkAdd').mockImplementation(async (name, rows, start, count) => {
            expect(name).toBe('terms');
            await appendRows(/** @type {Row[]} */ (rows.slice(start, start + count)));
        });
        try {
            await store.prepare();
            const outcome = await importer.importDictionary(database, archive, {
                termContentStorageMode: 'baseline', enableTermEntryContentDedup: dedup, zipUseWebWorkers: false,
            });
            expect(outcome.errors).toEqual([]);
            expect(outcome.result).toMatchObject({importSuccess: true, counts: {terms: {total: 322}}});
            expect(abort).not.toHaveBeenCalled();
            expect(records).toHaveLength(322);
            const persisted = filesystem.files.get(contentFileName);
            if (typeof persisted === 'undefined') { throw new Error('Expected published content'); }
            for (const {offset, length, expected} of records) {
                expect(contentIdentity(persisted.subarray(offset, offset + length))).toStrictEqual(contentIdentity(expected));
            }
            expect(records.map(({offset, length}) => JSON.parse(decoder.decode(persisted.subarray(offset, offset + length))).glossary))
                .toEqual(['start', ...new Array(80).fill('first'), ...new Array(80).fill('later')].flatMap((definition) => [[definition], [definition]]));
        } finally {
            await store.endImportSession();
        }
    });
});
