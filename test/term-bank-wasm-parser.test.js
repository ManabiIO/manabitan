/*
 * Copyright (C) 2026 Manabitan authors
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

import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js';
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js';
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js';
import {decodeRawTermContentTokenBinary} from '../ext/js/dictionary/raw-term-content.js';
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    disposeParallelTermBankParser,
    getParallelTermBankParserWorkerCount,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    parseTermBankWithWasmColumnChunksParallel,
    parseTermBankWithWasmColumnChunksParallelCompressedLazy,
    parseTermBankWithWasmColumnChunksParallelDeferred,
    parseTermBankWithWasmColumnChunksParallelLazy,
    prewarmParallelTermBankParser,
    TermBankWasmResourceError,
} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const termBankParserWasmPath = path.resolve(__dirname, '../ext/lib/term-bank-parser.wasm');
const maybeTest = existsSync(termBankParserWasmPath) ? test : test.skip;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const nativeFetch = globalThis.fetch;
/** @typedef {{expression: string, reading: string, glossaryMayContainMedia?: boolean, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array, readingEqualsExpression?: boolean, readingBytes?: Uint8Array}} ParsedRow */

/**
 * @param {Map<string, Set<(event: MessageEvent<unknown>) => void>>} listeners
 * @param {unknown} data
 */
function emitWorkerMessage(listeners, data) {
    for (const listener of listeners.get('message') ?? []) {
        listener(/** @type {MessageEvent<unknown>} */ ({data}));
    }
}

/**
 * @param {Map<string, Set<(event: MessageEvent<unknown>) => void>>} listeners
 * @param {number} id
 */
function emitSuccessfulWorkerResult(listeners, id) {
    emitWorkerMessage(listeners, {
        type: 'result',
        id,
        rowCount: 1,
        resultSentEpochMs: Date.now(),
        chunk: {rowCount: 1},
        profile: {chunkDispatchMs: 0},
    });
}
/** @typedef {{strings: string[], stringLengths: number[], stringHashes: number[], stringOffsets: number[], expressionIndexes: number[], readingIndexes: number[], readingEqualsExpressionList: number[]}} TermStringPlanSnapshot */

/**
 * @param {Array<unknown>} rows
 * @param {Parameters<typeof parseTermBankWithWasmChunks>[4]} [options]
 * @returns {Promise<ParsedRow[]>}
 */
async function parseRows(rows, options = {}) {
    /** @type {ParsedRow[]} */
    const parsedRows = [];
    await parseTermBankWithWasmChunks(
        textEncoder.encode(JSON.stringify(rows)),
        3,
        (chunk) => { parsedRows.push(...chunk); },
        2,
        {copyContentBytes: true, mediaHintFastScan: true, ...options},
    );
    return parsedRows;
}

/**
 * @param {string} json
 * @returns {Promise<ParsedRow[]>}
 */
async function parseRowsJson(json) {
    /** @type {ParsedRow[]} */
    const parsedRows = [];
    await parseTermBankWithWasmChunks(
        textEncoder.encode(json),
        3,
        (chunk) => { parsedRows.push(...chunk); },
        2,
        {copyContentBytes: true, mediaHintFastScan: true},
    );
    return parsedRows;
}

/**
 * @param {{termEntryContentBytes: Uint8Array}} row
 * @returns {string}
 */
function getContentString(row) {
    return textDecoder.decode(row.termEntryContentBytes);
}

/**
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function getContentSignatures(bytes) {
    const read = (offset) => (
        (bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)
    ) >>> 0;
    const lastOffset = Math.max(0, bytes.byteLength - 4);
    return [read(0), read(Math.floor(lastOffset / 2)), read(lastOffset)];
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
const hashBytes = hashTermKeyBytes;

/**
 * @param {string} json
 * @param {0|8} compressionMethod
 * @returns {{bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number}}
 */
function createCompressedTermBankSource(json, compressionMethod) {
    const inflated = textEncoder.encode(json);
    const bytes = compressionMethod === 8 ? Uint8Array.from(deflateRawSync(inflated)) : Uint8Array.from(inflated);
    return {
        bytes,
        compressionMethod,
        compressedSize: bytes.byteLength,
        uncompressedSize: inflated.byteLength,
        signature: crc32(inflated) >>> 0,
    };
}

/**
 * @param {Uint8Array[]} sources
 * @param {Awaited<ReturnType<typeof inflateCompressedTermBankSourcesWasm>>|null} preloadedSource
 * @returns {Promise<object|null>}
 */
async function parseColumnSnapshot(sources, preloadedSource = null) {
    let copiedChunk = null;
    await parseTermBankWithWasmColumnChunks(
        preloadedSource === null ? sources : new Uint8Array(0),
        3,
        (chunk) => { copiedChunk = copyWasmBackedColumnChunk(chunk); },
        2048,
        {
            computeContentHashes: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            singleChunk: true,
            ...(preloadedSource === null ? {} : {preloadedSource}),
        },
    );
    if (copiedChunk === null) { return null; }
    const chunk = /** @type {NonNullable<typeof copiedChunk>} */ (copiedChunk);
    return {
        rowCount: chunk.rowCount,
        expressions: chunk.expressionBytesList.map((bytes) => textDecoder.decode(bytes)),
        readings: chunk.readingBytesList.map((bytes) => textDecoder.decode(bytes)),
        readingEqualsExpression: [...chunk.readingEqualsExpressionList],
        scores: [...chunk.scoreList],
        sequences: [...chunk.sequenceList],
        content: chunk.contentBytesList.map((bytes) => [...bytes]),
        contentHash1: [...chunk.contentHash1List],
        contentHash2: [...chunk.contentHash2List],
        contentUniqueIndexes: chunk.contentUniqueIndexList === null ? null : [...chunk.contentUniqueIndexList],
    };
}

