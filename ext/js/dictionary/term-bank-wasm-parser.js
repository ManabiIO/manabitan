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
const EMPTY_UINT8_ARRAY = new Uint8Array(0);
/** @typedef {{expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, readingEqualsExpression?: boolean, definitionTags: string, rules: string, score: number, glossaryJson: string, glossaryJsonBytes?: Uint8Array, glossaryMayContainMedia?: boolean, sequence: number|null, termTags: string, termEntryContentHash1?: number, termEntryContentHash2?: number, termEntryContentBytes: Uint8Array}} ParsedTermBankRow */
/** @type {Promise<{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, parse_term_bank_with_media_hints: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, encode_term_content: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_no_hash: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number}>|null} */
let wasmPromise = null;

/** @type {TextDecoder} */
const textDecoder = new TextDecoder();
/** @type {TextEncoder} */
const textEncoder = new TextEncoder();
/** @type {{bufferSetupMs: number, allocationMs: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, rowDecodeMs: number, chunkDispatchMs: number, rowCount: number, chunkCount: number, chunkSize: number, maxPendingChunks: number, minimalDecode: boolean, includeContentMetadata: boolean, copyContentBytes: boolean, reuseExpressionForReadingDecode: boolean, skipTagRuleDecode: boolean, lazyGlossaryDecode: boolean, mediaHintFastScan: boolean}|null} */
let lastTermBankWasmParseProfile = null;
/** @type {number} */
let lastSuccessfulMetaCapacity = 0;
/** @type {number} */
let lastSuccessfulContentBytesPerRow = 0;

/**
 * @returns {Promise<{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, parse_term_bank_with_media_hints: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, encode_term_content: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_no_hash: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number}>}
 */
async function getWasm() {
    if (wasmPromise !== null) {
        return await wasmPromise;
    }
    wasmPromise = (async () => {
        const url = new URL('../../lib/term-bank-parser.wasm', import.meta.url);
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        const instance = await WebAssembly.instantiate(bytes, {});
        const exports = /** @type {WebAssembly.Exports & {memory?: WebAssembly.Memory, wasm_reset_heap?: () => void, wasm_alloc?: (size: number) => number, parse_term_bank?: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, parse_term_bank_with_media_hints?: (jsonPtr: number, jsonLen: number, outPtr: number, outCapacity: number) => number, encode_term_content?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number, encode_term_content_no_hash?: (jsonPtr: number, metasPtr: number, rowCount: number, outPtr: number, outCapacity: number, rowMetaPtr: number) => number}} */ (instance.instance.exports);
        if (
            !(exports.memory instanceof WebAssembly.Memory) ||
            typeof exports.wasm_reset_heap !== 'function' ||
            typeof exports.wasm_alloc !== 'function' ||
            typeof exports.parse_term_bank !== 'function' ||
            typeof exports.parse_term_bank_with_media_hints !== 'function' ||
            typeof exports.encode_term_content !== 'function' ||
            typeof exports.encode_term_content_no_hash !== 'function'
        ) {
            throw new Error('term-bank wasm parser exports are invalid');
        }
        return {
            memory: exports.memory,
            wasm_reset_heap: exports.wasm_reset_heap,
            wasm_alloc: exports.wasm_alloc,
            parse_term_bank: exports.parse_term_bank,
            parse_term_bank_with_media_hints: exports.parse_term_bank_with_media_hints,
            encode_term_content: exports.encode_term_content,
            encode_term_content_no_hash: exports.encode_term_content_no_hash,
        };
    })();
    return await wasmPromise;
}

/**
 * @returns {{bufferSetupMs: number, allocationMs: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number, rowDecodeMs: number, chunkDispatchMs: number, rowCount: number, chunkCount: number, chunkSize: number, maxPendingChunks: number, minimalDecode: boolean, includeContentMetadata: boolean, copyContentBytes: boolean, reuseExpressionForReadingDecode: boolean, skipTagRuleDecode: boolean, lazyGlossaryDecode: boolean, mediaHintFastScan: boolean}|null}
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
function isNullToken(source, start, length) {
    return length === 4 && source[start] === U8_N && source[start + 1] === U8_U && source[start + 2] === U8_L && source[start + 3] === U8_L;
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
 * @param {number} fallback
 * @returns {number}
 */
