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
import {safePerformance} from '../core/safe-performance.js';
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
const CONTENT_SIGNATURE_U32_FIELDS = 3;
const DEFAULT_ROW_CHUNK_SIZE = 2048;
const INITIAL_META_ROWS_PER_SOURCE = 10_000;
const OVERLAPPED_SOURCE_GROUP_COUNT = 1;
const DEFAULT_PARALLEL_SOURCE_WORKER_COUNT = 2;
const HIGH_CAPABILITY_PARALLEL_SOURCE_WORKER_COUNT = 3;
const HIGH_CAPABILITY_MIN_HARDWARE_CONCURRENCY = 8;
const LOW_MEMORY_DEVICE_GIB = 4;
const PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 4;
const MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 3;
const LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES = 24 * 1024 * 1024;
const PARALLEL_WORKER_READY_TIMEOUT_MS = 60_000;
const PARALLEL_WORKER_PARSE_TIMEOUT_MS = 300_000;
const PARALLEL_WORKER_CANCELLATION_POLL_MS = 25;
const LOW_MEMORY_PARALLEL_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_WASM32_BUFFER_BYTES = 0xffffffff;
const MAX_META_ROW_CAPACITY = Math.floor(0xffffffff / (META_U32_FIELDS * 4));
const EMPTY_UINT8_ARRAY = new Uint8Array(0);
/** @typedef {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}} ParsedTermBankRow */
/** @typedef {{rowCount: number, contentRowStart?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array, contentBytesList: Uint8Array[], contentHash1List: Uint32Array, contentHash2List: Uint32Array, contentBytesBuffer?: Uint8Array, contentBytesBaseOffset?: number, contentMetaList?: Uint32Array, contentUniqueIndexList: Uint32Array|null, contentDedupPlan: import('core').SafeAny|null, useResolvedContentReferences?: boolean, releaseBorrowedContent?: () => void, termRecordPreinternedPlan: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan, preparedLookupIndexes?: Map<string, import('./term-lookup-index-preparation.js').PreparedTermLookupIndex>, preparedLookupIndexEncodeMs?: number, mediaRows: Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>}} TermBankColumnChunk */
/** @typedef {{type?: unknown, id?: unknown, rowCount?: unknown, resultSentEpochMs?: unknown, borrowsWorkerMemory?: unknown, chunk?: unknown, profile?: unknown, error?: unknown}} ParallelParserWorkerMessage */
/** @typedef {{bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename?: string}} CompressedTermBankSource */
/** @typedef {Uint8Array|CompressedTermBankSource} ParallelTermBankSourceValue */
/** @typedef {{wasm: TermBankWasmExports, jsonPtr: number, jsonLength: number, sourceCount: number, inflateMs: number, compressedBytes: number, uncompressedBytes: number}} PreloadedTermBankSource */
/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, wasm_get_last_parse_capacity: () => number, wasm_get_last_content_capacity: () => number, inflate_and_join_term_banks: (...args: number[]) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number, parse_and_encode_term_bank_token_binary_dedup: (...args: number[]) => number, build_term_string_plan: (...args: number[]) => number, encode_term_lookup_index: (...args: number[]) => number, encode_term_content: (...args: number[]) => number, encode_term_content_no_hash: (...args: number[]) => number, encode_term_content_token_binary: (...args: number[]) => number, encode_term_content_token_binary_dedup: (...args: number[]) => number}} TermBankWasmExports */
/** @typedef {{stringLengths: Uint16Array, stringOffsets: Uint32Array, stringHashes: Uint32Array, stringsBuffer: Uint8Array, expressionIndexes: Uint32Array, readingIndexes: Uint32Array, readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array}} FusedTermStringPlan */
/** @typedef {{wasm: TermBankWasmExports|null, jsonPtr: number, jsonLength: number, metasPtr: number, contentMetasPtr: number, contentUniqueIndexesPtr: number, contentUniqueSignatures?: Uint32Array, heap: Uint8Array, source: Uint8Array, metas: Uint32Array, contentMetas: Uint32Array, contentOutPtr: number, contentUniqueIndexes: Uint32Array, contentUniqueCount: number, rowCount: number, metaCapacity: number, encodedContentBytes: number, contentCapacity: number, initialContentBytesPerRow: number, allocationMs: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, recentContentDedupHitCount?: number, fusedStringPlan?: FusedTermStringPlan}} ParsedTermBankWasmBuffers */
const wasmCache = new RetryablePromiseCache();
const wasmModuleCache = new RetryablePromiseCache();
/** @type {WebAssembly.Module|null} */
let suppliedWasmModule = null;

/** @type {TextDecoder} */
const textDecoder = new TextDecoder();
/** @type {TextEncoder} */
const textEncoder = new TextEncoder();
/** @type {{bufferSetupMs: number, allocationMs: number, nativeStringPlanAllocationMs?: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, recentContentDedupHitCount?: number, rowDecodeMs: number, nativeStringPlanMs?: number, nativeStringPlanChunkCount?: number, nativeStringPlanFallbackChunkCount?: number, chunkDispatchMs: number, sourcePreparationMs?: number, sourceDeliveryMs?: number, sourceTransferredBytes?: number, sourceInflateMs?: number, sourceCompressedBytes?: number, sourceUncompressedBytes?: number, resultCopyMs?: number, resultDeliveryMs?: number, orderedSinkWaitMs?: number, borrowedContentResultCount?: number, lookupIndexPrepareMs?: number, lookupIndexCompactMs?: number, lookupIndexEncodeMs?: number, rowCount: number, metaCapacity: number, metaAllocatedBytes: number, encodedContentBytes: number, contentCapacity: number, initialContentBytesPerRow: number, chunkCount: number, chunkSize: number, maxPendingChunks: number, minimalDecode: boolean, includeContentMetadata: boolean, copyContentBytes: boolean, reuseExpressionForReadingDecode: boolean, skipTagRuleDecode: boolean, lazyGlossaryDecode: boolean, mediaHintFastScan: boolean, parallelWorkerCount?: number, parallelPipelineGroupsPerWorker?: number, parallelGroupCount?: number, parallelWorkerWallMs?: number, parallelSourceReadWallMs?: number}|null} */
let lastTermBankWasmParseProfile = null;
/** @type {string|null} */
let lastParallelParserSkipReason = null;

export class TermBankWasmResourceError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @override */
        this.name = 'TermBankWasmResourceError';
    }
}

/**
 * Compiles the stateless parser module once so browser workers can reuse the
 * browser's compiled code through structured cloning.
 * @returns {Promise<WebAssembly.Module>}
 */
