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

import {hashTermKeyByteRange} from './term-key-hash.js';

export const MIN_EXACT_LOOKUP_SOURCE_BYTES = 1024 * 1024 * 1024;

const BITS_PER_KEY = 20;
const HASH_BUCKET_COUNT = 2 ** 20;
const BASE_HEADER_BYTES = 32;

/** @type {Uint32Array|null} */
let masks = null;

/**
 * Choose one bit from each octet using the upper twelve hash bits. The
 * remaining twenty bits select a word with no overlap between the choices.
 * @param {number} index
 * @returns {number}
 */
function hashMask(index) {
    return (1 << (index & 7)) |
    (1 << (8 + ((index >>> 3) & 7))) |
    (1 << (16 + ((index >>> 6) & 7))) |
    (1 << (24 + (index >>> 9)));
}

/**
 * @param {number} keyCount
 * @returns {number}
 */
function filterWordCount(keyCount) {
    return Math.ceil(keyCount * BITS_PER_KEY / 32);
}

/**
 * @param {Uint32Array|undefined} hashes
 * @returns {Uint32Array|null}
 */
export function buildTermLookupFilter(hashes) {
    if (!(hashes instanceof Uint32Array) || hashes.length === 0 || hashes.length >= 0xffff) { return null; }
    const wordCount = filterWordCount(hashes.length);
    const words = new Uint32Array(1 + wordCount);
    // Bind a transferred filter to its exact key count even when adjacent
    // counts round up to the same number of words.
    words[0] = hashes.length;
    const factor = wordCount / HASH_BUCKET_COUNT;
    const maskTable = masks ??= Uint32Array.from({length: 4096}, (_, index) => hashMask(index));
    for (let i = 0; i < hashes.length; ++i) {
        const hash = hashes[i];
        const word = ((hash & (HASH_BUCKET_COUNT - 1)) * factor) >>> 0;
        words[1 + word] |= maskTable[hash >>> 20];
    }
    return words;
}

/**
 * Uses interned key bytes for the chunks whose writer has no parser hashes.
 * Runs on the base section of the just-encoded, owned lookup index.
 * @param {Uint8Array} base
 * @param {Uint32Array|null} [prepared=null]
 * @returns {Uint32Array|null}
 */
export function buildTermLookupFilterFromBase(base, prepared = null) {
    if (base.byteLength < BASE_HEADER_BYTES || (base.byteOffset & 3) !== 0) { return null; }
    const header = new DataView(base.buffer, base.byteOffset, BASE_HEADER_BYTES);
    const keyCount = header.getUint32(4, true);
    const byteLength = header.getUint32(8, true);
    const lengthStart = BASE_HEADER_BYTES + (Math.ceil(byteLength / 4) * 4);
    if (keyCount === 0 || keyCount >= 0xffff || lengthStart + keyCount * 2 > base.byteLength) { return null; }
    if (prepared instanceof Uint32Array && prepared[0] === keyCount && prepared.length === 1 + filterWordCount(keyCount)) { return prepared; }

    const keyBytes = base.subarray(BASE_HEADER_BYTES, BASE_HEADER_BYTES + byteLength);
    const lengths = new Uint16Array(base.buffer, base.byteOffset + lengthStart, keyCount);
    const hashes = new Uint32Array(keyCount);
    let start = 0;
    for (let i = 0; i < keyCount; ++i) {
        const end = start + lengths[i];
        if (start === end || end > keyBytes.length) { return null; }
        hashes[i] = hashTermKeyByteRange(keyBytes, start, end);
        start = end;
    }
    return start === keyBytes.length ? buildTermLookupFilter(hashes) : null;
}

/**
 * @param {Uint32Array} words
 * @param {number} hash
 * @returns {boolean}
 */
export function termLookupFilterMayContain(words, hash) {
    const word = ((hash & (HASH_BUCKET_COUNT - 1)) * ((words.length - 1) / HASH_BUCKET_COUNT)) >>> 0;
    const mask = hashMask(hash >>> 20);
    return (words[1 + word] & mask) === mask;
}
