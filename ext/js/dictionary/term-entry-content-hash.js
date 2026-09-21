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
    // Keep both persisted XXH32 seeds, but load each input word only once.
    const seed1 = 0x811c9dc5;
    const seed2 = 0x9e3779b9;
    const length = bytes.length;
    let offset = 0;
    let h1;
    let h2;
    if (length >= 16) {
        const limit = length - 16;
        let a1 = (seed1 + 2654435761 + 2246822519) | 0;
        let a2 = (seed1 + 2246822519) | 0;
        let a3 = seed1 | 0;
        let a4 = (seed1 - 2654435761) | 0;
        let b1 = (seed2 + 2654435761 + 2246822519) | 0;
        let b2 = (seed2 + 2246822519) | 0;
        let b3 = seed2 | 0;
        let b4 = (seed2 - 2654435761) | 0;
        do {
            const w1 = Math.imul(readUint32Le(bytes, offset), 2246822519);
            const w2 = Math.imul(readUint32Le(bytes, offset + 4), 2246822519);
            const w3 = Math.imul(readUint32Le(bytes, offset + 8), 2246822519);
            const w4 = Math.imul(readUint32Le(bytes, offset + 12), 2246822519);
            a1 = (a1 + w1) | 0;
            a1 = Math.imul((a1 << 13) | (a1 >>> 19), 2654435761);
            b1 = (b1 + w1) | 0;
            b1 = Math.imul((b1 << 13) | (b1 >>> 19), 2654435761);
            a2 = (a2 + w2) | 0;
            a2 = Math.imul((a2 << 13) | (a2 >>> 19), 2654435761);
            b2 = (b2 + w2) | 0;
            b2 = Math.imul((b2 << 13) | (b2 >>> 19), 2654435761);
            a3 = (a3 + w3) | 0;
            a3 = Math.imul((a3 << 13) | (a3 >>> 19), 2654435761);
            b3 = (b3 + w3) | 0;
            b3 = Math.imul((b3 << 13) | (b3 >>> 19), 2654435761);
            a4 = (a4 + w4) | 0;
            a4 = Math.imul((a4 << 13) | (a4 >>> 19), 2654435761);
            b4 = (b4 + w4) | 0;
            b4 = Math.imul((b4 << 13) | (b4 >>> 19), 2654435761);
            offset += 16;
        } while (offset <= limit);
        h1 = (rotateLeft32(a1, 1) + rotateLeft32(a2, 7) + rotateLeft32(a3, 12) + rotateLeft32(a4, 18)) >>> 0;
        h2 = (rotateLeft32(b1, 1) + rotateLeft32(b2, 7) + rotateLeft32(b3, 12) + rotateLeft32(b4, 18)) >>> 0;
    } else {
        h1 = (seed1 + 374761393) >>> 0;
        h2 = (seed2 + 374761393) >>> 0;
    }
    h1 = (h1 + length) >>> 0;
    h2 = (h2 + length) >>> 0;
    while (offset + 4 <= length) {
        const word = readUint32Le(bytes, offset);
        const product = Math.imul(word, 3266489917);
        h1 = (h1 + product) | 0;
        h1 = Math.imul((h1 << 17) | (h1 >>> 15), 668265263);
        h2 = (h2 + product) | 0;
        h2 = Math.imul((h2 << 17) | (h2 >>> 15), 668265263);
        offset += 4;
    }
    while (offset < length) {
        const product = Math.imul(bytes[offset], 374761393);
        h1 = (h1 + product) | 0;
        h1 = Math.imul((h1 << 11) | (h1 >>> 21), 2654435761);
        h2 = (h2 + product) | 0;
        h2 = Math.imul((h2 << 11) | (h2 >>> 21), 2654435761);
        ++offset;
    }
    h1 = xxh32Avalanche(h1);
    h2 = xxh32Avalanche(h2);
    if ((h1 | h2) === 0) { h1 = 1; }
    return [h1, h2];
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hashTermEntryContentBytes(bytes) {
    if (bytes.length < 16) {
        let h1 = hashShortContentXxh32(bytes, 0x811c9dc5);
        const h2 = hashShortContentXxh32(bytes, 0x9e3779b9);
        if ((h1 | h2) === 0) { h1 = 1; }
        return hashPairToHex(h1, h2);
    }
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
 * @param {number} hash
 * @returns {number}
 */
function xxh32Avalanche(hash) {
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 2246822519) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 3266489917) >>> 0;
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/**
 * Keep the short hex-string path separate: fusing its pair regressed this
 * benchmark control, unlike the pair-returning import hot path.
 * @param {Uint8Array} bytes
 * @param {number} seed
 * @returns {number}
 */
function hashShortContentXxh32(bytes, seed) {
    const length = bytes.length;
    let h32 = (seed + 374761393 + length) >>> 0;
    let offset = 0;
    while (offset + 4 <= length) {
        h32 = (h32 + Math.imul(readUint32Le(bytes, offset), 3266489917)) | 0;
        h32 = Math.imul((h32 << 17) | (h32 >>> 15), 668265263);
        offset += 4;
    }
    while (offset < length) {
        h32 = (h32 + Math.imul(bytes[offset], 374761393)) | 0;
        h32 = Math.imul((h32 << 11) | (h32 >>> 21), 2654435761);
        ++offset;
    }
    return xxh32Avalanche(h32);
}