export async function compileTermBankWasmModule() {
    if (suppliedWasmModule !== null) { return suppliedWasmModule; }
    return await wasmModuleCache.get(async () => {
        const url = new URL('../../lib/term-bank-parser.wasm', import.meta.url);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load term-bank parser WASM: ${response.status}`);
        }
        return await WebAssembly.compile(await response.arrayBuffer());
    });
}

/**
 * Supplies a compiled module to a fresh parser worker before its first parse.
 * @param {WebAssembly.Module} module
 * @throws {TypeError} If module is not a compiled WebAssembly module.
 */
export function setTermBankWasmModule(module) {
    if (!(module instanceof WebAssembly.Module)) {
        throw new TypeError('Term-bank parser module is invalid');
    }
    suppliedWasmModule = module;
}

/**
 * @returns {Promise<TermBankWasmExports>}
 */
async function getWasm() {
    return await wasmCache.get(async () => {
        const module = await compileTermBankWasmModule();
        const instance = await WebAssembly.instantiate(module, {});
        const exports = /** @type {WebAssembly.Exports & Partial<TermBankWasmExports>} */ (instance.exports);
        if (
            !(exports.memory instanceof WebAssembly.Memory) ||
            typeof exports.wasm_reset_heap !== 'function' ||
            typeof exports.wasm_alloc !== 'function' ||
            typeof exports.wasm_get_last_parse_capacity !== 'function' ||
            typeof exports.wasm_get_last_content_capacity !== 'function' ||
            typeof exports.inflate_and_join_term_banks !== 'function' ||
            typeof exports.parse_term_bank !== 'function' ||
            typeof exports.parse_term_bank_with_media_hints !== 'function' ||
            typeof exports.parse_and_encode_term_bank_token_binary_dedup !== 'function' ||
            typeof exports.build_term_string_plan !== 'function' ||
            typeof exports.encode_term_lookup_index !== 'function' ||
            typeof exports.encode_term_content !== 'function' ||
            typeof exports.encode_term_content_no_hash !== 'function' ||
            typeof exports.encode_term_content_token_binary !== 'function' ||
            typeof exports.encode_term_content_token_binary_dedup !== 'function'
        ) {
            throw new Error('term-bank wasm parser exports are invalid');
        }
        return /** @type {TermBankWasmExports} */ ({
            memory: exports.memory,
            wasm_reset_heap: exports.wasm_reset_heap,
            wasm_alloc: exports.wasm_alloc,
            wasm_get_last_parse_capacity: exports.wasm_get_last_parse_capacity,
            wasm_get_last_content_capacity: exports.wasm_get_last_content_capacity,
            inflate_and_join_term_banks: exports.inflate_and_join_term_banks,
            parse_term_bank: exports.parse_term_bank,
            parse_term_bank_with_media_hints: exports.parse_term_bank_with_media_hints,
            parse_and_encode_term_bank_token_binary_dedup: exports.parse_and_encode_term_bank_token_binary_dedup,
            build_term_string_plan: exports.build_term_string_plan,
            encode_term_lookup_index: exports.encode_term_lookup_index,
            encode_term_content: exports.encode_term_content,
            encode_term_content_no_hash: exports.encode_term_content_no_hash,
            encode_term_content_token_binary: exports.encode_term_content_token_binary,
            encode_term_content_token_binary_dedup: exports.encode_term_content_token_binary_dedup,
        });
    });
}

/**
 * Inflates complete raw ZIP payloads into one parser-owned JSON array. The
 * returned allocation stays valid only until the next parser WASM operation.
 * @param {CompressedTermBankSource[]} sources
 * @returns {Promise<PreloadedTermBankSource>}
 */
export async function inflateCompressedTermBankSourcesWasm(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new TypeError('Compressed term-bank sources are empty');
    }
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    for (const [index, source] of sources.entries()) {
        if (
            typeof source !== 'object' || source === null ||
            !(source.bytes instanceof Uint8Array) ||
            (source.compressionMethod !== 0 && source.compressionMethod !== 8) ||
            !Number.isSafeInteger(source.compressedSize) || source.compressedSize < 0 ||
            !Number.isSafeInteger(source.uncompressedSize) || source.uncompressedSize < 0 ||
            !Number.isInteger(source.signature) || source.signature < 0 || source.signature > 0xffffffff ||
            source.bytes.byteLength !== source.compressedSize
        ) {
            throw new TypeError(`Compressed term-bank source ${index + 1} metadata is invalid`);
        }
        compressedBytes += source.compressedSize;
        uncompressedBytes += source.uncompressedSize;
    }
    if (
        !Number.isSafeInteger(compressedBytes) || compressedBytes > MAX_WASM32_BUFFER_BYTES ||
        !Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_WASM32_BUFFER_BYTES - 2
    ) {
        throw new TermBankWasmResourceError('Compressed term-bank source exceeds the 32-bit WASM parser limit');
    }

    const wasm = await getWasm();
    wasm.wasm_reset_heap();
    const inputPtr = allocateWasmBuffer(wasm, compressedBytes, 'compressed term-bank input');
    const inputOffsetsPtr = allocateWasmBuffer(wasm, sources.length * 4, 'compressed term-bank offset');
    const compressedLengthsPtr = allocateWasmBuffer(wasm, sources.length * 4, 'compressed term-bank length');
    const uncompressedLengthsPtr = allocateWasmBuffer(wasm, sources.length * 4, 'uncompressed term-bank length');
    const compressionMethodsPtr = allocateWasmBuffer(wasm, sources.length * 4, 'term-bank compression method');
    const signaturesPtr = allocateWasmBuffer(wasm, sources.length * 4, 'term-bank CRC');
    const outputCapacity = uncompressedBytes + 2;
    const outputPtr = allocateWasmBuffer(wasm, outputCapacity, 'inflated term-bank output');
    const heap = new Uint8Array(wasm.memory.buffer);
    const inputOffsets = new Uint32Array(wasm.memory.buffer, inputOffsetsPtr, sources.length);
    const compressedLengths = new Uint32Array(wasm.memory.buffer, compressedLengthsPtr, sources.length);
    const uncompressedLengths = new Uint32Array(wasm.memory.buffer, uncompressedLengthsPtr, sources.length);
    const compressionMethods = new Uint32Array(wasm.memory.buffer, compressionMethodsPtr, sources.length);
    const signatures = new Uint32Array(wasm.memory.buffer, signaturesPtr, sources.length);
    let inputOffset = 0;
    for (let i = 0; i < sources.length; ++i) {
        const source = sources[i];
        heap.set(source.bytes, inputPtr + inputOffset);
        inputOffsets[i] = inputOffset;
        compressedLengths[i] = source.compressedSize;
        uncompressedLengths[i] = source.uncompressedSize;
        compressionMethods[i] = source.compressionMethod;
        signatures[i] = source.signature >>> 0;
        inputOffset += source.compressedSize;
    }
    const startedAt = safePerformance.now();
    const jsonLength = wasm.inflate_and_join_term_banks(
        inputPtr,
        compressedBytes,
        inputOffsetsPtr,
        compressedLengthsPtr,
        uncompressedLengthsPtr,
        compressionMethodsPtr,
        signaturesPtr,
        sources.length,
        outputPtr,
        outputCapacity,
    );
    const inflateMs = Math.max(0, safePerformance.now() - startedAt);
    if (jsonLength < 0) {
        const messages = new Map([
            [-1, 'metadata or output bounds are invalid'],
            [-2, 'raw DEFLATE decoding failed'],
            [-3, 'inflated size does not match ZIP metadata'],
            [-4, 'inflated bytes do not match the ZIP CRC32'],
            [-5, 'inflated term bank is not a JSON array'],
            [-6, 'raw DEFLATE payload has trailing bytes'],
        ]);
        throw new Error(`Compressed term-bank source failed validation: ${messages.get(jsonLength) ?? `code ${jsonLength}`}`);
    }
    if (jsonLength < 2 || jsonLength > outputCapacity) {
        throw new Error('Compressed term-bank source returned an invalid JSON length');
    }
    return {
        wasm,
        jsonPtr: outputPtr,
        jsonLength,
        sourceCount: sources.length,
        inflateMs,
        compressedBytes,
        uncompressedBytes,
    };
}

/** @returns {Promise<void>} */
export async function initializeTermBankWasmParser() {
    await getWasm();
}

/**
 * @returns {typeof lastTermBankWasmParseProfile}
 */
export function consumeLastTermBankWasmParseProfile() {
    const value = lastTermBankWasmParseProfile;
    lastTermBankWasmParseProfile = null;
    return value;
}

/** @returns {string|null} */
export function consumeLastParallelParserSkipReason() {
    const value = lastParallelParserSkipReason;
    lastParallelParserSkipReason = null;
    return value;
}

/**
 * @param {Uint32Array} rowToUniqueIndex
 * @param {number} uniqueCount
 * @returns {Uint32Array}
 * @throws {Error} If the native dedupe projection is incomplete or unordered.
 */
function buildContentUniqueRowIndexes(rowToUniqueIndex, uniqueCount) {
    const uniqueRowIndexes = new Uint32Array(uniqueCount);
    uniqueRowIndexes.fill(0xffffffff);
    let nextUniqueIndex = 0;
    for (let rowIndex = 0; rowIndex < rowToUniqueIndex.length; ++rowIndex) {
        const uniqueIndex = rowToUniqueIndex[rowIndex];
        if (uniqueIndex >= uniqueCount) {
            throw new RangeError(`Native term content unique index is invalid at row ${rowIndex}`);
        }
        if (uniqueIndex === nextUniqueIndex) {
            uniqueRowIndexes[uniqueIndex] = rowIndex;
            ++nextUniqueIndex;
        } else if (uniqueRowIndexes[uniqueIndex] === 0xffffffff) {
            throw new Error(`Native term content unique index ${uniqueIndex} is out of order`);
        }
    }
    if (nextUniqueIndex !== uniqueCount) {
        throw new Error(`Native term content unique rows are incomplete: ${nextUniqueIndex}/${uniqueCount}`);
    }
    return uniqueRowIndexes;
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
 * @param {boolean} [allowFusedParse]
 * @param {PreloadedTermBankSource|null} [preloadedSource]
 * @returns {Promise<ParsedTermBankWasmBuffers>}
 * @throws {Error}
 */
async function parseTermBankWasmBuffers(contentBytes, includeContentMetadata, initialContentBytesPerRow, mediaHintFastScan, computeContentHashes, emitTokenBinaryContent, deduplicateContent, allowFusedParse = true, preloadedSource = null) {
    const sourceArrays = Array.isArray(contentBytes) ? contentBytes : [contentBytes];
    /** @type {Array<{bytes: Uint8Array, start: number, end: number}>} */
    const sourceSpans = [];
    let jsonLength = preloadedSource?.jsonLength ?? (sourceArrays.length > 1 ? 2 : 0);
    for (const bytes of preloadedSource === null ? sourceArrays : []) {
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
    if (preloadedSource === null && sourceArrays.length > 1) { jsonLength += Math.max(0, sourceSpans.length - 1); }
    if (!Number.isSafeInteger(jsonLength) || jsonLength > MAX_WASM32_BUFFER_BYTES) {
        throw new TermBankWasmResourceError('Term-bank source exceeds the 32-bit WASM parser limit');
    }
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
            recentContentDedupHitCount: 0,
        };
    }
    const wasm = await getWasm();
    if (preloadedSource !== null && preloadedSource.wasm !== wasm) {
        throw new Error('Preloaded term-bank source belongs to another parser instance');
    }
    if (preloadedSource === null) { wasm.wasm_reset_heap(); }
    let allocationMs = 0;
    let copyJsonMs = 0;
    let parseBankMs = 0;
    let encodeContentMs = 0;
    let tStart = Date.now();
    const jsonPtr = preloadedSource?.jsonPtr ?? wasm.wasm_alloc(jsonLength);
    if (preloadedSource === null) {
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
    }

    const initialMetaCapacity = Math.min(
        MAX_META_ROW_CAPACITY,
        Math.max(8192, (preloadedSource?.sourceCount ?? sourceSpans.length) * INITIAL_META_ROWS_PER_SOURCE),
    );
    const useFusedParse = (
        allowFusedParse &&
        (preloadedSource?.sourceCount ?? sourceArrays.length) > 1 &&
        includeContentMetadata &&
        computeContentHashes &&
        emitTokenBinaryContent &&
        deduplicateContent
    );
    if (useFusedParse) {
        tStart = Date.now();
        const outPtr = wasm.wasm_alloc(initialMetaCapacity * META_U32_FIELDS * 4);
        const contentMetaPtr = wasm.wasm_alloc(initialMetaCapacity * CONTENT_META_U32_FIELDS * 4);
        let contentHashTableSize = 1;
        while (contentHashTableSize < initialMetaCapacity * 2) { contentHashTableSize *= 2; }
        const contentHashTablePtr = wasm.wasm_alloc(contentHashTableSize * 4);
        const contentUniqueIndexesPtr = wasm.wasm_alloc(initialMetaCapacity * 4);
        const contentUniqueCountPtr = wasm.wasm_alloc(4);
        const contentUniqueSignaturesPtr = wasm.wasm_alloc(initialMetaCapacity * CONTENT_SIGNATURE_U32_FIELDS * 4);
        const rowCountPtr = wasm.wasm_alloc(4);
        const stringsCapacity = Math.max(1024 * 1024, Math.min(jsonLength, initialMetaCapacity * 64));
        const stringsPtr = wasm.wasm_alloc(stringsCapacity);
        const stringLengthsPtr = wasm.wasm_alloc(initialMetaCapacity * 2 * 2);
        const stringOffsetsPtr = wasm.wasm_alloc(initialMetaCapacity * 2 * 4);
        const stringHashesPtr = wasm.wasm_alloc(initialMetaCapacity * 2 * 4);
        const expressionIndexesPtr = wasm.wasm_alloc(initialMetaCapacity * 4);
        const readingIndexesPtr = wasm.wasm_alloc(initialMetaCapacity * 4);
        let stringHashTableSize = 1;
        while (stringHashTableSize < initialMetaCapacity * 4) { stringHashTableSize *= 2; }
        const stringHashTablePtr = wasm.wasm_alloc(stringHashTableSize * 4);
        const stringUniqueCountPtr = wasm.wasm_alloc(4);
        const stringBytesCountPtr = wasm.wasm_alloc(4);
        const readingEqualsPtr = wasm.wasm_alloc(initialMetaCapacity);
        const scoresPtr = wasm.wasm_alloc(initialMetaCapacity * 4);
        const sequencesPtr = wasm.wasm_alloc(initialMetaCapacity * 4);
        const recentContentHitsPtr = wasm.wasm_alloc(4);
        const normalizedInitialContentBytesPerRow = Number.isFinite(initialContentBytesPerRow) ? Math.max(16, Math.min(512, Math.trunc(initialContentBytesPerRow))) : 48;
        const contentOutCapacity = Math.min(
            0x7fffffff,
            Math.max(1024 * 1024, initialMetaCapacity * Math.max(192, normalizedInitialContentBytesPerRow)),
        );
        const contentOutPtr = wasm.wasm_alloc(contentOutCapacity);
        allocationMs += Math.max(0, Date.now() - tStart);
        if (
            outPtr === 0 || contentMetaPtr === 0 || contentHashTablePtr === 0 ||
            contentUniqueIndexesPtr === 0 || contentUniqueCountPtr === 0 || contentUniqueSignaturesPtr === 0 ||
            rowCountPtr === 0 || stringsPtr === 0 || stringLengthsPtr === 0 ||
            stringOffsetsPtr === 0 || stringHashesPtr === 0 || expressionIndexesPtr === 0 ||
            readingIndexesPtr === 0 || stringHashTablePtr === 0 || stringUniqueCountPtr === 0 ||
            stringBytesCountPtr === 0 || readingEqualsPtr === 0 || scoresPtr === 0 ||
            sequencesPtr === 0 || recentContentHitsPtr === 0 || contentOutPtr === 0
        ) {
            throw new TermBankWasmResourceError('Failed to allocate fused term-bank parser buffers');
        }
        new Uint32Array(wasm.memory.buffer, contentHashTablePtr, contentHashTableSize).fill(0);
        new Uint32Array(wasm.memory.buffer, stringHashTablePtr, stringHashTableSize).fill(0);
        new Uint32Array(wasm.memory.buffer, contentUniqueCountPtr, 1)[0] = 0;
        new Uint32Array(wasm.memory.buffer, rowCountPtr, 1)[0] = 0;
        new Uint32Array(wasm.memory.buffer, stringUniqueCountPtr, 1)[0] = 0;
        new Uint32Array(wasm.memory.buffer, stringBytesCountPtr, 1)[0] = 0;
        new Uint32Array(wasm.memory.buffer, recentContentHitsPtr, 1)[0] = 0;
        tStart = Date.now();
        const encodedContentBytes = wasm.parse_and_encode_term_bank_token_binary_dedup(
            jsonPtr,
            jsonLength,
            outPtr,
            initialMetaCapacity,
            contentOutPtr,
            contentOutCapacity,
            contentMetaPtr,
            contentHashTablePtr,
            contentHashTableSize,
            contentUniqueIndexesPtr,
            contentUniqueCountPtr,
            contentUniqueSignaturesPtr,
            rowCountPtr,
            stringsPtr,
            stringsCapacity,
            stringLengthsPtr,
            stringOffsetsPtr,
            stringHashesPtr,
            expressionIndexesPtr,
            readingIndexesPtr,
            stringHashTablePtr,
            stringHashTableSize,
            stringUniqueCountPtr,
            stringBytesCountPtr,
            readingEqualsPtr,
            scoresPtr,
            sequencesPtr,
            recentContentHitsPtr,
            mediaHintFastScan ? 1 : 0,
        );
        parseBankMs += Math.max(0, Date.now() - tStart);
        if (encodedContentBytes === -4 || encodedContentBytes === -5) {
            const fallbackContentBytes = preloadedSource === null ?
                contentBytes :
                Uint8Array.from(new Uint8Array(wasm.memory.buffer, jsonPtr, jsonLength));
            return await parseTermBankWasmBuffers(
                fallbackContentBytes,
                includeContentMetadata,
                initialContentBytesPerRow,
                mediaHintFastScan,
                computeContentHashes,
                emitTokenBinaryContent,
                deduplicateContent,
                false,
            );
        }
        if (encodedContentBytes < 0) {
            if (encodedContentBytes === -2) {
                throw new TermBankWasmResourceError('Failed to grow fused term-content buffer');
            }
            throw new Error(`fused term-bank parser failed with code ${encodedContentBytes}`);
        }
        const rowCount = new Uint32Array(wasm.memory.buffer, rowCountPtr, 1)[0];
        const contentUniqueCount = new Uint32Array(wasm.memory.buffer, contentUniqueCountPtr, 1)[0];
        const stringUniqueCount = new Uint32Array(wasm.memory.buffer, stringUniqueCountPtr, 1)[0];
        const stringBytesCount = new Uint32Array(wasm.memory.buffer, stringBytesCountPtr, 1)[0];
        const recentContentDedupHitCount = new Uint32Array(wasm.memory.buffer, recentContentHitsPtr, 1)[0];
        const contentCapacity = wasm.wasm_get_last_content_capacity();
        const heap = new Uint8Array(wasm.memory.buffer);
        return {
            wasm,
            jsonPtr,
            jsonLength,
            metasPtr: outPtr,
            contentMetasPtr: contentMetaPtr,
            contentUniqueIndexesPtr,
            contentUniqueSignatures: Uint32Array.from(new Uint32Array(
                wasm.memory.buffer,
                contentUniqueSignaturesPtr,
                contentUniqueCount * CONTENT_SIGNATURE_U32_FIELDS,
            )),
            heap,
            source: heap.subarray(jsonPtr, jsonPtr + jsonLength),
            metas: new Uint32Array(wasm.memory.buffer, outPtr, rowCount * META_U32_FIELDS),
            contentMetas: new Uint32Array(wasm.memory.buffer, contentMetaPtr, rowCount * CONTENT_META_U32_FIELDS),
            contentOutPtr,
            contentUniqueIndexes: new Uint32Array(wasm.memory.buffer, contentUniqueIndexesPtr, rowCount),
            contentUniqueCount,
            rowCount,
            metaCapacity: initialMetaCapacity,
            encodedContentBytes,
            contentCapacity,
            initialContentBytesPerRow: normalizedInitialContentBytesPerRow,
            allocationMs,
            copyJsonMs,
            parseBankMs,
            encodeContentMs,
            recentContentDedupHitCount,
            fusedStringPlan: {
                stringLengths: new Uint16Array(wasm.memory.buffer, stringLengthsPtr, stringUniqueCount),
                stringOffsets: new Uint32Array(wasm.memory.buffer, stringOffsetsPtr, stringUniqueCount),
                stringHashes: new Uint32Array(wasm.memory.buffer, stringHashesPtr, stringUniqueCount),
                stringsBuffer: new Uint8Array(wasm.memory.buffer, stringsPtr, stringBytesCount),
                expressionIndexes: new Uint32Array(wasm.memory.buffer, expressionIndexesPtr, rowCount),
                readingIndexes: new Uint32Array(wasm.memory.buffer, readingIndexesPtr, rowCount),
                readingEqualsExpressionList: new Uint8Array(wasm.memory.buffer, readingEqualsPtr, rowCount),
                scoreList: new Int32Array(wasm.memory.buffer, scoresPtr, rowCount),
                sequenceList: new Int32Array(wasm.memory.buffer, sequencesPtr, rowCount),
            },
        };
    }
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
 * @returns {(import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan & {stringOffsets: Uint32Array})|null}
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
 * @param {number} value
 * @returns {number}
 */
function align4(value) {
    return (value + 3) & ~3;
}

/**
 * @param {number} count
 * @returns {number}
 */
function getLookupHashSlotCount(count) {
    const target = Math.ceil(count / 4);
    let value = 1;
    while (value < target) { value *= 2; }
    return value;
}

/**
 * @param {number} count
 * @returns {number}
 */
function getSequenceInternSlotCount(count) {
    let value = 1;
    while (value < count) { value *= 2; }
    return value;
}

/**
 * @param {number} rowCount
 * @param {number} keyCount
 * @param {number} keyBytesLength
 * @returns {number}
 */
function getNativeLookupIndexCapacity(rowCount, keyCount, keyBytesLength) {
    const keySlotCount = getLookupHashSlotCount(keyCount);
    const sequenceSlotCount = getLookupHashSlotCount(rowCount);
    const baseU16Bytes = align4((keyCount + (rowCount * 3)) * 2);
    const derivedU16Count =
        keySlotCount + keyCount +
        (keyCount + 1) + rowCount +
        (keyCount + 1) + rowCount +
        sequenceSlotCount + rowCount +
        (rowCount + 1) + rowCount;
    return 16 + 32 + align4(keyBytesLength) + baseU16Bytes + (rowCount * 4) + 32 + align4(derivedU16Count * 2);
}

/**
 * @param {Awaited<ReturnType<typeof getWasm>>} wasm
 * @param {number} rowCapacity
 * @param {number} keyCapacity
 * @param {number} keyBytesCapacity
 * @returns {{outputPtr: number, outputCapacity: number, readingEqualsPtr: number, sequenceValuesPtr: number, sequenceKeysPtr: number, sequenceKeyByRowPtr: number, sequenceSlotsPtr: number, sequenceSlotsCount: number}}
 */
function createNativeLookupIndexScratch(wasm, rowCapacity, keyCapacity, keyBytesCapacity) {
    const sequenceSlotsCount = getSequenceInternSlotCount(rowCapacity);
    const outputCapacity = getNativeLookupIndexCapacity(rowCapacity, keyCapacity, keyBytesCapacity);
    return {
        outputPtr: allocateWasmBuffer(wasm, outputCapacity, 'term lookup index output'),
        outputCapacity,
        readingEqualsPtr: allocateWasmBuffer(wasm, rowCapacity, 'term lookup reading equality'),
        sequenceValuesPtr: allocateWasmBuffer(wasm, rowCapacity * 4, 'term lookup sequence values'),
        sequenceKeysPtr: allocateWasmBuffer(wasm, rowCapacity * 4, 'term lookup sequence keys'),
        sequenceKeyByRowPtr: allocateWasmBuffer(wasm, rowCapacity * 2, 'term lookup sequence row keys'),
        sequenceSlotsPtr: allocateWasmBuffer(wasm, sequenceSlotsCount * 2, 'term lookup sequence slots'),
        sequenceSlotsCount,
    };
}

/**
 * @param {Awaited<ReturnType<typeof getWasm>>} wasm
 * @param {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan & {stringOffsets: Uint32Array}} plan
 * @param {Uint8Array} readingEqualsExpressionList
 * @param {Int32Array} sequenceList
 * @param {number} rowCount
 * @param {ReturnType<typeof createNativeLookupIndexScratch>} scratch
 * @returns {Uint8Array|null}
 */
function encodeNativeTermLookupIndex(wasm, plan, readingEqualsExpressionList, sequenceList, rowCount, scratch) {
    const memory = wasm.memory.buffer;
    if (
        plan.stringLengths.buffer !== memory ||
        plan.stringOffsets.buffer !== memory ||
        plan.stringHashes?.buffer !== memory ||
        plan.stringsBuffer.buffer !== memory ||
        plan.expressionIndexes.buffer !== memory ||
        plan.readingIndexes.buffer !== memory ||
        rowCount <= 0 || rowCount >= 0xffff ||
        plan.stringLengths.length <= 0 || plan.stringLengths.length >= 0xffff
    ) {
        return null;
    }
    let readingEqualsPtr = readingEqualsExpressionList.byteOffset;
    if (readingEqualsExpressionList.buffer !== memory) {
        new Uint8Array(memory, scratch.readingEqualsPtr, rowCount).set(
            readingEqualsExpressionList.subarray(0, rowCount),
        );
        readingEqualsPtr = scratch.readingEqualsPtr;
    }
    let sequenceValuesPtr = sequenceList.byteOffset;
    if (sequenceList.buffer !== memory) {
        new Int32Array(memory, scratch.sequenceValuesPtr, rowCount).set(sequenceList.subarray(0, rowCount));
        sequenceValuesPtr = scratch.sequenceValuesPtr;
    }
    const length = wasm.encode_term_lookup_index(
        plan.stringsBuffer.byteOffset,
        plan.stringsBuffer.byteLength,
        plan.stringLengths.byteOffset,
        plan.stringOffsets.byteOffset,
        /** @type {Uint32Array} */ (plan.stringHashes).byteOffset,
        plan.stringLengths.length,
        plan.expressionIndexes.byteOffset,
        plan.readingIndexes.byteOffset,
        readingEqualsPtr,
        sequenceValuesPtr,
        rowCount,
        scratch.outputPtr,
        scratch.outputCapacity,
        scratch.sequenceKeysPtr,
        scratch.sequenceKeyByRowPtr,
        scratch.sequenceSlotsPtr,
        scratch.sequenceSlotsCount,
    );
    return length > 0 ? Uint8Array.from(new Uint8Array(wasm.memory.buffer, scratch.outputPtr, length)) : null;
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
 * @param {(chunk: {rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array, contentBytesList: Uint8Array[], contentHash1List: Uint32Array, contentHash2List: Uint32Array, contentBytesBuffer?: Uint8Array, contentBytesBaseOffset?: number, contentMetaList?: Uint32Array, contentUniqueIndexList: Uint32Array|null, contentDedupPlan: import('core').SafeAny|null, termRecordPreinternedPlan: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan, mediaRows: Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>}, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {number} [chunkSize]
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean, prepareLookupIndexes?: boolean, preloadedSource?: PreloadedTermBankSource}} [options]
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
    const prepareLookupIndexes = options.prepareLookupIndexes === true;
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
        true,
        options.preloadedSource ?? null,
    );
    const bufferSetupMs = Math.max(0, Date.now() - tBufferSetupStart);
    const {contentOutPtr, contentUniqueCount, rowCount, metaCapacity, contentCapacity} = parsed;
    const normalizedChunkSize = options.singleChunk === true ?
        Math.max(1, rowCount) :
        (Number.isFinite(chunkSize) ? Math.max(1, Math.trunc(chunkSize)) : DEFAULT_ROW_CHUNK_SIZE);
    const chunkCount = rowCount === 0 ? 0 : Math.ceil(rowCount / normalizedChunkSize);
    let fusedStringPlan = parsed.fusedStringPlan ?? null;
    /** @type {ReturnType<typeof createNativeTermStringPlanScratch>[]} */
    const nativeStringPlanScratches = [];
    let nativeStringPlanAllocationMs = 0;
    let maxNativeChunkStringBytes = fusedStringPlan?.stringsBuffer.byteLength ?? 0;
    if (fusedStringPlan === null && useNativeStringPlan && rowCount > 0 && parsed.wasm !== null) {
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
        maxNativeChunkStringBytes = maxChunkStringBytes;
    }
    /** @type {ReturnType<typeof createNativeLookupIndexScratch>|null} */
    let nativeLookupIndexScratch = null;
    const nativeLookupRowCapacity = Math.min(normalizedChunkSize, rowCount);
    if (
        prepareLookupIndexes &&
        parsed.wasm !== null &&
        nativeLookupRowCapacity > 0 &&
        nativeLookupRowCapacity < 0xffff &&
        (fusedStringPlan === null || normalizedChunkSize >= rowCount)
    ) {
        const fusedPlanLayout = fusedStringPlan === null ?
            null :
            {
                stringLengthsOffset: fusedStringPlan.stringLengths.byteOffset,
                stringLengthsLength: fusedStringPlan.stringLengths.length,
                stringOffsetsOffset: fusedStringPlan.stringOffsets.byteOffset,
                stringHashesOffset: fusedStringPlan.stringHashes.byteOffset,
                stringsOffset: fusedStringPlan.stringsBuffer.byteOffset,
                stringsLength: fusedStringPlan.stringsBuffer.byteLength,
                expressionIndexesOffset: fusedStringPlan.expressionIndexes.byteOffset,
                expressionIndexesLength: fusedStringPlan.expressionIndexes.length,
                readingIndexesOffset: fusedStringPlan.readingIndexes.byteOffset,
                readingEqualsOffset: fusedStringPlan.readingEqualsExpressionList.byteOffset,
                scoreOffset: fusedStringPlan.scoreList.byteOffset,
                sequenceOffset: fusedStringPlan.sequenceList.byteOffset,
            };
        const nativeLookupKeyCapacity = Math.min(
            0xffff - 1,
            fusedStringPlan?.stringLengths.length ?? nativeLookupRowCapacity * 2,
        );
        try {
            nativeLookupIndexScratch = createNativeLookupIndexScratch(
                parsed.wasm,
                nativeLookupRowCapacity,
                nativeLookupKeyCapacity,
                maxNativeChunkStringBytes,
            );
        } catch (error) {
            if (!(error instanceof TermBankWasmResourceError)) { throw error; }
        }
        if (fusedPlanLayout !== null) {
            const memory = parsed.wasm.memory.buffer;
            fusedStringPlan = {
                stringLengths: new Uint16Array(memory, fusedPlanLayout.stringLengthsOffset, fusedPlanLayout.stringLengthsLength),
                stringOffsets: new Uint32Array(memory, fusedPlanLayout.stringOffsetsOffset, fusedPlanLayout.stringLengthsLength),
                stringHashes: new Uint32Array(memory, fusedPlanLayout.stringHashesOffset, fusedPlanLayout.stringLengthsLength),
                stringsBuffer: new Uint8Array(memory, fusedPlanLayout.stringsOffset, fusedPlanLayout.stringsLength),
                expressionIndexes: new Uint32Array(memory, fusedPlanLayout.expressionIndexesOffset, fusedPlanLayout.expressionIndexesLength),
                readingIndexes: new Uint32Array(memory, fusedPlanLayout.readingIndexesOffset, fusedPlanLayout.expressionIndexesLength),
                readingEqualsExpressionList: new Uint8Array(memory, fusedPlanLayout.readingEqualsOffset, fusedPlanLayout.expressionIndexesLength),
                scoreList: new Int32Array(memory, fusedPlanLayout.scoreOffset, fusedPlanLayout.expressionIndexesLength),
                sequenceList: new Int32Array(memory, fusedPlanLayout.sequenceOffset, fusedPlanLayout.expressionIndexesLength),
            };
        }
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
            sourceRowCount: rowCount,
            uniqueRowIndexes: buildContentUniqueRowIndexes(contentUniqueIndexes, contentUniqueCount),
            uniqueSignatures: parsed.contentUniqueSignatures,
            resolvedFlags: new Uint8Array(contentUniqueCount),
            resolvedOffsets: new Float64Array(contentUniqueCount),
            resolvedLengths: new Uint32Array(contentUniqueCount),
            resolvedDictNames: null,
            resolvedUniformDictName: void 0,
            pendingEpochs: new Uint32Array(contentUniqueCount),
            pendingIndexes: new Uint32Array(contentUniqueCount),
            pendingSpanOffsetsScratch: new Uint32Array(normalizedChunkSize),
            pendingSpanLengthsScratch: new Uint32Array(normalizedChunkSize),
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: null,
        } :
        null;
    let rowDecodeMs = 0;
    let nativeStringPlanMs = 0;
    let nativeStringPlanChunkCount = 0;
    let nativeStringPlanFallbackChunkCount = 0;
    let nativeLookupIndexEncodeMs = 0;
    let chunkDispatchMs = 0;
    /** @type {Promise<void>[]} */
    const pendingDispatches = [];
    let dispatchTail = Promise.resolve();

    for (let start = 0, chunkIndex = 0; start < rowCount; start += normalizedChunkSize) {
        const end = Math.min(rowCount, start + normalizedChunkSize);
        const count = end - start;
        /** @type {Uint8Array[]} */
        const expressionBytesList = emitTermByteLists ? new Array(count) : [];
        /** @type {Uint8Array[]} */
        const readingBytesList = emitTermByteLists ? new Array(count) : [];
        const readingEqualsExpressionList = fusedStringPlan === null ?
            new Uint8Array(count) :
            /** @type {Uint8Array} */ (fusedStringPlan.readingEqualsExpressionList).subarray(start, end);
        const scoreList = fusedStringPlan === null ?
            new Int32Array(count) :
            /** @type {Int32Array} */ (fusedStringPlan.scoreList).subarray(start, end);
        const sequenceList = fusedStringPlan === null || version < 3 ?
            new Int32Array(count) :
            /** @type {Int32Array} */ (fusedStringPlan.sequenceList).subarray(start, end);
        if (fusedStringPlan !== null && version < 3) { sequenceList.fill(-1); }
        /** @type {Uint8Array[]} */
        const contentBytesList = emitContentSlab ? [] : new Array(count);
        const contentHash1List = emitContentSlab ? new Uint32Array(0) : new Uint32Array(count);
        const contentHash2List = emitContentSlab ? new Uint32Array(0) : new Uint32Array(count);
        const contentMetaList = emitContentSlab ?
            contentMetas.subarray(start * CONTENT_META_U32_FIELDS, end * CONTENT_META_U32_FIELDS) :
            new Uint32Array(0);
        const tNativeStringPlanStart = Date.now();
        const nativeStringPlan = fusedStringPlan === null ?
            (
                nativeStringPlanScratches.length === 0 || parsed.wasm === null ?
                    null :
                    buildNativeTermStringPlan(
                        parsed.wasm,
                        parsed.jsonPtr,
                        parsed.metasPtr,
                        start,
                        count,
                        nativeStringPlanScratches[chunkIndex % nativeStringPlanScratches.length],
                    )
            ) :
            {
                stringLengths: fusedStringPlan.stringLengths,
                stringOffsets: fusedStringPlan.stringOffsets,
                stringHashes: fusedStringPlan.stringHashes,
                stringsBuffer: fusedStringPlan.stringsBuffer,
                expressionIndexes: fusedStringPlan.expressionIndexes.subarray(start, end),
                readingIndexes: fusedStringPlan.readingIndexes.subarray(start, end),
            };
        if (fusedStringPlan === null) {
            nativeStringPlanMs += Math.max(0, Date.now() - tNativeStringPlanStart);
        }
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

        const needsRowProjection = fusedStringPlan === null || emitTermByteLists || !emitContentSlab || mediaHintFastScan;
        const tRowDecodeStart = needsRowProjection ? Date.now() : 0;
        for (let sourceIndex = start, i = 0; needsRowProjection && sourceIndex < end; ++sourceIndex, ++i) {
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
            if (fusedStringPlan === null) {
                scoreList[i] = metas[o + 8] | 0;
                sequenceList[i] = version >= 3 ? (metas[o + 11] | 0) : -1;
            }
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
        if (needsRowProjection) {
            rowDecodeMs += Math.max(0, Date.now() - tRowDecodeStart);
        }
        let termRecordPreinternedPlan;
        if (nativeStringPlan === null) {
            if (planBuilder === null) {
                throw new Error('Term string plan builder is unavailable');
            }
            termRecordPreinternedPlan = planBuilder.buildPlan(expressionIndexes, readingIndexes, count);
        } else {
            termRecordPreinternedPlan = nativeStringPlan;
        }
        /** @type {TermBankColumnChunk} */
        const chunk = {
            rowCount: count,
            contentRowStart: start,
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
            useResolvedContentReferences: contentDedupPlan !== null,
            termRecordPreinternedPlan,
            mediaRows,
        };
        if (
            nativeLookupIndexScratch !== null &&
            parsed.wasm !== null &&
            nativeStringPlan !== null &&
            (fusedStringPlan === null || (start === 0 && end === rowCount))
        ) {
            const tLookupIndexStart = safePerformance.now();
            const bytes = encodeNativeTermLookupIndex(
                parsed.wasm,
                nativeStringPlan,
                readingEqualsExpressionList,
                sequenceList,
                count,
                nativeLookupIndexScratch,
            );
            const elapsedMs = Math.max(0, safePerformance.now() - tLookupIndexStart);
            if (bytes !== null) {
                chunk.preparedLookupIndexes = new Map([
                    [`0:${count}`, {bytes, preinternedPlan: termRecordPreinternedPlan}],
                ]);
                chunk.preparedLookupIndexEncodeMs = elapsedMs;
                nativeLookupIndexEncodeMs += elapsedMs;
            }
        }
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
        recentContentDedupHitCount: parsed.recentContentDedupHitCount ?? 0,
        rowDecodeMs,
        nativeStringPlanMs,
        nativeStringPlanChunkCount,
        nativeStringPlanFallbackChunkCount,
        lookupIndexPrepareMs: nativeLookupIndexEncodeMs,
        lookupIndexCompactMs: 0,
        lookupIndexEncodeMs: nativeLookupIndexEncodeMs,
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

class ParallelTermBankParserPool {
    constructor() {
        /** @type {Promise<{workers: Worker[]}>|null} */
        this._workersPromise = null;
        /** @type {AbortController|null} */
        this._workerCreationAbortController = null;
        /** @type {number} */
        this._workerCount = 0;
        /** @type {{done: Promise<void>, resolveDone: (value: void|PromiseLike<void>) => void}|null} */
        this._activeRun = null;
        /** @type {Promise<void>|null} */
        this._disposalPromise = null;
        /** @type {boolean} */
        this._disposalRequested = false;
        /** @type {number} */
        this._disposalGeneration = 0;
    }

    /** @returns {Promise<boolean>} */
    async prewarm() {
        const disposalGeneration = this._disposalGeneration;
        const workerCount = getParallelTermBankParserWorkerCount();
        try {
            if (this._disposalRequested) {
                const activeRun = this._activeRun;
                if (activeRun !== null) { await activeRun.done; }
                await this._disposeIdleWorkers();
            }
            if (disposalGeneration !== this._disposalGeneration) { return false; }
            await this._getWorkers(workerCount, disposalGeneration);
            return disposalGeneration === this._disposalGeneration;
        } catch (_) {
            if (disposalGeneration === this._disposalGeneration) {
                await this._disposeIdleWorkers();
            }
            return false;
        }
    }

    /**
     * @param {number} workerCount
     * @returns {{getWorkers: () => Promise<{workers: Worker[]}>, release: (keepWorkers: boolean) => Promise<void>}|null}
     */
    acquireRun(workerCount) {
        if (this._activeRun !== null || this._disposalPromise !== null) { return null; }
        /** @type {(value: void|PromiseLike<void>) => void} */
        let resolveDone = () => {};
        const owner = {
            done: new Promise((resolve) => { resolveDone = resolve; }),
            resolveDone,
        };
        this._activeRun = owner;
        let released = false;
        return {
            getWorkers: async () => {
                if (released || this._activeRun !== owner) {
                    throw new Error('Parallel term-bank parser run no longer owns the worker pool');
                }
                return await this._getWorkers(workerCount);
            },
            release: async (keepWorkers) => {
                if (released) { return; }
                released = true;
                if (this._activeRun !== owner) { return; }
                this._activeRun = null;
                owner.resolveDone();
                if (!keepWorkers || this._disposalRequested) {
                    this._disposalRequested = false;
                    await this._disposeIdleWorkers();
                }
            },
        };
    }

    /** Releases parser heaps without terminating an active run. */
    async dispose() {
        ++this._disposalGeneration;
        const activeRun = this._activeRun;
        if (activeRun !== null) {
            this._disposalRequested = true;
            await activeRun.done;
        }
        await this._disposeIdleWorkers();
    }

    /**
     * @param {number} workerCount
     * @param {number|null} [expectedDisposalGeneration]
     * @returns {Promise<{workers: Worker[]}>}
     */
    async _getWorkers(workerCount, expectedDisposalGeneration = null) {
        const disposalPromise = this._disposalPromise;
        if (disposalPromise !== null) { await disposalPromise; }
        if (
            expectedDisposalGeneration !== null &&
            expectedDisposalGeneration !== this._disposalGeneration
        ) {
            throw createParallelParserCancellationError();
        }
        if (this._workersPromise === null) {
            const abortController = new AbortController();
            this._workerCreationAbortController = abortController;
            this._workerCount = workerCount;
            this._workersPromise = createParallelParserWorkers(abortController.signal, workerCount);
        } else if (this._workerCount !== workerCount) {
            throw new Error('Parallel term-bank parser worker capability changed while its pool was warm');
        }
        const promise = this._workersPromise;
        const abortController = this._workerCreationAbortController;
        let workers;
        try {
            workers = await promise;
        } catch (error) {
            if (this._workersPromise === promise) {
                this._workersPromise = null;
                this._workerCount = 0;
                if (this._workerCreationAbortController === abortController) {
                    this._workerCreationAbortController = null;
                }
            }
            throw error;
        }
        if (
            expectedDisposalGeneration !== null &&
            expectedDisposalGeneration !== this._disposalGeneration
        ) {
            throw createParallelParserCancellationError();
        }
        return workers;
    }

    /** @returns {Promise<void>} */
    async _disposeIdleWorkers() {
        if (this._activeRun !== null) {
            this._disposalRequested = true;
            await this._activeRun.done;
        }
        if (this._disposalPromise !== null) {
            await this._disposalPromise;
            return;
        }
        const workersPromise = this._workersPromise;
        const abortController = this._workerCreationAbortController;
        this._workersPromise = null;
        this._workerCount = 0;
        this._workerCreationAbortController = null;
        abortController?.abort();
        if (workersPromise === null) { return; }

        const disposalPromise = (async () => {
            try {
                const {workers} = await workersPromise;
                for (const worker of workers) { worker.terminate(); }
            } catch (_) {
                // Worker creation terminates any workers it initialized before failing.
            }
        })();
        this._disposalPromise = disposalPromise;
        try {
            await disposalPromise;
        } finally {
            if (this._disposalPromise === disposalPromise) {
                this._disposalPromise = null;
            }
        }
    }
}

class ParallelTermBankPipelineRun {
    /**
     * @param {ParallelTermBankSource[]} sources
     * @param {ParallelTermBankSource[][]} groups
     * @param {number} totalBytes
     * @param {number} version
     * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
     * @param {Record<string, unknown>} options
     * @param {() => boolean} shouldCancel
     * @param {{getWorkers: () => Promise<{workers: Worker[]}>, release: (keepWorkers: boolean) => Promise<void>}} poolLease
     * @param {number} pipelineGroupsPerWorker
     */
    constructor(sources, groups, totalBytes, version, onChunk, options, shouldCancel, poolLease, pipelineGroupsPerWorker) {
        /** @type {ParallelTermBankSource[]} */
        this._sources = sources;
        /** @type {ParallelTermBankSource[][]} */
        this._groups = groups;
        /** @type {number} */
        this._totalBytes = totalBytes;
        /** @type {number} */
        this._version = version;
        /** @type {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} */
        this._onChunk = onChunk;
        /** @type {Record<string, unknown>} */
        this._options = options;
        /** @type {() => boolean} */
        this._shouldCancel = shouldCancel;
        /** @type {{getWorkers: () => Promise<{workers: Worker[]}>, release: (keepWorkers: boolean) => Promise<void>}} */
        this._poolLease = poolLease;
        /** @type {number} */
        this._pipelineGroupsPerWorker = pipelineGroupsPerWorker;
        /** @type {Array<{promise: Promise<{chunk: TermBankColumnChunk|null, profile: NonNullable<typeof lastTermBankWasmParseProfile>|null, error: unknown, finishedAt: number, rowCount: number, sourceBytes: number, consume: (() => void)|null}>, resolve: (value: {chunk: TermBankColumnChunk|null, profile: NonNullable<typeof lastTermBankWasmParseProfile>|null, error: unknown, finishedAt: number, rowCount: number, sourceBytes: number, consume: (() => void)|null}) => void}>} */
        this._resultSlots = [];
        /** @type {Set<() => void>} */
        this._pendingResultConsumers = new Set();
        /** @type {Promise<void>[]} */
        this._workerLoops = [];
        /** @type {Error|null} */
        this._error = null;
        /** @type {boolean} */
        this._failed = false;
        /** @type {boolean} */
        this._keepWorkers = false;
        /** @type {number} */
        this._startedAt = safePerformance.now();
        /** @type {number} */
        this._nextSinkGroupIndex = 0;
        /** @type {number} */
        this._nextWorkerGroupIndex = 0;
        /** @type {number} */
        this._maxLeadGroups = 1;
        /** @type {Set<() => void>} */
        this._leadWaiters = new Set();
    }

    /** @returns {Promise<boolean>} */
    async run() {
        try {
            const {workers} = await this._poolLease.getWorkers();
            await this._runPipeline(workers);
            this._keepWorkers = true;
            return true;
        } catch (error) {
            const normalizedError = createParallelParserError(error);
            if (normalizedError instanceof TermBankWasmResourceError) {
                throw new Error(`Parallel term-bank parser exceeded its resource budget: ${normalizedError.message}`);
            }
            throw normalizedError;
        } finally {
            await this._poolLease.release(this._keepWorkers);
        }
    }

    /** @param {Worker[]} workers */
    async _runPipeline(workers) {
        this._createSlots();
        this._maxLeadGroups = Math.max(1, workers.length * this._pipelineGroupsPerWorker);
        this._activateLeadSources();
        this._workerLoops = workers.map((worker) => this._runWorkerLoop(worker));
        try {
            // Start the ordered sink as soon as group zero is available. Waiting
            // for every worker's first group creates a full parse/storage
            // barrier; byte-balanced groups make the first group sufficient
            // for the temporary progress estimate. Any peer failure resolves
            // all result slots through `_fail` and is still observed below.
            const initialResult = await this._resultSlots[0].promise;
            if (initialResult.error !== null) {
                throw createParallelParserError(initialResult.error);
            }
            this._throwIfCancelled();
            const initialRows = initialResult.rowCount;
            const initialBytes = initialResult.sourceBytes;
            const estimatedTotalRows = initialBytes > 0 ?
                Math.max(initialRows, Math.round(initialRows * this._totalBytes / initialBytes)) :
                initialRows;

            const profiles = [];
            let exactTotalRows = 0;
            let processedRows = 0;
            let workersFinishedAt = this._startedAt;
            for (let i = 0; i < this._resultSlots.length; ++i) {
                this._throwIfCancelled();
                const result = await this._resultSlots[i].promise;
                if (result.error !== null) { throw createParallelParserError(result.error); }
                if (result.chunk === null || result.profile === null) {
                    throw new Error('Parallel term-bank parser returned an incomplete result');
                }
                const chunk = result.chunk;
                if (result.consume !== null) { chunk.releaseBorrowedContent = result.consume; }
                if (result.profile !== null) {
                    result.profile.orderedSinkWaitMs = Math.max(0, safePerformance.now() - result.finishedAt);
                }
                profiles.push(result.profile);
                workersFinishedAt = Math.max(workersFinishedAt, result.finishedAt);
                processedRows += chunk.rowCount;
                exactTotalRows += chunk.rowCount;
                try {
                    await this._onChunk(chunk, {
                        processedRows,
                        totalRows: i + 1 === this._resultSlots.length ? processedRows : Math.max(processedRows, estimatedTotalRows),
                        chunkIndex: i + 1,
                        chunkCount: this._resultSlots.length,
                    });
                } finally {
                    result.consume?.();
                    delete chunk.releaseBorrowedContent;
                }
                this._nextSinkGroupIndex = i + 1;
                this._activateLeadSources();
                this._wakeLeadWaiters();
            }
            await Promise.all(this._workerLoops);
            if (this._error !== null) { throw this._error; }
            lastTermBankWasmParseProfile = {
                ...aggregateSequentialParseProfiles(
                    profiles,
                    exactTotalRows,
                    profiles.reduce((sum, profile) => sum + profile.chunkDispatchMs, 0),
                ),
                parallelWorkerCount: workers.length,
                parallelPipelineGroupsPerWorker: this._pipelineGroupsPerWorker,
                parallelGroupCount: this._groups.length,
                parallelWorkerWallMs: Math.max(0, workersFinishedAt - this._startedAt),
                parallelSourceReadWallMs: Math.max(
                    0,
                    Math.max(this._startedAt, ...this._sources.map(({resolvedAt}) => resolvedAt)) - this._startedAt,
                ),
            };
        } catch (error) {
            this._fail(error);
            await Promise.allSettled(this._workerLoops);
            throw this._error ?? new Error('Parallel term-bank pipeline failed');
        }
    }

    /** Creates one ordered result slot per byte-balanced source group. */
    _createSlots() {
        this._resultSlots = this._groups.map(() => {
            /** @type {(value: {chunk: TermBankColumnChunk|null, profile: NonNullable<typeof lastTermBankWasmParseProfile>|null, error: unknown, finishedAt: number, rowCount: number, sourceBytes: number, consume: (() => void)|null}) => void} */
            let resolve = () => {};
            const promise = new Promise((value) => { resolve = value; });
            return {promise, resolve};
        });
    }

    /**
     * @param {Worker} worker
     */
    async _runWorkerLoop(worker) {
        try {
            while (this._nextWorkerGroupIndex < this._groups.length) {
                const groupIndex = this._nextWorkerGroupIndex++;
                if (this._pipelineShouldCancel()) { throw createParallelParserCancellationError(); }
                await this._waitForLead(groupIndex);
                const sourceGroup = this._groups[groupIndex];
                const group = await waitForParallelSources(
                    sourceGroup.map((source) => loadParallelTermBankSource(source)),
                    () => this._pipelineShouldCancel(),
                );
                if (!group.every((source) => (
                    source instanceof Uint8Array ?
                        getJsonArrayContentSpan(source) !== null :
                        isCompressedTermBankSource(source)
                ))) {
                    throw new Error('Expected every deferred term-bank source to contain a JSON array');
                }
                // Capture this before postMessage transfers and detaches the
                // source buffers. The byte ratio estimates total rows until
                // every parallel group has reported its exact row count.
                const sourceBytes = sumParallelSourceByteLengths(group);
                const result = await runParallelParserJob(
                    worker,
                    groupIndex + 1,
                    group,
                    this._version,
                    this._options,
                    () => this._pipelineShouldCancel(),
                );
                if (result.error !== null) { throw createParallelParserError(result.error); }
                if (result.chunk === null || result.profile === null) {
                    throw new Error('Parallel term-bank parser returned an incomplete result');
                }
                if (result.chunk.rowCount !== result.rowCount) {
                    throw new Error('Parallel term-bank parser row count changed during result transfer');
                }
                /** @type {(() => void)|null} */
                let consume = null;
                /** @type {Promise<void>|null} */
                let consumed = null;
                if (result.borrowsWorkerMemory) {
                    /** @type {(value?: void|PromiseLike<void>) => void} */
                    let resolveConsumed = () => {};
                    consumed = new Promise((resolve) => { resolveConsumed = resolve; });
                    let pending = true;
                    const consumeResult = () => {
                        if (!pending) { return; }
                        pending = false;
                        this._pendingResultConsumers.delete(consumeResult);
                        resolveConsumed();
                    };
                    consume = consumeResult;
                    this._pendingResultConsumers.add(consume);
                }
                this._resultSlots[groupIndex].resolve({...result, sourceBytes, consume});
                if (consumed !== null) { await consumed; }
            }
        } catch (error) {
            this._fail(error);
        }
    }

    /** @returns {boolean} */
    _pipelineShouldCancel() {
        return this._failed || this._shouldCancel();
    }

    /** @throws {Error} If cancellation was requested. */
    _throwIfCancelled() {
        if (this._shouldCancel()) { throw createParallelParserCancellationError(); }
    }

    /** @param {unknown} error */
    _fail(error) {
        if (this._failed) { return; }
        this._failed = true;
        this._error = createParallelParserError(error);
        this._wakeLeadWaiters();
        for (const consume of this._pendingResultConsumers) { consume(); }
        const result = {chunk: null, profile: null, error: this._error, finishedAt: safePerformance.now(), rowCount: 0, sourceBytes: 0, consume: null};
        for (const slot of this._resultSlots) { slot.resolve(result); }
    }

    /**
     * Waits until the ordered sink opens room in the bounded parser lead.
     * @param {number} groupIndex
     * @returns {Promise<void>}
     */
    async _waitForLead(groupIndex) {
        while (
            !this._failed &&
            groupIndex >= this._nextSinkGroupIndex + this._maxLeadGroups
        ) {
            await new Promise(/** @param {(value?: void|PromiseLike<void>) => void} resolve */ (resolve) => {
                const timeoutId = setTimeout(() => {
                    this._leadWaiters.delete(wake);
                    resolve();
                }, PARALLEL_WORKER_CANCELLATION_POLL_MS);
                const wake = () => {
                    clearTimeout(timeoutId);
                    resolve();
                };
                this._leadWaiters.add(wake);
            });
            if (this._pipelineShouldCancel()) { throw createParallelParserCancellationError(); }
        }
    }

    /** Wakes parser workers after sink progress or terminal failure. */
    _wakeLeadWaiters() {
        const waiters = [...this._leadWaiters];
        this._leadWaiters.clear();
        for (const wake of waiters) { wake(); }
    }

    /** Starts ZIP reads for the bounded source window independently of parser workers. */
    _activateLeadSources() {
        const end = Math.min(
            this._groups.length,
            this._nextSinkGroupIndex + this._maxLeadGroups,
        );
        for (let groupIndex = this._nextSinkGroupIndex; groupIndex < end; ++groupIndex) {
            for (const source of this._groups[groupIndex]) {
                void loadParallelTermBankSource(source).catch(() => {});
            }
        }
    }
}

const parallelTermBankParserPool = new ParallelTermBankParserPool();

/**
 * Starts parser workers while source ZIP entries are still being inflated.
 * A failed prewarm is non-fatal; the caller can retain the in-worker parser.
 * @returns {Promise<boolean>}
 */
export async function prewarmParallelTermBankParser() {
    if (!canUseParallelTermBankParser()) { return false; }
    return await parallelTermBankParserPool.prewarm();
}

/** Releases parser heaps after import so lookup workloads do not retain them. */
export async function disposeParallelTermBankParser() {
    await parallelTermBankParserPool.dispose();
}

/**
 * Parses byte-balanced source-bank groups concurrently. Workers publish exact
 * complete column chunks in one message, allowing archive-ordered storage to
 * begin as soon as the first group is available and overlap later parsing.
 * @param {Uint8Array[]} contentBytes
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} [options]
 * @param {() => boolean} [shouldCancel]
 * @returns {Promise<boolean>}
 */
export async function parseTermBankWithWasmColumnChunksParallel(contentBytes, version, onChunk, options = {}, shouldCancel = () => false) {
    const sources = contentBytes.map((bytes) => ({
        promise: Promise.resolve(bytes),
        load: null,
        estimatedBytes: bytes.byteLength,
        resolvedAt: 0,
    }));
    return await parseTermBankWithWasmColumnChunksParallelSources(sources, version, onChunk, options, shouldCancel);
}

/**
 * Starts parsing before every source ZIP entry has finished inflating.
 * @param {Promise<Uint8Array>[]} contentBytePromises
 * @param {number[]} estimatedByteLengths
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} [options]
 * @param {() => boolean} [shouldCancel]
 * @returns {Promise<boolean>}
 */
export async function parseTermBankWithWasmColumnChunksParallelDeferred(contentBytePromises, estimatedByteLengths, version, onChunk, options = {}, shouldCancel = () => false) {
    if (contentBytePromises.length !== estimatedByteLengths.length) {
        throw new Error('Deferred term-bank source metadata length mismatch');
    }
    const sources = contentBytePromises.map((promise, index) => ({
        promise,
        load: null,
        estimatedBytes: estimatedByteLengths[index],
        resolvedAt: 0,
    }));
    return await parseTermBankWithWasmColumnChunksParallelSources(sources, version, onChunk, options, shouldCancel);
}

/**
 * Parses an import-wide source sequence without eagerly inflating every bank.
 * Parser workers activate only a bounded lead window of byte-balanced groups.
 * @param {Array<() => Promise<Uint8Array>>} contentByteLoaders
 * @param {number[]} estimatedByteLengths
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} [options]
 * @param {() => boolean} [shouldCancel]
 * @returns {Promise<boolean>}
 */
export async function parseTermBankWithWasmColumnChunksParallelLazy(contentByteLoaders, estimatedByteLengths, version, onChunk, options = {}, shouldCancel = () => false) {
    if (contentByteLoaders.length !== estimatedByteLengths.length) {
        throw new Error('Lazy term-bank source metadata length mismatch');
    }
    const sources = contentByteLoaders.map((load, index) => ({
        promise: null,
        load,
        estimatedBytes: estimatedByteLengths[index],
        resolvedAt: 0,
    }));
    return await parseTermBankWithWasmColumnChunksParallelSources(sources, version, onChunk, options, shouldCancel, true);
}

/**
 * Sends raw ZIP payloads to parser workers for fused WASM inflate, CRC
 * validation, and parsing without materializing uncompressed banks in the
 * import coordinator.
 * @param {Array<() => Promise<CompressedTermBankSource>>} sourceLoaders
 * @param {number[]} estimatedByteLengths
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} [options]
 * @param {() => boolean} [shouldCancel]
 * @returns {Promise<boolean>}
 */
export async function parseTermBankWithWasmColumnChunksParallelCompressedLazy(sourceLoaders, estimatedByteLengths, version, onChunk, options = {}, shouldCancel = () => false) {
    if (sourceLoaders.length !== estimatedByteLengths.length) {
        throw new Error('Compressed lazy term-bank source metadata length mismatch');
    }
    const sources = sourceLoaders.map((load, index) => ({
        promise: null,
        load,
        estimatedBytes: estimatedByteLengths[index],
        resolvedAt: 0,
    }));
    return await parseTermBankWithWasmColumnChunksParallelSources(sources, version, onChunk, options, shouldCancel, true);
}

/**
 * @param {ParallelTermBankSource[]} sources
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} options
 * @param {() => boolean} shouldCancel
 * @param {boolean} [lazy=false]
 * @returns {Promise<boolean>}
 */
async function parseTermBankWithWasmColumnChunksParallelSources(sources, version, onChunk, options, shouldCancel, lazy = false) {
    lastParallelParserSkipReason = null;
    if (sources.length < 4) {
        lastParallelParserSkipReason = 'source-count';
        return false;
    }
    if (options.emitContentSlab !== true) {
        lastParallelParserSkipReason = 'content-slab-disabled';
        return false;
    }
    if (!canUseParallelTermBankParser()) {
        lastParallelParserSkipReason = 'workers-unavailable';
        return false;
    }
    let totalBytes = 0;
    for (const source of sources) {
        if (!Number.isSafeInteger(source.estimatedBytes) || source.estimatedBytes < 0) {
            lastParallelParserSkipReason = 'source-size-budget';
            return false;
        }
        totalBytes += source.estimatedBytes;
        if (source.promise !== null) {
            source.promise = observeParallelTermBankSourcePromise(source, source.promise);
        } else if (typeof source.load !== 'function') {
            lastParallelParserSkipReason = 'source-loader';
            return false;
        }
    }
    if (!canUseParallelParserForSourceSize(totalBytes)) {
        lastParallelParserSkipReason = 'source-size-budget';
        return false;
    }
    const workerCount = getParallelTermBankParserWorkerCount();
    const pipelineGroupsPerWorker = getParallelSourcePipelineGroupsPerWorker(options);
    const requestedGroupCount = lazy ?
        Math.max(
            workerCount * pipelineGroupsPerWorker,
            Math.ceil(totalBytes / LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES),
        ) :
        workerCount * pipelineGroupsPerWorker;
    const groups = partitionSourceBanks(
        sources,
        totalBytes,
        requestedGroupCount,
    );
    if (groups.length < 2) {
        lastParallelParserSkipReason = 'partition-count';
        return false;
    }
    if (shouldCancel()) { throw createParallelParserCancellationError(); }
    const poolLease = parallelTermBankParserPool.acquireRun(workerCount);
    if (poolLease === null) {
        lastParallelParserSkipReason = 'parser-busy';
        return false;
    }

    const run = new ParallelTermBankPipelineRun(
        sources,
        groups,
        totalBytes,
        version,
        onChunk,
        options,
        shouldCancel,
        poolLease,
        pipelineGroupsPerWorker,
    );
    return await run.run();
}

/** @typedef {{promise: Promise<ParallelTermBankSourceValue>|null, load: (() => Promise<ParallelTermBankSourceValue>)|null, estimatedBytes: number, resolvedAt: number}} ParallelTermBankSource */

/**
 * @param {ParallelTermBankSource} source
 * @param {Promise<ParallelTermBankSourceValue>} promise
 * @returns {Promise<ParallelTermBankSourceValue>}
 */
function observeParallelTermBankSourcePromise(source, promise) {
    const observed = promise.then((bytes) => {
        source.resolvedAt = safePerformance.now();
        return bytes;
    });
    void observed.catch(() => {});
    return observed;
}

/**
 * @param {ParallelTermBankSource} source
 * @returns {Promise<ParallelTermBankSourceValue>}
 */
function loadParallelTermBankSource(source) {
    if (source.promise === null) {
        if (source.load === null) {
            return Promise.reject(new Error('Parallel term-bank source has no loader'));
        }
        let promise;
        try {
            promise = Promise.resolve(source.load());
        } catch (error) {
            promise = Promise.reject(error);
        }
        source.promise = observeParallelTermBankSourcePromise(source, promise);
    }
    return source.promise;
}

/** @returns {boolean} */
function canUseParallelTermBankParser() {
    return (
        getParallelTermBankParserWorkerCount() > 1 &&
        typeof Worker !== 'undefined' &&
        Reflect.get(globalThis, '__manabitanTermBankParserWorker') !== true
    );
}

/**
 * Uses a third parser heap only where the browser reports enough logical CPUs
 * and does not report a constrained memory tier. Missing device-memory hints
 * are normal in Firefox and do not disable the higher-throughput path.
 * @returns {number}
 */
export function getParallelTermBankParserWorkerCount() {
    const rawHardwareConcurrency = /** @type {unknown} */ (
        typeof navigator === 'undefined' ? void 0 : Reflect.get(navigator, 'hardwareConcurrency')
    );
    const rawDeviceMemory = /** @type {unknown} */ (
        typeof navigator === 'undefined' ? void 0 : Reflect.get(navigator, 'deviceMemory')
    );
    const hasEnoughCpus = (
        typeof rawHardwareConcurrency === 'number' &&
        Number.isFinite(rawHardwareConcurrency) &&
        rawHardwareConcurrency >= HIGH_CAPABILITY_MIN_HARDWARE_CONCURRENCY
    );
    const hasConstrainedMemory = (
        typeof rawDeviceMemory === 'number' &&
        Number.isFinite(rawDeviceMemory) &&
        rawDeviceMemory <= LOW_MEMORY_DEVICE_GIB
    );
    return hasEnoughCpus && !hasConstrainedMemory ?
        HIGH_CAPABILITY_PARALLEL_SOURCE_WORKER_COUNT :
        DEFAULT_PARALLEL_SOURCE_WORKER_COUNT;
}

/**
 * Media-aware parsing does more work per group and measured best with a
 * shallower queue. Plain term banks retain an extra group to overlap parsing
 * with journaled storage without keying policy to a dictionary title.
 * @param {Record<string, unknown>} options
 * @returns {number}
 */
function getParallelSourcePipelineGroupsPerWorker(options) {
    return options.mediaHintFastScan === true ?
        MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER :
        PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER;
}

/**
 * Avoids an uncatchable worker-process OOM on low-memory Chromium devices.
 * Firefox does not expose deviceMemory and has a lower measured worker peak,
 * so absence of the optional hint does not disable the portable fast path.
 * @param {number} totalBytes
 * @returns {boolean}
 */
function canUseParallelParserForSourceSize(totalBytes) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_WASM32_BUFFER_BYTES) {
        return false;
    }
    const rawDeviceMemory = /** @type {unknown} */ (
        typeof navigator === 'undefined' ? void 0 : Reflect.get(navigator, 'deviceMemory')
    );
    return !(
        typeof rawDeviceMemory === 'number' &&
        Number.isFinite(rawDeviceMemory) &&
        rawDeviceMemory <= LOW_MEMORY_DEVICE_GIB &&
        totalBytes > LOW_MEMORY_PARALLEL_SOURCE_LIMIT_BYTES
    );
}

/**
 * @param {AbortSignal} signal
 * @param {number} workerCount
 * @returns {Promise<{workers: Worker[]}>}
 */
async function createParallelParserWorkers(signal, workerCount) {
    const module = await compileTermBankWasmModule();
    if (signal.aborted) { throw createParallelParserCancellationError(); }
    /** @type {Worker[]} */
    const workers = [];
    try {
        const ready = [];
        for (let i = 0; i < workerCount; ++i) {
            const worker = new Worker(
                new URL('term-bank-wasm-parser-worker.js', import.meta.url),
                {type: 'module', name: `manabitan-term-bank-parser-${i + 1}`},
            );
            workers.push(worker);
            ready.push(waitForParallelParserWorkerReady(worker, module, signal));
        }
        await Promise.all(ready);
        return {workers};
    } catch (error) {
        for (const worker of workers) { worker.terminate(); }
        throw error;
    }
}

/**
 * @param {Worker} worker
 * @param {WebAssembly.Module} module
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function waitForParallelParserWorkerReady(worker, module, signal) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Term-bank parser worker initialization timed out after ${PARALLEL_WORKER_READY_TIMEOUT_MS}ms`));
        }, PARALLEL_WORKER_READY_TIMEOUT_MS);
        /** @param {MessageEvent<unknown>} event */
        const onMessage = (event) => {
            const data = /** @type {ParallelParserWorkerMessage} */ (event.data);
            if (data?.type !== 'ready' && data?.type !== 'initialization-error') { return; }
            cleanup();
            if (data.type === 'ready') {
                resolve();
            } else {
                reject(createParallelParserError(data.error));
            }
        };
        /** @param {ErrorEvent} event */
        const onError = (event) => {
            cleanup();
            reject(new Error(event.message || 'Term-bank parser worker initialization failed'));
        };
        const onAbort = () => {
            cleanup();
            reject(createParallelParserCancellationError());
        };
        const cleanup = () => {
            clearTimeout(timeoutId);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            signal.removeEventListener('abort', onAbort);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        signal.addEventListener('abort', onAbort, {once: true});
        try {
            if (signal.aborted) {
                onAbort();
                return;
            }
            worker.postMessage({type: 'initialize', module});
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/**
 * @param {Worker} worker
 * @param {number} id
 * @param {ParallelTermBankSourceValue[]} sources
 * @param {number} version
 * @param {Record<string, unknown>} options
 * @param {() => boolean} shouldCancel
 * @returns {Promise<{chunk: TermBankColumnChunk|null, profile: NonNullable<typeof lastTermBankWasmParseProfile>|null, error: unknown, finishedAt: number, rowCount: number, borrowsWorkerMemory: boolean}>}
 */
function runParallelParserJob(worker, id, sources, version, options, shouldCancel) {
    return new Promise((resolve, reject) => {
        const sourcePreparationStart = safePerformance.now();
        const sourceBuffers = [];
        /** @type {Array<{compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename?: string}>} */
        const sourceMetadata = [];
        const seenBuffers = new Set();
        let sourceTransferredBytes = 0;
        let hasCompressedSources = false;
        for (const source of sources) {
            const bytes = source instanceof Uint8Array ? source : source.bytes;
            let buffer = bytes.buffer;
            if (
                !(buffer instanceof ArrayBuffer) ||
                bytes.byteOffset !== 0 ||
                bytes.byteLength !== buffer.byteLength ||
                seenBuffers.has(buffer)
            ) {
                buffer = Uint8Array.from(bytes).buffer;
            }
            seenBuffers.add(buffer);
            sourceBuffers.push(buffer);
            sourceTransferredBytes += buffer.byteLength;
            if (source instanceof Uint8Array) {
                if (hasCompressedSources) {
                    throw new Error('Parallel parser cannot mix compressed and inflated term-bank sources');
                }
            } else {
                if (sourceMetadata.length !== sourceBuffers.length - 1) {
                    throw new Error('Parallel parser cannot mix inflated and compressed term-bank sources');
                }
                hasCompressedSources = true;
                sourceMetadata.push({
                    compressionMethod: source.compressionMethod,
                    compressedSize: source.compressedSize,
                    uncompressedSize: source.uncompressedSize,
                    signature: source.signature,
                    filename: source.filename,
                });
            }
        }
        const sourcePreparationMs = Math.max(0, safePerformance.now() - sourcePreparationStart);
        const timeoutId = setTimeout(() => {
            cleanup();
            worker.terminate();
            const error = new Error(`Term-bank parser worker timed out after ${PARALLEL_WORKER_PARSE_TIMEOUT_MS}ms`);
            reject(error);
        }, PARALLEL_WORKER_PARSE_TIMEOUT_MS);
        const cancellationIntervalId = setInterval(() => {
            let cancelled;
            try {
                cancelled = shouldCancel();
            } catch (error) {
                cleanup();
                worker.terminate();
                reject(error);
                return;
            }
            if (!cancelled) { return; }
            cleanup();
            worker.terminate();
            const error = createParallelParserCancellationError();
            reject(error);
        }, PARALLEL_WORKER_CANCELLATION_POLL_MS);
        /** @param {MessageEvent<unknown>} event */
        const onMessage = (event) => {
            const data = /** @type {ParallelParserWorkerMessage} */ (event.data);
            if (data?.id !== id) { return; }
            if (data.type !== 'result' && data.type !== 'parse-error') { return; }
            cleanup();
            if (data.type === 'result') {
                if (!Number.isSafeInteger(data.rowCount) || /** @type {number} */ (data.rowCount) < 0) {
                    worker.terminate();
                    const error = new Error('Term-bank parser worker returned an invalid row count');
                    reject(error);
                    return;
                }
                if (!Number.isSafeInteger(data.resultSentEpochMs) || /** @type {number} */ (data.resultSentEpochMs) < 0) {
                    worker.terminate();
                    reject(new Error('Term-bank parser worker returned an invalid result timestamp'));
                    return;
                }
                const profile = /** @type {NonNullable<typeof lastTermBankWasmParseProfile>|null} */ (data.profile ?? null);
                if (profile !== null) {
                    profile.sourcePreparationMs = sourcePreparationMs;
                    profile.sourceTransferredBytes = sourceTransferredBytes;
                    profile.resultDeliveryMs = Math.max(0, Date.now() - /** @type {number} */ (data.resultSentEpochMs));
                }
                const chunk = /** @type {TermBankColumnChunk|null} */ (data.chunk ?? null);
                resolve({
                    chunk,
                    profile,
                    error: null,
                    finishedAt: safePerformance.now(),
                    rowCount: /** @type {number} */ (data.rowCount),
                    borrowsWorkerMemory: (
                        data.borrowsWorkerMemory === true ||
                        (
                            typeof SharedArrayBuffer === 'function' &&
                            chunk?.contentBytesBuffer?.buffer instanceof SharedArrayBuffer
                        )
                    ),
                });
            } else {
                worker.terminate();
                const error = data.error ?? {message: 'Parallel term-bank parse failed'};
                resolve({chunk: null, profile: null, error, finishedAt: safePerformance.now(), rowCount: 0, borrowsWorkerMemory: false});
            }
        };
        /** @param {ErrorEvent} event */
        const onError = (event) => {
            cleanup();
            worker.terminate();
            const error = new Error(event.message || 'Term-bank parser worker failed');
            reject(error);
        };
        /** @param {MessageEvent<unknown>} _event */
        const onMessageError = (_event) => {
            cleanup();
            worker.terminate();
            const error = new Error('Term-bank parser worker returned an invalid message');
            reject(error);
        };
        const cleanup = () => {
            clearTimeout(timeoutId);
            clearInterval(cancellationIntervalId);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('messageerror', onMessageError);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        try {
            if (shouldCancel()) {
                cleanup();
                worker.terminate();
                const error = createParallelParserCancellationError();
                reject(error);
                return;
            }
            worker.postMessage({
                type: 'parse',
                id,
                sourceBuffers,
                ...(hasCompressedSources ? {sourceMetadata} : {}),
                sourceSentEpochMs: Date.now(),
                version,
                options,
            }, sourceBuffers);
        } catch (error) {
            cleanup();
            worker.terminate();
            const dispatchError = new Error(`Failed to dispatch term-bank parser worker: ${error}`);
            reject(dispatchError);
        }
    });
}

/**
 * Keeps cancellation responsive while source ZIP workers are still inflating.
 * The source promises remain observed after cancellation so late rejections do
 * not become unhandled; their owning importer may abort the underlying reads.
 * @param {Promise<ParallelTermBankSourceValue>[]} promises
 * @param {() => boolean} shouldCancel
 * @returns {Promise<ParallelTermBankSourceValue[]>}
 */
function waitForParallelSources(promises, shouldCancel) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => { clearInterval(cancellationIntervalId); };
        /** @param {ParallelTermBankSourceValue[]} value */
        const settleResolve = (value) => {
            if (settled) { return; }
            settled = true;
            cleanup();
            resolve(value);
        };
        /** @param {unknown} error */
        const settleReject = (error) => {
            if (settled) { return; }
            settled = true;
            cleanup();
            reject(createParallelParserError(error));
        };
        const pollCancellation = () => {
            try {
                if (shouldCancel()) { settleReject(createParallelParserCancellationError()); }
            } catch (error) {
                settleReject(error);
            }
        };
        const cancellationIntervalId = setInterval(pollCancellation, PARALLEL_WORKER_CANCELLATION_POLL_MS);
        void Promise.all(promises).then(settleResolve, settleReject);
        pollCancellation();
    });
}

