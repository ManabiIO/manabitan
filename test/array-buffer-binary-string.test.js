/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {Buffer} from 'node:buffer';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {arrayBufferToBase64, arrayBufferToBinaryString, base64ToArrayBuffer} from '../ext/js/data/array-buffer-util.js';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {number} size
 * @returns {Uint8Array<ArrayBuffer>}
 */
function createBytes(size) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; ++i) { bytes[i] = ((i * 73) ^ (i >>> 8)) & 255; }
    return bytes;
}

describe('bounded binary string conversion', () => {
    test.each([
        0,
        1,
        2,
        3,
        255,
        256,
        257,
        32767,
        32768,
        32769,
        65535,
        65536,
        65537,
        131071,
        131072,
        1048576,
    ])('preserves every byte and base64 padding for %i bytes', (size) => {
        const bytes = createBytes(size);
        const expected = Buffer.from(bytes);
        const binary = arrayBufferToBinaryString(bytes.buffer);
        const encoded = arrayBufferToBase64(bytes.buffer);
        expect(binary).toBe(expected.toString('latin1'));
        expect(encoded).toBe(expected.toString('base64'));
        expect(new Uint8Array(base64ToArrayBuffer(encoded))).toEqual(bytes);
        expect(Buffer.from(bytes)).toEqual(expected);
    }, 15_000);

    test('does not submit a whole media buffer as one argument list', () => {
        const bytes = createBytes(65539);
        const expected = Buffer.from(bytes).toString('latin1');
        /** @type {number[]} */
        const callSizes = [];
        vi.spyOn(String, 'fromCharCode').mockImplementation((...codes) => {
            callSizes.push(codes.length);
            return Buffer.from(codes).toString('latin1');
        });
        expect(arrayBufferToBinaryString(bytes.buffer)).toBe(expected);
        expect(callSizes).toEqual([32768, 32768, 3]);
    });

    test('retains the fallback for runtimes with a smaller argument limit', () => {
        const bytes = createBytes(5000);
        const expected = Buffer.from(bytes).toString('latin1');
        let rejectedCalls = 0;
        vi.spyOn(String, 'fromCharCode').mockImplementation((...codes) => {
            if (codes.length > 4096) {
                ++rejectedCalls;
                throw new RangeError('Simulated smaller argument limit');
            }
            return Buffer.from(codes).toString('latin1');
        });
        expect(arrayBufferToBinaryString(bytes.buffer)).toBe(expected);
        expect(rejectedCalls).toBe(1);
    });
});
