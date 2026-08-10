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

import {parseJson} from '../core/json.js';
import {RetryablePromiseCache} from '../core/retryable-promise-cache.js';
import {createTermRecordPreinternedPlanBuilder} from './term-record-preinterned-plan.js';

const META_U32_FIELDS = 17;
const U8_BACKSLASH = 0x5c;
const U8_QUOTE = 0x22;
const U8_N = 0x6e;
const U8_U = 0x75;
const U8_L = 0x6c;
const U8_ARRAY_OPEN = 0x5b;
const U8_ARRAY_CLOSE = 0x5d;
const U8_COMMA = 0x2c;

const CONTENT_META_U32_FIELDS = 4;
const DEFAULT_ROW_CHUNK_SIZE = 2048;
const INITIAL_META_ROWS_PER_SOURCE = 2048;
const MAX_META_ROW_CAPACITY = Math.floor(0xffffffff / (META_U32_FIELDS * 4));
const EMPTY_UINT8_ARRAY = new Uint8Array(0);
/** @typedef {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}} ParsedTermBankRow */
const wasmCache = new RetryablePromiseCache();

/** @type {TextDecoder} */
const textDecoder = new TextDecoder();
/** @type {TextEncoder} */
const textEncoder = new TextEncoder();
/** @type {{bufferSetupMs: number, allocationMs: number, nativeStringPlanAllocationMs?: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, rowDecodeMs: number, nativeStringPlanMs?: number, nativeStringPlanChunkCount?: number, nativeStringPlanFallbackChunkCount?: number, chunkDispatchMs: number, rowCount: number, metaCapacity: number, metaAllocatedBytes: number, encodedContentBytes: number, contentCapacity: number, initialContentBytesPerRow: number, chunkCount: number, chunkSize: number, maxPendingChunks: number, minimalDecode: boolean, includeContentMetadata: boolean, copyContentBytes: boolean, reuseExpressionForReadingDecode: boolean, skipTagRuleDecode: boolean, lazyGlossaryDecode: boolean, mediaHintFastScan: boolean}|null} */
let lastTermBankWasmParseProfile = null;

export class TermBankWasmResourceError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @override */
        this.name = 'TermBankWasmResourceError';
    }
}

/**
 * @returns {Promise<{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, wasm_get_last_parse_capacity: () => number, wasm_get_last_content_capacity: () => number, parse_term_bank: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, parse_term_bank_with_media_hints: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, build_term_string_plan: (jsonPtr: number, metasPtr: number, rowStart: number, rowCount: number, stringsPtr: number, stringsCapacity: number, stringLengthsPtr: number, stringOffsetsPtr: number, stringHashesPtr: number, expressionIndexesPtr: number, readingIndexesPtr: number, hashTablePtr: number, hashTableSize: number, uniqueCountPtr: number) => number, encode_term_content: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_no_hash: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_token_binary: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_token_binary_dedup: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number, hashTablePtr: number, hashTableSize: number, uniqueIndexesPtr: number, uniqueCountPtr: number) => number}>}
 */
async function getWasm() {
    return await wasmCache.get(async () => {
        const url = new URL('../../lib/term-bank-parser.wasm', import.meta.url);
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        const instance = await WebAssembly.instantiate(bytes, {});
        const exports = /** @type {WebAssembly.Exports & {memory?: WebAssembly.Memory, wasm_reset_heap?: () => void, wasm_alloc?: (size: number) => number, wasm_get_last_parse_capacity?: () => number, wasm_get_last_content_capacity?: () => number, parse_term_bank?: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, parse_term_bank_with_media_hints?: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, build_term_string_plan?: (jsonPtr: number, metasPtr: number, rowStart: number, rowCount: number, stringsPtr: number, stringsCapacity: number, stringLengthsPtr: number, stringOffsetsPtr: number, stringHashesPtr: number, expressionIndexesPtr: number, readingIndexesPtr: number, hashTablePtr: number, hashTableSize: number, uniqueCountPtr: number) => number, encode_term_content?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_no_hash?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_token_binary?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_token_binary_dedup?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number, hashTablePtr: number, hashTableSize: number, uniqueIndexesPtr: number, uniqueCountPtr: number) => number}} */ (instance.instance.exports);
        if (
            !(exports.memory instanceof WebAssembly.Memory) ||
            typeof exports.wasm_reset_heap !== 'function' ||
            typeof exports.wasm_alloc !== 'function' ||
            typeof exports.wasm_get_last_parse_capacity !== 'function' ||
            typeof exports.wasm_get_last_content_capacity !== 'function' ||
            typeof exports.parse_term_bank !== 'function' ||
            typeof exports.parse_term_bank_with_media_hints !== 'function' ||
            typeof exports.build_term_string_plan !== 'function' ||
            typeof exports.encode_term_content !== 'function' ||
            typeof exports.encode_term_content_no_hash !== 'function' ||
            typeof exports.encode_term_content_token_binary !== 'function' ||
            typeof exports.encode_term_content_token_binary_dedup !== 'function'
        ) {
            throw new Error('term-bank wasm parser exports are invalid');
        }
        return {
            memory: exports.memory,
            wasm_reset_heap: exports.wasm_reset_heap,
            wasm_alloc: exports.wasm_alloc,
            wasm_get_last_parse_capacity: exports.wasm_get_last_parse_capacity,
            wasm_get_last_content_capacity: exports.wasm_get_last_content_capacity,
            parse_term_bank: exports.parse_term_bank,
            parse_term_bank_with_media_hints: exports.parse_term_bank_with_media_hints,
            build_term_string_plan: exports.build_term_string_plan,
            encode_term_content: exports.encode_term_content,
            encode_term_content_no_hash: exports.encode_term_content_no_hash,
            encode_term_content_token_binary: exports.encode_term_content_token_binary,
            encode_term_content_token_binary_dedup: exports.encode_term_content_token_binary_dedup,
        };
    });
}

/**
 * @returns {{bufferSetupMs: number, allocationMs: number, nativeStringPlanAllocationMs?: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, rowDecodeMs: number, nativeStringPlanMs?: number, nativeStringPlanChunkCount?: number, nativeStringPlanFallbackChunkCount?: number, chunkDispatchMs: number, rowCount: number, metaCapacity: number, metaAllocatedBytes: number, encodedContentBytes: number, contentCapacity: number, initialContentBytesPerRow: number, chunkCount: number, chunkSize: number, maxPendingChunks: number, minimalDecode: boolean, includeContentMetadata: boolean, copyContentBytes: boolean, reuseExpressionForReadingDecode: boolean, skipTagRuleDecode: boolean, lazyGlossaryDecode: boolean, mediaHintFastScan: boolean}|null}
 */
export function consumeLastTermBankWasmParseProfile() {
    const value = lastTermBankWasmParseProfile;
    lastTermBankWasmParseProfile = null;
    return value;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{start: number, end: number}|null}
 */