/** @returns {Error} */
function createParallelParserCancellationError() {
    const error = new Error('Parallel term-bank parsing was cancelled');
    error.name = 'AbortError';
    return error;
}

/**
 * @param {unknown} value
 * @returns {Error}
 */
function createParallelParserError(value) {
    const data = /** @type {{name?: unknown, message?: unknown, stack?: unknown}|null} */ (
        typeof value === 'object' ? value : null
    );
    const message = typeof data?.message === 'string' ? data.message : `${value}`;
    const error = data?.name === 'TermBankWasmResourceError' ? new TermBankWasmResourceError(message) : new Error(message);
    if (typeof data?.name === 'string' && data.name.length > 0) { error.name = data.name; }
    if (typeof data?.stack === 'string') { error.stack = data.stack; }
    return error;
}

/**
 * Overlaps storage of the first source-bank group with parsing of the second.
 * The first result is detached from WASM memory before the parser heap is
 * reused; storage callbacks remain serialized in archive order.
 * @param {Uint8Array[]} contentBytes
 * @param {number} version
 * @param {(chunk: TermBankColumnChunk, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function parseTermBankWithWasmColumnChunksOverlapped(contentBytes, version, onChunk, options = {}) {
    if (contentBytes.length < 4 || options.emitContentSlab !== true) { return false; }

    let totalBytes = 0;
    for (const bytes of contentBytes) { totalBytes += bytes.byteLength; }
    const groups = partitionSourceBanks(contentBytes, totalBytes, OVERLAPPED_SOURCE_GROUP_COUNT);
    const groupBytes = groups.map((group) => {
        let result = 0;
        for (const bytes of group) { result += bytes.byteLength; }
        return result;
    });
    /** @type {Array<NonNullable<typeof lastTermBankWasmParseProfile>>} */
    const profiles = [];
    let processedRows = 0;
    let sinkWorkMs = 0;
    let sinkTail = Promise.resolve();
    /** @type {Error|null} */
    let parseError = null;

    try {
        for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
            await parseTermBankWithWasmColumnChunks(
                groups[groupIndex],
                version,
                (chunk) => {
                    const stableChunk = groupIndex + 1 < groups.length ? copyWasmBackedColumnChunk(chunk) : chunk;
                    const rowCount = stableChunk.rowCount;
                    processedRows += rowCount;
                    const totalRows = groupIndex + 1 === groups.length ?
                        processedRows :
                        Math.max(250_001, Math.round(rowCount * totalBytes / Math.max(1, groupBytes[groupIndex])));
                    const progress = {
                        processedRows,
                        totalRows,
                        chunkIndex: groupIndex + 1,
                        chunkCount: groups.length,
                    };
                    sinkTail = sinkTail.then(async () => {
                        const startedAt = Date.now();
                        await onChunk(stableChunk, progress);
                        sinkWorkMs += Math.max(0, Date.now() - startedAt);
                    });
                    void sinkTail.catch(() => {});
                },
                DEFAULT_ROW_CHUNK_SIZE,
                {...options, maxPendingChunks: 1, singleChunk: true},
            );
            const profile = lastTermBankWasmParseProfile;
            if (profile === null) { throw new Error('Term-bank parser profile is unavailable'); }
            profiles.push(profile);
        }
    } catch (error) {
        parseError = error instanceof Error ? error : new Error(`${error}`);
    }

    /** @type {Error|null} */
    let sinkError = null;
    try {
        await sinkTail;
    } catch (error) {
        sinkError = error instanceof Error ? error : new Error(`${error}`);
    }
    if (parseError !== null) { throw parseError; }
    if (sinkError !== null) { throw sinkError; }
    lastTermBankWasmParseProfile = aggregateSequentialParseProfiles(profiles, processedRows, sinkWorkMs);
    return true;
}

