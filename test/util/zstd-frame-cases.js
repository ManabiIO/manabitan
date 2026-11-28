/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

/**
 * @typedef {object} ZstdFrameCase
 * @property {string} name
 * @property {'plain'|'dictionary'} api
 * @property {'none'|'jmdict'|'raw'} dictionary
 * @property {number} level
 * @property {'repeat'|'dictionary-tail'} pattern
 * @property {number} period
 * @property {number} sourceBytes
 * @property {boolean} [blockMarkers]
 * @property {boolean} [lastByteMismatch]
 * @property {string} sourceSha256
 * @property {number} frameBytes
 * @property {string} frameSha256
 * @property {boolean} requiresDictionary
 */

/**
 * Deterministic test data, independent of the native matching implementation.
 * @param {number} length
 * @param {number} seed
 * @returns {Uint8Array}
 */
function pseudoRandomBytes(length, seed) {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; ++i) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        bytes[i] = seed & 0xff
    }
    return bytes
}

/** @returns {Uint8Array} */
export function createRawZstdFrameDictionary() {
    return pseudoRandomBytes(4096, 0x6e624eb7)
}

/**
 * Repeating a dictionary suffix lets a match continue from the dictionary's
 * end into the current source prefix. Markers exercise subsequent 128 KiB
 * blocks without turning the entire input into one identical-byte run.
 * @param {ZstdFrameCase} specification
 * @param {Uint8Array} dictionary
 * @returns {Uint8Array}
 */
export function createZstdFrameInput(specification, dictionary) {
    const {pattern, period, sourceBytes, blockMarkers = false, lastByteMismatch = false} = specification
    const bytes = new Uint8Array(sourceBytes)
    const repeated = pattern === 'dictionary-tail' ? dictionary.subarray(dictionary.byteLength - period) : pseudoRandomBytes(period, 0x8097ab61)
    for (let i = 0; i < bytes.byteLength; ++i) { bytes[i] = repeated[i % repeated.byteLength] }
    if (blockMarkers) {
        for (let i = 4096; i < bytes.byteLength; i += 4096) { bytes[i] ^= i >>> 12 }
    }
    if (lastByteMismatch && bytes.byteLength > 0) { bytes[bytes.byteLength - 1] ^= 0x80 }
    return bytes
}