function decodeNumberToken(source, start, length, fallback) {
    if (length <= 0) { return fallback; }
    let i = start;
    const end = start + length;
    let sign = 1;
    if (source[i] === 0x2d) { // '-'
        sign = -1;
        ++i;
        if (i >= end) { return fallback; }
    }
    let value = 0;
    let hasDigit = false;
    for (; i < end; ++i) {
        const c = source[i];
        if (c >= 0x30 && c <= 0x39) { // '0'..'9'
            value = (value * 10) + (c - 0x30);
            hasDigit = true;
            continue;
        }
        const raw = textDecoder.decode(source.subarray(start, end));
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return hasDigit ? (sign * value) : fallback;
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
 * @param {number} initialMetaCapacityDivisor
 * @param {number} initialContentBytesPerRow
 * @param {boolean} mediaHintFastScan
 * @param {boolean} computeContentHashes
 * @returns {Promise<{heap: Uint8Array, source: Uint8Array, metas: Uint32Array, contentMetas: Uint32Array, contentOutPtr: number, rowCount: number, allocationMs: number, copyJsonMs: number, parseBankMs: number, encodeContentMs: number}>}
 * @throws {Error}
 */
async function parseTermBankWasmBuffers(contentBytes, includeContentMetadata, initialMetaCapacityDivisor, initialContentBytesPerRow, mediaHintFastScan, computeContentHashes) {
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
            heap: new Uint8Array(0),
            source: new Uint8Array(0),
            metas: new Uint32Array(0),
            contentMetas: new Uint32Array(0),
            contentOutPtr: 0,
            rowCount: 0,
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
        throw new Error('Failed to allocate wasm json buffer');
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

    const normalizedMetaCapacityDivisor = Number.isFinite(initialMetaCapacityDivisor) ? Math.max(8, Math.min(128, Math.trunc(initialMetaCapacityDivisor))) : 24;
    let capacity = Math.max(1024, Math.floor(jsonLength / normalizedMetaCapacityDivisor));
    if (capacity < 8192) { capacity = 8192; }
    if (lastSuccessfulMetaCapacity > 0) {
        capacity = Math.max(capacity, lastSuccessfulMetaCapacity);
    }
    let rowCount = -1;
    let outPtr = 0;
    for (let attempt = 0; attempt < 6; ++attempt) {
        tStart = Date.now();
        outPtr = wasm.wasm_alloc(capacity * META_U32_FIELDS * 4);
        allocationMs += Math.max(0, Date.now() - tStart);
        if (outPtr === 0) {
            throw new Error('Failed to allocate wasm term metadata buffer');
        }
        tStart = Date.now();
        rowCount = mediaHintFastScan ?
            wasm.parse_term_bank_with_media_hints(jsonPtr, jsonLength, outPtr, capacity) :
            wasm.parse_term_bank(jsonPtr, jsonLength, outPtr, capacity);
        parseBankMs += Math.max(0, Date.now() - tStart);
        if (rowCount >= 0) {
            break;
        }
        if (rowCount !== -2) {
            throw new Error(`term-bank parser failed with code ${rowCount}`);
        }
        capacity *= 2;
    }
    if (rowCount < 0) {
        throw new Error(`term-bank parser exhausted capacity (code ${rowCount})`);
    }
    lastSuccessfulMetaCapacity = Math.max(lastSuccessfulMetaCapacity, capacity);

    if (!includeContentMetadata) {
        const heap = new Uint8Array(wasm.memory.buffer);
        const metas = new Uint32Array(wasm.memory.buffer, outPtr, rowCount * META_U32_FIELDS);
        const source = heap.subarray(jsonPtr, jsonPtr + jsonLength);
        return {
            heap,
            source,
            metas,
            contentMetas: new Uint32Array(0),
            contentOutPtr: 0,
            rowCount,
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
        throw new Error('Failed to allocate wasm content metadata buffer');
    }
    const normalizedInitialContentBytesPerRow = Number.isFinite(initialContentBytesPerRow) ? Math.max(16, Math.min(512, Math.trunc(initialContentBytesPerRow))) : 96;
    let contentOutCapacity = Math.max(jsonLength, rowCount * normalizedInitialContentBytesPerRow);
    if (lastSuccessfulContentBytesPerRow > 0) {
        contentOutCapacity = Math.max(contentOutCapacity, rowCount * lastSuccessfulContentBytesPerRow);
    }
    let contentOutPtr = 0;
    let encodedContentBytes = -1;
    for (let attempt = 0; attempt < 6; ++attempt) {
        tStart = Date.now();
        contentOutPtr = wasm.wasm_alloc(contentOutCapacity);
        allocationMs += Math.max(0, Date.now() - tStart);
        if (contentOutPtr === 0) {
            throw new Error('Failed to allocate wasm content buffer');
        }
        tStart = Date.now();
        const encodeTermContent = computeContentHashes ? wasm.encode_term_content : wasm.encode_term_content_no_hash;
        encodedContentBytes = encodeTermContent(
            jsonPtr,
            outPtr,
            rowCount,
            contentOutPtr,
            contentOutCapacity,
            contentMetaPtr,
        );
        encodeContentMs += Math.max(0, Date.now() - tStart);
        if (encodedContentBytes >= 0) {
            break;
        }
        if (encodedContentBytes !== -2) {
            throw new Error(`term-content encoder failed with code ${encodedContentBytes}`);
        }
        contentOutCapacity *= 2;
    }
    if (encodedContentBytes < 0) {
        throw new Error(`term-content encoder exhausted capacity (code ${encodedContentBytes})`);
    }
    if (rowCount > 0) {
        const nextContentBytesPerRow = Math.max(
            normalizedInitialContentBytesPerRow,
            Math.ceil(encodedContentBytes / rowCount) + 8,
        );
        lastSuccessfulContentBytesPerRow = Math.max(lastSuccessfulContentBytesPerRow, nextContentBytesPerRow);
    }

    const heap = new Uint8Array(wasm.memory.buffer);
    const metas = new Uint32Array(wasm.memory.buffer, outPtr, rowCount * META_U32_FIELDS);
    const source = heap.subarray(jsonPtr, jsonPtr + jsonLength);
    const contentMetas = new Uint32Array(wasm.memory.buffer, contentMetaPtr, rowCount * CONTENT_META_U32_FIELDS);
    return {
        heap,
        source,
        metas,
        contentMetas,
        contentOutPtr,
        rowCount,
        allocationMs,
        copyJsonMs,
        parseBankMs,
        encodeContentMs,
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
    const score = decodeNumberToken(source, metas[o + 8], metas[o + 9], 0);
    const glossaryStart = metas[o + 10];
    const glossaryLength = metas[o + 11];
    const glossaryJsonBytes = source.subarray(glossaryStart, glossaryStart + glossaryLength);
    const glossaryJson = lazyGlossaryDecode ? '' : decodeRawToken(source, glossaryStart, glossaryLength);
    const glossaryMayContainMedia = mediaHintFastScan ? metas[o + 16] === 1 : void 0;
    const sequence = version >= 3 ? (isNullToken(source, metas[o + 12], metas[o + 13]) ? null : decodeNumberToken(source, metas[o + 12], metas[o + 13], 0)) : null;
    const termTags = skipTagRuleDecode ? '' : (version >= 3 ? (decodeNullableJsonStringToken(source, metas[o + 14], metas[o + 15]) ?? '') : '');
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
    const score = decodeNumberToken(source, metas[o + 8], metas[o + 9], 0);
    const glossaryStart = metas[o + 10];
    const glossaryLength = metas[o + 11];
    const glossaryJsonBytes = lazyGlossaryDecode ? source.subarray(glossaryStart, glossaryStart + glossaryLength) : void 0;
    const glossaryMayContainMedia = mediaHintFastScan ? metas[o + 16] === 1 : void 0;
    const sequence = version >= 3 ? (isNullToken(source, metas[o + 12], metas[o + 13]) ? null : decodeNumberToken(source, metas[o + 12], metas[o + 13], 0)) : null;
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
 * @param {{copyContentBytes?: boolean, includeContentMetadata?: boolean, initialMetaCapacityDivisor?: number, initialContentBytesPerRow?: number, minimalDecode?: boolean, reuseExpressionForReadingDecode?: boolean, skipTagRuleDecode?: boolean, lazyGlossaryDecode?: boolean, mediaHintFastScan?: boolean, preallocateChunkRows?: boolean, computeContentHashes?: boolean, maxPendingChunks?: number}} [options]
 * @returns {Promise<void>}
 */
export async function parseTermBankWithWasmChunks(contentBytes, version, onChunk, chunkSize = DEFAULT_ROW_CHUNK_SIZE, options = {}) {
    const copyContentBytes = options.copyContentBytes === true;
    const includeContentMetadata = options.includeContentMetadata !== false;
    const initialMetaCapacityDivisor = Number.isFinite(options.initialMetaCapacityDivisor) ? /** @type {number} */ (options.initialMetaCapacityDivisor) : 24;
    const initialContentBytesPerRow = Number.isFinite(options.initialContentBytesPerRow) ? /** @type {number} */ (options.initialContentBytesPerRow) : 96;
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
        allocationMs,
        copyJsonMs,
        parseBankMs,
        encodeContentMs,
    } = await parseTermBankWasmBuffers(
        contentBytes,
        includeContentMetadata,
        initialMetaCapacityDivisor,
        initialContentBytesPerRow,
        mediaHintFastScan,
        computeContentHashes,
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
 * @param {(chunk: {rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: Uint8Array, scoreList: Int32Array, sequenceList: Int32Array, contentBytesList: Uint8Array[], contentHash1List: Uint32Array, contentHash2List: Uint32Array, termRecordPreinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan, mediaRows: Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>}, progress: {processedRows: number, totalRows: number, chunkIndex: number, chunkCount: number}) => Promise<void>|void} onChunk
 * @param {number} [chunkSize]
 * @param {{initialMetaCapacityDivisor?: number, initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function parseTermBankWithWasmColumnChunks(contentBytes, version, onChunk, chunkSize = DEFAULT_ROW_CHUNK_SIZE, options = {}) {
    const initialMetaCapacityDivisor = Number.isFinite(options.initialMetaCapacityDivisor) ? /** @type {number} */ (options.initialMetaCapacityDivisor) : 24;
    const initialContentBytesPerRow = Number.isFinite(options.initialContentBytesPerRow) ? /** @type {number} */ (options.initialContentBytesPerRow) : 96;
    const mediaHintFastScan = options.mediaHintFastScan === true;
    const computeContentHashes = options.computeContentHashes !== false;
    const maxPendingChunks = Number.isFinite(options.maxPendingChunks) ? Math.max(1, Math.min(4, Math.trunc(/** @type {number} */ (options.maxPendingChunks)))) : 1;
    const tBufferSetupStart = Date.now();
    const parsed = await parseTermBankWasmBuffers(
        contentBytes,
        true,
        initialMetaCapacityDivisor,
        initialContentBytesPerRow,
        mediaHintFastScan,
        computeContentHashes,
    );
    const bufferSetupMs = Math.max(0, Date.now() - tBufferSetupStart);
    const {heap, source, metas, contentMetas, contentOutPtr, rowCount} = parsed;
    const normalizedChunkSize = Number.isFinite(chunkSize) ? Math.max(1, Math.trunc(chunkSize)) : DEFAULT_ROW_CHUNK_SIZE;
    const chunkCount = rowCount === 0 ? 0 : Math.ceil(rowCount / normalizedChunkSize);
    let rowDecodeMs = 0;
    let chunkDispatchMs = 0;
    /** @type {Promise<void>[]} */
    const pendingDispatches = [];
    let dispatchTail = Promise.resolve();

    for (let start = 0, chunkIndex = 0; start < rowCount; start += normalizedChunkSize) {
        const tDecodeStart = Date.now();
        const end = Math.min(rowCount, start + normalizedChunkSize);
        const count = end - start;
        /** @type {Uint8Array[]} */
        const expressionBytesList = new Array(count);
        /** @type {Uint8Array[]} */
        const readingBytesList = new Array(count);
        const readingEqualsExpressionList = new Uint8Array(count);
        const scoreList = new Int32Array(count);
        const sequenceList = new Int32Array(count);
        /** @type {Uint8Array[]} */
        const contentBytesList = new Array(count);
        const contentHash1List = new Uint32Array(count);
        const contentHash2List = new Uint32Array(count);
        const expressionIndexes = new Uint32Array(count);
        const readingIndexes = new Uint32Array(count);
        const planBuilder = createTermRecordPreinternedPlanBuilder(count * 2);
        /** @type {Array<{index: number, row: ReturnType<typeof decodeParsedTermRowMinimal>}>} */
        const mediaRows = [];

        for (let sourceIndex = start, i = 0; sourceIndex < end; ++sourceIndex, ++i) {
            const o = sourceIndex * META_U32_FIELDS;
            const c = sourceIndex * CONTENT_META_U32_FIELDS;
            const expressionStart = metas[o + 0];
            const expressionLength = metas[o + 1];
            const readingStart = metas[o + 2];
            const readingLength = metas[o + 3];
            const expressionBytes = getUnescapedJsonStringTokenBytes(source, expressionStart, expressionLength) ?? textEncoder.encode(decodeJsonStringToken(source, expressionStart, expressionLength));
            const readingEqualsExpression = (
                isEmptyJsonStringToken(source, readingStart, readingLength) ||
                tokenBytesEqual(source, expressionStart, expressionLength, readingStart, readingLength)
            );
            const readingBytes = readingEqualsExpression ?
                EMPTY_UINT8_ARRAY :
                (getUnescapedJsonStringTokenBytes(source, readingStart, readingLength) ?? textEncoder.encode(decodeJsonStringToken(source, readingStart, readingLength)));
            expressionBytesList[i] = expressionBytes;
            readingBytesList[i] = readingBytes;
            readingEqualsExpressionList[i] = readingEqualsExpression ? 1 : 0;
            expressionIndexes[i] = planBuilder.internStringBytes(expressionBytes);
            readingIndexes[i] = readingEqualsExpression ? expressionIndexes[i] : planBuilder.internStringBytes(readingBytes);
            scoreList[i] = decodeNumberToken(source, metas[o + 8], metas[o + 9], 0) | 0;
            sequenceList[i] = version >= 3 && !isNullToken(source, metas[o + 12], metas[o + 13]) ? decodeNumberToken(source, metas[o + 12], metas[o + 13], 0) : -1;
            const contentOffset = contentMetas[c + 0];
            const contentLength = contentMetas[c + 1];
            contentBytesList[i] = heap.subarray(contentOutPtr + contentOffset, contentOutPtr + contentOffset + contentLength);
            contentHash1List[i] = contentMetas[c + 2] >>> 0;
            contentHash2List[i] = contentMetas[c + 3] >>> 0;
            if (mediaHintFastScan && metas[o + 16] === 1) {
                mediaRows.push({
                    index: i,
                    row: decodeParsedTermRowMinimal(source, metas, contentMetas, heap, contentOutPtr, version, sourceIndex, false, true, true, true, true),
                });
            }
        }
        rowDecodeMs += Math.max(0, Date.now() - tDecodeStart);
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
            termRecordPreinternedPlan: planBuilder.buildPlan(expressionIndexes, readingIndexes, count),
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
        copyJsonMs: parsed.copyJsonMs,
        parseBankMs: parsed.parseBankMs,
        encodeContentMs: parsed.encodeContentMs,
        rowDecodeMs,
        chunkDispatchMs,
        rowCount,
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