/**
 * @template T
 * @param {T[]} contentBytes
 * @param {number} totalBytes
 * @param {number} requestedGroupCount
 * @returns {T[][]}
 */
function partitionSourceBanks(contentBytes, totalBytes, requestedGroupCount) {
    const groupCount = Math.min(requestedGroupCount, contentBytes.length);
    const groups = [];
    let start = 0;
    let consumedBytes = 0;
    for (let groupIndex = 0; groupIndex < groupCount - 1; ++groupIndex) {
        const remainingGroups = groupCount - groupIndex;
        const targetBytes = (totalBytes - consumedBytes) / remainingGroups;
        let end = start + 1;
        let bytes = getPartitionSourceByteLength(contentBytes[start]);
        const maxEnd = contentBytes.length - (remainingGroups - 1);
        while (end < maxEnd) {
            const nextBytes = bytes + getPartitionSourceByteLength(contentBytes[end]);
            if (Math.abs(nextBytes - targetBytes) > Math.abs(bytes - targetBytes)) { break; }
            bytes = nextBytes;
            ++end;
        }
        groups.push(contentBytes.slice(start, end));
        start = end;
        consumedBytes += bytes;
    }
    groups.push(contentBytes.slice(start));
    return groups;
}

/**
 * @param {unknown} source
 * @returns {number}
 */
