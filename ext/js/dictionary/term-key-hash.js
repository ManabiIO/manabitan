/*
 * Copyright (C) 2026  Manabitan authors
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


const HASH_SEED = 0x811c9dc5;
const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

/**
 * @param {number} value
 * @param {number} amount
 * @returns {number}
 */
function rotateLeft(value, amount) {
    return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/**
 * @param {number} accumulator
 * @param {number} value
 * @returns {number}
 */
function round(accumulator, value) {
    return Math.imul(rotateLeft((accumulator + Math.imul(value, PRIME2)) >>> 0, 13), PRIME1) >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function hashTermKeyBytes(bytes) {
    return hashTermKeyByteRange(bytes, 0, bytes.byteLength);
}

/**
 * Stable XXH32 used by both persisted lookup indexes and runtime queries.
 * Keep this implementation synchronized with term-bank-parser.c.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
export function hashTermKeyByteRange(bytes, start, end) {
    const length = end - start;
    if (
        length >= 1024 && start >= 0 && end <= bytes.byteLength &&
        Number.isInteger(start) && Number.isInteger(end)
    ) {
        return hashLargeTermKeyByteRange(bytes, start, end);
    }
    let offset = start;
    let hash;
    if (length >= 16) {
        const limit = end - 16;
        let v1 = (HASH_SEED + PRIME1 + PRIME2) >>> 0;
        let v2 = (HASH_SEED + PRIME2) >>> 0;
        let v3 = HASH_SEED;
        let v4 = (HASH_SEED - PRIME1) >>> 0;
        do {
            v1 = round(v1, readUint32(bytes, offset)); offset += 4;
            v2 = round(v2, readUint32(bytes, offset)); offset += 4;
            v3 = round(v3, readUint32(bytes, offset)); offset += 4;
            v4 = round(v4, readUint32(bytes, offset)); offset += 4;
        } while (offset <= limit);
        hash = (rotateLeft(v1, 1) + rotateLeft(v2, 7) + rotateLeft(v3, 12) + rotateLeft(v4, 18)) >>> 0;
    } else {
        hash = (HASH_SEED + PRIME5) >>> 0;
    }
    hash = (hash + length) >>> 0;
    while (offset + 4 <= end) {
        hash = Math.imul(rotateLeft((hash + Math.imul(readUint32(bytes, offset), PRIME3)) >>> 0, 17), PRIME4) >>> 0;
        offset += 4;
    }
    while (offset < end) {
        hash = Math.imul(rotateLeft((hash + Math.imul(bytes[offset], PRIME5)) >>> 0, 11), PRIME1) >>> 0;
        ++offset;
    }
    hash ^= hash >>> 15;
    hash = Math.imul(hash, PRIME2) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, PRIME3) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readUint32(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

/**
 * Read whole words for large integrity payloads. Small lookup keys keep their
 * allocation-free byte reader; persisted hashes and little-endian order match.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function hashLargeTermKeyByteRange(bytes, start, end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = end - start;
    const limit = end - 16;
    let offset = start;
    let v1 = (HASH_SEED + PRIME1 + PRIME2) >>> 0;
    let v2 = (HASH_SEED + PRIME2) >>> 0;
    let v3 = HASH_SEED;
    let v4 = (HASH_SEED - PRIME1) >>> 0;
    do {
        v1 = round(v1, view.getUint32(offset, true)); offset += 4;
        v2 = round(v2, view.getUint32(offset, true)); offset += 4;
        v3 = round(v3, view.getUint32(offset, true)); offset += 4;
        v4 = round(v4, view.getUint32(offset, true)); offset += 4;
    } while (offset <= limit);
    let hash = (rotateLeft(v1, 1) + rotateLeft(v2, 7) + rotateLeft(v3, 12) + rotateLeft(v4, 18)) >>> 0;
    hash = (hash + length) >>> 0;
    while (offset + 4 <= end) {
        hash = Math.imul(rotateLeft((hash + Math.imul(view.getUint32(offset, true), PRIME3)) >>> 0, 17), PRIME4) >>> 0;
        offset += 4;
    }
    while (offset < end) {
        hash = Math.imul(rotateLeft((hash + Math.imul(bytes[offset], PRIME5)) >>> 0, 11), PRIME1) >>> 0;
        ++offset;
    }
    hash ^= hash >>> 15;
    hash = Math.imul(hash, PRIME2) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, PRIME3) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/** @typedef {{lanes: number[], tail: number[]}} TermKeyHashState */

/** @returns {TermKeyHashState} */
export function createTermKeyHashState() {
    return {lanes: [(HASH_SEED + PRIME1 + PRIME2) >>> 0,
        (HASH_SEED + PRIME2) >>> 0, HASH_SEED, (HASH_SEED - PRIME1) >>> 0], tail: []};
}
/**
 * Streaming XXH32 with the same persisted seed and rounds as the scalar API.
 * The returned state owns four accumulators and <=15 bytes, never a source view.
 * @param {TermKeyHashState} state @param {Uint8Array} bytes
 * @returns {TermKeyHashState}
 */
export function updateTermKeyHashState(state, bytes) {
    const input = new Uint8Array(state.tail.length + bytes.byteLength);
    input.set(state.tail);
    input.set(bytes, state.tail.length);
    const lanes = [...state.lanes];
    const view = new DataView(input.buffer);
    let offset = 0;
    for (; offset + 16 <= input.byteLength; offset += 16) {
        for (let lane = 0; lane < 4; ++lane) {
            lanes[lane] = round(lanes[lane], view.getUint32(offset + lane * 4, true));
        }
    }
    return {lanes, tail: Array.from(input.subarray(offset))};
}
/** @param {TermKeyHashState} state @param {number} length @returns {number} */
export function finishTermKeyHashState(state, length) {
    let hash = length >= 16 ? (rotateLeft(state.lanes[0], 1) +
        rotateLeft(state.lanes[1], 7) + rotateLeft(state.lanes[2], 12) +
        rotateLeft(state.lanes[3], 18)) >>> 0 : (HASH_SEED + PRIME5) >>> 0;
    hash = (hash + length) >>> 0;
    const tail = Uint8Array.from(state.tail);
    const view = new DataView(tail.buffer);
    let offset = 0;
    while (offset + 4 <= tail.length) {
        hash = Math.imul(rotateLeft((hash + Math.imul(view.getUint32(offset, true), PRIME3)) >>> 0, 17), PRIME4) >>> 0;
        offset += 4;
    }
    while (offset < tail.length) {
        hash = Math.imul(rotateLeft((hash + Math.imul(tail[offset++], PRIME5)) >>> 0, 11), PRIME1) >>> 0;
    }
    hash ^= hash >>> 15;
    hash = Math.imul(hash, PRIME2) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, PRIME3) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
}
