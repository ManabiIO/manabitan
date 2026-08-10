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

const DEFAULT_INITIAL_STRING_CAPACITY = 16384;

/**
 * @param {number} [initialStringCapacity]
 * @returns {{
 *   internStringBytes: (bytes: Uint8Array) => number,
 *   internStringBytesWithHash: (bytes: Uint8Array, hash: number) => number,
 *   buildPlan: (expressionIndexes: number[]|Uint32Array, readingIndexes: number[]|Uint32Array, count?: number) => import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan,
 * }}
 */
export function createTermRecordPreinternedPlanBuilder(initialStringCapacity = DEFAULT_INITIAL_STRING_CAPACITY) {
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
            let h1 = 0x811c9dc5;
            for (let i = 0; i < bytes.byteLength; ++i) {
                h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
            }
            return internHashedBytes(bytes, h1);
        },
        internStringBytesWithHash(bytes, hash) {
            return internHashedBytes(bytes, hash);
        },
        buildPlan(expressionIndexes, readingIndexes, count = expressionIndexes.length) {
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
                expressionIndexes: expressionIndexes instanceof Uint32Array ? expressionIndexes.subarray(0, count) : Uint32Array.from(expressionIndexes.slice(0, count)),
                readingIndexes: readingIndexes instanceof Uint32Array ? readingIndexes.subarray(0, count) : Uint32Array.from(readingIndexes.slice(0, count)),
            };
        },
    };
}