function getPartitionSourceByteLength(source) {
    if (source instanceof Uint8Array) { return source.byteLength; }
    if (typeof source !== 'object' || source === null) { return 0; }
    const estimatedBytes = /** @type {unknown} */ (Reflect.get(source, 'estimatedBytes'));
    return typeof estimatedBytes === 'number' && Number.isFinite(estimatedBytes) ? estimatedBytes : 0;
}

/**
 * @param {ParallelTermBankSourceValue[]} values
 * @returns {number}
 */
function sumParallelSourceByteLengths(values) {
    let total = 0;
    for (const value of values) {
        total += value instanceof Uint8Array ? value.byteLength : value.uncompressedSize;
    }
    return total;
}

/**
 * @param {unknown} value
 * @returns {value is CompressedTermBankSource}
 */
function isCompressedTermBankSource(value) {
    if (typeof value !== 'object' || value === null) { return false; }
    const bytes = /** @type {unknown} */ (Reflect.get(value, 'bytes'));
    const compressionMethod = /** @type {unknown} */ (Reflect.get(value, 'compressionMethod'));
    const compressedSize = /** @type {unknown} */ (Reflect.get(value, 'compressedSize'));
    const uncompressedSize = /** @type {unknown} */ (Reflect.get(value, 'uncompressedSize'));
    const signature = /** @type {unknown} */ (Reflect.get(value, 'signature'));
    return (
        bytes instanceof Uint8Array &&
        (compressionMethod === 0 || compressionMethod === 8) &&
        typeof compressedSize === 'number' && Number.isSafeInteger(compressedSize) && compressedSize >= 0 && bytes.byteLength === compressedSize &&
        typeof uncompressedSize === 'number' && Number.isSafeInteger(uncompressedSize) && uncompressedSize >= 0 &&
        typeof signature === 'number' && Number.isInteger(signature) && signature >= 0 && signature <= 0xffffffff
    );
}

