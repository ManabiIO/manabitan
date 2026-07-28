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
 *   buildPlan: (expressionIndexes: number[]|Uint32Array, readingIndexes: number[]|Uint32Array, count?: number) => import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan,
 * }}
 */
export function createTermRecordPreinternedPlanBuilder(initialStringCapacity = DEFAULT_INITIAL_STRING_CAPACITY) {
    const normalizedInitialCapacity = Math.max(16, Math.trunc(initialStringCapacity));
    /** @type {Map<number, number|number[]>} */
    const stringIndexesByHash = new Map();
    let stringLengthsCapacity = normalizedInitialCapacity;
    let stringLengths = new Uint16Array(stringLengthsCapacity);
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
     * @param {number} h2
     * @param {number} byteLength
     * @returns {number}
     */
    const getHashKey = (h1, h2, byteLength) => (
        (h1 ^ Math.imul(h2, 0x9e3779b1) ^ Math.imul(byteLength, 0x85ebca6b)) >>> 0
    );

    return {
        internStringBytes(bytes) {
            if (bytes.byteLength > 0xffff) {
                throw new Error('Term expression or reading exceeds the binary record limit');
            }
            let h1 = 0x811c9dc5;
            let h2 = 0x9e3779b9;
            for (let i = 0; i < bytes.byteLength; ++i) {
                const code = bytes[i];
                h1 = Math.imul((h1 ^ code) >>> 0, 0x01000193);
                h2 = Math.imul((h2 ^ code) >>> 0, 0x85ebca6b);
                h2 = (h2 ^ (h2 >>> 13)) >>> 0;
            }
            const key = getHashKey(h1, h2, bytes.byteLength);
            const cached = stringIndexesByHash.get(key);
            if (typeof cached === 'number') {
                if (bytesEqual(stringBytesList[cached], bytes)) { return cached; }
            } else if (Array.isArray(cached)) {
                for (const index of cached) {
                    if (bytesEqual(stringBytesList[index], bytes)) { return index; }
                }
            }

            const index = stringCount;
            ensureCapacity(index + 1);
            stringLengths[index] = bytes.byteLength;
            stringBytesList[index] = bytes;
            totalStringBytes += bytes.byteLength;
            stringCount = index + 1;
            if (typeof cached === 'number') {
                stringIndexesByHash.set(key, [cached, index]);
            } else if (Array.isArray(cached)) {
                cached.push(index);
            } else {
                stringIndexesByHash.set(key, index);
            }
            return index;
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
                stringOffsets,
                stringsBuffer,
                expressionIndexes: expressionIndexes instanceof Uint32Array ? expressionIndexes.subarray(0, count) : Uint32Array.from(expressionIndexes.slice(0, count)),
                readingIndexes: readingIndexes instanceof Uint32Array ? readingIndexes.subarray(0, count) : Uint32Array.from(readingIndexes.slice(0, count)),
            };
        },
    };
}