function getJsonArrayContentSpan(bytes) {
    let start = 0;
    let end = bytes.byteLength;
    while (start < end && isJsonWhitespace(bytes[start])) { ++start; }
    while (end > start && isJsonWhitespace(bytes[end - 1])) { --end; }
    if (start >= end || bytes[start] !== U8_ARRAY_OPEN || bytes[end - 1] !== U8_ARRAY_CLOSE) { return null; }
    ++start;
    --end;
    while (start < end && isJsonWhitespace(bytes[start])) { ++start; }
    while (end > start && isJsonWhitespace(bytes[end - 1])) { --end; }
    return {start, end};
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isJsonWhitespace(value) {
    return value === 0x20 || value === 0x0a || value === 0x0d || value === 0x09;
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function decodeJsonStringToken(source, start, length) {
    if (length < 2 || source[start] !== U8_QUOTE || source[start + length - 1] !== U8_QUOTE) {
        return '';
    }
    if (length === 2) {
        return '';
    }
    const valueStart = start + 1;
    const valueEnd = start + length - 1;
    const valueBytes = source.subarray(valueStart, valueEnd);
    if (!valueBytes.includes(U8_BACKSLASH)) {
        return textDecoder.decode(valueBytes);
    }
    const quoted = textDecoder.decode(source.subarray(start, start + length));
    return /** @type {string} */ (parseJson(quoted));
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {Uint8Array|null}
 */
function getUnescapedJsonStringTokenBytes(source, start, length) {
    if (length < 2 || source[start] !== U8_QUOTE || source[start + length - 1] !== U8_QUOTE) {
        return null;
    }
    if (length === 2) {
        return EMPTY_UINT8_ARRAY;
    }
    const valueStart = start + 1;
    const valueEnd = start + length - 1;
    const valueBytes = source.subarray(valueStart, valueEnd);
    return valueBytes.includes(U8_BACKSLASH) ? null : valueBytes;
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {string|null}
 */
function decodeNullableJsonStringToken(source, start, length) {
    if (length === 4 && source[start] === U8_N && source[start + 1] === U8_U && source[start + 2] === U8_L && source[start + 3] === U8_L) {
        return null;
    }
    return decodeJsonStringToken(source, start, length);
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {boolean}
 */
function isEmptyJsonStringToken(source, start, length) {
    return length === 2 && source[start] === U8_QUOTE && source[start + 1] === U8_QUOTE;
}

/**
 * @param {Uint8Array} source
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function decodeRawToken(source, start, length) {
    if (length <= 0) { return ''; }
    return textDecoder.decode(source.subarray(start, start + length));
}

/**
 * @param {Uint8Array} source
 * @param {number} startA
 * @param {number} lengthA
 * @param {number} startB
 * @param {number} lengthB
 * @returns {boolean}
 */
function tokenBytesEqual(source, startA, lengthA, startB, lengthB) {
    if (lengthA !== lengthB) { return false; }
    for (let i = 0; i < lengthA; ++i) {
        if (source[startA + i] !== source[startB + i]) {
            return false;
        }
    }
    return true;
}

/**
 * @param {Uint8Array|Uint8Array[]} contentBytes
 * @param {boolean} includeContentMetadata
 * @param {number} initialContentBytesPerRow
 * @param {boolean} mediaHintFastScan
 * @param {boolean} computeContentHashes
 * @param {boolean} emitTokenBinaryContent
 * @param {boolean} deduplicateContent
 * @returns {Promise<{wasm: Awaited<ReturnType<typeof getWasm>>|null, jsonPtr: number, jsonLength: number, metasPtr: number, contentMetasPtr: number, contentUniqueIndexesPtr: number, heap: Uint8Array, source: Uint8Array, metas: Uint32Array, contentMetas: Uint32Array, contentOutPtr: number, contentUniqueIndexes: Uint32Array, contentUniqueCount: number, rowCount: number, metaCapacity: number, encodedContentBytes: number, contentCapacity: number, initialContentBytesPerRow: number, allocationMs: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number}>}
 * @throws {Error}
 */
async function parseTermBankWasmBuffers(contentBytes, includeContentMetadata, initialContentBytesPerRow, mediaHintFastScan, computeContentHashes, emitTokenBinaryContent, deduplicateContent) {
    const sourceArrays = Array.isArray(contentBytes) ? contentBytes : [contentBytes];
    /** @type {Array<{bytes: Uint8Array, start: number, end: number}>} */
    const sourceSpans = [];
    let jsonLength = sourceArrays.length > 1 ? 2 : 0;
    for (const bytes of sourceArrays) {
        if (sourceArrays.length === 1) {
            sourceSpans.push({bytes, start: 0, end: bytes.byteLength});
            jsonLength = bytes.byteLength;
            continue;
        }
        const span = getJsonArrayContentSpan(bytes);
        if (span === null) { throw new Error('Expected a JSON array in term-bank source fragment'); }
        if (span.end > span.start) {
            sourceSpans.push({bytes, ...span});
            jsonLength += span.end - span.start;
        }
    }
    if (sourceArrays.length > 1) { jsonLength += Math.max(0, sourceSpans.length - 1); }
    if (jsonLength === 0) {
        return {
            wasm: null,
            jsonPtr: 0,
            jsonLength: 0,
            metasPtr: 0,
            contentMetasPtr: 0,
            contentUniqueIndexesPtr: 0,
            heap: new Uint8Array(0),
            source: new Uint8Array(0),
            metas: new Uint32Array(0),
            contentMetas: new Uint32Array(0),
            contentOutPtr: 0,
            contentUniqueIndexes: new Uint32Array(0),
            contentUniqueCount: 0,
            rowCount: 0,
            metaCapacity: 0,
            encodedContentBytes: 0,
            contentCapacity: 0,
            initialContentBytesPerRow: 0,
            allocationMs: 0,
            copyJsonMs: 0,
            parseBankMs: 0,
            encodeContentMs: 0,
        };
    }
    const wasm = await getWasm();
    wasm.wasm_reset_heap();
    let allocationMs = 0;
    let copyJsonMs = 0;
    let parseBankMs = 0;
    let encodeContentMs = 0;
    let tStart = Date.now();
    const jsonPtr = wasm.wasm_alloc(jsonLength);
    allocationMs += Math.max(0, Date.now() - tStart);
    if (jsonPtr === 0) {
        throw new TermBankWasmResourceError('Failed to allocate wasm json buffer');
    }
    tStart = Date.now();
    const inputHeap = new Uint8Array(wasm.memory.buffer);
    if (sourceArrays.length === 1) {
        inputHeap.set(sourceArrays[0], jsonPtr);
    } else {
        let cursor = jsonPtr;
        inputHeap[cursor++] = U8_ARRAY_OPEN;
        for (let i = 0; i < sourceSpans.length; ++i) {
            if (i > 0) { inputHeap[cursor++] = U8_COMMA; }
            const {bytes, start, end} = sourceSpans[i];
            inputHeap.set(bytes.subarray(start, end), cursor);
            cursor += end - start;
        }
        inputHeap[cursor] = U8_ARRAY_CLOSE;
    }
    copyJsonMs += Math.max(0, Date.now() - tStart);

    const initialMetaCapacity = Math.min(
        MAX_META_ROW_CAPACITY,
        Math.max(8192, sourceSpans.length * INITIAL_META_ROWS_PER_SOURCE),
    );
    tStart = Date.now();
    const outPtr = wasm.wasm_alloc(initialMetaCapacity * META_U32_FIELDS * 4);
    allocationMs += Math.max(0, Date.now() - tStart);
    if (outPtr === 0) {
        throw new TermBankWasmResourceError('Failed to allocate wasm term metadata buffer');
    }
    tStart = Date.now();
    const rowCount = mediaHintFastScan ?
        wasm.parse_term_bank_with_media_hints(jsonPtr, jsonLength, outPtr, initialMetaCapacity) :
        wasm.parse_term_bank(jsonPtr, jsonLength, outPtr, initialMetaCapacity);
    parseBankMs += Math.max(0, Date.now() - tStart);
    if (rowCount < 0) {
        if (rowCount === -2) {
            throw new TermBankWasmResourceError('Failed to grow wasm term metadata buffer');
        }
        throw new Error(`term-bank parser failed with code ${rowCount}`);
    }
    const metaCapacity = wasm.wasm_get_last_parse_capacity();
    if (metaCapacity < rowCount) {
        throw new Error('term-bank parser returned an invalid metadata capacity');
    }

    if (!includeContentMetadata) {
        const heap = new Uint8Array(wasm.memory.buffer);
        const metas = new Uint32Array(wasm.memory.buffer, outPtr, rowCount * META_U32_FIELDS);
        const source = heap.subarray(jsonPtr, jsonPtr + jsonLength);
        return {
            wasm,
            jsonPtr,
            jsonLength,
            metasPtr: outPtr,
            contentMetasPtr: 0,
            contentUniqueIndexesPtr: 0,
            heap,
            source,
            metas,
            contentMetas: new Uint32Array(0),
            contentOutPtr: 0,
            contentUniqueIndexes: new Uint32Array(0),
            contentUniqueCount: 0,
            rowCount,
            metaCapacity,
            encodedContentBytes: 0,
            contentCapacity: 0,
            initialContentBytesPerRow: 0,
            allocationMs,
            copyJsonMs,
            parseBankMs,
            encodeContentMs,
        };
    }

    tStart = Date.now();
    const contentMetaPtr = wasm.wasm_alloc(rowCount * CONTENT_META_U32_FIELDS * 4);
    allocationMs += Math.max(0, Date.now() - tStart);
    if (contentMetaPtr === 0) {
        throw new TermBankWasmResourceError('Failed to allocate wasm content metadata buffer');
    }
    const useInlineContentDedup = deduplicateContent && computeContentHashes && emitTokenBinaryContent && rowCount > 0;
    let contentHashTablePtr = 0;
    let contentHashTableSize = 0;
    let contentUniqueIndexesPtr = 0;
    let contentUniqueCountPtr = 0;
    if (useInlineContentDedup) {
        contentHashTableSize = 1;
        while (contentHashTableSize < rowCount * 2) { contentHashTableSize *= 2; }
        contentHashTablePtr = wasm.wasm_alloc(contentHashTableSize * 4);
        contentUniqueIndexesPtr = wasm.wasm_alloc(rowCount * 4);
        contentUniqueCountPtr = wasm.wasm_alloc(4);
        if (contentHashTablePtr === 0 || contentUniqueIndexesPtr === 0 || contentUniqueCountPtr === 0) {
            throw new TermBankWasmResourceError('Failed to allocate wasm term-content dedupe buffers');
        }
    }
    const normalizedInitialContentBytesPerRow = Number.isFinite(initialContentBytesPerRow) ? Math.max(16, Math.min(512, Math.trunc(initialContentBytesPerRow))) : 48;
    const contentOutCapacity = Math.min(
        0x7fffffff,
        Math.max(1024 * 1024, rowCount * normalizedInitialContentBytesPerRow),
    );
    tStart = Date.now();
    const contentOutPtr = wasm.wasm_alloc(contentOutCapacity);
    allocationMs += Math.max(0, Date.now() - tStart);
    if (contentOutPtr === 0) {
        throw new TermBankWasmResourceError('Failed to allocate wasm content buffer');
    }
    tStart = Date.now();
    const encodedContentBytes = useInlineContentDedup ?
        (() => {
            new Uint32Array(wasm.memory.buffer, contentHashTablePtr, contentHashTableSize).fill(0);
            new Uint32Array(wasm.memory.buffer, contentUniqueCountPtr, 1)[0] = 0;
            return wasm.encode_term_content_token_binary_dedup(
                jsonPtr,
                outPtr,
                rowCount,
                contentOutPtr,
                contentOutCapacity,
                contentMetaPtr,
                contentHashTablePtr,
                contentHashTableSize,
                contentUniqueIndexesPtr,
                contentUniqueCountPtr,
            );
        })() :
        (
            emitTokenBinaryContent ?
                wasm.encode_term_content_token_binary(
                    jsonPtr,
                    outPtr,
                    rowCount,
                    contentOutPtr,
                    contentOutCapacity,
                    contentMetaPtr,
                ) :
                (computeContentHashes ? wasm.encode_term_content : wasm.encode_term_content_no_hash)(
                    jsonPtr,
                    outPtr,
                    rowCount,
                    contentOutPtr,
                    contentOutCapacity,
                    contentMetaPtr,
                )
        );
    encodeContentMs += Math.max(0, Date.now() - tStart);
    if (encodedContentBytes < 0) {
        if (encodedContentBytes === -2) {
            throw new TermBankWasmResourceError('Failed to grow wasm term-content buffer');
        }
        throw new Error(`term-content encoder failed with code ${encodedContentBytes}`);
    }
    const contentCapacity = wasm.wasm_get_last_content_capacity();
    if (contentCapacity < encodedContentBytes) {
        throw new Error('term-content encoder returned an invalid output capacity');
    }
    const contentUniqueCount = useInlineContentDedup ?
        new Uint32Array(wasm.memory.buffer, contentUniqueCountPtr, 1)[0] :
        0;

    const heap = new Uint8Array(wasm.memory.buffer);
    const metas = new Uint32Array(wasm.memory.buffer, outPtr, rowCount * META_U32_FIELDS);
    const source = heap.subarray(jsonPtr, jsonPtr + jsonLength);
    const contentMetas = new Uint32Array(wasm.memory.buffer, contentMetaPtr, rowCount * CONTENT_META_U32_FIELDS);
    const contentUniqueIndexes = contentUniqueIndexesPtr === 0 ?
        new Uint32Array(0) :
        new Uint32Array(wasm.memory.buffer, contentUniqueIndexesPtr, rowCount);
    return {
        wasm,
        jsonPtr,
        jsonLength,
        metasPtr: outPtr,
        contentMetasPtr: contentMetaPtr,
        contentUniqueIndexesPtr,
        heap,
        source,
        metas,
        contentMetas,
        contentOutPtr,
        contentUniqueIndexes,
        contentUniqueCount,
        rowCount,
        metaCapacity,
        encodedContentBytes,
        contentCapacity,
        initialContentBytesPerRow: normalizedInitialContentBytesPerRow,
        allocationMs,
        copyJsonMs,
        parseBankMs,
        encodeContentMs,
    };
}

/**
 * @param {Awaited<ReturnType<typeof getWasm>>} wasm
 * @param {number} size
 * @param {string} label
 * @returns {number}
 * @throws {Error}
 */
function allocateWasmBuffer(wasm, size, label) {
    const pointer = wasm.wasm_alloc(Math.max(1, size));
    if (pointer === 0) {
        throw new TermBankWasmResourceError(`Failed to allocate wasm ${label} buffer`);
    }
    return pointer;
}

/**
 * @param {Awaited<ReturnType<typeof getWasm>>} wasm
 * @param {number} rowCapacity
 * @param {number} stringsCapacity
 * @returns {{rowCapacity: number, stringsCapacity: number, stringsPtr: number, stringLengthsPtr: number, stringOffsetsPtr: number, stringHashesPtr: number, expressionIndexesPtr: number, readingIndexesPtr: number, hashTablePtr: number, hashTableSize: number, uniqueCountPtr: number}}
 * @throws {Error}
 */
function createNativeTermStringPlanScratch(wasm, rowCapacity, stringsCapacity) {
    const maxUniqueCount = rowCapacity * 2;
    let hashTableSize = 1;
    while (hashTableSize < maxUniqueCount * 2) { hashTableSize *= 2; }
    return {
        rowCapacity,
        stringsCapacity: Math.max(1, stringsCapacity),
        stringsPtr: allocateWasmBuffer(wasm, stringsCapacity, 'term string arena'),
        stringLengthsPtr: allocateWasmBuffer(wasm, maxUniqueCount * 2, 'term string length'),
        stringOffsetsPtr: allocateWasmBuffer(wasm, maxUniqueCount * 4, 'term string offset'),
        stringHashesPtr: allocateWasmBuffer(wasm, maxUniqueCount * 4, 'term string hash'),
        expressionIndexesPtr: allocateWasmBuffer(wasm, rowCapacity * 4, 'term expression index'),
        readingIndexesPtr: allocateWasmBuffer(wasm, rowCapacity * 4, 'term reading index'),
        hashTablePtr: allocateWasmBuffer(wasm, hashTableSize * 4, 'term string hash table'),
        hashTableSize,
        uniqueCountPtr: allocateWasmBuffer(wasm, 4, 'term string count'),
    };
}

/**
 * @param {Awaited<ReturnType<typeof getWasm>>} wasm
 * @param {number} jsonPtr
 * @param {number} metasPtr
 * @param {number} rowStart
 * @param {number} rowCount
 * @param {ReturnType<typeof createNativeTermStringPlanScratch>} scratch
 * @returns {(import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan & {stringOffsets: Uint32Array})|null}
 * @throws {Error}
 */
function buildNativeTermStringPlan(wasm, jsonPtr, metasPtr, rowStart, rowCount, scratch) {
    if (rowCount > scratch.rowCapacity) {
        throw new Error('Native term string plan row capacity is too small');
    }
    new Uint32Array(wasm.memory.buffer, scratch.hashTablePtr, scratch.hashTableSize).fill(0);
    new Uint32Array(wasm.memory.buffer, scratch.uniqueCountPtr, 1)[0] = 0;
    const stringsLength = wasm.build_term_string_plan(
        jsonPtr,
        metasPtr,
        rowStart,
        rowCount,
        scratch.stringsPtr,
        scratch.stringsCapacity,
        scratch.stringLengthsPtr,
        scratch.stringOffsetsPtr,
        scratch.stringHashesPtr,
        scratch.expressionIndexesPtr,
        scratch.readingIndexesPtr,
        scratch.hashTablePtr,
        scratch.hashTableSize,
        scratch.uniqueCountPtr,
    );
    if (stringsLength === -4) {
        return null;
    }
    if (stringsLength === -5) {
        throw new Error('Term expression or reading exceeds the binary record limit');
    }
    if (stringsLength < 0) {
        throw new Error(`Native term string plan failed with code ${stringsLength}`);
    }
    const uniqueCount = new Uint32Array(wasm.memory.buffer, scratch.uniqueCountPtr, 1)[0];
    return {
        stringLengths: new Uint16Array(wasm.memory.buffer, scratch.stringLengthsPtr, uniqueCount),
        stringHashes: new Uint32Array(wasm.memory.buffer, scratch.stringHashesPtr, uniqueCount),
        stringOffsets: new Uint32Array(wasm.memory.buffer, scratch.stringOffsetsPtr, uniqueCount),
        stringsBuffer: new Uint8Array(wasm.memory.buffer, scratch.stringsPtr, stringsLength),
        expressionIndexes: new Uint32Array(wasm.memory.buffer, scratch.expressionIndexesPtr, rowCount),
        readingIndexes: new Uint32Array(wasm.memory.buffer, scratch.readingIndexesPtr, rowCount),
    };
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} metas
 * @param {Uint32Array} contentMetas
 * @param {Uint8Array} heap
 * @param {number} contentOutPtr
 * @param {number} version
 * @param {number} i
 * @param {boolean} copyContentBytes
 * @param {boolean} includeContentMetadata
 * @param {boolean} reuseExpressionForReadingDecode
 * @param {boolean} skipTagRuleDecode
 * @param {boolean} lazyGlossaryDecode
 * @param {boolean} mediaHintFastScan
 * @returns {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}}
 */
function decodeParsedTermRow(source, metas, contentMetas, heap, contentOutPtr, version, i, copyContentBytes, includeContentMetadata, reuseExpressionForReadingDecode, skipTagRuleDecode, lazyGlossaryDecode, mediaHintFastScan) {
    const o = i * META_U32_FIELDS;
    const c = i * CONTENT_META_U32_FIELDS;
    const expressionStart = metas[o + 0];
    const expressionLength = metas[o + 1];
    const readingStart = metas[o + 2];
    const readingLength = metas[o + 3];
    const expression = decodeJsonStringToken(source, expressionStart, expressionLength);
    const readingIsEmpty = readingLength === 2 && source[readingStart] === U8_QUOTE && source[readingStart + 1] === U8_QUOTE;
    const reuseExpressionReading = (
        reuseExpressionForReadingDecode &&
        (
            readingIsEmpty ||
            tokenBytesEqual(source, expressionStart, expressionLength, readingStart, readingLength)
        )
    );
    const reading = reuseExpressionReading ?
        expression :
        decodeJsonStringToken(source, readingStart, readingLength);
    const definitionTags = skipTagRuleDecode ? '' : (decodeNullableJsonStringToken(source, metas[o + 4], metas[o + 5]) ?? '');
    const rules = skipTagRuleDecode ? '' : decodeJsonStringToken(source, metas[o + 6], metas[o + 7]);
    const score = metas[o + 8] | 0;
    const glossaryStart = metas[o + 9];
    const glossaryLength = metas[o + 10];
    const glossaryJsonBytes = source.subarray(glossaryStart, glossaryStart + glossaryLength);
    const glossaryJson = lazyGlossaryDecode ? '' : decodeRawToken(source, glossaryStart, glossaryLength);
    const glossaryMayContainMedia = mediaHintFastScan ? metas[o + 14] === 1 : void 0;
    const sequenceValue = metas[o + 11] | 0;
    const sequence = version >= 3 && sequenceValue >= 0 ? sequenceValue : null;
    const termTags = skipTagRuleDecode ? '' : (version >= 3 ? (decodeNullableJsonStringToken(source, metas[o + 12], metas[o + 13]) ?? '') : '');
    let termEntryContentHash1;
    let termEntryContentHash2;
    let termEntryContentBytes = EMPTY_UINT8_ARRAY;
    if (includeContentMetadata) {
        const contentOffset = contentMetas[c + 0];
        const contentLength = contentMetas[c + 1];
        const hash1 = contentMetas[c + 2];
        const hash2 = contentMetas[c + 3];
        const contentStart = contentOutPtr + contentOffset;
        const contentEnd = contentStart + contentLength;
        const contentSlice = heap.subarray(contentStart, contentEnd);
        termEntryContentBytes = copyContentBytes ? Uint8Array.from(contentSlice) : contentSlice;
        termEntryContentHash1 = hash1 >>> 0;
        termEntryContentHash2 = hash2 >>> 0;
    }
    return {
        expression,
        reading,
        definitionTags,
        rules,
        score,
        glossaryJson,
        glossaryJsonBytes: lazyGlossaryDecode ? glossaryJsonBytes : void 0,
        glossaryMayContainMedia,
        sequence,
        termTags,
        termEntryContentHash1,
        termEntryContentHash2,
        termEntryContentBytes,
    };
}

/**
 * @param {Uint8Array} source
 * @param {Uint32Array} metas
 * @param {Uint32Array} contentMetas
 * @param {Uint8Array} heap
 * @param {number} contentOutPtr
 * @param {number} version
 * @param {number} i
 * @param {boolean} copyContentBytes
 * @param {boolean} includeContentMetadata
 * @param {boolean} reuseExpressionForReadingDecode
 * @param {boolean} lazyGlossaryDecode
 * @param {boolean} mediaHintFastScan
 * @returns {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}}
 */
function decodeParsedTermRowMinimal(source, metas, contentMetas, heap, contentOutPtr, version, i, copyContentBytes, includeContentMetadata, reuseExpressionForReadingDecode, lazyGlossaryDecode, mediaHintFastScan) {
    const o = i * META_U32_FIELDS;
    const c = i * CONTENT_META_U32_FIELDS;
    const expressionStart = metas[o + 0];
    const expressionLength = metas[o + 1];
    const readingStart = metas[o + 2];
    const readingLength = metas[o + 3];
    const reuseExpressionReading = (
        reuseExpressionForReadingDecode &&
        (
            isEmptyJsonStringToken(source, readingStart, readingLength) ||
            tokenBytesEqual(source, expressionStart, expressionLength, readingStart, readingLength)
        )
    );
    const expressionBytes = getUnescapedJsonStringTokenBytes(source, expressionStart, expressionLength) ?? void 0;
    const readingBytes = reuseExpressionReading ?
        expressionBytes :
        (getUnescapedJsonStringTokenBytes(source, readingStart, readingLength) ?? void 0);
    const expression = typeof expressionBytes === 'undefined' ? decodeJsonStringToken(source, expressionStart, expressionLength) : '';
    const reading = reuseExpressionReading ?
        expression :
        (typeof readingBytes === 'undefined' ? decodeJsonStringToken(source, readingStart, readingLength) : '');
    const score = metas[o + 8] | 0;
    const glossaryStart = metas[o + 9];
    const glossaryLength = metas[o + 10];
    const glossaryJsonBytes = lazyGlossaryDecode ? source.subarray(glossaryStart, glossaryStart + glossaryLength) : void 0;
    const glossaryMayContainMedia = mediaHintFastScan ? metas[o + 14] === 1 : void 0;
    const sequenceValue = metas[o + 11] | 0;
    const sequence = version >= 3 && sequenceValue >= 0 ? sequenceValue : null;
    let termEntryContentHash1;
    let termEntryContentHash2;
    let termEntryContentBytes = EMPTY_UINT8_ARRAY;
    if (includeContentMetadata) {
        const contentOffset = contentMetas[c + 0];
        const contentLength = contentMetas[c + 1];
        const hash1 = contentMetas[c + 2];
        const hash2 = contentMetas[c + 3];
        const contentStart = contentOutPtr + contentOffset;
        const contentEnd = contentStart + contentLength;
        const contentSlice = heap.subarray(contentStart, contentEnd);
        termEntryContentBytes = copyContentBytes ? Uint8Array.from(contentSlice) : contentSlice;
        termEntryContentHash1 = hash1 >>> 0;
        termEntryContentHash2 = hash2 >>> 0;
    }
    return {
        expression,
        reading,
        expressionBytes,
        readingBytes,
        readingEqualsExpression: reuseExpressionReading,
        definitionTags: '',
        rules: '',
        score,
        glossaryJson: '[]',
        glossaryJsonBytes,
        glossaryMayContainMedia,
        sequence,
        termTags: '',
        termEntryContentHash1,
        termEntryContentHash2,
        termEntryContentBytes,
    };
}

/**
 * @param {Uint8Array|Uint8Array[]} contentBytes
 * @param {number} version
 * @param {(rows: {expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[], progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {number} [chunkSize]
 * @param {{copyContentBytes?: boolean, includeContentMetadata?: boolean, initialContentBytesPerRow?: number, minimalDecode?: boolean, reuseExpressionForReadingDecode?: boolean, skipTagRuleDecode?: boolean, lazyGlossaryDecode?: boolean, mediaHintFastScan?: boolean, preallocateChunkRows?: boolean, computeContentHashes?: boolean, maxPendingChunks?: number}} [options]
 * @returns {Promise<void>}
 */
export async function parseTermBankWithWasmChunks(contentBytes, version, onChunk, chunkSize = DEFAULT_ROW_CHUNK_SIZE, options = {}) {
    const copyContentBytes = options.copyContentBytes === true;
    const includeContentMetadata = options.includeContentMetadata !== false;
    const initialContentBytesPerRow = Number.isFinite(options.initialContentBytesPerRow) ? /** @type {number} */ (options.initialContentBytesPerRow) : 48;
    const minimalDecode = options.minimalDecode === true;
    const reuseExpressionForReadingDecode = options.reuseExpressionForReadingDecode === true;
    const skipTagRuleDecode = options.skipTagRuleDecode === true;
    const lazyGlossaryDecode = options.lazyGlossaryDecode === true;
    const mediaHintFastScan = options.mediaHintFastScan === true;
    const preallocateChunkRows = options.preallocateChunkRows === true;
    const computeContentHashes = options.computeContentHashes !== false;
    const maxPendingChunks = Number.isFinite(options.maxPendingChunks) ? Math.max(1, Math.min(4, Math.trunc(/** @type {number} */ (options.maxPendingChunks)))) : 1;
    const tBufferSetupStart = Date.now();
    const {
        heap,
        source,
        metas,
        contentMetas,
        contentOutPtr,
        rowCount,
        metaCapacity,
        encodedContentBytes,
        contentCapacity,
        initialContentBytesPerRow: normalizedInitialContentBytesPerRow,
        allocationMs,
        copyJsonMs,
        parseBankMs,
        encodeContentMs,
    } = await parseTermBankWasmBuffers(
        contentBytes,
        includeContentMetadata,
        initialContentBytesPerRow,
        mediaHintFastScan,
        computeContentHashes,
        false,
        false,
    );
    const bufferSetupMs = Math.max(0, Date.now() - tBufferSetupStart);
    if (rowCount === 0) {
        lastTermBankWasmParseProfile = {
            bufferSetupMs,
            allocationMs,
            copyJsonMs,
            parseBankMs,
            encodeContentMs,
            rowDecodeMs: 0,
            chunkDispatchMs: 0,
            rowCount: 0,
            metaCapacity,
            metaAllocatedBytes: metaCapacity * META_U32_FIELDS * 4,
            encodedContentBytes,
            contentCapacity,
            initialContentBytesPerRow: normalizedInitialContentBytesPerRow,
            chunkCount: 0,
            chunkSize: 0,
            maxPendingChunks,
            minimalDecode,
            includeContentMetadata,
            copyContentBytes,
            reuseExpressionForReadingDecode,
            skipTagRuleDecode,
            lazyGlossaryDecode,
            mediaHintFastScan,
        };
        return;
    }
    const normalizedChunkSize = Number.isFinite(chunkSize) ? Math.max(1, Math.trunc(chunkSize)) : DEFAULT_ROW_CHUNK_SIZE;
    const chunkCount = Math.max(1, Math.ceil(rowCount / normalizedChunkSize));
    /**
     * @param {number} size
     * @returns {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[]}
     */
    const createRowBuffer = (size) => /** @type {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[]} */ (new Array(size));
    /** @type {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[]} */
    let rows = preallocateChunkRows ? createRowBuffer(Math.min(normalizedChunkSize, rowCount)) : [];
    let rowsIndex = 0;
    let chunkIndex = 0;
    let rowDecodeMs = 0;
    let chunkDispatchMs = 0;
    /** @type {Promise<void>[]} */
    const pendingDispatches = [];
    /** @type {Promise<void>} */
    let dispatchTail = Promise.resolve();
    /**
     * @param {ParsedTermBankRow[]} chunk
     * @param {{processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}} progress
     * @returns {Promise<void>|null}
     */
    const enqueueChunk = (chunk, progress) => {
        const invoke = async () => {
            const tDispatchStart = Date.now();
            await onChunk(chunk, progress);
            chunkDispatchMs += Math.max(0, Date.now() - tDispatchStart);
        };
        const promise = pendingDispatches.length === 0 ? invoke() : dispatchTail.then(invoke);
        // Backpressure awaits the original promise. Observe it eagerly as well so
        // an early exit cannot leave a later chained dispatch rejection unhandled.
        void promise.catch(() => {});
        dispatchTail = promise;
        pendingDispatches.push(promise);
        return pendingDispatches.length >= maxPendingChunks ? /** @type {Promise<void>} */ (pendingDispatches.shift()) : null;
    };
    let tChunkDecodeStart = Date.now();
    for (let i = 0; i < rowCount; ++i) {
        const row = minimalDecode ?
            decodeParsedTermRowMinimal(source, metas, contentMetas, heap, contentOutPtr, version, i, copyContentBytes, includeContentMetadata, reuseExpressionForReadingDecode, lazyGlossaryDecode, mediaHintFastScan) :
            decodeParsedTermRow(source, metas, contentMetas, heap, contentOutPtr, version, i, copyContentBytes, includeContentMetadata, reuseExpressionForReadingDecode, skipTagRuleDecode, lazyGlossaryDecode, mediaHintFastScan);
        if (preallocateChunkRows) {
            rows[rowsIndex] = row;
            ++rowsIndex;
        } else {
            rows.push(row);
            rowsIndex = rows.length;
        }
        if (rowsIndex >= normalizedChunkSize) {
            rowDecodeMs += Math.max(0, Date.now() - tChunkDecodeStart);
            const chunk = rows;
            rows = preallocateChunkRows ? createRowBuffer(Math.min(normalizedChunkSize, rowCount - (i + 1))) : [];
            rowsIndex = 0;
            ++chunkIndex;
            const backpressure = enqueueChunk(chunk, {
                processedRows: i + 1,
                totalRows: rowCount,
                chunkIndex,
                chunkCount,
            });
            if (backpressure !== null) { await backpressure; }
            tChunkDecodeStart = Date.now();
        }
    }
    if (rowsIndex > 0) {
        rowDecodeMs += Math.max(0, Date.now() - tChunkDecodeStart);
        if (preallocateChunkRows) {
            rows.length = rowsIndex;
        }
        ++chunkIndex;
        const backpressure = enqueueChunk(rows, {
            processedRows: rowCount,
            totalRows: rowCount,
            chunkIndex,
            chunkCount,
        });
        if (backpressure !== null) { await backpressure; }
    }
    await Promise.all(pendingDispatches);
    lastTermBankWasmParseProfile = {
        bufferSetupMs,
        allocationMs,
        copyJsonMs,
        parseBankMs,
        encodeContentMs,
        rowDecodeMs,
        chunkDispatchMs,
        rowCount,
        metaCapacity,
        metaAllocatedBytes: metaCapacity * META_U32_FIELDS * 4,
        encodedContentBytes,
        contentCapacity,
        initialContentBytesPerRow: normalizedInitialContentBytesPerRow,
        chunkCount,
        chunkSize: normalizedChunkSize,
        maxPendingChunks,
        minimalDecode,
        includeContentMetadata,
        copyContentBytes,
        reuseExpressionForReadingDecode,
        skipTagRuleDecode,
        lazyGlossaryDecode,
        mediaHintFastScan,
    };
}

/**
 * Parses directly into the columnar payload consumed by the raw-byte importer.
 * Only rows which may contain media receive a compatibility row object.
 * @param {Uint8Array|Uint8Array[]} contentBytes
 * @param {number} version
 * @param {(chunk: {rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array, contentBytesList: Uint8Array[], contentHash1List: Uint32Array, contentHash2List: Uint32Array, contentBytesBuffer?: Uint8Array, contentBytesBaseOffset?: number, contentMetaList?: Uint32Array, contentUniqueIndexList: Uint32Array|null, contentDedupPlan: import('core').SafeAny|null, termRecordPreinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan, mediaRows: Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>}, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {number} [chunkSize]
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function parseTermBankWithWasmColumnChunks(contentBytes, version, onChunk, chunkSize = DEFAULT_ROW_CHUNK_SIZE, options = {}) {
    const initialContentBytesPerRow = Number.isFinite(options.initialContentBytesPerRow) ? /** @type {number} */ (options.initialContentBytesPerRow) : 48;
    const mediaHintFastScan = options.mediaHintFastScan === true;
    const computeContentHashes = options.computeContentHashes !== false;
    const emitContentSlab = options.emitContentSlab === true;
    const emitTokenBinaryContent = options.emitTokenBinaryContent === true;
    const useNativeStringPlan = options.useNativeStringPlan !== false;
    const emitTermByteLists = options.emitTermByteLists !== false;
    const maxPendingChunks = Number.isFinite(options.maxPendingChunks) ? Math.max(1, Math.min(4, Math.trunc(/** @type {number} */ (options.maxPendingChunks)))) : 1;
    const tBufferSetupStart = Date.now();
    const parsed = await parseTermBankWasmBuffers(
        contentBytes,
        true,
        initialContentBytesPerRow,
        mediaHintFastScan,
        computeContentHashes,
        emitTokenBinaryContent,
        emitContentSlab && computeContentHashes,
    );
    const bufferSetupMs = Math.max(0, Date.now() - tBufferSetupStart);
    const {contentOutPtr, contentUniqueCount, rowCount, metaCapacity, contentCapacity} = parsed;
    const normalizedChunkSize = Number.isFinite(chunkSize) ? Math.max(1, Math.trunc(chunkSize)) : DEFAULT_ROW_CHUNK_SIZE;
    const chunkCount = rowCount === 0 ? 0 : Math.ceil(rowCount / normalizedChunkSize);
    /** @type {ReturnType<typeof createNativeTermStringPlanScratch>[]} */
    const nativeStringPlanScratches = [];
    let nativeStringPlanAllocationMs = 0;
    if (useNativeStringPlan && rowCount > 0 && parsed.wasm !== null) {
        let maxChunkStringBytes = 1;
        let chunkStringBytes = 0;
        for (let i = 0; i < rowCount; ++i) {
            const offset = i * META_U32_FIELDS;
            chunkStringBytes += Math.max(0, parsed.metas[offset + 1] - 2);
            chunkStringBytes += Math.max(0, parsed.metas[offset + 3] - 2);
            if ((i + 1) % normalizedChunkSize === 0 || i + 1 === rowCount) {
                maxChunkStringBytes = Math.max(maxChunkStringBytes, chunkStringBytes);
                chunkStringBytes = 0;
            }
        }
        const tNativeAllocationStart = Date.now();
        for (let i = 0; i < maxPendingChunks; ++i) {
            nativeStringPlanScratches.push(
                createNativeTermStringPlanScratch(parsed.wasm, normalizedChunkSize, maxChunkStringBytes),
            );
        }
        nativeStringPlanAllocationMs = Math.max(0, Date.now() - tNativeAllocationStart);
    }
    const heap = parsed.wasm === null ? parsed.heap : new Uint8Array(parsed.wasm.memory.buffer);
    const source = parsed.wasm === null ? parsed.source : heap.subarray(parsed.jsonPtr, parsed.jsonPtr + parsed.jsonLength);
    const metas = parsed.wasm === null ?
        parsed.metas :
        new Uint32Array(parsed.wasm.memory.buffer, parsed.metasPtr, rowCount * META_U32_FIELDS);
    const contentMetas = parsed.wasm === null ?
        parsed.contentMetas :
        new Uint32Array(parsed.wasm.memory.buffer, parsed.contentMetasPtr, rowCount * CONTENT_META_U32_FIELDS);
    const contentUniqueIndexes = parsed.contentUniqueIndexesPtr === 0 || parsed.wasm === null ?
        parsed.contentUniqueIndexes :
        new Uint32Array(parsed.wasm.memory.buffer, parsed.contentUniqueIndexesPtr, rowCount);
    const contentDedupPlan = contentUniqueIndexes.length === rowCount && contentUniqueCount > 0 ?
        {
            uniqueCount: contentUniqueCount,
            resolvedFlags: new Uint8Array(contentUniqueCount),
            resolvedOffsets: new Float64Array(contentUniqueCount),
            resolvedLengths: new Uint32Array(contentUniqueCount),
            resolvedDictNames: new Array(contentUniqueCount),
            pendingEpochs: new Uint32Array(contentUniqueCount),
            pendingIndexes: new Uint32Array(contentUniqueCount),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: null,
        } :
        null;
    let rowDecodeMs = 0;
    let nativeStringPlanMs = 0;
    let nativeStringPlanChunkCount = 0;
    let nativeStringPlanFallbackChunkCount = 0;
    let chunkDispatchMs = 0;
    /** @type {Promise<void>[]} */
    const pendingDispatches = [];
    let dispatchTail = Promise.resolve();

    for (let start = 0, chunkIndex = 0; start < rowCount; start += normalizedChunkSize) {
        const tDecodeStart = Date.now();
        const end = Math.min(rowCount, start + normalizedChunkSize);
        const count = end - start;
        /** @type {Uint8Array[]} */
        const expressionBytesList = emitTermByteLists ? new Array(count) : [];
        /** @type {Uint8Array[]} */
        const readingBytesList = emitTermByteLists ? new Array(count) : [];
        const readingEqualsExpressionList = new Uint8Array(count);
        const scoreList = new Int32Array(count);
        const sequenceList = new Int32Array(count);
        /** @type {Uint8Array[]} */
        const contentBytesList = emitContentSlab ? [] : new Array(count);
        const contentHash1List = emitContentSlab ? new Uint32Array(0) : new Uint32Array(count);
        const contentHash2List = emitContentSlab ? new Uint32Array(0) : new Uint32Array(count);
        const contentMetaList = emitContentSlab ?
            contentMetas.subarray(start * CONTENT_META_U32_FIELDS, end * CONTENT_META_U32_FIELDS) :
            new Uint32Array(0);
        const tNativeStringPlanStart = Date.now();
        const nativeStringPlan = nativeStringPlanScratches.length === 0 || parsed.wasm === null ?
            null :
            buildNativeTermStringPlan(
                parsed.wasm,
                parsed.jsonPtr,
                parsed.metasPtr,
                start,
                count,
                nativeStringPlanScratches[chunkIndex % nativeStringPlanScratches.length],
            );
        nativeStringPlanMs += Math.max(0, Date.now() - tNativeStringPlanStart);
        if (nativeStringPlan === null) {
            if (nativeStringPlanScratches.length > 0) { ++nativeStringPlanFallbackChunkCount; }
        } else {
            ++nativeStringPlanChunkCount;
        }
        const expressionIndexes = nativeStringPlan?.expressionIndexes ?? new Uint32Array(count);
        const readingIndexes = nativeStringPlan?.readingIndexes ?? new Uint32Array(count);
        /** @type {ReturnType<typeof createTermRecordPreinternedPlanBuilder>|null} */
        const planBuilder = nativeStringPlan === null ? createTermRecordPreinternedPlanBuilder(count * 2) : null;
        /** @type {Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>} */
        const mediaRows = [];

        for (let sourceIndex = start, i = 0; sourceIndex < end; ++sourceIndex, ++i) {
            const o = sourceIndex * META_U32_FIELDS;
            const c = sourceIndex * CONTENT_META_U32_FIELDS;
            if (nativeStringPlan === null) {
                if (planBuilder === null) {
                    throw new Error('JavaScript term string plan builder is unavailable');
                }
                const expressionStart = metas[o + 0];
                const expressionLength = metas[o + 1];
                const readingStart = metas[o + 2];
                const readingLength = metas[o + 3];
                const expressionTokenBytes = getUnescapedJsonStringTokenBytes(source, expressionStart, expressionLength);
                const expressionBytes = (
                    expressionTokenBytes ??
                    textEncoder.encode(decodeJsonStringToken(source, expressionStart, expressionLength))
                );
                const readingEqualsExpression = (
                    isEmptyJsonStringToken(source, readingStart, readingLength) ||
                    tokenBytesEqual(source, expressionStart, expressionLength, readingStart, readingLength)
                );
                const readingTokenBytes = readingEqualsExpression ?
                    EMPTY_UINT8_ARRAY :
                    getUnescapedJsonStringTokenBytes(source, readingStart, readingLength);
                const readingBytes = readingEqualsExpression ?
                    EMPTY_UINT8_ARRAY :
                    (readingTokenBytes ?? textEncoder.encode(decodeJsonStringToken(source, readingStart, readingLength)));
                if (emitTermByteLists) {
                    expressionBytesList[i] = expressionBytes;
                    readingBytesList[i] = readingBytes;
                }
                readingEqualsExpressionList[i] = readingEqualsExpression ? 1 : 0;
                expressionIndexes[i] = planBuilder.internStringBytes(expressionBytes);
                readingIndexes[i] = readingEqualsExpression ?
                    expressionIndexes[i] :
                    planBuilder.internStringBytes(readingBytes);
            } else {
                const expressionIndex = expressionIndexes[i];
                const readingIndex = readingIndexes[i];
                const readingEqualsExpression = readingIndex === expressionIndex;
                readingEqualsExpressionList[i] = readingEqualsExpression ? 1 : 0;
                if (emitTermByteLists) {
                    const expressionOffset = nativeStringPlan.stringOffsets[expressionIndex];
                    const expressionLength = nativeStringPlan.stringLengths[expressionIndex];
                    expressionBytesList[i] = nativeStringPlan.stringsBuffer.subarray(
                        expressionOffset,
                        expressionOffset + expressionLength,
                    );
                    if (readingEqualsExpression) {
                        readingBytesList[i] = EMPTY_UINT8_ARRAY;
                    } else {
                        const readingOffset = nativeStringPlan.stringOffsets[readingIndex];
                        const readingLength = nativeStringPlan.stringLengths[readingIndex];
                        readingBytesList[i] = nativeStringPlan.stringsBuffer.subarray(
                            readingOffset,
                            readingOffset + readingLength,
                        );
                    }
                }
            }
            scoreList[i] = metas[o + 8] | 0;
            sequenceList[i] = version >= 3 ? (metas[o + 11] | 0) : -1;
            if (!emitContentSlab) {
                const contentOffset = contentMetas[c + 0];
                const contentLength = contentMetas[c + 1];
                contentBytesList[i] = heap.subarray(contentOutPtr + contentOffset, contentOutPtr + contentOffset + contentLength);
                contentHash1List[i] = contentMetas[c + 2] >>> 0;
                contentHash2List[i] = contentMetas[c + 3] >>> 0;
            }
            if (mediaHintFastScan && metas[o + 14] === 1) {
                mediaRows.push({
                    index: i,
                    row: decodeParsedTermRowMinimal(source, metas, contentMetas, heap, contentOutPtr, version, sourceIndex, false, true, true, true, true),
                });
            }
        }
        rowDecodeMs += Math.max(0, Date.now() - tDecodeStart);
        let termRecordPreinternedPlan;
        if (nativeStringPlan === null) {
            if (planBuilder === null) {
                throw new Error('Term string plan builder is unavailable');
            }
            termRecordPreinternedPlan = planBuilder.buildPlan(expressionIndexes, readingIndexes, count);
        } else {
            termRecordPreinternedPlan = nativeStringPlan;
        }
        const chunk = {
            rowCount: count,
            expressionBytesList,
            readingBytesList,
            readingEqualsExpressionList,
            scoreList,
            sequenceList,
            contentBytesList,
            contentHash1List,
            contentHash2List,
            contentBytesBuffer: emitContentSlab ? heap : void 0,
            contentBytesBaseOffset: emitContentSlab ? contentOutPtr : void 0,
            contentMetaList,
            contentUniqueIndexList: contentDedupPlan === null ? null : contentUniqueIndexes.subarray(start, end),
            contentDedupPlan,
            termRecordPreinternedPlan,
            mediaRows,
        };
        ++chunkIndex;
        const progress = {processedRows: end, totalRows: rowCount, chunkIndex, chunkCount};
        const invokeColumnChunk = async () => {
            const tDispatchStart = Date.now();
            const result = onChunk(chunk, progress);
            await result;
            chunkDispatchMs += Math.max(0, Date.now() - tDispatchStart);
        };
        const promise = pendingDispatches.length === 0 ? invokeColumnChunk() : dispatchTail.then(invokeColumnChunk);
        void promise.catch(() => {});
        dispatchTail = promise;
        pendingDispatches.push(promise);
        if (pendingDispatches.length >= maxPendingChunks) {
            await /** @type {Promise<void>} */ (pendingDispatches.shift());
        }
    }
    await Promise.all(pendingDispatches);
    lastTermBankWasmParseProfile = {
        bufferSetupMs,
        allocationMs: parsed.allocationMs,
        nativeStringPlanAllocationMs,
        copyJsonMs: parsed.copyJsonMs,
        parseBankMs: parsed.parseBankMs,
        encodeContentMs: parsed.encodeContentMs,
        rowDecodeMs,
        nativeStringPlanMs,
        nativeStringPlanChunkCount,
        nativeStringPlanFallbackChunkCount,
        chunkDispatchMs,
        rowCount,
        metaCapacity,
        metaAllocatedBytes: metaCapacity * META_U32_FIELDS * 4,
        encodedContentBytes: parsed.encodedContentBytes,
        contentCapacity,
        initialContentBytesPerRow: parsed.initialContentBytesPerRow,
        chunkCount,
        chunkSize: rowCount === 0 ? 0 : normalizedChunkSize,
        maxPendingChunks,
        minimalDecode: true,
        includeContentMetadata: true,
        copyContentBytes: false,
        reuseExpressionForReadingDecode: true,
        skipTagRuleDecode: true,
        lazyGlossaryDecode: true,
        mediaHintFastScan,
    };
}

/**
 * @param {Uint8Array} contentBytes
 * @param {number} version
 * @returns {Promise<{expression: string, reading: string, definitionTags: string, rules: string, score: number, glossaryJson: string, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[]>}
 */
export async function parseTermBankWithWasm(contentBytes, version) {
    /** @type {{expression: string, reading: string, definitionTags: string, rules: string, score: number, glossaryJson: string, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}[]} */
    const rows = [];
    await parseTermBankWithWasmChunks(
        contentBytes,
        version,
        (chunk) => {
            rows.push(...chunk);
        },
        DEFAULT_ROW_CHUNK_SIZE,
        {copyContentBytes: true},
    );
    return rows;
}