/**
 * @param {TermBankColumnChunk} chunk
 * @param {boolean} [shareContentBytes=false]
 * @param {boolean} [shareContentMetadata=false]
 * @returns {TermBankColumnChunk}
 * @throws {Error} If the native string plan is incomplete.
 */
export function copyWasmBackedColumnChunk(chunk, shareContentBytes = false, shareContentMetadata = false) {
    const sourceContentMetaList = chunk.contentMetaList ?? new Uint32Array(0);
    const contentMetaList =
        shareContentMetadata &&
        typeof SharedArrayBuffer === 'function' &&
        sourceContentMetaList.buffer instanceof SharedArrayBuffer ?
            sourceContentMetaList :
            Uint32Array.from(sourceContentMetaList);
    let contentBytesLength = 0;
    for (let i = 0; i < contentMetaList.length; i += CONTENT_META_U32_FIELDS) {
        contentBytesLength = Math.max(contentBytesLength, contentMetaList[i] + contentMetaList[i + 1]);
    }
    const contentBytesStart = chunk.contentBytesBaseOffset ?? 0;
    const contentBytesSource = chunk.contentBytesBuffer?.subarray(
        contentBytesStart,
        contentBytesStart + contentBytesLength,
    );
    let contentBytesBuffer;
    if (
        typeof contentBytesSource !== 'undefined' &&
        shareContentBytes &&
        typeof SharedArrayBuffer === 'function'
    ) {
        if (contentBytesSource.buffer instanceof SharedArrayBuffer) {
            contentBytesBuffer = contentBytesSource;
        } else {
            contentBytesBuffer = new Uint8Array(new SharedArrayBuffer(contentBytesLength));
            contentBytesBuffer.set(contentBytesSource);
        }
    } else {
        contentBytesBuffer = contentBytesSource?.slice();
    }
    const plan = chunk.termRecordPreinternedPlan;
    const stringOffsets = plan.stringOffsets;
    if (!(stringOffsets instanceof Uint32Array)) {
        throw new Error('Term record string offsets are unavailable');
    }
    const mediaRows = chunk.mediaRows.map(({index, row}) => ({
        index,
        row: {
            ...row,
            expressionBytes: row.expressionBytes instanceof Uint8Array ? Uint8Array.from(row.expressionBytes) : void 0,
            readingBytes: row.readingBytes instanceof Uint8Array ? Uint8Array.from(row.readingBytes) : void 0,
            glossaryJsonBytes: row.glossaryJsonBytes instanceof Uint8Array ? Uint8Array.from(row.glossaryJsonBytes) : void 0,
            termEntryContentBytes: Uint8Array.from(row.termEntryContentBytes),
        },
    }));
    const stablePlan = {
        stringLengths: Uint16Array.from(plan.stringLengths),
        stringOffsets: chunk.preparedLookupIndexes instanceof Map ? void 0 : Uint32Array.from(stringOffsets),
        stringHashes: chunk.preparedLookupIndexes instanceof Map ?
            void 0 :
            (plan.stringHashes instanceof Uint32Array ? Uint32Array.from(plan.stringHashes) : void 0),
        stringsBuffer: Uint8Array.from(plan.stringsBuffer),
        expressionIndexes: Uint32Array.from(plan.expressionIndexes),
        readingIndexes: Uint32Array.from(plan.readingIndexes),
    };
    /** @type {Map<string, import('./term-lookup-index-preparation.js').PreparedTermLookupIndex>|undefined} */
    let preparedLookupIndexes;
    if (chunk.preparedLookupIndexes instanceof Map) {
        preparedLookupIndexes = new Map();
        for (const [key, prepared] of chunk.preparedLookupIndexes) {
            preparedLookupIndexes.set(key, {
                bytes: prepared.bytes.buffer === plan.stringsBuffer.buffer ?
                    Uint8Array.from(prepared.bytes) :
                    prepared.bytes,
                preinternedPlan: stablePlan,
            });
        }
    }
    return {
        ...chunk,
        expressionBytesList: chunk.expressionBytesList.map((bytes) => Uint8Array.from(bytes)),
        readingBytesList: chunk.readingBytesList.map((bytes) => Uint8Array.from(bytes)),
        readingEqualsExpressionList: Uint8Array.from(chunk.readingEqualsExpressionList),
        scoreList: Int32Array.from(chunk.scoreList),
        sequenceList: Int32Array.from(chunk.sequenceList),
        contentBytesList: chunk.contentBytesList.map((bytes) => Uint8Array.from(bytes)),
        contentHash1List: Uint32Array.from(chunk.contentHash1List),
        contentHash2List: Uint32Array.from(chunk.contentHash2List),
        contentBytesBuffer,
        contentBytesBaseOffset: 0,
        contentMetaList,
        contentUniqueIndexList: chunk.contentUniqueIndexList === null ? null : Uint32Array.from(chunk.contentUniqueIndexList),
        mediaRows,
        termRecordPreinternedPlan: stablePlan,
        ...(typeof preparedLookupIndexes === 'undefined' ? {} : {preparedLookupIndexes}),
    };
}

