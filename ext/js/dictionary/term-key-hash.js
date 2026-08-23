/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
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
    let offset = start;
    const length = end - start;
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
