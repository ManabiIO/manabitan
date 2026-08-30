/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

import {hashTermKeyBytes} from './term-key-hash.js';

const DEFAULT_INITIAL_STRING_CAPACITY = 16384;

/**
 * @typedef {{
 *   stringLengths: Uint16Array,
 *   stringOffsets?: Uint32Array,
 *   stringHashes?: Uint32Array,
 *   stringsBuffer: Uint8Array,
 *   expressionIndexes: Uint32Array,
 *   readingIndexes: Uint32Array,
 * }} PreinternedTermRecordPlan
 */

/**
 * @param {number} [initialStringCapacity]
 * @returns {{
 *   internStringBytes: (bytes: Uint8Array) => number,
 *   internStringBytesWithHash: (bytes: Uint8Array, hash: number) => number,
 *   buildPlan: (expressionIndexes: number[]|Uint32Array, readingIndexes: number[]|Uint32Array, count?: number) => PreinternedTermRecordPlan,
 * }}
 * @throws {RangeError} If the initial capacity is not finite.
 */
export function createTermRecordPreinternedPlanBuilder(initialStringCapacity = DEFAULT_INITIAL_STRING_CAPACITY) {
    if (!Number.isFinite(initialStringCapacity)) {
        throw new RangeError('Invalid initial preinterned string capacity');
    }
    const normalizedInitialCapacity = Math.max(16, Math.trunc(initialStringCapacity));
    let hashTableCapacity = 32;
    while (hashTableCapacity < normalizedInitialCapacity * 2) { hashTableCapacity *= 2; }
    let stringIndexTable = new Uint32Array(hashTableCapacity);
    let stringLengthsCapacity = normalizedInitialCapacity;
    let stringLengths = new Uint16Array(stringLengthsCapacity);
    let stringHashes = new Uint32Array(stringLengthsCapacity);
    /** @type {Uint8Array[]} */
    const stringBytesList = new Array(stringLengthsCapacity);
    let totalStringBytes = 0;
    let stringCount = 0;

    /** @param {number} requiredCapacity */
    const ensureCapacity = (requiredCapacity) => {
        if (requiredCapacity <= stringLengthsCapacity) { return; }
        let nextCapacity = stringLengthsCapacity;
        while (nextCapacity < requiredCapacity) { nextCapacity *= 2; }
        const nextStringLengths = new Uint16Array(nextCapacity);
        nextStringLengths.set(stringLengths.subarray(0, stringCount));
        stringLengths = nextStringLengths;
        const nextStringHashes = new Uint32Array(nextCapacity);
        nextStringHashes.set(stringHashes.subarray(0, stringCount));
        stringHashes = nextStringHashes;
        stringBytesList.length = nextCapacity;
        stringLengthsCapacity = nextCapacity;
    };

    /**
     * @param {Uint8Array} lhs
     * @param {Uint8Array} rhs
     * @returns {boolean}
     */
    const bytesEqual = (lhs, rhs) => {
        if (lhs.byteLength !== rhs.byteLength) { return false; }
        for (let i = 0; i < lhs.byteLength; ++i) {
            if (lhs[i] !== rhs[i]) { return false; }
        }
        return true;
    };

    /**
     * @param {number} h1
     * @param {number} byteLength
     * @returns {number}
     */
    const getHashSlot = (h1, byteLength) => {
        let value = (h1 ^ Math.imul(byteLength, 0x85ebca6b)) >>> 0;
        value ^= value >>> 16;
        return value & (stringIndexTable.length - 1);
    };

    /** @param {number} requiredCount */
    const ensureHashCapacity = (requiredCount) => {
        if (requiredCount * 2 <= stringIndexTable.length) { return; }
        const oldTable = stringIndexTable;
        stringIndexTable = new Uint32Array(oldTable.length * 2);
        for (let index = 0; index < stringCount; ++index) {
            let slot = getHashSlot(stringHashes[index], stringLengths[index]);
            while (stringIndexTable[slot] !== 0) {
                slot = (slot + 1) & (stringIndexTable.length - 1);
            }
            stringIndexTable[slot] = index + 1;
        }
    };

    /**
     * @param {Uint8Array} bytes
     * @param {number} hash
     * @returns {number}
     * @throws {Error} If a string exceeds the persisted record format limit.
     */
    const internHashedBytes = (bytes, hash) => {
        if (bytes.byteLength > 0xffff) {
            throw new Error('Term expression or reading exceeds the binary record limit');
        }
        const h1 = hash >>> 0;
        let slot = getHashSlot(h1, bytes.byteLength);
        while (true) {
            const stored = stringIndexTable[slot];
            if (stored === 0) { break; }
            const index = stored - 1;
            if (
                stringHashes[index] === h1 &&
                stringLengths[index] === bytes.byteLength &&
                bytesEqual(stringBytesList[index], bytes)
            ) {
                return index;
            }
            slot = (slot + 1) & (stringIndexTable.length - 1);
        }

        const index = stringCount;
        ensureCapacity(index + 1);
        ensureHashCapacity(index + 1);
        slot = getHashSlot(h1, bytes.byteLength);
        while (stringIndexTable[slot] !== 0) {
            slot = (slot + 1) & (stringIndexTable.length - 1);
        }
        stringLengths[index] = bytes.byteLength;
        stringHashes[index] = h1;
        stringBytesList[index] = bytes;
        stringIndexTable[slot] = index + 1;
        totalStringBytes += bytes.byteLength;
        stringCount = index + 1;
        return index;
    };

    return {
        internStringBytes(bytes) {
            return internHashedBytes(bytes, hashTermKeyBytes(bytes));
        },
        internStringBytesWithHash(bytes, hash) {
            return internHashedBytes(bytes, hash);
        },
        buildPlan(expressionIndexes, readingIndexes, count = expressionIndexes.length) {
            if (
                !Number.isSafeInteger(count) || count < 0 ||
                count > expressionIndexes.length || count > readingIndexes.length
            ) {
                throw new RangeError('Invalid preinterned plan row count');
            }
            const stringsBuffer = new Uint8Array(totalStringBytes);
            const stringOffsets = new Uint32Array(stringCount);
            let cursor = 0;
            for (let i = 0; i < stringCount; ++i) {
                const bytes = stringBytesList[i];
                stringOffsets[i] = cursor;
                stringsBuffer.set(bytes, cursor);
                cursor += bytes.byteLength;
            }
            return {
                stringLengths: stringLengths.subarray(0, stringCount),
                stringHashes: stringHashes.subarray(0, stringCount),
                stringOffsets,
                stringsBuffer,
                expressionIndexes: expressionIndexes instanceof Uint32Array ?
                    expressionIndexes.subarray(0, count) :
                    Uint32Array.from(expressionIndexes.slice(0, count)),
                readingIndexes: readingIndexes instanceof Uint32Array ?
                    readingIndexes.subarray(0, count) :
                    Uint32Array.from(readingIndexes.slice(0, count)),
            };
        },
    };
}

