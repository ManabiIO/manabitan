/*
 * Copyright (C) 2026  Yomitan Authors
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

import {arrayBufferToBase64} from '../../data/array-buffer-util.js';

/**
 * @param {unknown} condition
 * @param {string} [message]
 * @throws {Error}
 */
export function assert(condition, message = 'Assertion failed') {
    if (!condition) {
        throw new Error(message);
    }
}

/**
 * @param {Uint8Array[]} arrays
 * @returns {Uint8Array}
 */
export function concatUint8Arrays(...arrays) {
    const totalLength = arrays.reduce((sum, array) => sum + array.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const array of arrays) {
        result.set(array, offset);
        offset += array.byteLength;
    }
    return result;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
    let result = '';
    for (const value of bytes) {
        result += value.toString(16).padStart(2, '0');
    }
    return result;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ArrayToBase64(bytes) {
    return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
