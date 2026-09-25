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

import './pako-inflate.js';

/**
 * @typedef {{
 *   inflate?: ((bytes: Uint8Array) => Uint8Array),
 *   Inflate?: new (options?: {chunkSize?: number}) => {
 *     push: (bytes: Uint8Array, final: boolean) => boolean,
 *     err: number,
 *     msg: string,
 *     strm: {avail_in: number},
 *     onData: (chunk: Uint8Array) => void
 *   }
 * }} PakoInflateApi
 */

/**
 * @param {Uint8Array} bytes
 * @param {number|null} [maxOutputSize]
 * @returns {Uint8Array}
 * @throws {Error}
 */
export function inflateSync(bytes, maxOutputSize = null) {
    const pako = /** @type {PakoInflateApi|undefined} */ (Reflect.get(globalThis, 'pako'));
    if (maxOutputSize === null) {
        if (typeof pako?.inflate !== 'function') {
            throw new Error('pako.inflate is unavailable');
        }
        return pako.inflate(bytes);
    }
    if (!Number.isSafeInteger(maxOutputSize) || maxOutputSize < 0) {
        throw new RangeError('Invalid MDict decompression output limit');
    }
    if (typeof pako?.Inflate !== 'function') {
        throw new Error('pako.Inflate is unavailable');
    }

    // Ask pako for chunks no larger than one byte past the declared limit.
    // The callback rejects before retaining an over-limit chunk, so malformed
    // compressed data cannot inflate arbitrarily before the caller's size check.
    const chunkSize = Math.max(1, Math.min(16 * 1024, maxOutputSize + 1));
    const inflator = new pako.Inflate({chunkSize});
    /** @type {Uint8Array[]} */
    const chunks = [];
    let outputSize = 0;
    inflator.onData = (chunk) => {
        const nextOutputSize = outputSize + chunk.byteLength;
        if (!Number.isSafeInteger(nextOutputSize) || nextOutputSize > maxOutputSize) {
            throw new RangeError(`MDict decompressed block exceeds declared size of ${maxOutputSize} bytes`);
        }
        chunks.push(chunk);
        outputSize = nextOutputSize;
    };

    const ok = inflator.push(bytes, true);
    if (!ok || inflator.err !== 0) {
        throw new Error(inflator.msg || 'MDict zlib decompression failed');
    }
    if (inflator.strm.avail_in !== 0) {
        throw new Error('MDict zlib stream has trailing compressed input');
    }
    const result = new Uint8Array(outputSize);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