/**
 * @param {unknown[]} rows
 * @returns {PreinternedTermRecordPlan|null}
 */
export function getTermRecordPreinternedPlan(rows) {
    const value = /** @type {{termRecordPreinternedPlan?: PreinternedTermRecordPlan}} */ (/** @type {unknown} */ (rows)).termRecordPreinternedPlan;
    return value ?? null;
}

/**
 * @param {PreinternedTermRecordPlan} plan
 * @param {number} start
 * @param {number} count
 * @throws {RangeError} If the requested row range is invalid.
 */
function validatePlanRowRange(plan, start, count) {
    if (
        !(plan.expressionIndexes instanceof Uint32Array) ||
        !(plan.readingIndexes instanceof Uint32Array) ||
        !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(count) || count < 0 ||
        start > plan.expressionIndexes.length - count ||
        start > plan.readingIndexes.length - count
    ) {
        throw new RangeError('Invalid preinterned plan row range');
    }
}

/**
 * @param {PreinternedTermRecordPlan|null} plan
 * @param {number[]} indexes
 * @returns {PreinternedTermRecordPlan|null}
 * @throws {RangeError} If a selected row index is invalid.
 */
export function selectTermRecordPreinternedPlan(plan, indexes) {
    if (plan === null) { return null; }
    validatePlanRowRange(plan, 0, 0);
    const count = indexes.length;
    const expressionIndexes = new Uint32Array(count);
    const readingIndexes = new Uint32Array(count);
    for (let i = 0; i < count; ++i) {
        const sourceIndex = indexes[i];
        if (
            !Number.isSafeInteger(sourceIndex) || sourceIndex < 0 ||
            sourceIndex >= plan.expressionIndexes.length ||
            sourceIndex >= plan.readingIndexes.length
        ) {
            throw new RangeError(`Preinterned plan row index out of bounds: ${sourceIndex}`);
        }
        expressionIndexes[i] = plan.expressionIndexes[sourceIndex];
        readingIndexes[i] = plan.readingIndexes[sourceIndex];
    }
    return {
        stringLengths: plan.stringLengths,
        stringOffsets: plan.stringOffsets,
        stringHashes: plan.stringHashes,
        stringsBuffer: plan.stringsBuffer,
        expressionIndexes,
        readingIndexes,
    };
}

