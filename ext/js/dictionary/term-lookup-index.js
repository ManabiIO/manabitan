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

import {hashTermKeyByteRange, hashTermKeyBytes} from './term-key-hash.js';

const HEADER_U32_COUNT = 16;
const HEADER_BYTES = HEADER_U32_COUNT * 4;
const RADIX_SIZE = 257;
const U32_NULL = 0xffffffff;
const U16_NULL = 0xffff;
const RECORD_HEADER_BYTES = 24;
const RECORD_STRING_TABLE_HEADER_BYTES = 8;
const READING_EQUALS_EXPRESSION_U32 = 0xffffffff;
const COMPACT_INDEX_FORMAT_VERSION = 5;

/**
 * @typedef {object} PersistedTermLookupIndex
 * @property {Uint8Array} keyBytes
 * @property {Uint32Array} keyOffsets
 * @property {Uint16Array} keyHeads
 * @property {Uint16Array} keyNext
 * @property {Uint16Array} expressionKeys
 * @property {Uint16Array} readingKeys
 * @property {Int32Array} sequenceValues
 * @property {Uint16Array} expressionPostingOffsets
 * @property {Uint16Array} expressionPostingRows
 * @property {Uint16Array} readingPostingOffsets
 * @property {Uint16Array} readingPostingRows
 * @property {Uint16Array} sequenceHeads
 * @property {Uint16Array} sequenceNext
 * @property {Uint32Array|null} keyOrder
 * @property {Uint32Array|null} keyReverseOrder
 * @property {Uint32Array|null} keyRadix
 * @property {Uint32Array|null} keyReverseRadix
 * @property {boolean} forwardReady
 * @property {boolean} reverseReady
 */

/**
 * Builds a key-centric lookup index directly from the current term-record
 * payload. The payload's interned string table becomes the lookup key arena.
 * @param {Uint8Array} recordPayload
 * @param {number} rowCount
 * @returns {Uint8Array}
 * @throws {Error} If the record payload is malformed.
 */
export function encodePersistedTermLookupIndexFromRecordPayload(recordPayload, rowCount) {
    if (
        recordPayload.byteLength < RECORD_STRING_TABLE_HEADER_BYTES ||
        !Number.isSafeInteger(rowCount) ||
        rowCount <= 0
    ) {
        throw new Error('Invalid term-record payload for lookup index');
    }
    if (rowCount >= U16_NULL) {
        throw new RangeError('Term lookup index has too many rows for one chunk');
    }
    const view = new DataView(recordPayload.buffer, recordPayload.byteOffset, recordPayload.byteLength);
    const keyCount = view.getUint32(0, true);
    const keyBytesLength = view.getUint32(4, true);
    const lengthsOffset = RECORD_STRING_TABLE_HEADER_BYTES;
    const keyBytesOffset = lengthsOffset + (keyCount * 2);
    const recordsOffset = keyBytesOffset + keyBytesLength;
    if (
        keyCount === 0 ||
        keyCount >= U16_NULL ||
        recordsOffset > recordPayload.byteLength ||
        (recordPayload.byteLength - recordsOffset) !== rowCount * RECORD_HEADER_BYTES
    ) {
        throw new Error('Invalid term-record string table for lookup index');
    }
    const keyOffsets = new Uint32Array(keyCount + 1);
    let keyCursor = 0;
    for (let i = 0; i < keyCount; ++i) {
        keyOffsets[i] = keyCursor;
        keyCursor += view.getUint16(lengthsOffset + (i * 2), true);
        if (keyCursor > keyBytesLength) { throw new Error('Invalid term-record lookup key length'); }
    }
    keyOffsets[keyCount] = keyCursor;
    if (keyCursor !== keyBytesLength) { throw new Error('Invalid term-record lookup key arena'); }
    const keyBytes = recordPayload.subarray(keyBytesOffset, recordsOffset);
    const expressionKeys = new Uint32Array(rowCount);
    const readingKeys = new Uint32Array(rowCount);
    const sequenceValues = new Int32Array(rowCount);
    let readingPostingCount = 0;
    for (let row = 0; row < rowCount; ++row) {
        const offset = recordsOffset + (row * RECORD_HEADER_BYTES);
        const expressionKey = view.getUint32(offset, true);
        const readingKey = view.getUint32(offset + 4, true);
        if (
            expressionKey >= keyCount ||
            (readingKey !== READING_EQUALS_EXPRESSION_U32 && readingKey >= keyCount)
        ) {
            throw new Error('Invalid term-record lookup key reference');
        }
        expressionKeys[row] = expressionKey;
        readingKeys[row] = readingKey;
        sequenceValues[row] = view.getInt32(offset + 20, true);
        if (readingKey !== READING_EQUALS_EXPRESSION_U32) { ++readingPostingCount; }
    }
    return encodeIndexPlan({
        keyBytes,
        keyOffsets,
        expressionKeys,
        readingKeys,
        sequenceValues,
        readingPostingCount,
    });
}

/**
 * Builds the lookup index directly from the parser's interned record plan.
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan} plan
 * @param {boolean[]|Uint8Array} readingEqualsExpressionList
 * @param {(number|undefined)[]|Int32Array} sequenceList
 * @param {number} rowCount
 * @returns {Uint8Array}
 * @throws {Error} If the preinterned plan is malformed.
 */
export function encodePersistedTermLookupIndexFromPreinternedPlan(
    plan,
    readingEqualsExpressionList,
    sequenceList,
    rowCount,
) {
    return encodePersistedTermLookupIndexFromPreinternedPlanInternal(
        plan,
        readingEqualsExpressionList,
        sequenceList,
        rowCount,
        null,
    );
}

/**
 * Builds the lookup index after the caller has validated every row key and
 * counted non-expression reading postings in the same traversal.
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan} plan
 * @param {boolean[]|Uint8Array} readingEqualsExpressionList
 * @param {(number|undefined)[]|Int32Array} sequenceList
 * @param {number} rowCount
 * @param {number} readingPostingCount
 * @returns {Uint8Array}
 * @throws {Error} If the validated count or preinterned plan is malformed.
 */
export function encodePersistedTermLookupIndexFromValidatedPreinternedPlan(
    plan,
    readingEqualsExpressionList,
    sequenceList,
    rowCount,
    readingPostingCount,
) {
    if (
        !Number.isSafeInteger(readingPostingCount) ||
        readingPostingCount < 0 ||
        readingPostingCount > rowCount
    ) {
        throw new Error('Invalid validated reading posting count');
    }
    return encodePersistedTermLookupIndexFromPreinternedPlanInternal(
        plan,
        readingEqualsExpressionList,
        sequenceList,
        rowCount,
        readingPostingCount,
    );
}