/**
 * @param {Array<NonNullable<typeof lastTermBankWasmParseProfile>>} profiles
 * @param {number} rowCount
 * @param {number} chunkDispatchMs
 * @returns {NonNullable<typeof lastTermBankWasmParseProfile>}
 */
function aggregateSequentialParseProfiles(profiles, rowCount, chunkDispatchMs) {
    /**
     * @param {keyof NonNullable<typeof lastTermBankWasmParseProfile>} key
     * @returns {number}
     */
    const sum = (key) => {
        let result = 0;
        for (const profile of profiles) {
            const value = profile[key];
            if (typeof value === 'number') { result += value; }
        }
        return result;
    };
    return {
        bufferSetupMs: sum('bufferSetupMs'),
        allocationMs: sum('allocationMs'),
        nativeStringPlanAllocationMs: sum('nativeStringPlanAllocationMs'),
        copyJsonMs: sum('copyJsonMs'),
        parseBankMs: sum('parseBankMs'),
        encodeContentMs: sum('encodeContentMs'),
        recentContentDedupHitCount: sum('recentContentDedupHitCount'),
        rowDecodeMs: sum('rowDecodeMs'),
        nativeStringPlanMs: sum('nativeStringPlanMs'),
        nativeStringPlanChunkCount: sum('nativeStringPlanChunkCount'),
        nativeStringPlanFallbackChunkCount: sum('nativeStringPlanFallbackChunkCount'),
        chunkDispatchMs,
        sourcePreparationMs: sum('sourcePreparationMs'),
        sourceDeliveryMs: sum('sourceDeliveryMs'),
        sourceTransferredBytes: sum('sourceTransferredBytes'),
        sourceInflateMs: sum('sourceInflateMs'),
        sourceCompressedBytes: sum('sourceCompressedBytes'),
        sourceUncompressedBytes: sum('sourceUncompressedBytes'),
        resultCopyMs: sum('resultCopyMs'),
        resultDeliveryMs: sum('resultDeliveryMs'),
        orderedSinkWaitMs: sum('orderedSinkWaitMs'),
        borrowedContentResultCount: sum('borrowedContentResultCount'),
        lookupIndexPrepareMs: sum('lookupIndexPrepareMs'),
        lookupIndexCompactMs: sum('lookupIndexCompactMs'),
        lookupIndexEncodeMs: sum('lookupIndexEncodeMs'),
        rowCount,
        metaCapacity: sum('metaCapacity'),
        metaAllocatedBytes: sum('metaAllocatedBytes'),
        encodedContentBytes: sum('encodedContentBytes'),
        contentCapacity: sum('contentCapacity'),
        initialContentBytesPerRow: profiles[0]?.initialContentBytesPerRow ?? 0,
        chunkCount: profiles.length,
        chunkSize: 0,
        maxPendingChunks: 1,
        minimalDecode: true,
        includeContentMetadata: true,
        copyContentBytes: false,
        reuseExpressionForReadingDecode: true,
        skipTagRuleDecode: true,
        lazyGlossaryDecode: true,
        mediaHintFastScan: false,
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
