/*
 * Copyright (C) 2026  Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const HEX_BYTE_TABLE = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * @param {number} h1
 * @param {number} h2
 * @returns {string}
 */
export function hashPairToHex(h1, h2) {
    const a = h1 >>> 0;
    const b = h2 >>> 0;
    return (
        HEX_BYTE_TABLE[(a >>> 24) & 0xff] +
        HEX_BYTE_TABLE[(a >>> 16) & 0xff] +
        HEX_BYTE_TABLE[(a >>> 8) & 0xff] +
        HEX_BYTE_TABLE[a & 0xff] +
        HEX_BYTE_TABLE[(b >>> 24) & 0xff] +
        HEX_BYTE_TABLE[(b >>> 16) & 0xff] +
        HEX_BYTE_TABLE[(b >>> 8) & 0xff] +
        HEX_BYTE_TABLE[b & 0xff]
    );
}

/**
 * @param {Uint8Array} bytes
 * @returns {[number, number]}
 */
export function hashTermEntryContentBytesPair(bytes) {
    let h1 = hashContentXxh32(bytes, 0x811c9dc5);
    const h2 = hashContentXxh32(bytes, 0x9e3779b9);
    if ((h1 | h2) === 0) {
        h1 = 1;
    }
    return [h1 >>> 0, h2 >>> 0];
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hashTermEntryContentBytes(bytes) {
    const [h1, h2] = hashTermEntryContentBytesPair(bytes);
    return hashPairToHex(h1, h2);
}

/**
 * @param {number} value
 * @param {number} amount
 * @returns {number}
 */
function rotateLeft32(value, amount) {
    return (((value << amount) >>> 0) | (value >>> (32 - amount))) >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readUint32Le(bytes, offset) {
    return (
        bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
    ) >>> 0;
}

/**
 * @param {number} accumulator
 * @param {number} input
 * @returns {number}
 */
function xxh32Round(accumulator, input) {
    accumulator = (accumulator + Math.imul(input >>> 0, 2246822519)) >>> 0;
    accumulator = rotateLeft32(accumulator, 13);
    return Math.imul(accumulator, 2654435761) >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} seed
 * @returns {number}
 */
function hashContentXxh32(bytes, seed) {
    let offset = 0;
    const length = bytes.length;
    let h32;
    if (length >= 16) {
        const limit = length - 16;
        let v1 = (seed + 2654435761 + 2246822519) >>> 0;
        let v2 = (seed + 2246822519) >>> 0;
        let v3 = seed >>> 0;
        let v4 = (seed - 2654435761) >>> 0;
        do {
            v1 = xxh32Round(v1, readUint32Le(bytes, offset)); offset += 4;
            v2 = xxh32Round(v2, readUint32Le(bytes, offset)); offset += 4;
            v3 = xxh32Round(v3, readUint32Le(bytes, offset)); offset += 4;
            v4 = xxh32Round(v4, readUint32Le(bytes, offset)); offset += 4;
        } while (offset <= limit);
        h32 = (
            rotateLeft32(v1, 1) +
            rotateLeft32(v2, 7) +
            rotateLeft32(v3, 12) +
            rotateLeft32(v4, 18)
        ) >>> 0;
    } else {
        h32 = (seed + 374761393) >>> 0;
    }
    h32 = (h32 + length) >>> 0;
    while ((offset + 4) <= length) {
        h32 = (h32 + Math.imul(readUint32Le(bytes, offset), 3266489917)) >>> 0;
        h32 = Math.imul(rotateLeft32(h32, 17), 668265263) >>> 0;
        offset += 4;
    }
    while (offset < length) {
        h32 = (h32 + Math.imul(bytes[offset], 374761393)) >>> 0;
        h32 = Math.imul(rotateLeft32(h32, 11), 2654435761) >>> 0;
        ++offset;
    }
    h32 ^= h32 >>> 15;
    h32 = Math.imul(h32, 2246822519) >>> 0;
    h32 ^= h32 >>> 13;
    h32 = Math.imul(h32, 3266489917) >>> 0;
    h32 ^= h32 >>> 16;
    return h32 >>> 0;
}