/**
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan} plan
 * @param {boolean[]|Uint8Array} readingEqualsExpressionList
 * @param {(number|undefined)[]|Int32Array} sequenceList
 * @param {number} rowCount
 * @param {number|null} validatedReadingPostingCount
 * @returns {Uint8Array}
 * @throws {Error} If the preinterned plan is malformed.
 */
function encodePersistedTermLookupIndexFromPreinternedPlanInternal(
    plan,
    readingEqualsExpressionList,
    sequenceList,
    rowCount,
    validatedReadingPostingCount,
) {
    const {stringLengths, stringOffsets, stringHashes, stringsBuffer, expressionIndexes, readingIndexes} = plan;
    if (!Number.isSafeInteger(rowCount) || rowCount >= U16_NULL) {
        throw new RangeError('Term lookup index has too many rows for one chunk');
    }
    if (stringLengths.length >= U16_NULL) {
        throw new RangeError('Term lookup index has too many keys for one chunk');
    }
    if (
        rowCount <= 0 ||
        stringLengths.length === 0 ||
        expressionIndexes.length < rowCount ||
        readingIndexes.length < rowCount ||
        readingEqualsExpressionList.length < rowCount ||
        sequenceList.length < rowCount
    ) {
        throw new Error('Invalid preinterned term-record plan for lookup index');
    }
    /** @type {Uint32Array} */
    let keyOffsets;
    let keyBytesLength;
    if (
        stringOffsets instanceof Uint32Array &&
        stringOffsets.length === stringLengths.length
    ) {
        keyOffsets = stringOffsets;
        const lastKey = stringLengths.length - 1;
        keyBytesLength = stringOffsets[lastKey] + stringLengths[lastKey];
    } else {
        keyOffsets = new Uint32Array(stringLengths.length);
        keyBytesLength = 0;
        for (let key = 0; key < stringLengths.length; ++key) {
            keyOffsets[key] = keyBytesLength;
            keyBytesLength += stringLengths[key];
        }
    }
    if (keyBytesLength !== stringsBuffer.byteLength) {
        throw new Error('Invalid preinterned term-record string arena');
    }
    const expressionKeys = expressionIndexes.subarray(0, rowCount);
    const readingKeys = readingIndexes.subarray(0, rowCount);
    const sequenceValues = sequenceList instanceof Int32Array ?
        sequenceList.subarray(0, rowCount) :
        Int32Array.from(sequenceList.slice(0, rowCount), (value) => value ?? -1);
    let readingPostingCount = validatedReadingPostingCount;
    if (readingPostingCount === null) {
        readingPostingCount = 0;
        for (let row = 0; row < rowCount; ++row) {
            const expressionKey = expressionKeys[row];
            const readingEqualsExpression = (
                readingEqualsExpressionList[row] === true ||
                readingEqualsExpressionList[row] === 1
            );
            const readingKey = readingEqualsExpression ? READING_EQUALS_EXPRESSION_U32 : readingIndexes[row];
            if (
                expressionKey >= stringLengths.length ||
                (readingKey !== READING_EQUALS_EXPRESSION_U32 && readingKey >= stringLengths.length)
            ) {
                throw new Error('Invalid preinterned term-record key reference');
            }
            if (!readingEqualsExpression) { ++readingPostingCount; }
        }
    }
    return encodeIndexPlan({
        keyBytes: stringsBuffer,
        keyOffsets,
        keyCount: stringLengths.length,
        expressionKeys,
        readingKeys,
        readingEqualsExpressionList,
        sequenceValues,
        readingPostingCount,
        keyHashes: stringHashes,
    });
}

/**
 * Test and fallback entry point for row-oriented input.
 * @param {Array<{expressionBytes: Uint8Array, readingBytes: Uint8Array|null, sequence: number|null}>} rows
 * @returns {Uint8Array}
 * @throws {RangeError} If a row contains an invalid string length.
 * @throws {Error} If the generated index plan is invalid.
 */
export function encodePersistedTermLookupIndex(rows) {
    if (rows.length === 0) { throw new RangeError('Term lookup index requires at least one row'); }
    if (rows.length >= U16_NULL) {
        throw new RangeError('Term lookup index has too many rows for one chunk');
    }
    /** @type {Uint8Array[]} */
    const keys = [];
    /** @type {Map<number, number[]>} */
    const keyIndexesByHash = new Map();
    const expressionKeys = new Uint32Array(rows.length);
    const readingKeys = new Uint32Array(rows.length);
    const sequenceValues = new Int32Array(rows.length);
    let readingPostingCount = 0;
    /**
     * @param {Uint8Array} bytes
     * @returns {number}
     * @throws {RangeError} If the key cannot be represented by the record format.
     */
    const intern = (bytes) => {
        if (bytes.byteLength === 0 || bytes.byteLength >= U16_NULL) {
            throw new RangeError('Invalid term lookup index string length');
        }
        const hash = hashBytes(bytes);
        const candidates = keyIndexesByHash.get(hash);
        if (typeof candidates !== 'undefined') {
            for (const index of candidates) {
                if (bytesEqual(keys[index], bytes)) { return index; }
            }
        }
        const index = keys.length;
        keys.push(bytes);
        if (typeof candidates === 'undefined') {
            keyIndexesByHash.set(hash, [index]);
        } else {
            candidates.push(index);
        }
        return index;
    };
    for (let row = 0; row < rows.length; ++row) {
        const value = rows[row];
        expressionKeys[row] = intern(value.expressionBytes);
        if (value.readingBytes === null) {
            readingKeys[row] = READING_EQUALS_EXPRESSION_U32;
        } else {
            readingKeys[row] = intern(value.readingBytes);
            ++readingPostingCount;
        }
        sequenceValues[row] = value.sequence ?? -1;
    }
    const keyOffsets = new Uint32Array(keys.length + 1);
    let totalKeyBytes = 0;
    for (let i = 0; i < keys.length; ++i) {
        keyOffsets[i] = totalKeyBytes;
        totalKeyBytes += keys[i].byteLength;
    }
    keyOffsets[keys.length] = totalKeyBytes;
    const keyBytes = new Uint8Array(totalKeyBytes);
    for (let i = 0; i < keys.length; ++i) { keyBytes.set(keys[i], keyOffsets[i]); }
    return encodeIndexPlan({
        keyBytes,
        keyOffsets,
        expressionKeys,
        readingKeys,
        sequenceValues,
        readingPostingCount,
    });
}

