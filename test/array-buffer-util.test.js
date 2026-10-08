/*
 * Copyright (C) 2026 Manabitan authors
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

import {describe, expect, test, vi} from 'vitest';
import {arrayBufferToBase64, arrayBufferToBinaryString, base64ToArrayBuffer} from '../ext/js/data/array-buffer-util.js';

describe('large ArrayBuffer conversions', () => {
    test('converts binary buffers larger than the spread-argument limit in bounded chunks', () => {
        const bytes = new Uint8Array(0x20001);
        for (let i = 0; i < bytes.length; ++i) {
            bytes[i] = i % 256;
        }
        const original = String.fromCharCode;
        let largestChunk = 0;
        const spy = vi.spyOn(String, 'fromCharCode').mockImplementation((...codes) => {
            largestChunk = Math.max(largestChunk, codes.length);
            return original(...codes);
        });
        try {
            const result = arrayBufferToBinaryString(bytes.buffer);
            expect(result.length).toBe(bytes.length);
            expect(result.charCodeAt(0)).toBe(0);
            expect(result.charCodeAt(0x100ff)).toBe(255);
            expect(result.charCodeAt(bytes.length - 1)).toBe(0);
            expect(largestChunk).toBeLessThanOrEqual(0x8000);
            expect(spy).toHaveBeenCalledTimes(5);
        } finally {
            spy.mockRestore();
        }
    });

    test('preserves arbitrary bytes through base64 and handles an empty buffer', () => {
        const bytes = new Uint8Array(0x20001);
        for (let i = 0; i < bytes.length; ++i) {
            bytes[i] = (i * 31) & 255;
        }
        expect(new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)))).toStrictEqual(bytes);
        expect(arrayBufferToBinaryString(new ArrayBuffer(0))).toBe('');
    });
});