/**
 * @param {PreinternedTermRecordPlan|null} plan
 * @param {number} start
 * @param {number} count
 * @returns {PreinternedTermRecordPlan|null}
 * @throws {RangeError} If the requested row range is invalid.
 */
export function sliceTermRecordPreinternedPlan(plan, start, count) {
    if (plan === null) { return null; }
    validatePlanRowRange(plan, start, count);
    const end = start + count;
    return {
        stringLengths: plan.stringLengths,
        stringOffsets: plan.stringOffsets,
        stringHashes: plan.stringHashes,
        stringsBuffer: plan.stringsBuffer,
        expressionIndexes: plan.expressionIndexes.subarray(start, end),
        readingIndexes: plan.readingIndexes.subarray(start, end),
    };
}

/**
 * @param {PreinternedTermRecordPlan} plan
 * @returns {Uint32Array}
 * @throws {TypeError|RangeError} If string metadata or the arena is malformed.
 */
function getValidatedStringOffsets(plan) {
    const {stringLengths, stringOffsets, stringHashes, stringsBuffer} = plan;
    if (!(stringLengths instanceof Uint16Array) || !(stringsBuffer instanceof Uint8Array)) {
        throw new TypeError('Invalid preinterned plan string storage');
    }
    if (stringHashes !== void 0 && (!(stringHashes instanceof Uint32Array) || stringHashes.length !== stringLengths.length)) {
        throw new TypeError('Invalid preinterned plan string hashes');
    }
    let offsets;
    if (stringOffsets === void 0) {
        offsets = new Uint32Array(stringLengths.length);
        let offset = 0;
        for (let i = 0; i < stringLengths.length; ++i) {
            offsets[i] = offset;
            offset += stringLengths[i];
            if (offset > stringsBuffer.byteLength) {
                throw new RangeError('Preinterned plan string arena is out of bounds');
            }
        }
        if (offset !== stringsBuffer.byteLength) {
            throw new RangeError('Preinterned plan string arena length does not match its strings');
        }
        return offsets;
    }
    if (!(stringOffsets instanceof Uint32Array) || stringOffsets.length !== stringLengths.length) {
        throw new TypeError('Invalid preinterned plan string offsets');
    }
    offsets = stringOffsets;
    let expectedOffset = 0;
    for (let i = 0; i < stringLengths.length; ++i) {
        const offset = offsets[i];
        if (offset !== expectedOffset || offset > stringsBuffer.byteLength - stringLengths[i]) {
            throw new RangeError('Preinterned plan string arena is out of bounds');
        }
        expectedOffset += stringLengths[i];
    }
    if (expectedOffset !== stringsBuffer.byteLength) {
        throw new RangeError('Preinterned plan string arena length does not match its strings');
    }
    return offsets;
}

/**
 * Copies and remaps only the strings referenced by a row slice.
 * @param {PreinternedTermRecordPlan|null} plan
 * @param {number} start
 * @param {number} count
 * @param {Uint32Array} remapScratch
 * @param {boolean[]|Uint8Array} [readingEqualsExpressionList]
 * @returns {PreinternedTermRecordPlan|null}
 * @throws {TypeError|RangeError|Error} If the plan, range, or scratch storage is invalid.
 */