/**
 * @param {{keyBytes: Uint8Array, keyOffsets: Uint32Array, keyCount?: number, expressionKeys: Uint32Array, readingKeys: Uint32Array, readingEqualsExpressionList?: boolean[]|Uint8Array, sequenceValues: Int32Array, readingPostingCount: number, keyHashes?: Uint32Array}} plan
 * @returns {Uint8Array}
 * @throws {RangeError} If one chunk cannot represent all interned keys.
 */
function encodeIndexPlan(plan) {
    const {keyBytes, keyOffsets, expressionKeys, readingKeys, readingEqualsExpressionList, sequenceValues, readingPostingCount, keyHashes} = plan;
    const rowCount = expressionKeys.length;
    const keyCount = typeof plan.keyCount === 'number' ? plan.keyCount : keyOffsets.length - 1;
    if (
        !Number.isSafeInteger(keyCount) ||
        keyCount <= 0 ||
        rowCount <= 0 ||
        rowCount >= U16_NULL ||
        (keyOffsets.length !== keyCount && keyOffsets.length !== keyCount + 1)
    ) {
        throw new Error('Invalid term lookup index key offsets');
    }
    if (
        readingKeys.length !== rowCount ||
        sequenceValues.length !== rowCount ||
        !Number.isSafeInteger(readingPostingCount) ||
        readingPostingCount < 0 ||
        readingPostingCount > rowCount ||
        (
            typeof readingEqualsExpressionList !== 'undefined' &&
            readingEqualsExpressionList.length < rowCount
        )
    ) {
        throw new Error('Invalid term lookup index row columns');
    }
    if (keyCount >= U16_NULL) {
        throw new RangeError('Term lookup index has too many keys for one chunk');
    }
    const keySlotCount = getHashSlotCount(keyCount);
    const sequenceSlotCount = getHashSlotCount(rowCount);
    const alignedKeyBytesLength = align4(keyBytes.byteLength);
    const keyMetadataBytesLength = align4((keyCount + keySlotCount + keyCount) * 2);
    const compactU16Count =
        (keyCount + 1) +
        rowCount +
        (keyCount + 1) +
        readingPostingCount +
        sequenceSlotCount +
        rowCount;
    const compactU16BytesLength = align4(compactU16Count * 2);
    const output = new Uint8Array(
        HEADER_BYTES +
        alignedKeyBytesLength +
        keyMetadataBytesLength +
        compactU16BytesLength +
        (rowCount * 4),
    );
    const header = new Uint32Array(output.buffer, output.byteOffset, HEADER_U32_COUNT);
    header[0] = rowCount;
    header[1] = keyCount;
    header[2] = keyBytes.byteLength;
    header[3] = keySlotCount;
    header[4] = sequenceSlotCount;
    header[5] = readingPostingCount;
    header[6] = COMPACT_INDEX_FORMAT_VERSION;
    output.set(keyBytes, HEADER_BYTES);
    let cursor = HEADER_BYTES + alignedKeyBytesLength;
    /**
     * @param {number} length
     * @returns {Uint16Array}
     */
    const takeCompact = (length) => {
        const value = new Uint16Array(output.buffer, output.byteOffset + cursor, length);
        cursor += length * 2;
        return value;
    };
    const persistedKeyLengths = takeCompact(keyCount);
    const keyHeads = takeCompact(keySlotCount);
    const keyNext = takeCompact(keyCount);
    cursor = align4(cursor);
    keyHeads.fill(U16_NULL);
    keyNext.fill(U16_NULL);
    let expectedKeyStart = 0;
    for (let key = 0; key < keyCount; ++key) {
        const start = keyOffsets[key];
        const end = key === keyCount - 1 ? keyBytes.byteLength : keyOffsets[key + 1];
        if (start !== expectedKeyStart || start >= end || end > keyBytes.byteLength) {
            throw new Error('Invalid term lookup index key boundary');
        }
        const length = end - start;
        if (length > 0xffff) {
            throw new RangeError('Term lookup index key is too long');
        }
        persistedKeyLengths[key] = length;
        expectedKeyStart = end;
    }
    const expressionPostingOffsets = takeCompact(keyCount + 1);
    const expressionPostingRows = takeCompact(rowCount);
    const readingPostingOffsets = takeCompact(keyCount + 1);
    const readingPostingRows = takeCompact(readingPostingCount);
    const sequenceHeads = takeCompact(sequenceSlotCount); sequenceHeads.fill(U16_NULL);
    const sequenceNext = takeCompact(rowCount); sequenceNext.fill(U16_NULL);
    cursor = align4(cursor);
    new Int32Array(output.buffer, output.byteOffset + cursor, rowCount).set(sequenceValues);

    for (let key = 0; key < keyCount; ++key) {
        insertHash(
            keyHeads,
            keyNext,
            key,
            keyHashes instanceof Uint32Array && keyHashes.length === keyCount ?
                keyHashes[key] :
                hashByteRange(
                    keyBytes,
                    keyOffsets[key],
                    key === keyCount - 1 ? keyBytes.byteLength : keyOffsets[key + 1],
                ),
        );
    }
    fillPostingAndSequenceTables(
        expressionPostingOffsets,
        expressionPostingRows,
        expressionKeys,
        readingPostingOffsets,
        readingPostingRows,
        readingKeys,
        readingEqualsExpressionList,
        sequenceHeads,
        sequenceNext,
        sequenceValues,
    );
    return output;
}

/**
 * @param {Uint8Array} bytes
 * @returns {PersistedTermLookupIndex}
 * @throws {Error} If the persisted index is malformed.
 */
export function parsePersistedTermLookupIndex(bytes) {
    return parsePersistedTermLookupIndexInternal(bytes, true);
}

/**
 * Parses an index whose complete byte payload has already passed its persisted
 * checksum. Structural validation remains strict, but recalculating every key
 * hash would duplicate the immediately preceding full-payload integrity pass.
 * @param {Uint8Array} bytes
 * @returns {PersistedTermLookupIndex}
 * @throws {Error} If the persisted index is malformed.
 */
export function parseChecksummedPersistedTermLookupIndex(bytes) {
    return parsePersistedTermLookupIndexInternal(bytes, false);
}

/**
 * @param {Uint8Array} bytes
 * @param {boolean} validateKeyHashBuckets
 * @returns {PersistedTermLookupIndex}
 * @throws {Error} If the persisted index is malformed.
 */
