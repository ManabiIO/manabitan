/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))));
});

/**
 * @param {number} format
 * @param {unknown[][]} banks
 * @param {boolean} imageFile
 * @returns {Promise<Uint8Array>}
 */
async function archive(format, banks, imageFile) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Source row contract', revision: '1', format})), options);
    for (const [index, rows] of banks.entries()) {
        await writer.add(`term_bank_${index + 1}.json`, new TextReader(JSON.stringify(rows)), options);
    }
    if (imageFile) { await writer.add('unused.png', new Uint8ArrayReader(Uint8Array.of(1, 2, 3)), options); }
    return Uint8Array.from(await writer.close());
}

function database() {
    /** @type {Array<{bytes: Uint8Array, dictName: string}>} */
    const payloads = [];
    return {
        payloads,
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: vi.fn(async () => 1),
        startBulkImport: vi.fn(async () => 'source-row-contract'),
        finishBulkImport: vi.fn(async () => ({})),
        abortBulkImport: vi.fn(async () => { payloads.length = 0; }),
        deleteDictionaryImportPlaceholder: vi.fn(async () => {}),
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        bulkAdd: vi.fn(async (/** @type {string} */ store, /** @type {import('dictionary-database').DatabaseTermEntry[]} */ rows, /** @type {number} */ start, /** @type {number} */ count) => {
            if (store !== 'terms') { return; }
            for (const row of rows.slice(start, start + count)) {
                expect(row.termEntryContentBytes).toBeInstanceOf(Uint8Array);
                payloads.push({bytes: Uint8Array.from(/** @type {Uint8Array} */ (row.termEntryContentBytes)), dictName: 'raw'});
            }
        }),
        bulkAddArtifactTermsChunk: vi.fn(async (/** @type {Parameters<DictionaryDatabase['bulkAddArtifactTermsChunk']>[0]} */ chunk) => {
            for (let i = 0; i < chunk.rowCount; ++i) {
                let bytes = chunk.contentBytesList[i];
                if (chunk.contentBytesBuffer instanceof Uint8Array && chunk.contentMetaList instanceof Uint32Array) {
                    const start = (chunk.contentBytesBaseOffset ?? 0) + chunk.contentMetaList[i * 4];
                    bytes = chunk.contentBytesBuffer.subarray(start, start + chunk.contentMetaList[i * 4 + 1]);
                }
                payloads.push({bytes: Uint8Array.from(bytes), dictName: chunk.uniformContentDictName ?? 'raw'});
            }
        }),
    };
}

/**
 * @param {ReturnType<typeof database>} db
 * @returns {Promise<import('dictionary-data').TermGlossary[][]>}
 */
async function readGlossaries(db) {
    const reader = new DictionaryDatabase();
    const mark = vi.spyOn(Reflect.get(reader, '_termRecordStore'), 'markDictionaryReimportRequired');
    vi.spyOn(reader, '_readTermEntryContentBytesDetailed').mockImplementation(async (offset) => ({status: 'ok', bytes: db.payloads[offset].bytes}));
    const glossaries = [];
    for (const [index, payload] of db.payloads.entries()) {
        const row = await reader._deserializeTermRow({
            id: index + 1,
            dictionary: 'Source row contract',
            expression: 'term',
            reading: 'term',
            entryContentOffset: index,
            entryContentLength: payload.bytes.byteLength,
            entryContentDictName: payload.dictName,
        });
        glossaries.push(row.glossary);
    }
    expect(mark).not.toHaveBeenCalled();
    return glossaries;
}