export function compactTermRecordPreinternedPlan(plan, start, count, remapScratch, readingEqualsExpressionList = void 0) {
    if (plan === null) { return null; }
    validatePlanRowRange(plan, start, count);
    if (!(remapScratch instanceof Uint32Array) || remapScratch.length < plan.stringLengths.length) {
        throw new RangeError('Invalid preinterned plan compaction scratch');
    }
    if (typeof readingEqualsExpressionList !== 'undefined' && readingEqualsExpressionList.length < start + count) {
        throw new RangeError('Invalid preinterned plan reading-equality range');
    }
    const sourceStringOffsets = getValidatedStringOffsets(plan);
    const referencedOldIndexes = [];
    const expressionIndexes = new Uint32Array(count);
    const readingIndexes = new Uint32Array(count);
    try {
        for (let i = 0; i < count; ++i) {
            const sourceIndex = start + i;
            const expressionOldIndex = plan.expressionIndexes[sourceIndex];
            const readingEqualsExpression = (
                readingEqualsExpressionList?.[sourceIndex] === true ||
                readingEqualsExpressionList?.[sourceIndex] === 1
            );
            const readingOldIndex = readingEqualsExpression ? expressionOldIndex : plan.readingIndexes[sourceIndex];
            if (expressionOldIndex >= plan.stringLengths.length) {
                throw new RangeError(`Preinterned string index out of bounds: ${expressionOldIndex}`);
            }
            let expressionRemap = remapScratch[expressionOldIndex];
            if (expressionRemap === 0) {
                referencedOldIndexes.push(expressionOldIndex);
                expressionRemap = referencedOldIndexes.length;
                remapScratch[expressionOldIndex] = expressionRemap;
            } else if (referencedOldIndexes[expressionRemap - 1] !== expressionOldIndex) {
                throw new Error('Preinterned plan compaction scratch is not clear');
            }
            expressionIndexes[i] = expressionRemap - 1;

            if (readingOldIndex >= plan.stringLengths.length) {
                throw new RangeError(`Preinterned string index out of bounds: ${readingOldIndex}`);
            }
            let readingRemap = remapScratch[readingOldIndex];
            if (readingRemap === 0) {
                referencedOldIndexes.push(readingOldIndex);
                readingRemap = referencedOldIndexes.length;
                remapScratch[readingOldIndex] = readingRemap;
            } else if (referencedOldIndexes[readingRemap - 1] !== readingOldIndex) {
                throw new Error('Preinterned plan compaction scratch is not clear');
            }
            readingIndexes[i] = readingRemap - 1;
        }
    } finally {
        for (const oldIndex of referencedOldIndexes) {
            remapScratch[oldIndex] = 0;
        }
    }
    const stringLengths = new Uint16Array(referencedOldIndexes.length);
    const stringOffsets = new Uint32Array(referencedOldIndexes.length);
    const stringHashes = plan.stringHashes instanceof Uint32Array ? new Uint32Array(referencedOldIndexes.length) : void 0;
    let stringsByteLength = 0;
    for (let i = 0; i < referencedOldIndexes.length; ++i) {
        const oldIndex = referencedOldIndexes[i];
        stringOffsets[i] = stringsByteLength;
        stringLengths[i] = plan.stringLengths[oldIndex];
        if (stringHashes instanceof Uint32Array && plan.stringHashes instanceof Uint32Array) {
            stringHashes[i] = plan.stringHashes[oldIndex];
        }
        stringsByteLength += stringLengths[i];
    }
    const stringsBuffer = new Uint8Array(stringsByteLength);
    let cursor = 0;
    for (const oldIndex of referencedOldIndexes) {
        const oldOffset = sourceStringOffsets[oldIndex];
        const length = plan.stringLengths[oldIndex];
        stringsBuffer.set(plan.stringsBuffer.subarray(oldOffset, oldOffset + length), cursor);
        cursor += length;
    }
    return {stringLengths, stringOffsets, stringHashes, stringsBuffer, expressionIndexes, readingIndexes};
}

/**
 * @param {PreinternedTermRecordPlan|null} plan
 * @param {number} count
 * @returns {plan is PreinternedTermRecordPlan}
 */
export function hasCompleteTermRecordPreinternedPlan(plan, count) {
    if (plan === null || !Number.isSafeInteger(count) || count < 0) { return false; }
    const {stringLengths, stringOffsets, stringHashes, stringsBuffer, expressionIndexes, readingIndexes} = plan;
    if (
        !(stringLengths instanceof Uint16Array) ||
        !(stringsBuffer instanceof Uint8Array) ||
        !(expressionIndexes instanceof Uint32Array) ||
        !(readingIndexes instanceof Uint32Array) ||
        expressionIndexes.length < count || readingIndexes.length < count ||
        (stringHashes !== void 0 && (!(stringHashes instanceof Uint32Array) || stringHashes.length !== stringLengths.length)) ||
        (stringOffsets !== void 0 && (!(stringOffsets instanceof Uint32Array) || stringOffsets.length !== stringLengths.length))
    ) {
        return false;
    }
    if (stringLengths.length === 0) {
        return count === 0 && stringsBuffer.byteLength === 0;
    }
    if (stringOffsets instanceof Uint32Array) {
        const lastIndex = stringLengths.length - 1;
        return stringOffsets[0] === 0 && stringOffsets[lastIndex] + stringLengths[lastIndex] === stringsBuffer.byteLength;
    }
    let expectedBytes = 0;
    for (let i = 0; i < stringLengths.length; ++i) { expectedBytes += stringLengths[i]; }
    return expectedBytes === stringsBuffer.byteLength;
}