function parsePersistedTermLookupIndexInternal(bytes, validateKeyHashBuckets) {
    if (bytes.byteLength < HEADER_BYTES || (bytes.byteOffset & 3) !== 0) {
        throw new Error('Invalid persisted term lookup index header');
    }
    const header = new Uint32Array(bytes.buffer, bytes.byteOffset, HEADER_U32_COUNT);
    const rowCount = header[0];
    const keyCount = header[1];
    const keyBytesLength = header[2];
    const keySlotCount = header[3];
    const sequenceSlotCount = header[4];
    const readingPostingCount = header[5];
    const flags = header[6];
    if (
        rowCount === 0 ||
        rowCount >= U16_NULL ||
        keyCount === 0 ||
        readingPostingCount > rowCount ||
        flags !== COMPACT_INDEX_FORMAT_VERSION ||
        keyCount >= U16_NULL ||
        !isPowerOfTwo(keySlotCount) ||
        !isPowerOfTwo(sequenceSlotCount)
    ) {
        throw new Error('Invalid persisted term lookup index dimensions');
    }
    const alignedKeyBytesLength = align4(keyBytesLength);
    const keyMetadataBytesLength = align4((keyCount + keySlotCount + keyCount) * 2);
    const compactU16Count =
        (keyCount + 1) +
        rowCount +
        (keyCount + 1) +
        readingPostingCount +
        sequenceSlotCount +
        rowCount;
    const compactU16BytesLength = align4(compactU16Count * 2);
    if (
        bytes.byteLength !==
        HEADER_BYTES +
        alignedKeyBytesLength +
        keyMetadataBytesLength +
        compactU16BytesLength +
        (rowCount * 4)
    ) {
        throw new Error('Invalid persisted term lookup index length');
    }
    const keyBytes = bytes.subarray(HEADER_BYTES, HEADER_BYTES + keyBytesLength);
    let cursor = HEADER_BYTES + alignedKeyBytesLength;
    /**
     * @param {number} length
     * @returns {Uint16Array}
     */
    const takeCompact = (length) => {
        const value = new Uint16Array(bytes.buffer, bytes.byteOffset + cursor, length);
        cursor += length * 2;
        return value;
    };
    const keyLengths = takeCompact(keyCount);
    const keyHeads = takeCompact(keySlotCount);
    const keyNext = takeCompact(keyCount);
    cursor = align4(cursor);
    const keyOffsets = reconstructKeyOffsets(keyLengths, keyBytesLength);
    const expressionPostingOffsets = takeCompact(keyCount + 1);
    const expressionPostingRows = takeCompact(rowCount);
    const readingPostingOffsets = takeCompact(keyCount + 1);
    const readingPostingRows = takeCompact(readingPostingCount);
    const sequenceHeads = takeCompact(sequenceSlotCount);
    const sequenceNext = takeCompact(rowCount);
    cursor = align4(cursor);
    const sequenceValues = new Int32Array(bytes.buffer, bytes.byteOffset + cursor, rowCount);
    validateOffsets(expressionPostingOffsets, expressionPostingRows.length);
    validateOffsets(readingPostingOffsets, readingPostingRows.length);
    const expressionKeys = reconstructPostingKeys(
        expressionPostingOffsets,
        expressionPostingRows,
        rowCount,
        true,
    );
    const readingKeys = reconstructPostingKeys(
        readingPostingOffsets,
        readingPostingRows,
        rowCount,
        false,
    );
    const index = {
        keyBytes,
        keyOffsets,
        keyHeads,
        keyNext,
        expressionKeys,
        readingKeys,
        sequenceValues,
        expressionPostingOffsets,
        expressionPostingRows,
        readingPostingOffsets,
        readingPostingRows,
        sequenceHeads,
        sequenceNext,
        keyOrder: null,
        keyReverseOrder: null,
        keyRadix: null,
        keyReverseRadix: null,
        forwardReady: false,
        reverseReady: false,
    };
    validateIndex(index, validateKeyHashBuckets, true);
    return index;
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {Uint8Array} query
 * @param {'expression'|'reading'} field
 * @param {number} [queryHash]
 * @returns {number[]}
 */
export function findExactRows(index, query, field, queryHash = hashBytes(query)) {
    const key = findKey(index, query, queryHash);
    if (key < 0) { return []; }
    return getPostingRows(index, key, field);
}

/**
 * Appends both exact-match posting lists after a single key hash-table probe.
 * @param {PersistedTermLookupIndex} index
 * @param {Uint8Array} query
 * @param {number[]} expressionRows
 * @param {number[]} readingRows
 * @param {number} [rowOffset=0]
 * @param {number} [queryHash]
 */
export function appendExactRowMatches(
    index,
    query,
    expressionRows,
    readingRows,
    rowOffset = 0,
    queryHash = hashBytes(query),
) {
    const key = findKey(index, query, queryHash);
    if (key < 0) { return; }
    appendPostingRows(index, key, 'expression', expressionRows, rowOffset);
    appendPostingRows(index, key, 'reading', readingRows, rowOffset);
}

/**
 * @param {Uint8Array} query
 * @returns {number}
 */
export function hashTermLookupKeyBytes(query) {
    return hashBytes(query);
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {number} sequence
 * @returns {number[]}
 * @throws {Error} If a persisted hash chain is cyclic.
 */
export function findSequenceRows(index, sequence) {
    if (!Number.isInteger(sequence) || sequence < 0) { return []; }
    const result = [];
    let visited = 0;
    for (
        let row = index.sequenceHeads[hashSequence(sequence) & (index.sequenceHeads.length - 1)];
        row !== U16_NULL;
        row = index.sequenceNext[row]
    ) {
        if (++visited > index.sequenceNext.length) { throw new Error('Cyclic persisted sequence lookup hash chain'); }
        if (index.sequenceValues[row] === sequence) { result.push(row); }
    }
    return result;
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {Uint8Array} query
 * @param {'expression'|'reading'} field
 * @param {boolean} reverse
 * @returns {Array<{row: number, exact: boolean}>}
 */
export function findPrefixRows(index, query, field, reverse = false) {
    if (query.byteLength === 0) { return []; }
    if (reverse) {
        ensureReverseIndex(index);
    } else {
        ensureForwardIndex(index);
    }
    const order = reverse ?
        /** @type {Uint32Array} */ (index.keyReverseOrder) :
        /** @type {Uint32Array} */ (index.keyOrder);
    const radix = reverse ?
        /** @type {Uint32Array} */ (index.keyReverseRadix) :
        /** @type {Uint32Array} */ (index.keyRadix);
    const radixKey = reverse ? query[query.byteLength - 1] : query[0];
    let low = radix[radixKey];
    let high = radix[radixKey + 1];
    while (low < high) {
        const middle = (low + high) >>> 1;
        const comparison = compareKeyBytes(
            index.keyBytes,
            index.keyOffsets,
            order[middle],
            query,
            reverse,
        );
        if (comparison < 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const result = [];
    const postingOffsets = field === 'reading' ? index.readingPostingOffsets : index.expressionPostingOffsets;
    const postingRows = field === 'reading' ? index.readingPostingRows : index.expressionPostingRows;
    for (let i = low; i < radix[radixKey + 1]; ++i) {
        const key = order[i];
        if (!keyBytesHavePrefix(index.keyBytes, index.keyOffsets, key, query, reverse)) { break; }
        const exact = (index.keyOffsets[key + 1] - index.keyOffsets[key]) === query.byteLength;
        for (let posting = postingOffsets[key]; posting < postingOffsets[key + 1]; ++posting) {
            result.push({row: postingRows[posting], exact});
        }
    }
    return result;
}

/**
 * Finds expression and reading prefix postings with one key-range search.
 * @param {PersistedTermLookupIndex} index
 * @param {Uint8Array} query
 * @param {boolean} reverse
 * @returns {{expression: Array<{row: number, exact: boolean}>, reading: Array<{row: number, exact: boolean}>}}
 */
export function findPrefixRowMatches(index, query, reverse = false) {
    /** @type {Array<{row: number, exact: boolean}>} */
    const expression = [];
    /** @type {Array<{row: number, exact: boolean}>} */
    const reading = [];
    if (query.byteLength === 0) { return {expression, reading}; }
    if (reverse) {
        ensureReverseIndex(index);
    } else {
        ensureForwardIndex(index);
    }
    const order = reverse ?
        /** @type {Uint32Array} */ (index.keyReverseOrder) :
        /** @type {Uint32Array} */ (index.keyOrder);
    const radix = reverse ?
        /** @type {Uint32Array} */ (index.keyReverseRadix) :
        /** @type {Uint32Array} */ (index.keyRadix);
    const radixKey = reverse ? query[query.byteLength - 1] : query[0];
    let low = radix[radixKey];
    let high = radix[radixKey + 1];
    while (low < high) {
        const middle = (low + high) >>> 1;
        const comparison = compareKeyBytes(index.keyBytes, index.keyOffsets, order[middle], query, reverse);
        if (comparison < 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    for (let i = low; i < radix[radixKey + 1]; ++i) {
        const key = order[i];
        if (!keyBytesHavePrefix(index.keyBytes, index.keyOffsets, key, query, reverse)) { break; }
        const exact = (index.keyOffsets[key + 1] - index.keyOffsets[key]) === query.byteLength;
        for (let posting = index.expressionPostingOffsets[key]; posting < index.expressionPostingOffsets[key + 1]; ++posting) {
            expression.push({row: index.expressionPostingRows[posting], exact});
        }
        for (let posting = index.readingPostingOffsets[key]; posting < index.readingPostingOffsets[key + 1]; ++posting) {
            reading.push({row: index.readingPostingRows[posting], exact});
        }
    }
    return {expression, reading};
}

/**
 * Builds the transient forward prefix order during background prewarm.
 * @param {PersistedTermLookupIndex} index
 */
export function warmPersistedTermPrefixIndex(index) {
    ensureForwardIndex(index);
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {number} row
 * @param {'expression'|'reading'} field
 * @returns {Uint8Array|null}
 */
export function getPersistedTermKeyBytes(index, row, field) {
    if (!Number.isInteger(row) || row < 0 || row >= index.expressionKeys.length) { return null; }
    const key = field === 'reading' ? index.readingKeys[row] : index.expressionKeys[row];
    if (key === U16_NULL) { return null; }
    return getKeyBytes(index.keyBytes, index.keyOffsets, key);
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {Uint8Array} query
 * @param {number} [queryHash]
 * @returns {number}
 * @throws {Error} If a persisted key hash chain is cyclic.
 */
function findKey(index, query, queryHash = hashBytes(query)) {
    if (query.byteLength === 0) { return -1; }
    let visited = 0;
    for (
        let key = index.keyHeads[queryHash & (index.keyHeads.length - 1)];
        key !== U16_NULL;
        key = index.keyNext[key]
    ) {
        if (++visited > index.keyNext.length) { throw new Error('Cyclic persisted term lookup hash chain'); }
        if (keyBytesEqual(index.keyBytes, index.keyOffsets, key, query)) { return key; }
    }
    return -1;
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {number} key
 * @param {'expression'|'reading'} field
 * @returns {number[]}
 */
function getPostingRows(index, key, field) {
    const offsets = field === 'reading' ? index.readingPostingOffsets : index.expressionPostingOffsets;
    const rows = field === 'reading' ? index.readingPostingRows : index.expressionPostingRows;
    return [...rows.subarray(offsets[key], offsets[key + 1])];
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {number} key
 * @param {'expression'|'reading'} field
 * @param {number[]} output
 * @param {number} rowOffset
 */
function appendPostingRows(index, key, field, output, rowOffset) {
    const offsets = field === 'reading' ? index.readingPostingOffsets : index.expressionPostingOffsets;
    const rows = field === 'reading' ? index.readingPostingRows : index.expressionPostingRows;
    for (let i = offsets[key]; i < offsets[key + 1]; ++i) {
        output.push(rowOffset + rows[i]);
    }
}

/**
 * @param {PersistedTermLookupIndex} index
 * @param {boolean} [validateKeyHashBuckets=true]
 * @param {boolean} [postingKeysValidated=false]
 * @throws {Error} If an index reference or boundary is invalid.
 */
function validateIndex(index, validateKeyHashBuckets = true, postingKeysValidated = false) {
    const keyCount = index.keyOffsets.length - 1;
    const rowCount = index.expressionKeys.length;
    if (
        index.keyOffsets[0] !== 0 ||
        index.keyOffsets[keyCount] !== index.keyBytes.byteLength ||
        index.readingKeys.length !== rowCount ||
        index.sequenceValues.length !== rowCount
    ) {
        throw new Error('Invalid persisted term lookup index boundaries');
    }
    for (let key = 0; key < keyCount; ++key) {
        if (index.keyOffsets[key] >= index.keyOffsets[key + 1]) { throw new Error('Invalid persisted term lookup key boundary'); }
    }
    validateKeyHashChains(
        index.keyHeads,
        index.keyNext,
        index.keyBytes,
        index.keyOffsets,
        validateKeyHashBuckets,
    );
    if (!postingKeysValidated) {
        validateOffsets(index.expressionPostingOffsets, index.expressionPostingRows.length);
        validateOffsets(index.readingPostingOffsets, index.readingPostingRows.length);
    }
    const rowSeen = new Uint8Array(rowCount);
    if (!postingKeysValidated) {
        validatePostingRows(
            index.expressionPostingOffsets,
            index.expressionPostingRows,
            index.expressionKeys,
            U16_NULL,
            rowSeen,
            1,
        );
        validatePostingRows(
            index.readingPostingOffsets,
            index.readingPostingRows,
            index.readingKeys,
            U16_NULL,
            rowSeen,
            2,
        );
    }
    validateSequenceHashChains(index.sequenceHeads, index.sequenceNext, index.sequenceValues, rowSeen, 3);
    if (index.forwardReady) {
        validateForwardIndex(index);
    }
    if (index.reverseReady) {
        if (index.keyReverseOrder === null || index.keyReverseRadix === null) {
            throw new Error('Invalid persisted reverse term lookup index');
        }
        validateReferences(index.keyReverseOrder, keyCount);
    }
}

/**
 * Reconstructs the row-to-key column already represented by posting lists.
 * @param {Uint16Array} offsets
 * @param {Uint16Array} rows
 * @param {number} rowCount
 * @param {boolean} requireEveryRow
 * @returns {Uint16Array}
 * @throws {Error} If a posting is duplicated, missing, or out of bounds.
 */
function reconstructPostingKeys(offsets, rows, rowCount, requireEveryRow) {
    const keys = new Uint16Array(rowCount);
    keys.fill(U16_NULL);
    for (let key = 0; key < offsets.length - 1; ++key) {
        for (let i = offsets[key]; i < offsets[key + 1]; ++i) {
            const row = rows[i];
            if (row >= rowCount || keys[row] !== U16_NULL) {
                throw new Error('Invalid persisted term lookup posting row');
            }
            keys[row] = key;
        }
    }
    if (requireEveryRow) {
        for (const key of keys) {
            if (key === U16_NULL) {
                throw new Error('Incomplete persisted term lookup posting rows');
            }
        }
    }
    return keys;
}

/**
 * Reconstructs cumulative key offsets from compact persisted UTF-8 lengths.
 * @param {Uint16Array} lengths
 * @param {number} keyBytesLength
 * @returns {Uint32Array}
 * @throws {Error} If a key is empty or lengths do not cover the key arena.
 */
function reconstructKeyOffsets(lengths, keyBytesLength) {
    const offsets = new Uint32Array(lengths.length + 1);
    let offset = 0;
    for (let key = 0; key < lengths.length; ++key) {
        offsets[key] = offset;
        const length = lengths[key];
        if (length === 0 || (offset + length) > keyBytesLength) {
            throw new Error('Invalid persisted term lookup key boundary');
        }
        offset += length;
    }
    offsets[lengths.length] = offset;
    if (offset !== keyBytesLength) {
        throw new Error('Invalid persisted term lookup key arena');
    }
    return offsets;
}

/**
 * @param {Uint16Array} heads
 * @param {Uint16Array} next
 * @param {Uint8Array} keyBytes
 * @param {Uint32Array} keyOffsets
 * @param {boolean} validateHashBuckets
 * @throws {Error} If a key is missing, duplicated, or part of a cycle.
 */
function validateKeyHashChains(heads, next, keyBytes, keyOffsets, validateHashBuckets) {
    const keyCount = keyOffsets.length - 1;
    const seen = new Uint8Array(keyCount);
    let seenCount = 0;
    for (let slot = 0; slot < heads.length; ++slot) {
        const head = heads[slot];
        for (let key = head; key !== U16_NULL; key = next[key]) {
            if (key >= keyCount) {
                throw new Error('Invalid persisted 16-bit term lookup reference');
            }
            if (seen[key] !== 0) {
                throw new Error('Cyclic or duplicated persisted term lookup hash chain');
            }
            if (
                validateHashBuckets &&
                (hashByteRange(keyBytes, keyOffsets[key], keyOffsets[key + 1]) & (heads.length - 1)) !== slot
            ) {
                throw new Error('Invalid persisted term lookup hash bucket');
            }
            seen[key] = 1;
            ++seenCount;
        }
    }
    if (seenCount !== keyCount) {
        throw new Error('Incomplete persisted term lookup hash chains');
    }
}

/**
 * @param {Uint16Array|Uint32Array} offsets
 * @param {Uint16Array|Uint32Array} rows
 * @param {Uint16Array|Uint32Array} keys
 * @param {number} skipKey
 * @param {Uint8Array} seen
 * @param {number} marker
 * @throws {Error} If a posting is duplicated, missing, or assigned to the wrong key.
 */
function validatePostingRows(offsets, rows, keys, skipKey, seen, marker) {
    for (let key = 0; key < offsets.length - 1; ++key) {
        for (let i = offsets[key]; i < offsets[key + 1]; ++i) {
            const row = rows[i];
            if (keys[row] !== key || seen[row] === marker) {
                throw new Error('Invalid persisted term lookup posting row');
            }
            seen[row] = marker;
        }
    }
    for (let row = 0; row < keys.length; ++row) {
        if ((keys[row] !== skipKey) !== (seen[row] === marker)) {
            throw new Error('Incomplete persisted term lookup posting rows');
        }
    }
}

/**
 * @param {Uint16Array} heads
 * @param {Uint16Array} next
 * @param {Int32Array} values
 * @param {Uint8Array} seen
 * @param {number} marker
 * @throws {Error} If a sequence row is duplicated, missing, or assigned to the wrong bucket.
 */
function validateSequenceHashChains(heads, next, values, seen, marker) {
    for (let slot = 0; slot < heads.length; ++slot) {
        for (let row = heads[slot]; row !== U16_NULL; row = next[row]) {
            if (row >= values.length) {
                throw new Error('Invalid persisted 16-bit term lookup reference');
            }
            const value = values[row];
            if (
                value < 0 ||
                seen[row] === marker ||
                (hashSequence(value) & (heads.length - 1)) !== slot
            ) {
                throw new Error('Invalid persisted sequence lookup hash chain');
            }
            seen[row] = marker;
        }
    }
    for (let row = 0; row < values.length; ++row) {
        if ((values[row] >= 0) !== (seen[row] === marker)) {
            throw new Error('Incomplete persisted sequence lookup hash chains');
        }
    }
}

/**
 * @param {PersistedTermLookupIndex} index
 * @throws {Error} If the persisted forward order is not a sorted permutation.
 */
function validateForwardIndex(index) {
    const {keyOrder, keyRadix, keyBytes, keyOffsets} = index;
    const keyCount = keyOffsets.length - 1;
    if (
        !(keyOrder instanceof Uint32Array) ||
        !(keyRadix instanceof Uint32Array) ||
        keyOrder.length !== keyCount ||
        keyRadix.length !== RADIX_SIZE
    ) {
        throw new Error('Invalid persisted forward term lookup index dimensions');
    }
    const seen = new Uint8Array(keyCount);
    for (let i = 0; i < keyCount; ++i) {
        const key = keyOrder[i];
        if (key >= keyCount || seen[key] !== 0) {
            throw new Error('Invalid persisted forward term lookup key order');
        }
        seen[key] = 1;
        if (
            i > 0 &&
            compareKeyRanges(keyBytes, keyOffsets, keyOrder[i - 1], key, false) >= 0
        ) {
            throw new Error('Unsorted persisted forward term lookup key order');
        }
    }
    const expectedRadix = new Uint32Array(RADIX_SIZE);
    fillRadix(expectedRadix, keyOrder, keyBytes, keyOffsets, false);
    for (let i = 0; i < RADIX_SIZE; ++i) {
        if (keyRadix[i] !== expectedRadix[i]) {
            throw new Error('Invalid persisted forward term lookup radix');
        }
    }
}

/**
 * Builds the forward-key order only for explicit prefix search.
 * @param {PersistedTermLookupIndex} index
 */
function ensureForwardIndex(index) {
    if (index.forwardReady) { return; }
    const keyOrder = new Uint32Array(index.keyOffsets.length - 1);
    const keyRadix = new Uint32Array(RADIX_SIZE);
    const scratch = new Uint32Array(keyOrder.length);
    radixSortKeysInto(keyOrder, scratch, index.keyBytes, index.keyOffsets, false);
    fillRadix(keyRadix, keyOrder, index.keyBytes, index.keyOffsets, false);
    index.keyOrder = keyOrder;
    index.keyRadix = keyRadix;
    index.forwardReady = true;
}

/**
 * Builds the reverse-key order only for the uncommon suffix-search path.
 * @param {PersistedTermLookupIndex} index
 */
function ensureReverseIndex(index) {
    if (index.reverseReady) { return; }
    const keyReverseOrder = new Uint32Array(index.keyOffsets.length - 1);
    const keyReverseRadix = new Uint32Array(RADIX_SIZE);
    const scratch = new Uint32Array(keyReverseOrder.length);
    radixSortKeysInto(keyReverseOrder, scratch, index.keyBytes, index.keyOffsets, true);
    fillRadix(keyReverseRadix, keyReverseOrder, index.keyBytes, index.keyOffsets, true);
    index.keyReverseOrder = keyReverseOrder;
    index.keyReverseRadix = keyReverseRadix;
    index.reverseReady = true;
}

/**
 * @param {Uint32Array} values
 * @param {number} limit
 * @throws {Error} If a reference is outside its valid range.
 */
function validateReferences(values, limit) {
    for (const value of values) {
        if (value !== U32_NULL && value >= limit) { throw new Error('Invalid persisted term lookup reference'); }
    }
}

/**
 * @param {Uint16Array|Uint32Array} offsets
 * @param {number} end
 * @throws {Error} If offsets are non-monotonic or out of bounds.
 */
function validateOffsets(offsets, end) {
    if (offsets[0] !== 0 || offsets[offsets.length - 1] !== end) {
        throw new Error('Invalid persisted term lookup posting offsets');
    }
    for (let i = 1; i < offsets.length; ++i) {
        if (offsets[i] < offsets[i - 1]) { throw new Error('Invalid persisted term lookup posting order'); }
    }
}

/**
 * @param {Uint16Array} expressionOffsets
 * @param {Uint16Array} expressionRows
 * @param {Uint16Array|Uint32Array} expressionKeys
 * @param {Uint16Array} readingOffsets
 * @param {Uint16Array} readingRows
 * @param {Uint16Array|Uint32Array} readingKeys
 * @param {boolean[]|Uint8Array|undefined} readingEqualsExpressionList
 * @param {Uint16Array} sequenceHeads
 * @param {Uint16Array} sequenceNext
 * @param {Int32Array} sequenceValues
 */
function fillPostingAndSequenceTables(
    expressionOffsets,
    expressionRows,
    expressionKeys,
    readingOffsets,
    readingRows,
    readingKeys,
    readingEqualsExpressionList,
    sequenceHeads,
    sequenceNext,
    sequenceValues,
) {
    const rowCount = expressionKeys.length;
    for (let row = 0; row < rowCount; ++row) {
        ++expressionOffsets[expressionKeys[row] + 1];
        const readingKey = isReadingEqualToExpression(readingEqualsExpressionList, row) ? U16_NULL : readingKeys[row];
        if (readingKey !== U16_NULL) { ++readingOffsets[readingKey + 1]; }
        const sequence = sequenceValues[row];
        if (sequence >= 0) { insertHash(sequenceHeads, sequenceNext, row, hashSequence(sequence)); }
    }
    for (let key = 1; key < expressionOffsets.length; ++key) {
        expressionOffsets[key] += expressionOffsets[key - 1];
        readingOffsets[key] += readingOffsets[key - 1];
    }
    for (let row = rowCount - 1; row >= 0; --row) {
        const expressionKey = expressionKeys[row];
        expressionRows[--expressionOffsets[expressionKey + 1]] = row;
        const readingKey = isReadingEqualToExpression(readingEqualsExpressionList, row) ? U16_NULL : readingKeys[row];
        if (readingKey !== U16_NULL) {
            readingRows[--readingOffsets[readingKey + 1]] = row;
        }
    }
    const keyCount = expressionOffsets.length - 1;
    for (let key = 1; key < keyCount; ++key) {
        expressionOffsets[key] = expressionOffsets[key + 1];
        readingOffsets[key] = readingOffsets[key + 1];
    }
    expressionOffsets[keyCount] = expressionRows.length;
    readingOffsets[keyCount] = readingRows.length;
}

/**
 * @param {boolean[]|Uint8Array|undefined} values
 * @param {number} row
 * @returns {boolean}
 */
function isReadingEqualToExpression(values, row) {
    return typeof values !== 'undefined' && (values[row] === true || values[row] === 1);
}

/**
 * @param {number} value
 * @returns {number}
 */
function align4(value) {
    return (value + 3) & ~3;
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function isPowerOfTwo(value) {
    return value > 0 && (value & (value - 1)) === 0;
}

/**
 * @param {number} count
 * @returns {number}
 */
function getHashSlotCount(count) {
    let value = 1;
    while (value < count) { value *= 2; }
    return value;
}

/**
 * @param {Uint16Array|Uint32Array} heads
 * @param {Uint16Array|Uint32Array} next
 * @param {number} value
 * @param {number} hash
 */
function insertHash(heads, next, value, hash) {
    const slot = hash & (heads.length - 1);
    next[value] = heads[slot];
    heads[slot] = value;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function hashBytes(bytes) {
    return hashTermKeyBytes(bytes);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function hashByteRange(bytes, start, end) {
    return hashTermKeyByteRange(bytes, start, end);
}

/**
 * @param {number} value
 * @returns {number}
 */
function hashSequence(value) {
    let hash = 0x811c9dc5;
    for (let shift = 0; shift < 32; shift += 8) {
        hash = Math.imul(hash ^ ((value >>> shift) & 0xff), 0x01000193);
    }
    return hash >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {number} key
 * @returns {Uint8Array}
 */
function getKeyBytes(bytes, offsets, key) {
    return bytes.subarray(offsets[key], offsets[key + 1]);
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {boolean} reverse
 * @returns {number}
 */
function compareBytes(a, b, reverse) {
    const count = Math.min(a.byteLength, b.byteLength);
    for (let i = 0; i < count; ++i) {
        const aIndex = reverse ? a.byteLength - 1 - i : i;
        const bIndex = reverse ? b.byteLength - 1 - i : i;
        if (a[aIndex] !== b[bIndex]) { return a[aIndex] - b[bIndex]; }
    }
    return a.byteLength - b.byteLength;
}

/**
 * @param {Uint32Array} radix
 * @param {Uint32Array} order
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {boolean} reverse
 */
function fillRadix(radix, order, bytes, offsets, reverse) {
    let cursor = 0;
    for (let value = 0; value < 256; ++value) {
        radix[value] = cursor;
        while (cursor < order.length) {
            const key = order[cursor];
            const first = reverse ? bytes[offsets[key + 1] - 1] : bytes[offsets[key]];
            if (first !== value) { break; }
            ++cursor;
        }
    }
    radix[256] = order.length;
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function bytesEqual(a, b) {
    return compareBytes(a, b, false) === 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {number} key
 * @param {Uint8Array} query
 * @returns {boolean}
 */
function keyBytesEqual(bytes, offsets, key, query) {
    const start = offsets[key];
    const end = offsets[key + 1];
    const length = end - start;
    if (length !== query.byteLength) { return false; }
    for (let i = 0; i < length; ++i) {
        if (bytes[start + i] !== query[i]) { return false; }
    }
    return true;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {number} aKey
 * @param {number} bKey
 * @param {boolean} reverse
 * @returns {number}
 */
function compareKeyRanges(bytes, offsets, aKey, bKey, reverse) {
    const aStart = offsets[aKey];
    const aEnd = offsets[aKey + 1];
    const bStart = offsets[bKey];
    const bEnd = offsets[bKey + 1];
    const aLength = aEnd - aStart;
    const bLength = bEnd - bStart;
    const count = Math.min(aLength, bLength);
    for (let i = 0; i < count; ++i) {
        const aIndex = reverse ? aEnd - 1 - i : aStart + i;
        const bIndex = reverse ? bEnd - 1 - i : bStart + i;
        if (bytes[aIndex] !== bytes[bIndex]) { return bytes[aIndex] - bytes[bIndex]; }
    }
    return aLength - bLength;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {number} key
 * @param {Uint8Array} query
 * @param {boolean} reverse
 * @returns {number}
 */
function compareKeyBytes(bytes, offsets, key, query, reverse) {
    const start = offsets[key];
    const end = offsets[key + 1];
    const length = end - start;
    const count = Math.min(length, query.byteLength);
    for (let i = 0; i < count; ++i) {
        const keyIndex = reverse ? end - 1 - i : start + i;
        const queryIndex = reverse ? query.byteLength - 1 - i : i;
        if (bytes[keyIndex] !== query[queryIndex]) { return bytes[keyIndex] - query[queryIndex]; }
    }
    return length - query.byteLength;
}

/**
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {number} key
 * @param {Uint8Array} query
 * @param {boolean} reverse
 * @returns {boolean}
 */
function keyBytesHavePrefix(bytes, offsets, key, query, reverse) {
    const start = offsets[key];
    const end = offsets[key + 1];
    const length = end - start;
    if (query.byteLength > length) { return false; }
    const offset = reverse ? end - query.byteLength : start;
    for (let i = 0; i < query.byteLength; ++i) {
        if (bytes[offset + i] !== query[i]) { return false; }
    }
    return true;
}

/**
 * @param {Uint32Array} sorted
 * @param {Uint32Array} scratch
 * @param {Uint8Array} bytes
 * @param {Uint32Array} offsets
 * @param {boolean} reverse
 */
function radixSortKeysInto(sorted, scratch, bytes, offsets, reverse) {
    for (let key = 0; key < sorted.length; ++key) { sorted[key] = key; }
    if (sorted.length < 2) { return; }
    /** @type {Array<{start: number, end: number, depth: number}>} */
    const pending = [{start: 0, end: sorted.length, depth: 0}];
    const counts = new Uint32Array(257);
    const positions = new Uint32Array(257);
    while (pending.length > 0) {
        const range = pending.pop();
        if (typeof range === 'undefined') { break; }
        const {start, end, depth} = range;
        if ((end - start) < 2) { continue; }
        counts.fill(0);
        for (let i = start; i < end; ++i) {
            const key = sorted[i];
            const length = offsets[key + 1] - offsets[key];
            const value = depth >= length ?
                0 :
                1 + bytes[reverse ? offsets[key + 1] - 1 - depth : offsets[key] + depth];
            ++counts[value];
        }
        let position = start;
        for (let value = 0; value < counts.length; ++value) {
            positions[value] = position;
            position += counts[value];
        }
        for (let i = start; i < end; ++i) {
            const key = sorted[i];
            const length = offsets[key + 1] - offsets[key];
            const value = depth >= length ?
                0 :
                1 + bytes[reverse ? offsets[key + 1] - 1 - depth : offsets[key] + depth];
            scratch[positions[value]++] = key;
        }
        sorted.set(scratch.subarray(start, end), start);
        position = start + counts[0];
        for (let value = 1; value < counts.length; ++value) {
            const next = position + counts[value];
            if ((next - position) > 1) { pending.push({start: position, end: next, depth: depth + 1}); }
            position = next;
        }
    }
}