const malformedRows = [
    {name: 'missing term tags', row: ['term', '', '', '', 0, ['definition'], 1]},
    {name: 'missing sequence and term tags', row: ['term', '', '', '', 0, ['definition']]},
    {name: 'extra field', row: ['term', '', '', '', 0, ['definition'], 1, '', 'ignored']},
    {name: 'string glossary', row: ['term', '', '', '', 0, 'definition', 1, '']},
    {name: 'object glossary', row: ['term', '', '', '', 0, {type: 'text', text: 'definition'}, 1, '']},
    {name: 'null glossary', row: ['term', '', '', '', 0, null, 1, '']},
    {name: 'numeric glossary', row: ['term', '', '', '', 0, 1, 1, '']},
    {name: 'fractional sequence', row: ['term', '', '', '', 0, ['definition'], 1.5, '']},
    {name: 'unsafe positive sequence', row: ['term', '', '', '', 0, ['definition'], Number.MAX_SAFE_INTEGER + 1, '']},
    {name: 'unsafe negative sequence', row: ['term', '', '', '', 0, ['definition'], Number.MIN_SAFE_INTEGER - 1, '']},
];

describe('source ZIP term-row contract', () => {
    for (const slow of [false, true]) {
        for (const imageFile of [false, true]) {
            test(`keeps format 1 glossaries readable (slow=${slow}, images=${imageFile})`, async () => {
                const glossaries = [[], ['definition'], ['first', 'second'], ['last']];
                const banks = glossaries.map((glossary) => [['term', '', '', '', 0, ...glossary]]);
                const db = database();
                const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                importer._disableTermBankWasmFastPath = slow;
                const prewarm = vi.spyOn(parser, 'prewarmParallelTermBankParser').mockResolvedValue(false);
                try {
                    const result = await importer.importDictionary(
                        /** @type {DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                        new Blob([await archive(1, banks, imageFile)]),
                        /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata: true, zipUseWebWorkers: false}),
                    );
                    expect(result.errors).toEqual([]);
                    expect(result.result?.counts?.terms.total).toBe(4);
                    expect(await readGlossaries(db)).toEqual(glossaries);
                    expect(db.bulkAddArtifactTermsChunk).not.toHaveBeenCalled();
                    expect(prewarm).not.toHaveBeenCalled();
                } finally {
                    prewarm.mockRestore();
                }
            });

            test.each(malformedRows)(`rejects $name before publication (slow=${slow}, images=${imageFile})`, async ({row}) => {
                const db = database();
                const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
                importer._disableTermBankWasmFastPath = slow;
                const result = await importer.importDictionary(
                    /** @type {DictionaryDatabase} */ (/** @type {unknown} */ (db)),
                    new Blob([await archive(3, [[row]], imageFile)]),
                    /** @type {import('dictionary-importer').ImportDetails} */ ({skipImageMetadata: true, zipUseWebWorkers: false}),
                );
                expect(result.result).toBeNull();
                expect(result.errors.length).toBeGreaterThan(0);
                expect(db.payloads).toEqual([]);
                expect(db.finishBulkImport).not.toHaveBeenCalled();
                expect(db.abortBulkImport).toHaveBeenCalledOnce();
            });
        }
    }
});

for (const mode of ['rows', 'fused', 'fallback']) {
    test.each(malformedRows)(`strict native ${mode} rejects $name before dispatch`, async ({row}) => {
        const source = new TextEncoder().encode(JSON.stringify([row]));
        const first = new TextEncoder().encode('[["first","","","",1.5,["valid"],1,""]]');
        const sink = vi.fn();
        const options = {validateGlossaryTypes: true, emitContentSlab: true, emitTokenBinaryContent: true, singleChunk: true};
        const parsing = mode === 'rows' ?
            parser.parseTermBankWithWasmChunks(source, 3, sink, 8192, options) :
            parser.parseTermBankWithWasmColumnChunks(mode === 'fallback' ? [first, source] : source, 3, sink, 8192, options);
        await expect(parsing).rejects.toThrow();
        expect(sink).not.toHaveBeenCalled();
    });
}

test('keeps generic native object-glossary parsing permissive without source validation', async () => {
    const source = new TextEncoder().encode('[["term","","","",0,{"type":"text","text":"definition"},1,""]]');
    const sink = vi.fn();
    await parser.parseTermBankWithWasmColumnChunks(source, 3, sink, 8192, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true});
    expect(sink).toHaveBeenCalledOnce();
});