describe('term-bank WASM parser', () => {
    beforeAll(() => {
        vi.stubGlobal('fetch', async (resource) => {
            const url = resource instanceof URL ? resource : new URL(String(resource));
            if (url.protocol === 'file:') {
                return new Response(await readFile(fileURLToPath(url)));
            }
            return await nativeFetch(resource);
        });
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    maybeTest('inflates, validates, and joins mixed raw ZIP term-bank payloads', async () => {
        const sources = [
            createCompressedTermBankSource(' \n [["a","", "", "", 1, ["one"], 10, ""]] \r', 8),
            createCompressedTermBankSource('\t[]\n', 0),
            createCompressedTermBankSource('[["b","び", "tag", "v1", -2, [{"type":"text","text":"two"}], 11, "common"]]', 8),
        ];
        const preloaded = await inflateCompressedTermBankSourcesWasm(sources);
        const joined = new Uint8Array(preloaded.wasm.memory.buffer, preloaded.jsonPtr, preloaded.jsonLength);

        expect(JSON.parse(textDecoder.decode(joined))).toEqual([
            ['a', '', '', '', 1, ['one'], 10, ''],
            ['b', 'び', 'tag', 'v1', -2, [{type: 'text', text: 'two'}], 11, 'common'],
        ]);
    });

    maybeTest('matches ordinary inflated parsing across every emitted column', async () => {
        const jsonSources = [
            JSON.stringify([
                ['食べる', 'たべる', 'v1', 'v1', 5, ['to eat'], 101, 'common'],
                ['同じ', '', '', '', 2, ['duplicate'], 102, ''],
            ]),
            '[]',
            JSON.stringify([
                ['同じ', '', '', '', 2, ['duplicate'], 102, ''],
                ['画像', 'がぞう', '', '', -1, [{type: 'image', path: 'image.png'}], 103, ''],
            ]),
        ];
        const inflated = jsonSources.map((json) => textEncoder.encode(json));
        const compressed = jsonSources.map((json, index) => createCompressedTermBankSource(json, index === 1 ? 0 : 8));
        const expected = await parseColumnSnapshot(inflated);
        const preloaded = await inflateCompressedTermBankSourcesWasm(compressed);
        const actual = await parseColumnSnapshot([], preloaded);

        expect(actual).toEqual(expected);
    });

    maybeTest.each([
        {
            name: 'CRC mismatch',
            mutate: (/** @type {ReturnType<typeof createCompressedTermBankSource>} */ source) => ({...source, signature: (source.signature + 1) >>> 0}),
            message: 'CRC32',
        },
        {
            name: 'uncompressed size mismatch',
            mutate: (/** @type {ReturnType<typeof createCompressedTermBankSource>} */ source) => ({...source, uncompressedSize: source.uncompressedSize + 1}),
            message: 'size does not match',
        },
        {
            name: 'truncated DEFLATE stream',
            mutate: (/** @type {ReturnType<typeof createCompressedTermBankSource>} */ source) => ({...source, bytes: source.bytes.slice(0, -2), compressedSize: source.compressedSize - 2}),
            message: 'DEFLATE decoding failed',
        },
        {
            name: 'DEFLATE stream with trailing bytes',
            mutate: (/** @type {ReturnType<typeof createCompressedTermBankSource>} */ source) => {
                const bytes = new Uint8Array(source.bytes.byteLength + 2);
                bytes.set(source.bytes);
                bytes.set([0xde, 0xad], source.bytes.byteLength);
                return {...source, bytes, compressedSize: bytes.byteLength};
            },
            message: 'trailing bytes',
        },
    ])('rejects a $name', async ({mutate, message}) => {
        const source = createCompressedTermBankSource('[["a","","","",0,["x"],1,""]]', 8);
        await expect(inflateCompressedTermBankSourcesWasm([mutate(source)])).rejects.toThrow(message);
    });

    maybeTest('rejects inflated JSON which is not an array', async () => {
        const source = createCompressedTermBankSource('{"term":"a"}', 8);
        await expect(inflateCompressedTermBankSourcesWasm([source])).rejects.toThrow('not a JSON array');
    });

    test('copies every WASM-backed column before a parser heap can be reused', () => {
        const heap = new Uint8Array(512);
        const expressionBytesList = [heap.subarray(8, 11), heap.subarray(12, 15)];
        const readingBytesList = [heap.subarray(16, 19), heap.subarray(20, 23)];
        expressionBytesList[0].set([1, 2, 3]);
        expressionBytesList[1].set([4, 5, 6]);
        readingBytesList[0].set([7, 8, 9]);
        readingBytesList[1].set([10, 11, 12]);
        const readingEqualsExpressionList = new Uint8Array(heap.buffer, 24, 2);
        readingEqualsExpressionList.set([0, 1]);
        const scoreList = new Int32Array(heap.buffer, 28, 2);
        scoreList.set([-4, 8]);
        const sequenceList = new Int32Array(heap.buffer, 36, 2);
        sequenceList.set([100, 200]);
        const contentHash1List = new Uint32Array(heap.buffer, 44, 2);
        contentHash1List.set([101, 102]);
        const contentHash2List = new Uint32Array(heap.buffer, 52, 2);
        contentHash2List.set([201, 202]);
        const contentMetaList = new Uint32Array(heap.buffer, 60, 8);
        contentMetaList.set([0, 3, 101, 201, 3, 2, 102, 202]);
        const contentUniqueIndexList = new Uint32Array(heap.buffer, 92, 2);
        contentUniqueIndexList.set([0, 1]);
        const stringLengths = new Uint16Array(heap.buffer, 100, 2);
        stringLengths.set([3, 3]);
        const stringOffsets = new Uint32Array(heap.buffer, 104, 2);
        stringOffsets.set([0, 3]);
        const stringHashes = new Uint32Array(heap.buffer, 112, 2);
        stringHashes.set([301, 302]);
        const stringsBuffer = heap.subarray(120, 126);
        stringsBuffer.set([13, 14, 15, 16, 17, 18]);
        const expressionIndexes = new Uint32Array(heap.buffer, 128, 2);
        expressionIndexes.set([0, 1]);
        const readingIndexes = new Uint32Array(heap.buffer, 136, 2);
        readingIndexes.set([1, 0]);
        heap.set([31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42], 160);
        heap.set([21, 22, 23, 24, 25], 256);

        const copy = copyWasmBackedColumnChunk({
            rowCount: 2,
            expressionBytesList,
            readingBytesList,
            readingEqualsExpressionList,
            scoreList,
            sequenceList,
            contentBytesList: [heap.subarray(256, 259), heap.subarray(259, 261)],
            contentHash1List,
            contentHash2List,
            contentBytesBuffer: heap,
            contentBytesBaseOffset: 256,
            contentMetaList,
            contentUniqueIndexList,
            contentDedupPlan: null,
            termRecordPreinternedPlan: {
                stringLengths,
                stringOffsets,
                stringHashes,
                stringsBuffer,
                expressionIndexes,
                readingIndexes,
            },
            mediaRows: [{
                index: 1,
                row: {
                    expression: '',
                    reading: '',
                    expressionBytes: heap.subarray(160, 163),
                    readingBytes: heap.subarray(163, 166),
                    readingEqualsExpression: false,
                    definitionTags: '',
                    rules: '',
                    score: 0,
                    glossaryJson: '[]',
                    glossaryJsonBytes: heap.subarray(166, 169),
                    glossaryMayContainMedia: true,
                    sequence: null,
                    termTags: '',
                    termEntryContentBytes: heap.subarray(169, 172),
                },
            }],
        }, true);

        heap.fill(0);
        expect(copy.contentBytesBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);
        expect(copy.expressionBytesList.map((value) => [...value])).toStrictEqual([[1, 2, 3], [4, 5, 6]]);
        expect(copy.readingBytesList.map((value) => [...value])).toStrictEqual([[7, 8, 9], [10, 11, 12]]);
        expect([...copy.readingEqualsExpressionList]).toStrictEqual([0, 1]);
        expect([...copy.scoreList]).toStrictEqual([-4, 8]);
        expect([...copy.sequenceList]).toStrictEqual([100, 200]);
        expect(copy.contentBytesList.map((value) => [...value])).toStrictEqual([[21, 22, 23], [24, 25]]);
        expect([...copy.contentHash1List]).toStrictEqual([101, 102]);
        expect([...copy.contentHash2List]).toStrictEqual([201, 202]);
        expect([...copy.contentBytesBuffer]).toStrictEqual([21, 22, 23, 24, 25]);
        expect([...copy.contentMetaList]).toStrictEqual([0, 3, 101, 201, 3, 2, 102, 202]);
        expect([...copy.contentUniqueIndexList]).toStrictEqual([0, 1]);
        expect([...copy.termRecordPreinternedPlan.stringLengths]).toStrictEqual([3, 3]);
        expect([...copy.termRecordPreinternedPlan.stringOffsets]).toStrictEqual([0, 3]);
        expect([...copy.termRecordPreinternedPlan.stringHashes]).toStrictEqual([301, 302]);
        expect([...copy.termRecordPreinternedPlan.stringsBuffer]).toStrictEqual([13, 14, 15, 16, 17, 18]);
        expect([...copy.termRecordPreinternedPlan.expressionIndexes]).toStrictEqual([0, 1]);
        expect([...copy.termRecordPreinternedPlan.readingIndexes]).toStrictEqual([1, 0]);
        expect(copy.mediaRows).toHaveLength(1);
        expect([...copy.mediaRows[0].row.expressionBytes]).toStrictEqual([31, 32, 33]);
        expect([...copy.mediaRows[0].row.readingBytes]).toStrictEqual([34, 35, 36]);
        expect([...copy.mediaRows[0].row.glossaryJsonBytes]).toStrictEqual([37, 38, 39]);
        expect([...copy.mediaRows[0].row.termEntryContentBytes]).toStrictEqual([40, 41, 42]);
    });

    test('borrows an exact shared content span while copying mutable metadata', () => {
        const heap = new Uint8Array(new SharedArrayBuffer(128));
        heap.set([1, 2, 3, 4], 64);
        const contentMetaList = new Uint32Array(heap.buffer, 8, 8);
        contentMetaList.set([0, 2, 11, 12, 2, 2, 13, 14]);
        const result = copyWasmBackedColumnChunk({
            rowCount: 2,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList: new Uint8Array(2),
            scoreList: new Int32Array(2),
            sequenceList: new Int32Array(2),
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: heap,
            contentBytesBaseOffset: 64,
            contentMetaList,
            contentUniqueIndexList: new Uint32Array([0, 1]),
            contentDedupPlan: null,
            termRecordPreinternedPlan: {
                stringLengths: new Uint16Array(0),
                stringOffsets: new Uint32Array(0),
                stringHashes: new Uint32Array(0),
                stringsBuffer: new Uint8Array(0),
                expressionIndexes: new Uint32Array(2),
                readingIndexes: new Uint32Array(2),
            },
            mediaRows: [],
        }, true);

        expect(result.contentBytesBuffer?.buffer).toBe(heap.buffer);
        expect(result.contentBytesBuffer?.byteOffset).toBe(64);
        expect([...result.contentBytesBuffer]).toStrictEqual([1, 2, 3, 4]);
        expect(result.contentMetaList?.buffer).not.toBe(heap.buffer);
    });

    test('owns record metadata while borrowing only the explicitly fenced content slab', () => {
        const heap = new Uint8Array(new SharedArrayBuffer(256));
        heap.set([1, 2, 3, 4], 192);
        const contentMetaList = new Uint32Array(heap.buffer, 8, 8);
        contentMetaList.set([0, 2, 11, 12, 2, 2, 13, 14]);
        const readingEqualsExpressionList = new Uint8Array(heap.buffer, 48, 2);
        const scoreList = new Int32Array(heap.buffer, 52, 2);
        const sequenceList = new Int32Array(heap.buffer, 60, 2);
        const contentUniqueIndexList = new Uint32Array(heap.buffer, 68, 2);
        const stringLengths = new Uint16Array(heap.buffer, 76, 2);
        const stringOffsets = new Uint32Array(heap.buffer, 80, 2);
        const stringHashes = new Uint32Array(heap.buffer, 88, 2);
        const stringsBuffer = heap.subarray(96, 100);
        const expressionIndexes = new Uint32Array(heap.buffer, 100, 2);
        const readingIndexes = new Uint32Array(heap.buffer, 108, 2);
        readingEqualsExpressionList.set([0, 1]);
        scoreList.set([-123456789, 987654321]);
        sequenceList.set([101, -1]);
        contentUniqueIndexList.set([7, 8]);
        stringLengths.set([1, 3]);
        stringOffsets.set([0, 1]);
        stringHashes.set([0x11223344, 0xaabbccdd]);
        stringsBuffer.set([10, 20, 30, 40]);
        expressionIndexes.set([0, 1]);
        readingIndexes.set([1, 0]);
        const result = copyWasmBackedColumnChunk({
            rowCount: 2,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList,
            scoreList,
            sequenceList,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: heap,
            contentBytesBaseOffset: 192,
            contentMetaList,
            contentUniqueIndexList,
            contentDedupPlan: null,
            termRecordPreinternedPlan: {
                stringLengths,
                stringOffsets,
                stringHashes,
                stringsBuffer,
                expressionIndexes,
                readingIndexes,
            },
            mediaRows: [],
        }, true);

        for (const view of [
            result.contentMetaList,
            result.readingEqualsExpressionList,
            result.scoreList,
            result.sequenceList,
            result.contentUniqueIndexList,
            result.termRecordPreinternedPlan.stringLengths,
            result.termRecordPreinternedPlan.stringOffsets,
            result.termRecordPreinternedPlan.stringHashes,
            result.termRecordPreinternedPlan.stringsBuffer,
            result.termRecordPreinternedPlan.expressionIndexes,
            result.termRecordPreinternedPlan.readingIndexes,
        ]) {
            expect(view?.buffer).not.toBe(heap.buffer);
        }
        heap.fill(0xff);
        expect([...result.contentBytesBuffer]).toStrictEqual([255, 255, 255, 255]);
        expect([...result.contentMetaList]).toStrictEqual([0, 2, 11, 12, 2, 2, 13, 14]);
        expect([...result.readingEqualsExpressionList]).toStrictEqual([0, 1]);
        expect([...result.scoreList]).toStrictEqual([-123456789, 987654321]);
        expect([...result.sequenceList]).toStrictEqual([101, -1]);
        expect([...result.contentUniqueIndexList]).toStrictEqual([7, 8]);
        expect([...result.termRecordPreinternedPlan.stringLengths]).toStrictEqual([1, 3]);
        expect([...result.termRecordPreinternedPlan.stringOffsets]).toStrictEqual([0, 1]);
        expect([...result.termRecordPreinternedPlan.stringHashes]).toStrictEqual([0x11223344, 0xaabbccdd]);
        expect([...result.termRecordPreinternedPlan.stringsBuffer]).toStrictEqual([10, 20, 30, 40]);
        expect([...result.termRecordPreinternedPlan.expressionIndexes]).toStrictEqual([0, 1]);
        expect([...result.termRecordPreinternedPlan.readingIndexes]).toStrictEqual([1, 0]);
    });

    test('copies fenced metadata from an unrelated shared buffer', () => {
        const contentHeap = new Uint8Array(new SharedArrayBuffer(128));
        contentHeap.set([1, 2, 3, 4], 96);
        const metadataHeap = new Uint8Array(new SharedArrayBuffer(128));
        const contentMetaList = new Uint32Array(metadataHeap.buffer, 8, 8);
        contentMetaList.set([0, 2, 11, 12, 2, 2, 13, 14]);
        const readingEqualsExpressionList = new Uint8Array(metadataHeap.buffer, 48, 2);
        readingEqualsExpressionList.set([0, 1]);
        const result = copyWasmBackedColumnChunk({
            rowCount: 2,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList,
            scoreList: new Int32Array(metadataHeap.buffer, 52, 2),
            sequenceList: new Int32Array(metadataHeap.buffer, 60, 2),
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: contentHeap,
            contentBytesBaseOffset: 96,
            contentMetaList,
            contentUniqueIndexList: new Uint32Array(metadataHeap.buffer, 68, 2),
            contentDedupPlan: null,
            termRecordPreinternedPlan: {
                stringLengths: new Uint16Array(metadataHeap.buffer, 76, 2),
                stringOffsets: new Uint32Array(metadataHeap.buffer, 80, 2),
                stringHashes: new Uint32Array(metadataHeap.buffer, 88, 2),
                stringsBuffer: metadataHeap.subarray(96, 100),
                expressionIndexes: new Uint32Array(metadataHeap.buffer, 100, 2),
                readingIndexes: new Uint32Array(metadataHeap.buffer, 108, 2),
            },
            mediaRows: [],
        }, true, true);

        expect(result.contentBytesBuffer?.buffer).toBe(contentHeap.buffer);
        for (const view of [
            result.contentMetaList,
            result.readingEqualsExpressionList,
            result.scoreList,
            result.sequenceList,
            result.contentUniqueIndexList,
            result.termRecordPreinternedPlan.stringLengths,
            result.termRecordPreinternedPlan.stringOffsets,
            result.termRecordPreinternedPlan.stringHashes,
            result.termRecordPreinternedPlan.stringsBuffer,
            result.termRecordPreinternedPlan.expressionIndexes,
            result.termRecordPreinternedPlan.readingIndexes,
        ]) {
            expect(view?.buffer).not.toBe(metadataHeap.buffer);
        }
        contentMetaList[0] = 1;
        readingEqualsExpressionList[0] = 1;
        expect(result.contentMetaList?.[0]).toBe(0);
        expect(result.readingEqualsExpressionList[0]).toBe(0);
    });

    test.each([
        [{hardwareConcurrency: 12, deviceMemory: 8}, 5],
        [{hardwareConcurrency: 12, deviceMemory: 4}, 2],
        [{hardwareConcurrency: 4, deviceMemory: 8}, 2],
        [{}, 2],
    ])('selects parser worker count from browser capability: %j', (navigatorValue, expected) => {
        const originalNavigator = globalThis.navigator;
        try {
            vi.stubGlobal('navigator', navigatorValue);
            expect(getParallelTermBankParserWorkerCount()).toBe(expected);
        } finally {
            vi.stubGlobal('navigator', originalNavigator);
        }
    });

    maybeTest('deduplicates concurrent parallel parser prewarm calls', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let constructionCount = 0;
        let terminateCount = 0;
        class ReadyWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
                ++constructionCount;
            }

            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            /** @param {{type: string, id?: number}} message */
            postMessage(message) {
                if (message.type !== 'initialize') { return; }
                queueMicrotask(() => emitWorkerMessage(this.listeners, {type: 'ready'}));
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', ReadyWorker);
        try {
            await expect(Promise.all([
                prewarmParallelTermBankParser(),
                prewarmParallelTermBankParser(),
                prewarmParallelTermBankParser(),
            ])).resolves.toStrictEqual([true, true, true]);
            expect(constructionCount).toBe(workerCount);
            await disposeParallelTermBankParser();
            expect(terminateCount).toBe(workerCount);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('does not recreate a prewarm generation ordered before a later disposal', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let constructionCount = 0;
        let terminateCount = 0;
        /** @type {() => void} */
        let markInitialWorkersCreated;
        const initialWorkersCreated = new Promise((resolve) => { markInitialWorkersCreated = resolve; });
        class GenerationWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
                this.generation = Math.floor(constructionCount / workerCount);
                ++constructionCount;
                if (constructionCount === workerCount) { markInitialWorkersCreated(); }
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                if (message.type === 'initialize' && this.generation > 0) {
                    queueMicrotask(() => emitWorkerMessage(this.listeners, {type: 'ready'}));
                }
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', GenerationWorker);
        try {
            const obsoletePrewarm = prewarmParallelTermBankParser();
            await initialWorkersCreated;
            const firstDisposal = disposeParallelTermBankParser();
            const stalePrewarm = prewarmParallelTermBankParser();
            const laterDisposal = disposeParallelTermBankParser();

            await expect(obsoletePrewarm).resolves.toBe(false);
            await Promise.all([firstDisposal, laterDisposal]);
            await expect(stalePrewarm).resolves.toBe(false);
            expect(constructionCount).toBe(workerCount);
            expect(terminateCount).toBe(workerCount);

            await expect(prewarmParallelTermBankParser()).resolves.toBe(true);
            expect(constructionCount).toBe(workerCount * 2);
            await disposeParallelTermBankParser();
            expect(terminateCount).toBe(workerCount * 2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('allows serial fallback after parallel parser resource pressure', async () => {
        class ResourceFailingWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                if (!this.listeners.has(type)) { this.listeners.set(type, new Set()); }
                this.listeners.get(type).add(listener);
            }

            removeEventListener(type, listener) {
                const listeners = this.listeners.get(type);
                if (typeof listeners !== 'undefined') { listeners.delete(listener); }
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        this.emit('message', {type: 'ready'});
                    } else if (message.type === 'parse') {
                        this.emit('message', {
                            type: 'parse-error',
                            id: message.id,
                            error: {name: 'TermBankWasmResourceError', message: 'mock allocation failure'},
                        });
                    }
                });
            }

            terminate() {}

            emit(type, data) {
                for (const listener of this.listeners.get(type) ?? []) {
                    listener(/** @type {MessageEvent<unknown>} */ ({data}));
                }
            }
        }

        vi.stubGlobal('Worker', ResourceFailingWorker);
        try {
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            let sinkCalls = 0;
            const result = parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => { ++sinkCalls; },
                {emitContentSlab: true},
            );
            await expect(result).rejects.toSatisfy((error) => (
                error instanceof Error &&
                !(error instanceof TermBankWasmResourceError) &&
                /Parallel term-bank parser exceeded its resource budget/.test(error.message)
            ));
            expect(sinkCalls).toBe(0);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('reuses successful parser workers until import cleanup', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let constructionCount = 0;
        let parseCount = 0;
        let terminateCount = 0;
        class SuccessfulWorker {
            constructor() {
                ++constructionCount;
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                const listeners = this.listeners.get(type);
                if (typeof listeners !== 'undefined') { listeners.delete(listener); }
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    ++parseCount;
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 0,
                        resultSentEpochMs: Date.now(),
                        chunk: {rowCount: 0},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', SuccessfulWorker);
        try {
            for (let batch = 0; batch < 2; ++batch) {
                const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
                await expect(parseTermBankWithWasmColumnChunksParallel(
                    sourceBanks,
                    3,
                    () => {},
                    {emitContentSlab: true},
                )).resolves.toBe(true);
            }
            expect(constructionCount).toBe(workerCount);
            expect(parseCount).toBe(8);
            expect(terminateCount).toBe(0);
            await disposeParallelTermBankParser();
            expect(terminateCount).toBe(workerCount);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('uses shallower parallel grouping for media-aware term banks', async () => {
        const originalNavigator = globalThis.navigator;
        let parseCount = 0;
        class SuccessfulWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            /**
             * @param {string} type
             * @param {(event: MessageEvent<unknown>) => void} listener
             */
            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            /** @param {{type: string, id?: number}} message */
            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    ++parseCount;
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('navigator', {hardwareConcurrency: 12, deviceMemory: 8});
        vi.stubGlobal('Worker', SuccessfulWorker);
        try {
            const workerCount = getParallelTermBankParserWorkerCount();
            const sourceBanks = Array.from({length: workerCount * 4}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks.map((bytes) => new Uint8Array(bytes)),
                3,
                () => {},
                {emitContentSlab: true},
            )).resolves.toBe(true);
            const plainProfile = consumeLastTermBankWasmParseProfile();
            expect(plainProfile).toMatchObject({
                parallelWorkerCount: workerCount,
                parallelPipelineGroupsPerWorker: 4,
                parallelGroupCount: workerCount * 4,
            });
            expect(parseCount).toBe(workerCount * 4);

            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks.map((bytes) => new Uint8Array(bytes)),
                3,
                () => {},
                {emitContentSlab: true, mediaHintFastScan: true},
            )).resolves.toBe(true);
            const mediaProfile = consumeLastTermBankWasmParseProfile();
            expect(mediaProfile).toMatchObject({
                parallelWorkerCount: workerCount,
                parallelPipelineGroupsPerWorker: 3,
                parallelGroupCount: workerCount * 3,
            });
            expect(parseCount).toBe(workerCount * 7);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('navigator', originalNavigator);
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('assigns the next parser group to the first idle worker', async () => {
        const originalNavigator = globalThis.navigator;
        let workerIndex = 0;
        /** @type {number[]} */
        let parseCounts = [];
        class SkewedWorker {
            constructor() {
                this.index = workerIndex++;
                this.delay = this.index === 0 ? 20 : 0;
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                if (message.type === 'initialize') {
                    queueMicrotask(() => { emitWorkerMessage(this.listeners, {type: 'ready'}); });
                    return;
                }
                ++parseCounts[this.index];
                setTimeout(() => {
                    emitSuccessfulWorkerResult(this.listeners, message.id);
                }, this.delay);
            }

            terminate() {}
        }

        vi.stubGlobal('navigator', {hardwareConcurrency: 12, deviceMemory: 8});
        parseCounts = Array.from({length: getParallelTermBankParserWorkerCount()}, () => 0);
        vi.stubGlobal('Worker', SkewedWorker);
        try {
            const sourceBanks = Array.from({length: 12}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => {},
                {emitContentSlab: true},
            )).resolves.toBe(true);
            expect(parseCounts.reduce((sum, count) => sum + count, 0)).toBe(12);
            for (let index = 1; index < parseCounts.length; ++index) {
                expect(parseCounts[0]).toBeLessThan(parseCounts[index]);
            }
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('navigator', originalNavigator);
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('defers disposal until an active parallel run releases ownership', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let terminateCount = 0;
        class SuccessfulWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    emitSuccessfulWorkerResult(this.listeners, message.id);
                });
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', SuccessfulWorker);
        /** @type {() => void} */
        let releaseSink;
        const sinkGate = new Promise((resolve) => { releaseSink = resolve; });
        /** @type {() => void} */
        let markSinkStarted;
        const sinkStarted = new Promise((resolve) => { markSinkStarted = resolve; });
        try {
            const sourceBanks = Array.from({length: workerCount * 2}, () => textEncoder.encode('[]'));
            const parsing = parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                async (_chunk, progress) => {
                    if (progress.chunkIndex !== 1) { return; }
                    markSinkStarted();
                    await sinkGate;
                },
                {emitContentSlab: true},
            );
            await sinkStarted;
            const stalePrewarm = prewarmParallelTermBankParser();
            let disposalSettled = false;
            const disposal = disposeParallelTermBankParser().then(() => { disposalSettled = true; });
            const nextPrewarm = prewarmParallelTermBankParser();
            await Promise.resolve();
            expect(disposalSettled).toBe(false);
            expect(terminateCount).toBe(0);

            releaseSink();
            await expect(parsing).resolves.toBe(true);
            await expect(stalePrewarm).resolves.toBe(false);
            await disposal;
            await expect(nextPrewarm).resolves.toBe(true);
            expect(disposalSettled).toBe(true);
            expect(terminateCount).toBe(workerCount);
            await disposeParallelTermBankParser();
            expect(terminateCount).toBe(workerCount * 2);
        } finally {
            releaseSink();
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('creates a fresh worker pool after a failed parallel run', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let constructionCount = 0;
        let failNextParse = true;
        class FailOnceWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
                constructionCount += 1;
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    if (failNextParse) {
                        failNextParse = false;
                        emitWorkerMessage(this.listeners, {
                            type: 'parse-error',
                            id: message.id,
                            error: {message: 'injected one-time parse failure'},
                        });
                        return;
                    }
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 0,
                        resultSentEpochMs: Date.now(),
                        chunk: {rowCount: 0},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', FailOnceWorker);
        try {
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => {},
                {emitContentSlab: true},
            )).rejects.toThrow('injected one-time parse failure');
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => {},
                {emitContentSlab: true},
            )).resolves.toBe(true);
            expect(constructionCount).toBe(workerCount * 2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('rejects malformed single-result worker metadata without stalling peers', async () => {
        const cases = [
            {
                result: {rowCount: -1, resultSentEpochMs: Date.now(), chunk: {rowCount: 0}},
                error: 'invalid row count',
            },
            {
                result: {rowCount: 0, resultSentEpochMs: null, chunk: {rowCount: 0}},
                error: 'invalid result timestamp',
            },
            {
                result: {rowCount: 2, resultSentEpochMs: Date.now(), chunk: {rowCount: 1}},
                error: 'row count changed during result transfer',
            },
        ];
        for (const {result, error} of cases) {
            class MalformedWorker {
                constructor() {
                    /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                    this.listeners = new Map();
                }

                addEventListener(type, listener) {
                    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
                }

                removeEventListener(type, listener) {
                    this.listeners.get(type)?.delete(listener);
                }

                postMessage(message) {
                    queueMicrotask(() => {
                        if (message.type === 'initialize') {
                            emitWorkerMessage(this.listeners, {type: 'ready'});
                            return;
                        }
                        emitWorkerMessage(this.listeners, {
                            type: 'result',
                            id: message.id,
                            ...result,
                            profile: {chunkDispatchMs: 0},
                        });
                    });
                }

                terminate() {}
            }

            vi.stubGlobal('Worker', MalformedWorker);
            try {
                const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
                await expect(parseTermBankWithWasmColumnChunksParallel(
                    sourceBanks,
                    3,
                    () => {},
                    {emitContentSlab: true},
                )).rejects.toThrow(error);
            } finally {
                await disposeParallelTermBankParser();
                vi.stubGlobal('Worker', void 0);
            }
        }
    });

    maybeTest('streams archive-ordered results while later workers finish output', async () => {
        let workerIndex = 0;
        /** @type {() => void} */
        let releaseSecondResult;
        const secondResultGate = new Promise((resolve) => { releaseSecondResult = resolve; });
        let fallbackReleasedSecondResult = false;
        let firstSinkPrecededSecondParse = false;
        const fallbackTimeout = setTimeout(() => {
            fallbackReleasedSecondResult = true;
            releaseSecondResult();
        }, 100);
        class StagedWorker {
            constructor() {
                this.index = workerIndex++;
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message, transfer = []) {
                const dispatchedMessage = structuredClone(message, {transfer});
                queueMicrotask(() => {
                    if (dispatchedMessage.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    if (this.index === 0) {
                        emitSuccessfulWorkerResult(this.listeners, dispatchedMessage.id);
                    } else {
                        void secondResultGate.then(() => {
                            emitSuccessfulWorkerResult(this.listeners, dispatchedMessage.id);
                        });
                    }
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', StagedWorker);
        try {
            const progress = [];
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                (_chunk, value) => {
                    progress.push(value);
                    if (value.chunkIndex === 1) {
                        firstSinkPrecededSecondParse = !fallbackReleasedSecondResult;
                        releaseSecondResult();
                    }
                },
                {emitContentSlab: true},
            )).resolves.toBe(true);
            expect(firstSinkPrecededSecondParse).toBe(true);
            expect(progress).toStrictEqual([
                {processedRows: 1, totalRows: 4, chunkIndex: 1, chunkCount: 4},
                {processedRows: 2, totalRows: 4, chunkIndex: 2, chunkCount: 4},
                {processedRows: 3, totalRows: 4, chunkIndex: 3, chunkCount: 4},
                {processedRows: 4, totalRows: 4, chunkIndex: 4, chunkCount: 4},
            ]);
        } finally {
            clearTimeout(fallbackTimeout);
            releaseSecondResult();
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('streams early groups while later ZIP sources are unresolved', async () => {
        class SuccessfulWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', SuccessfulWorker);
        /** @type {() => void} */
        let releaseLaterSources;
        const laterSources = new Promise((resolve) => { releaseLaterSources = resolve; });
        /** @type {() => void} */
        let resolveFirstSink;
        const firstSink = new Promise((resolve) => { resolveFirstSink = resolve; });
        try {
            const emptyBank = textEncoder.encode('[]');
            const sourcePromises = [
                Promise.resolve(new Uint8Array(emptyBank)),
                Promise.resolve(new Uint8Array(emptyBank)),
                laterSources.then(() => new Uint8Array(emptyBank)),
                laterSources.then(() => new Uint8Array(emptyBank)),
            ];
            const sinkIndexes = [];
            const parsing = parseTermBankWithWasmColumnChunksParallelDeferred(
                sourcePromises,
                sourcePromises.map(() => emptyBank.byteLength),
                3,
                (_chunk, progress) => {
                    sinkIndexes.push(progress.chunkIndex);
                    resolveFirstSink();
                },
                {emitContentSlab: true},
            );
            await firstSink;
            expect(sinkIndexes.length).toBeGreaterThan(0);
            expect(Math.max(...sinkIndexes)).toBeLessThanOrEqual(2);
            releaseLaterSources();
            await expect(parsing).resolves.toBe(true);
            expect(sinkIndexes).toStrictEqual([1, 2, 3, 4]);
        } finally {
            releaseLaterSources();
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('does not reuse borrowed worker memory before the ordered sink consumes it', async () => {
        const workerCount = getParallelTermBankParserWorkerCount();
        let parseCount = 0;
        const sharedContent = new Uint8Array(new SharedArrayBuffer(1));
        class BorrowingWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                const respond = () => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    ++parseCount;
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        borrowsWorkerMemory: false,
                        chunk: {rowCount: 1, contentBytesBuffer: sharedContent},
                        profile: {chunkDispatchMs: 0},
                    });
                };
                queueMicrotask(respond);
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', BorrowingWorker);
        let releaseFirstSink = () => {};
        const firstSinkGate = new Promise((resolve) => { releaseFirstSink = resolve; });
        let firstSinkStarted = () => {};
        const firstSinkStart = new Promise((resolve) => { firstSinkStarted = resolve; });
        try {
            const sourceBanks = Array.from({length: workerCount * 4}, () => textEncoder.encode('[]'));
            const parsing = parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                async (_chunk, progress) => {
                    if (progress.chunkIndex !== 1) { return; }
                    firstSinkStarted();
                    await firstSinkGate;
                },
                {emitContentSlab: true},
            );
            await firstSinkStart;
            await new Promise((resolve) => { setTimeout(resolve, 10); });
            expect(parseCount).toBe(workerCount);
            releaseFirstSink();
            await expect(parsing).resolves.toBe(true);
            expect(parseCount).toBe(workerCount * 4);
        } finally {
            releaseFirstSink();
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('bounds lazy source loading while the ordered sink is blocked', async () => {
        class SuccessfulWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                if (typeof message?.type !== 'string') { return; }
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        borrowsWorkerMemory: true,
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', SuccessfulWorker);
        /** @type {() => void} */
        let releaseSink;
        const sinkGate = new Promise((resolve) => { releaseSink = resolve; });
        let loadCount = 0;
        try {
            const sourceCount = 24;
            const emptyBank = textEncoder.encode('[]');
            const parsing = parseTermBankWithWasmColumnChunksParallelLazy(
                Array.from({length: sourceCount}, () => async () => {
                    ++loadCount;
                    return new Uint8Array(emptyBank);
                }),
                Array.from({length: sourceCount}, () => 24 * 1024 * 1024),
                3,
                async (_chunk, progress) => {
                    if (progress.chunkIndex === 1) { await sinkGate; }
                },
                {emitContentSlab: true},
            );
            await vi.waitFor(() => { expect(loadCount).toBeGreaterThan(0); });
            await new Promise((resolve) => { setTimeout(resolve, 25); });
            expect(loadCount).toBeLessThan(sourceCount);
            expect(loadCount).toBeLessThanOrEqual(getParallelTermBankParserWorkerCount() * 4);
            releaseSink();
            await expect(parsing).resolves.toBe(true);
            expect(loadCount).toBe(sourceCount);
        } finally {
            releaseSink();
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('transfers compressed sources with aligned metadata in deterministic order', async () => {
        const parseMessages = [];
        class SuccessfulWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message, transfer = []) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    const delivered = structuredClone(message, {transfer});
                    parseMessages.push(delivered);
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: delivered.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', SuccessfulWorker);
        const loadedSources = [];
        try {
            const sourceCount = 4;
            const sinkIndexes = [];
            await expect(parseTermBankWithWasmColumnChunksParallelCompressedLazy(
                Array.from({length: sourceCount}, (_, index) => async () => {
                    const source = createCompressedTermBankSource('[]', index === 0 ? 0 : 8);
                    loadedSources.push(source);
                    return {...source, filename: `term_bank_${index + 1}.json`};
                }),
                Array.from({length: sourceCount}, () => 2),
                3,
                (_chunk, progress) => { sinkIndexes.push(progress.chunkIndex); },
                {emitContentSlab: true},
            )).resolves.toBe(true);

            expect(parseMessages).toHaveLength(sourceCount);
            expect(parseMessages.map(({sourceMetadata}) => sourceMetadata[0].filename)).toEqual(
                Array.from({length: sourceCount}, (_, index) => `term_bank_${index + 1}.json`),
            );
            expect(parseMessages.every(({sourceBuffers, sourceMetadata}) => (
                sourceBuffers.length === 1 &&
                sourceMetadata.length === 1 &&
                sourceBuffers[0].byteLength === sourceMetadata[0].compressedSize
            ))).toBe(true);
            expect(loadedSources.every(({bytes}) => bytes.byteLength === 0)).toBe(true);
            expect(sinkIndexes).toEqual([1, 2, 3, 4]);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('rejects promptly when a later pipelined group fails', async () => {
        await disposeParallelTermBankParser();
        const originalNavigator = globalThis.navigator;
        vi.stubGlobal('navigator', {hardwareConcurrency: 12, deviceMemory: 8});
        const workerCount = getParallelTermBankParserWorkerCount();
        let workerIndex = 0;
        class LaterFailingWorker {
            constructor() {
                this.index = workerIndex++;
                this.parseCount = 0;
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    ++this.parseCount;
                    if (message.id === 2) {
                        emitWorkerMessage(this.listeners, {
                            type: 'parse-error',
                            id: message.id,
                            error: {name: 'Error', message: 'injected later pipeline failure'},
                        });
                        return;
                    }
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        borrowsWorkerMemory: true,
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', LaterFailingWorker);
        try {
            const sinkIndexes = [];
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                (_chunk, progress) => { sinkIndexes.push(progress.chunkIndex); },
                {emitContentSlab: true},
            )).rejects.toThrow('injected later pipeline failure');
            expect(sinkIndexes.length).toBeGreaterThan(0);
            expect(sinkIndexes.length).toBeLessThanOrEqual(workerCount);
            expect(sinkIndexes).toStrictEqual(
                Array.from({length: sinkIndexes.length}, (_, index) => index + 1),
            );
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('navigator', originalNavigator);
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('terminates parser workers promptly when import is cancelled', async () => {
        let terminateCount = 0;
        class HangingWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                let listeners = this.listeners.get(type);
                if (typeof listeners === 'undefined') {
                    listeners = new Set();
                    this.listeners.set(type, listeners);
                }
                listeners.add(listener);
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                if (message.type !== 'initialize') { return; }
                queueMicrotask(() => {
                    for (const listener of this.listeners.get('message') ?? []) {
                        listener(/** @type {MessageEvent<unknown>} */ ({data: {type: 'ready'}}));
                    }
                });
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', HangingWorker);
        let cancelled = false;
        const cancelTimer = setTimeout(() => { cancelled = true; }, 10);
        try {
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            let sinkCalls = 0;
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => { ++sinkCalls; },
                {emitContentSlab: true},
                () => cancelled,
            )).rejects.toMatchObject({name: 'AbortError'});
            expect(sinkCalls).toBe(0);
            expect(terminateCount).toBeGreaterThanOrEqual(2);
        } finally {
            clearTimeout(cancelTimer);
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('cancels while deferred ZIP sources are unresolved', async () => {
        let terminateCount = 0;
        class ReadyWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                if (message.type === 'initialize') {
                    queueMicrotask(() => {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                    });
                }
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', ReadyWorker);
        let cancellationChecks = 0;
        try {
            const never = new Promise(() => {});
            await expect(parseTermBankWithWasmColumnChunksParallelDeferred(
                Array.from({length: 4}, () => never),
                Array.from({length: 4}, () => 2),
                3,
                () => {},
                {emitContentSlab: true},
                () => ++cancellationChecks >= 3,
            )).rejects.toMatchObject({name: 'AbortError'});
            expect(terminateCount).toBeGreaterThanOrEqual(2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('settles active worker jobs when the chunk sink rejects', async () => {
        let terminateCount = 0;
        class HangingAfterFirstWorker {
            constructor() {
                this.parseCount = 0;
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    ++this.parseCount;
                    if (this.parseCount > 1) { return; }
                    emitWorkerMessage(this.listeners, {
                        type: 'result',
                        id: message.id,
                        rowCount: 1,
                        resultSentEpochMs: Date.now(),
                        borrowsWorkerMemory: true,
                        chunk: {rowCount: 1},
                        profile: {chunkDispatchMs: 0},
                    });
                });
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', HangingAfterFirstWorker);
        try {
            const sourceBanks = Array.from({length: 4}, () => Promise.resolve(textEncoder.encode('[]')));
            await expect(parseTermBankWithWasmColumnChunksParallelDeferred(
                sourceBanks,
                sourceBanks.map(() => 2),
                3,
                () => { throw new Error('injected sink failure'); },
                {emitContentSlab: true},
            )).rejects.toThrow('injected sink failure');
            expect(terminateCount).toBeGreaterThanOrEqual(2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('settles peer jobs when a worker result cannot be transferred', async () => {
        let workerIndex = 0;
        let terminateCount = 0;
        class TransferFailingWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
                this.index = workerIndex++;
            }

            addEventListener(type, listener) {
                this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage(message) {
                queueMicrotask(() => {
                    if (message.type === 'initialize') {
                        emitWorkerMessage(this.listeners, {type: 'ready'});
                        return;
                    }
                    if (this.index !== 0) { return; }
                    for (const listener of this.listeners.get('messageerror') ?? []) {
                        listener(/** @type {MessageEvent<unknown>} */ ({}));
                    }
                });
            }

            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', TransferFailingWorker);
        try {
            const sourceBanks = Array.from({length: 4}, () => textEncoder.encode('[]'));
            await expect(parseTermBankWithWasmColumnChunksParallel(
                sourceBanks,
                3,
                () => {},
                {emitContentSlab: true},
            )).rejects.toThrow('returned an invalid message');
            expect(terminateCount).toBeGreaterThanOrEqual(2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('normalizes a null deferred-source rejection', async () => {
        class ReadyWorker {
            constructor() {
                /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener)); }

            removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

            postMessage(message) {
                if (message.type !== 'initialize') { return; }
                queueMicrotask(() => emitWorkerMessage(this.listeners, {type: 'ready'}));
            }

            terminate() {}
        }

        vi.stubGlobal('Worker', ReadyWorker);
        try {
            const rejectedSource = Promise.reject(null);
            void rejectedSource.catch(() => {});
            await expect(parseTermBankWithWasmColumnChunksParallelDeferred(
                [rejectedSource, ...Array.from({length: 3}, () => Promise.resolve(textEncoder.encode('[]')))],
                Array.from({length: 4}, () => 2),
                3,
                () => {},
                {emitContentSlab: true},
            )).rejects.toThrow('null');
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('aborts a hung parser prewarm during import cleanup', async () => {
        let terminateCount = 0;
        class NeverReadyWorker {
            constructor() {
                /** @type {Map<string, Set<(event: Event) => void>>} */
                this.listeners = new Map();
            }

            addEventListener(type, listener) {
                const listeners = this.listeners.get(type) ?? new Set();
                listeners.add(listener);
                this.listeners.set(type, listeners);
            }

            removeEventListener(type, listener) {
                this.listeners.get(type)?.delete(listener);
            }

            postMessage() {}
            terminate() { ++terminateCount; }
        }

        vi.stubGlobal('Worker', NeverReadyWorker);
        try {
            const prewarm = prewarmParallelTermBankParser();
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            let timeoutId;
            const timeout = new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Parser prewarm disposal timed out')), 250);
            });
            try {
                await Promise.race([disposeParallelTermBankParser(), timeout]);
            } finally {
                clearTimeout(timeoutId);
            }
            await expect(prewarm).resolves.toBe(false);
            expect(terminateCount).toBeGreaterThanOrEqual(2);
        } finally {
            await disposeParallelTermBankParser();
            vi.stubGlobal('Worker', void 0);
        }
    });

    test('uses the serial path for large imports on low-memory devices', async () => {
        const originalNavigator = globalThis.navigator;
        let workerConstructionCount = 0;
        class UnexpectedWorker {
            constructor() { ++workerConstructionCount; }
        }
        vi.stubGlobal('navigator', {deviceMemory: 4});
        vi.stubGlobal('Worker', UnexpectedWorker);
        try {
            const sharedBytes = new Uint8Array(16 * 1024 * 1024);
            const usedParallel = await parseTermBankWithWasmColumnChunksParallel(
                Array.from({length: 5}, () => sharedBytes),
                3,
                () => {},
                {emitContentSlab: true},
            );
            expect(usedParallel).toBe(false);
            expect(workerConstructionCount).toBe(0);
        } finally {
            vi.stubGlobal('navigator', originalNavigator);
            vi.stubGlobal('Worker', void 0);
        }
    });

    maybeTest('keeps text-object glossary dedup equivalent to plain text glossary', async () => {
        const textFirstObject = {text: 'shared text', type: 'text'};
        const rows = await parseRows([
            ['plain', 'plain', '', '', 0, ['shared text'], 1, ''],
            ['object', 'object', '', '', 0, [{type: 'text', text: 'shared text'}], 2, ''],
            ['text-first-object', 'text-first-object', '', '', 0, [textFirstObject], 3, ''],
        ]);

        expect(rows).toHaveLength(3);
        expect(getContentString(rows[0])).toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["shared text"]}');
        expect(getContentString(rows[1])).toBe(getContentString(rows[0]));
        expect(getContentString(rows[2])).toBe(getContentString(rows[0]));
        expect(rows[1].termEntryContentHash1).toBe(rows[0].termEntryContentHash1);
        expect(rows[1].termEntryContentHash2).toBe(rows[0].termEntryContentHash2);
        expect(rows[2].termEntryContentHash1).toBe(rows[0].termEntryContentHash1);
        expect(rows[2].termEntryContentHash2).toBe(rows[0].termEntryContentHash2);
    });

    maybeTest('keeps source-identical duplicates canonical after a normalized match', async () => {
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            textEncoder.encode(JSON.stringify([
                ['object', '', '', '', 0, [{type: 'text', text: 'same'}], 1, ''],
                ['plain', '', '', '', 0, ['same'], 2, ''],
                ['plain-duplicate', '', '', '', 0, ['same'], 3, ''],
            ])),
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true},
        );

        const [chunk] = chunks;
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 0, 0]));
        expect(chunk.contentDedupPlan?.uniqueCount).toBe(1);
        expect(chunk.contentDedupPlan?.sourceRowCount).toBe(3);
        expect(chunk.contentDedupPlan?.uniqueRowIndexes).toStrictEqual(new Uint32Array([0]));
        expect(chunk.contentDedupPlan?.resolvedDictNames).toBeNull();
        expect(chunk.contentDedupPlan?.resolvedUniformDictName).toBeUndefined();
        expect(chunk.useResolvedContentReferences).toBe(true);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[8]);
        expect(chunk.contentMetaList[1]).toBe(chunk.contentMetaList[5]);
        expect(chunk.contentMetaList[1]).toBe(chunk.contentMetaList[9]);
    });

    maybeTest('preserves compact plain glossaries while normalizing equivalent object and spaced forms', async () => {
        const rows = await parseRows([
            ['compact', 'compact', '', '', 0, ['brace { and spaces', 'escaped "quote"'], 1, ''],
            ['object', 'object', '', '', 0, [{type: 'text', text: 'same'}], 2, ''],
            ['plain', 'plain', '', '', 0, ['same'], 3, ''],
        ]);

        expect(getContentString(rows[0])).toBe(
            '{"rules":"","definitionTags":"","termTags":"","glossary":["brace { and spaces","escaped \\"quote\\""]}',
        );
        expect(getContentString(rows[1])).toBe(getContentString(rows[2]));
    });

    maybeTest('scans escaped strings correctly at every wide-word alignment', async () => {
        const glossary = Array.from({length: 16}, (_, index) => (
            `${'x'.repeat(index)}-"quoted"-\\-${'y'.repeat(257 - index)}-終`
        ));
        const [row] = await parseRows([
            ['alignment', 'alignment', '', '', 0, glossary, 1, ''],
        ]);

        const content = JSON.parse(getContentString(row));
        expect(content.glossary).toStrictEqual(glossary);
    });

    maybeTest('rejects an unterminated string ending at a word boundary', async () => {
        const malformed = `[["entry","entry","","",0,["${'x'.repeat(64)}]`;
        await expect(parseRowsJson(malformed)).rejects.toThrow(/term-bank parser failed/);
    });

    maybeTest('rejects mismatched nested glossary containers before dispatch', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmChunks(
            textEncoder.encode('[["entry","","","",0,[{"value":[1,2}}],1,""]]'),
            3,
            () => { ++chunkCount; },
            1,
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest.each([
        ['missing field comma', '[["entry" "", "", "", 0, ["definition"], 1, ""]]'],
        ['trailing field comma', '[["entry", "", "", "", 0, ["definition"], 1, "",]]'],
        ['missing row comma', '[["first", "", "", "", 0, ["definition"], 1, ""] ["second", "", "", "", 0, ["definition"], 2, ""]]'],
        ['trailing row comma', '[["entry", "", "", "", 0, ["definition"], 1, ""],]'],
        ['trailing content', '[["entry", "", "", "", 0, ["definition"], 1, ""]] false'],
        ['invalid escape', '[["entry\\x", "", "", "", 0, ["definition"], 1, ""]]'],
        ['invalid unicode escape', '[["entry\\u12xz", "", "", "", 0, ["definition"], 1, ""]]'],
        ['leading-zero score', '[["entry", "", "", "", 01, ["definition"], 1, ""]]'],
        ['invalid glossary literal', '[["entry", "", "", "", 0, [nonsense], 1, ""]]'],
        ['invalid nested literal', '[["entry", "", "", "", 0, [{"value":truth}], 1, ""]]'],
        ['leading-zero glossary number', '[["entry", "", "", "", 0, [01], 1, ""]]'],
        ['missing fractional digits', '[["entry", "", "", "", 0, [1.], 1, ""]]'],
        ['missing exponent digits', '[["entry", "", "", "", 0, [1e+], 1, ""]]'],
        ['nested missing comma', '[["entry", "", "", "", 0, ["first" "second"], 1, ""]]'],
        ['object missing colon', '[["entry", "", "", "", 0, [{"value" "text"}], 1, ""]]'],
        ['nested trailing comma', '[["entry", "", "", "", 0, ["value",], 1, ""]]'],
        ['non-string object key', '[["entry", "", "", "", 0, [{1:"value"}], 1, ""]]'],
    ])('rejects malformed JSON syntax: %s', async (_name, malformed) => {
        await expect(parseRowsJson(malformed)).rejects.toThrow(/term-bank parser failed/);
    });

    maybeTest('accepts every valid JSON scalar form in glossary content', async () => {
        const glossary = [true, false, null, 0, -0, 12, -12, 1.25, 1e20, 1e-20];
        const [row] = await parseRows([
            ['scalars', '', '', '', 0, glossary, 1, ''],
        ]);

        expect(JSON.parse(getContentString(row)).glossary).toStrictEqual(JSON.parse(JSON.stringify(glossary)));
    });

    maybeTest('preserves valid deeply mixed glossary containers', async () => {
        /** @type {unknown} */
        let nested = 'leaf';
        for (let i = 0; i < 32; ++i) {
            nested = {content: [nested], tag: 'span'};
        }
        const [row] = await parseRows([
            ['nested', '', '', '', 0, [nested], 1, ''],
        ]);
        expect(JSON.parse(getContentString(row)).glossary[0]).toStrictEqual(nested);
    });

    maybeTest('grows the metadata buffer in place without dropping rows', async () => {
        const rowCount = 9000;
        const source = textEncoder.encode(JSON.stringify(
            Array.from({length: rowCount}, (_, index) => [
                `entry-${index}`,
                '',
                '',
                '',
                index,
                ['definition'],
                index,
                '',
            ]),
        ));
        let processedRows = 0;
        await parseTermBankWithWasmChunks(
            source,
            3,
            (chunk) => { processedRows += chunk.length; },
            4096,
            {includeContentMetadata: false, minimalDecode: true},
        );
        const profile = consumeLastTermBankWasmParseProfile();

        expect(processedRows).toBe(rowCount);
        expect(profile?.rowCount).toBe(rowCount);
        expect(profile?.metaCapacity).toBeGreaterThanOrEqual(rowCount);
        expect(profile?.metaCapacity).toBeLessThan(20000);
        expect(profile?.metaAllocatedBytes).toBe((profile?.metaCapacity ?? 0) * 17 * 4);
    });

    maybeTest('grows the content buffer while preserving a large row', async () => {
        const definition = 'x'.repeat(2 * 1024 * 1024);
        const [row] = await parseRows([
            ['large-content', '', '', '', 0, [definition], 1, ''],
        ]);
        const profile = consumeLastTermBankWasmParseProfile();

        expect(JSON.parse(getContentString(row)).glossary).toStrictEqual([definition]);
        expect(profile?.encodedContentBytes).toBe(row.termEntryContentBytes.byteLength);
        expect(profile?.initialContentBytesPerRow).toBe(48);
        expect(profile?.contentCapacity).toBeGreaterThanOrEqual(row.termEntryContentBytes.byteLength);
        expect(profile?.contentCapacity).toBeLessThan(4 * 1024 * 1024);
    });

    maybeTest('reports the normalized initial content capacity hint', async () => {
        await parseRows(
            [['capacity-hint', '', '', '', 0, ['definition'], 1, '']],
            {initialContentBytesPerRow: 768},
        );
        const profile = consumeLastTermBankWasmParseProfile();

        expect(profile?.initialContentBytesPerRow).toBe(512);
        expect(profile?.encodedContentBytes).toBeGreaterThan(0);
        expect(profile?.contentCapacity).toBeGreaterThanOrEqual(profile?.encodedContentBytes ?? Infinity);
    });

    maybeTest('falls back to normalization for formatted glossary JSON', async () => {
        const rows = await parseRowsJson(`[
            ["formatted", "formatted", "", "", 0, [ "same", { "type" : "text", "text" : "wrapped" } ], 1, ""],
            ["canonical", "canonical", "", "", 0, ["same", "wrapped"], 2, ""]
        ]`);

        expect(rows).toHaveLength(2);
        expect(getContentString(rows[0])).toBe(getContentString(rows[1]));
        expect(rows[0].termEntryContentHash1).toBe(rows[1].termEntryContentHash1);
        expect(rows[0].termEntryContentHash2).toBe(rows[1].termEntryContentHash2);
    });

    maybeTest('uses the same dedup hash pair as every JavaScript fallback path', async () => {
        const [row] = await parseRows([
            ['hash', 'hash', 'tag', 'rule', 7, ['hash definition'], 1, 'term-tag'],
        ]);
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const database = new DictionaryDatabase();
        const hashEntryContentBytesPair = /** @type {(this: DictionaryImporter, bytes: Uint8Array) => [number, number]} */ (
            Reflect.get(importer, '_hashEntryContentBytesPair')
        );
        const hashEntryContent = /** @type {(this: DictionaryDatabase, contentJson: string) => string} */ (
            Reflect.get(database, '_hashEntryContent')
        );
        const contentString = getContentString(row);
        const expectedHashPair = [
            row.termEntryContentHash1,
            row.termEntryContentHash2,
        ];

        expect(hashTermEntryContentBytesPair(row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContentBytesPair.call(importer, row.termEntryContentBytes)).toEqual(expectedHashPair);
        expect(hashEntryContent.call(database, contentString)).toBe(
            `${(row.termEntryContentHash1 ?? 0).toString(16).padStart(8, '0')}` +
            `${(row.termEntryContentHash2 ?? 0).toString(16).padStart(8, '0')}`,
        );
    });

    maybeTest('does not collapse structured-content objects into text glossary content', async () => {
        const structuredGlossary = {
            content: [{tag: 'span', content: 'structured definition'}],
            type: 'structured-content',
        };
        const [row] = await parseRows([
            ['structured', 'structured', '', '', 0, [structuredGlossary], 1, ''],
        ]);

        const content = getContentString(row);
        expect(content).toContain('"type":"structured-content"');
        expect(content).toContain('"structured definition"');
        expect(content).not.toBe('{"rules":"","definitionTags":"","termTags":"","glossary":["structured definition"]}');
    });

    maybeTest('reports exact image media markers without matching ordinary words', async () => {
        const rows = await parseRows([
            ['image-row', 'image-row', '', '', 0, [{type: 'image', path: 'image-row.png'}], 1, ''],
            ['img-row', 'img-row', '', '', 0, [{tag: 'div', content: [{tag: 'img', path: 'nested.png'}]}], 2, ''],
            ['word-row', 'word-row', '', '', 0, ['imagination and imagery'], 2, ''],
            ['quoted-row', 'quoted-row', '', '', 0, ['The literal token "image" is not media'], 3, ''],
        ]);

        expect(rows[0].glossaryMayContainMedia).toBe(true);
        expect(rows[1].glossaryMayContainMedia).toBe(true);
        expect(rows[2].glossaryMayContainMedia).toBe(false);
        expect(rows[3].glossaryMayContainMedia).toBe(false);
    });

    maybeTest('does not dispatch partial chunks when parsing malformed term-bank JSON', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmChunks(
            textEncoder.encode('[["ok","ok","","",0,["ok"],1,""],not-json]'),
            3,
            () => { ++chunkCount; },
            1,
            {copyContentBytes: true},
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest('rejects out-of-range integer metadata before dispatch', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmColumnChunks(
            textEncoder.encode('[["overflow","overflow","","",2147483648,["definition"],1,""]]'),
            3,
            () => { ++chunkCount; },
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest('bounds and serializes pipelined chunk dispatch', async () => {
        const calls = [];
        let releaseFirst = () => {};
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let active = 0;
        let maxActive = 0;
        const parsePromise = parseTermBankWithWasmChunks(
            textEncoder.encode(JSON.stringify([
                ['a', 'a', '', '', 0, ['a'], 1, ''],
                ['b', 'b', '', '', 0, ['b'], 2, ''],
                ['c', 'c', '', '', 0, ['c'], 3, ''],
            ])),
            3,
            async (_chunk, progress) => {
                ++active;
                maxActive = Math.max(maxActive, active);
                calls.push(progress.chunkIndex);
                if (progress.chunkIndex === 1) { await firstGate; }
                --active;
            },
            1,
            {copyContentBytes: true, maxPendingChunks: 2},
        );
        await vi.waitFor(() => { expect(calls).toStrictEqual([1]); });
        releaseFirst();
        await parsePromise;

        expect(calls).toStrictEqual([1, 2, 3]);
        expect(maxActive).toBe(1);
        expect(consumeLastTermBankWasmParseProfile()?.maxPendingChunks).toBe(2);
    });

    maybeTest.each([
        ['row', parseTermBankWithWasmChunks],
        ['column', parseTermBankWithWasmColumnChunks],
    ])('observes queued %s dispatch rejections after an earlier chunk fails', async (_kind, parseChunks) => {
        const source = textEncoder.encode(JSON.stringify([
            ['a', 'a', '', '', 0, ['a'], 1, ''],
            ['b', 'b', '', '', 0, ['b'], 2, ''],
            ['c', 'c', '', '', 0, ['c'], 3, ''],
        ]));
        const failure = new Error('chunk write failed');
        const calls = [];
        const unhandledRejections = [];
        const onUnhandledRejection = (reason) => { unhandledRejections.push(reason); };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            await expect(parseChunks(
                source,
                3,
                async (_chunk, progress) => {
                    calls.push(progress.chunkIndex);
                    if (progress.chunkIndex === 1) { throw failure; }
                },
                1,
                {copyContentBytes: true, maxPendingChunks: 2},
            )).rejects.toBe(failure);
            await new Promise((resolve) => { setTimeout(resolve, 0); });
            expect(calls).toStrictEqual([1]);
            expect(unhandledRejections).toStrictEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    maybeTest('combines source arrays directly in WASM input memory', async () => {
        const chunks = [];
        await parseTermBankWithWasmChunks(
            [
                textEncoder.encode(JSON.stringify([['a', 'a', '', '', 0, ['first'], 1, '']])),
                textEncoder.encode(JSON.stringify([['b', 'b', '', '', 0, ['second'], 2, '']])),
            ],
            3,
            (rows) => { chunks.push(...rows); },
            1,
            {copyContentBytes: true},
        );

        expect(chunks.map((row) => row.expression)).toStrictEqual(['a', 'b']);
        expect(chunks.map(getContentString)).toStrictEqual([
            '{"rules":"","definitionTags":"","termTags":"","glossary":["first"]}',
            '{"rules":"","definitionTags":"","termTags":"","glossary":["second"]}',
        ]);
    });

    maybeTest('fuses multi-bank parsing, content dedup, and lookup projection', async () => {
        const sources = [
            textEncoder.encode(JSON.stringify([
                ['first', '', '', '', 2, ['shared'], 11, ''],
                ['first', '', '', '', 3, ['shared'], 12, ''],
            ])),
            textEncoder.encode(JSON.stringify([
                ['second', 'reading', '', '', 4, ['distinct'], 13, ''],
            ])),
        ];
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            sources,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, singleChunk: true},
        );

        const [chunk] = chunks;
        expect(chunks).toHaveLength(1);
        expect(chunk.rowCount).toBe(3);
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 0, 1]));
        expect(chunk.contentDedupPlan?.uniqueRowIndexes).toStrictEqual(new Uint32Array([0, 2]));
        const uniqueSignatures = [0, 2].flatMap((rowIndex) => {
            const metaOffset = rowIndex * 4;
            const offset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaOffset];
            const length = chunk.contentMetaList[metaOffset + 1];
            return getContentSignatures(chunk.contentBytesBuffer.subarray(offset, offset + length));
        });
        expect(chunk.contentDedupPlan?.uniqueSignatures).toStrictEqual(Uint32Array.from(uniqueSignatures));
        expect(chunk.readingEqualsExpressionList).toStrictEqual(new Uint8Array([1, 1, 0]));
        expect(chunk.scoreList).toStrictEqual(new Int32Array([2, 3, 4]));
        expect(chunk.sequenceList).toStrictEqual(new Int32Array([11, 12, 13]));
        const plan = chunk.termRecordPreinternedPlan;
        const wasmBuffer = chunk.contentBytesBuffer.buffer;
        expect(wasmBuffer).toBeInstanceOf(SharedArrayBuffer);
        for (const [name, view] of [
            ['readingEqualsExpressionList', chunk.readingEqualsExpressionList],
            ['scoreList', chunk.scoreList],
            ['sequenceList', chunk.sequenceList],
            ['contentMetaList', chunk.contentMetaList],
            ['contentUniqueIndexList', chunk.contentUniqueIndexList],
            ['stringLengths', plan.stringLengths],
            ['stringOffsets', plan.stringOffsets],
            ['stringHashes', plan.stringHashes],
            ['stringsBuffer', plan.stringsBuffer],
            ['expressionIndexes', plan.expressionIndexes],
            ['readingIndexes', plan.readingIndexes],
        ]) {
            expect(view?.buffer, name).toBe(wasmBuffer);
        }
        expect(chunk.contentDedupPlan?.uniqueRowIndexes.buffer).toBeInstanceOf(ArrayBuffer);
        expect(chunk.contentDedupPlan?.uniqueSignatures.buffer).toBeInstanceOf(ArrayBuffer);
        expect(plan.expressionIndexes[0]).toBe(plan.expressionIndexes[1]);
        expect(plan.readingIndexes[0]).toBe(plan.expressionIndexes[0]);
        expect(plan.readingIndexes[2]).not.toBe(plan.expressionIndexes[2]);
        const cloned = structuredClone(chunk);
        expect(cloned.contentBytesBaseOffset).toBe(chunk.contentBytesBaseOffset);
        expect(cloned.contentBytesBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);
        expect(cloned.termRecordPreinternedPlan.stringsBuffer.buffer).toBeInstanceOf(SharedArrayBuffer);
        const originalScore = chunk.scoreList[0];
        chunk.scoreList[0] = 123456;
        expect(cloned.scoreList[0]).toBe(123456);
        chunk.scoreList[0] = originalScore;
        expect(cloned.contentDedupPlan.uniqueSignatures).toStrictEqual(chunk.contentDedupPlan.uniqueSignatures);
        const profile = consumeLastTermBankWasmParseProfile();
        expect(profile?.rowDecodeMs).toBe(0);
        expect(profile?.nativeStringPlanMs).toBe(0);
        expect(profile?.recentContentDedupHitCount).toBe(1);

        const version1Chunks = [];
        await parseTermBankWithWasmColumnChunks(
            sources,
            1,
            (version1Chunk) => { version1Chunks.push(version1Chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, singleChunk: true},
        );
        expect(version1Chunks[0].sequenceList).toStrictEqual(new Int32Array([-1, -1, -1]));
    });

    maybeTest('encodes parser-owned lookup sidecars byte-identically in WASM', async () => {
        const sources = [
            textEncoder.encode(JSON.stringify([
                ['first', '', '', '', 1, ['one'], 10, ''],
                ['first', 'reading', '', '', 2, ['two'], 10, ''],
            ])),
            textEncoder.encode(JSON.stringify([
                ['second', 'reading', '', '', 3, ['three'], 11, ''],
                ['third', '', '', '', 4, ['four'], -1, ''],
            ])),
        ];
        let result = null;
        await parseTermBankWithWasmColumnChunks(
            sources,
            3,
            (chunk) => { result = copyWasmBackedColumnChunk(chunk); },
            8,
            {
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                emitTermByteLists: false,
                prepareLookupIndexes: true,
                singleChunk: true,
            },
        );
        const chunk = /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (/** @type {unknown} */ (result));
        const nativeBytes = chunk.preparedLookupIndexes?.get(`0:${chunk.rowCount}`)?.bytes;
        const javascriptBytes = encodePersistedTermLookupIndexFromPreinternedPlan(
            chunk.termRecordPreinternedPlan,
            chunk.readingEqualsExpressionList,
            chunk.sequenceList,
            chunk.rowCount,
        );

        expect(nativeBytes).toStrictEqual(javascriptBytes);
        expect(chunk.preparedLookupIndexes?.get(`0:${chunk.rowCount}`)?.preinternedPlan).toBe(
            chunk.termRecordPreinternedPlan,
        );
        expect(chunk.termRecordPreinternedPlan.stringOffsets).toBeUndefined();
        expect(chunk.termRecordPreinternedPlan.stringHashes).toBeUndefined();
        expect(consumeLastTermBankWasmParseProfile()?.lookupIndexEncodeMs).toBeGreaterThanOrEqual(0);
    });

    maybeTest('encodes single-source native plans and leaves escaped plans to the fallback', async () => {
        /**
         * @param {string} expression
         * @returns {Promise<ReturnType<typeof copyWasmBackedColumnChunk>>}
         */
        const parsePrepared = async (expression) => {
            let result = null;
            await parseTermBankWithWasmColumnChunks(
                textEncoder.encode(JSON.stringify([
                    [expression, '', '', '', 1, ['one'], 10, ''],
                    ['second', 'reading', '', '', 2, ['two'], 11, ''],
                ])),
                3,
                (chunk) => { result = copyWasmBackedColumnChunk(chunk); },
                8,
                {
                    emitContentSlab: true,
                    emitTokenBinaryContent: true,
                    emitTermByteLists: false,
                    prepareLookupIndexes: true,
                    singleChunk: true,
                },
            );
            return /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (/** @type {unknown} */ (result));
        };
        const nativeChunk = await parsePrepared('first');
        const nativeBytes = nativeChunk.preparedLookupIndexes?.get('0:2')?.bytes;
        expect(nativeBytes).toStrictEqual(encodePersistedTermLookupIndexFromPreinternedPlan(
            nativeChunk.termRecordPreinternedPlan,
            nativeChunk.readingEqualsExpressionList,
            nativeChunk.sequenceList,
            nativeChunk.rowCount,
        ));

        const escapedChunk = await parsePrepared('escaped\\expression');
        expect(escapedChunk.preparedLookupIndexes).toBeUndefined();
    });

    maybeTest('keeps native lookup encoding byte-identical across dense mixed columns', async () => {
        const rows = Array.from({length: 2048}, (_, row) => {
            const expression = `term-${row % 317}`;
            const reading = row % 5 === 0 ? '' : `reading-${row % 193}`;
            const sequence = row % 7 === 0 ? -1 : row % 251;
            return [expression, reading, '', '', row - 1024, [`definition-${row % 127}`], sequence, ''];
        });
        let result = null;
        await parseTermBankWithWasmColumnChunks(
            textEncoder.encode(JSON.stringify(rows)),
            3,
            (chunk) => { result = copyWasmBackedColumnChunk(chunk); },
            rows.length,
            {
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                emitTermByteLists: false,
                prepareLookupIndexes: true,
                singleChunk: true,
            },
        );
        const chunk = /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (/** @type {unknown} */ (result));
        expect(chunk.preparedLookupIndexes?.get(`0:${rows.length}`)?.bytes).toStrictEqual(
            encodePersistedTermLookupIndexFromPreinternedPlan(
                chunk.termRecordPreinternedPlan,
                chunk.readingEqualsExpressionList,
                chunk.sequenceList,
                chunk.rowCount,
            ),
        );
    });

    maybeTest('keeps recent exact matches on a normalized duplicate canonical', async () => {
        const objectGlossary = {type: 'text', text: 'same'};
        const sources = [
            textEncoder.encode(JSON.stringify([
                ['plain', '', '', '', 0, ['same'], 1, ''],
                ['object', '', '', '', 0, [objectGlossary], 2, ''],
            ])),
            textEncoder.encode(JSON.stringify([
                ['object-copy', '', '', '', 0, [objectGlossary], 3, ''],
            ])),
        ];
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            sources,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, singleChunk: true},
        );

        const [chunk] = chunks;
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 0, 0]));
        expect(chunk.contentDedupPlan?.uniqueCount).toBe(1);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[8]);
        expect(consumeLastTermBankWasmParseProfile()?.recentContentDedupHitCount).toBe(1);
    });

    maybeTest('keeps fused multi-bank columns equivalent to the established single-buffer path', async () => {
        const rows = [
            ['日本語', '', 'common tag', 'v1', -2147483648, ['plain', {type: 'text', text: 'normalized'}], null, 'tag-a'],
            ['escaped\\expression', 'escaped\\reading', '', '', 2147483647, ['slashes \\ and "quotes"'], 2147483647, ''],
            ['duplicate-a', '', '', '', 0, ['same'], 3, ''],
            ['duplicate-b', 'duplicate-b', '', '', 0, [{type: 'text', text: 'same'}], 4, ''],
            ['supplementary-𠮷', 'よし', '', '', -1, [true, false, null, 1.25], 5, ''],
        ];
        const sources = [
            textEncoder.encode(JSON.stringify(rows.slice(0, 2))),
            textEncoder.encode('[]'),
            textEncoder.encode(JSON.stringify(rows.slice(2))),
        ];
        /**
         * @param {Uint8Array|Uint8Array[]} source
         * @returns {Promise<ReturnType<typeof copyWasmBackedColumnChunk>>}
         */
        const parseStableChunk = async (source) => {
            let result = null;
            await parseTermBankWithWasmColumnChunks(
                source,
                3,
                (chunk) => { result = copyWasmBackedColumnChunk(chunk); },
                16,
                {
                    emitContentSlab: true,
                    emitTokenBinaryContent: true,
                    emitTermByteLists: false,
                    singleChunk: true,
                },
            );
            return /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (result);
        };
        const getContentRows = (chunk) => {
            const result = [];
            for (let i = 0; i < chunk.rowCount; ++i) {
                const metaOffset = i * 4;
                const offset = chunk.contentMetaList[metaOffset];
                const length = chunk.contentMetaList[metaOffset + 1];
                result.push([...chunk.contentBytesBuffer.subarray(offset, offset + length)]);
            }
            return result;
        };
        const getPlanStrings = (chunk) => {
            const {stringLengths, stringOffsets, stringsBuffer} = chunk.termRecordPreinternedPlan;
            return Array.from(stringLengths, (length, index) => (
                [...stringsBuffer.subarray(stringOffsets[index], stringOffsets[index] + length)]
            ));
        };

        const fused = await parseStableChunk(sources);
        const established = await parseStableChunk(textEncoder.encode(JSON.stringify(rows)));
        expect(fused.rowCount).toBe(established.rowCount);
        expect(fused.readingEqualsExpressionList).toStrictEqual(established.readingEqualsExpressionList);
        expect(fused.scoreList).toStrictEqual(established.scoreList);
        expect(fused.sequenceList).toStrictEqual(established.sequenceList);
        expect(fused.contentHash1List).toStrictEqual(established.contentHash1List);
        expect(fused.contentHash2List).toStrictEqual(established.contentHash2List);
        expect(fused.contentUniqueIndexList).toStrictEqual(established.contentUniqueIndexList);
        expect(getContentRows(fused)).toStrictEqual(getContentRows(established));
        expect(getPlanStrings(fused)).toStrictEqual(getPlanStrings(established));
        expect(fused.termRecordPreinternedPlan.stringHashes).toStrictEqual(established.termRecordPreinternedPlan.stringHashes);
        expect(fused.termRecordPreinternedPlan.expressionIndexes).toStrictEqual(established.termRecordPreinternedPlan.expressionIndexes);
        expect(fused.termRecordPreinternedPlan.readingIndexes).toStrictEqual(established.termRecordPreinternedPlan.readingIndexes);
    });

    maybeTest('preserves media hints in the fused multi-bank path', async () => {
        const sources = [
            textEncoder.encode(JSON.stringify([
                ['plain', '', '', '', 1, ['definition'], 1, ''],
                ['image', '', '', '', 2, [{type: 'image', path: 'test.png'}], 2, ''],
            ])),
            textEncoder.encode(JSON.stringify([
                ['other', '', '', '', 3, ['other definition'], 3, ''],
            ])),
        ];
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            sources,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                emitTermByteLists: false,
                mediaHintFastScan: true,
                singleChunk: true,
            },
        );

        const [chunk] = chunks;
        expect(chunk.rowCount).toBe(3);
        expect(chunk.mediaRows).toHaveLength(1);
        expect(chunk.mediaRows[0].index).toBe(1);
        expect(chunk.mediaRows[0].row.glossaryMayContainMedia).toBe(true);
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 1, 2]));
        const profile = consumeLastTermBankWasmParseProfile();
        expect(profile?.nativeStringPlanMs).toBe(0);
        expect(profile?.nativeStringPlanFallbackChunkCount).toBe(0);
    });

    maybeTest('treats an empty reading as the expression in minimal and columnar paths', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['expression', '', '', '', 4, ['definition'], 12, ''],
        ]));
        /** @type {ParsedRow[]} */
        const rows = [];
        await parseTermBankWithWasmChunks(
            source,
            3,
            (chunk) => { rows.push(...chunk); },
            1,
            {minimalDecode: true, reuseExpressionForReadingDecode: true},
        );
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const columns = [];
        await parseTermBankWithWasmColumnChunks(source, 3, (chunk) => { columns.push(chunk); }, 1);

        expect(rows[0].readingEqualsExpression).toBe(true);
        expect(textDecoder.decode(rows[0].readingBytes)).toBe('expression');
        expect(columns[0].readingEqualsExpressionList[0]).toBe(1);
        expect(columns[0].readingBytesList[0]).toHaveLength(0);
        expect(columns[0].termRecordPreinternedPlan.readingIndexes[0]).toBe(
            columns[0].termRecordPreinternedPlan.expressionIndexes[0],
        );
    });

    maybeTest('builds native string plans equivalent to the JavaScript fallback across duplicates', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['003pwu', '00a5fa', '', '', 1, ['first collision'], 1, ''],
            ['00a5fa', '003pwu', '', '', 2, ['second collision'], 2, ''],
            ['same', 'same', '', '', 3, ['same token'], 3, ''],
            ['same', '', '', '', 4, ['empty reading'], 4, ''],
            ['other', 'same', '', '', 5, ['shared reading'], 5, ''],
        ]));

        /**
         * @param {boolean} useNativeStringPlan
         * @returns {Promise<TermStringPlanSnapshot>}
         */
        const parsePlan = async (useNativeStringPlan) => {
            /** @type {TermStringPlanSnapshot|null} */
            let snapshot = null;
            await parseTermBankWithWasmColumnChunks(
                source,
                3,
                (chunk) => {
                    const plan = chunk.termRecordPreinternedPlan;
                    if (plan.stringOffsets === undefined || plan.stringHashes === undefined) {
                        throw new Error('Expected complete preinterned string metadata');
                    }
                    snapshot = {
                        strings: Array.from(plan.stringLengths, (length, index) => {
                            const offset = plan.stringOffsets[index];
                            return textDecoder.decode(plan.stringsBuffer.subarray(offset, offset + length));
                        }),
                        stringLengths: [...plan.stringLengths],
                        stringHashes: [...plan.stringHashes],
                        stringOffsets: [...plan.stringOffsets],
                        expressionIndexes: [...plan.expressionIndexes],
                        readingIndexes: [...plan.readingIndexes],
                        readingEqualsExpressionList: [...chunk.readingEqualsExpressionList],
                    };
                },
                8,
                {emitTermByteLists: false, useNativeStringPlan},
            );
            return /** @type {TermStringPlanSnapshot} */ (snapshot);
        };

        const nativePlan = await parsePlan(true);
        const nativeProfile = consumeLastTermBankWasmParseProfile();
        const fallbackPlan = await parsePlan(false);
        const fallbackProfile = consumeLastTermBankWasmParseProfile();

        expect(nativePlan).toStrictEqual(fallbackPlan);
        expect(nativeProfile?.nativeStringPlanChunkCount).toBe(1);
        expect(nativeProfile?.nativeStringPlanFallbackChunkCount).toBe(0);
        expect(fallbackProfile?.nativeStringPlanChunkCount).toBe(0);
        expect(nativePlan?.strings).toContain('003pwu');
        expect(nativePlan?.strings).toContain('00a5fa');
        for (const value of ['003pwu', '00a5fa', 'same', 'other']) {
            const index = nativePlan.strings.indexOf(value);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(nativePlan.stringHashes[index]).toBe(hashBytes(textEncoder.encode(value)));
        }
    });

    maybeTest('emits equivalent import columns and decodes only media compatibility rows', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['escaped\\value', 'reading', '', '', -2, ['plain'], null, ''],
            ['image', '', '', '', 7, [{type: 'image', path: 'test.png'}], 8, ''],
            ['minimum-score', '', '', '', -2147483648, ['minimum'], 9, ''],
            ['maximum-values', '', '', '', 2147483647, ['maximum'], 2147483647, ''],
        ]));
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {mediaHintFastScan: true},
        );
        const [chunk] = chunks;
        const plan = chunk.termRecordPreinternedPlan;
        const stringOffsets = [];
        let offset = 0;
        for (const length of plan.stringLengths) {
            stringOffsets.push(offset);
            offset += length;
        }
        const getPlanString = (index) => textDecoder.decode(
            plan.stringsBuffer.subarray(stringOffsets[index], stringOffsets[index] + plan.stringLengths[index]),
        );

        expect(chunk.rowCount).toBe(4);
        expect(chunk.scoreList).toStrictEqual(new Int32Array([-2, 7, -2147483648, 2147483647]));
        expect(chunk.sequenceList).toStrictEqual(new Int32Array([-1, 8, 9, 2147483647]));
        expect(getPlanString(plan.expressionIndexes[0])).toBe('escaped\\value');
        expect(getPlanString(plan.readingIndexes[0])).toBe('reading');
        expect(getPlanString(plan.expressionIndexes[1])).toBe('image');
        expect(plan.readingIndexes[1]).toBe(plan.expressionIndexes[1]);
        expect(chunk.mediaRows).toHaveLength(1);
        expect(chunk.mediaRows[0].index).toBe(1);
        expect(chunk.mediaRows[0].row.glossaryMayContainMedia).toBe(true);
        expect(getContentString({termEntryContentBytes: chunk.contentBytesList[0]})).toContain('"plain"');
        expect(plan.stringHashes[plan.expressionIndexes[0]]).toBe(hashBytes(textEncoder.encode('escaped\\value')));
        expect(plan.stringHashes[plan.expressionIndexes[1]]).toBe(hashBytes(textEncoder.encode('image')));
        expect(consumeLastTermBankWasmParseProfile()?.nativeStringPlanFallbackChunkCount).toBe(1);
    });

    maybeTest('emits shared content slabs without allocating per-row content views', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['first', '', '', '', 1, ['same'], 1, ''],
            ['second', '', '', '', 2, ['same'], 2, ''],
            ['third', '', '', '', 3, ['different'], 3, ''],
            ['fourth', '', '', '', 4, ['different'], 4, ''],
        ]));
        /** @type {Array<Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]>} */
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTermByteLists: false},
        );

        const [chunk] = chunks;
        expect(chunk.contentBytesList).toHaveLength(0);
        expect(chunk.expressionBytesList).toHaveLength(0);
        expect(chunk.readingBytesList).toHaveLength(0);
        expect(chunk.contentHash1List).toHaveLength(0);
        expect(chunk.contentHash2List).toHaveLength(0);
        expect(chunk.contentMetaList).toBeInstanceOf(Uint32Array);
        expect(chunk.contentMetaList).toHaveLength(16);
        expect(chunk.contentBytesBuffer).toBeInstanceOf(Uint8Array);
        const contentStrings = [0, 1, 2, 3].map((index) => {
            const metaOffset = index * 4;
            const offset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaOffset];
            const length = chunk.contentMetaList[metaOffset + 1];
            return textDecoder.decode(chunk.contentBytesBuffer.subarray(offset, offset + length));
        });
        expect(contentStrings[0]).toBe(contentStrings[1]);
        expect(contentStrings[0]).toContain('"same"');
        expect(contentStrings[2]).toBe(contentStrings[3]);
        expect(contentStrings[2]).toContain('"different"');
        expect(contentStrings[2]).not.toBe(contentStrings[0]);
        expect(chunk.contentMetaList[2]).toBe(chunk.contentMetaList[6]);
        expect(chunk.contentMetaList[3]).toBe(chunk.contentMetaList[7]);
        expect(chunk.contentMetaList[10]).toBe(chunk.contentMetaList[14]);
        expect(chunk.contentMetaList[11]).toBe(chunk.contentMetaList[15]);
        expect(chunk.contentMetaList[0]).not.toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[8]).not.toBe(chunk.contentMetaList[12]);
        expect(chunk.contentMetaList[8]).toBeGreaterThan(chunk.contentMetaList[0]);
        expect(chunk.contentUniqueIndexList).toBeNull();
        expect(chunk.contentDedupPlan).toBeNull();
        expect(chunk.useResolvedContentReferences).toBe(false);
    });

    maybeTest('emits compact token-binary content with strict round-trip decoding', async () => {
        const source = textEncoder.encode(JSON.stringify([
            ['first', '', 'tag\\value', 'rule\\value', 1, ['same', {type: 'text', text: 'wrapped'}], 1, 'term-tag'],
            ['second', '', 'tag\\value', 'rule\\value', 2, ['same', 'wrapped'], 2, 'term-tag'],
            ['third', '', 'tag\\value', 'rule\\value', 3, ['different'], 3, 'term-tag'],
            ['fourth', '', 'tag\\value', 'rule\\value', 4, [{type: 'text', text: 'different'}], 4, 'term-tag'],
        ]));
        const chunks = [];
        await parseTermBankWithWasmColumnChunks(
            source,
            3,
            (chunk) => { chunks.push(chunk); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true},
        );

        const [chunk] = chunks;
        const contents = [0, 1].map((index) => {
            const metaOffset = index * 4;
            const offset = chunk.contentBytesBaseOffset + chunk.contentMetaList[metaOffset];
            const length = chunk.contentMetaList[metaOffset + 1];
            const bytes = chunk.contentBytesBuffer.subarray(offset, offset + length);
            return {bytes, decoded: decodeRawTermContentTokenBinary(bytes, textDecoder)};
        });
        expect(contents[0].decoded).toStrictEqual({
            rules: 'rule\\value',
            definitionTags: 'tag\\value',
            termTags: 'term-tag',
            glossaryJson: '["same","wrapped"]',
        });
        expect(contents[1].decoded).toStrictEqual(contents[0].decoded);
        expect(chunk.contentMetaList[2]).toBe(chunk.contentMetaList[6]);
        expect(chunk.contentMetaList[3]).toBe(chunk.contentMetaList[7]);
        expect(chunk.contentMetaList[0]).toBe(chunk.contentMetaList[4]);
        expect(chunk.contentMetaList[8]).toBe(chunk.contentMetaList[12]);
        expect(chunk.contentMetaList[8]).toBeGreaterThan(chunk.contentMetaList[0]);
        expect(chunk.contentUniqueIndexList).toStrictEqual(new Uint32Array([0, 0, 1, 1]));
        expect(chunk.contentDedupPlan?.uniqueCount).toBe(2);
        expect(hashTermEntryContentBytesPair(contents[0].bytes)).toEqual([
            chunk.contentMetaList[2],
            chunk.contentMetaList[3],
        ]);

        const malformed = Uint8Array.from(contents[0].bytes.filter((value) => value !== 0));
        expect(decodeRawTermContentTokenBinary(malformed, textDecoder)).toBeNull();

        const formattedChunks = [];
        await parseTermBankWithWasmColumnChunks(
            textEncoder.encode(`[
                ["formatted", "", "", "", 0, [ "same", { "type" : "text", "text" : "wrapped" } ], 1, ""],
                ["canonical", "", "", "", 0, ["same","wrapped"], 2, ""]
            ]`),
            3,
            (chunk2) => { formattedChunks.push(chunk2); },
            8,
            {emitContentSlab: true, emitTokenBinaryContent: true},
        );
        const [formattedChunk] = formattedChunks;
        expect(formattedChunk.contentMetaList[2]).toBe(formattedChunk.contentMetaList[6]);
        expect(formattedChunk.contentMetaList[3]).toBe(formattedChunk.contentMetaList[7]);
        expect(formattedChunk.contentMetaList[1]).toBe(formattedChunk.contentMetaList[5]);
    });
});
