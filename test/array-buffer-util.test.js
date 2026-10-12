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

import {describe, expect, test} from 'vitest';
import {arrayBufferToBase64, uint8ArrayToArrayBuffer} from '../ext/js/data/array-buffer-util.js';

describe('byte view buffer boundaries', () => {
    test('base64 encodes only a byte view span', () => {
        const bytes = new Uint8Array([88, 1, 2, 3, 99]);
        expect(arrayBufferToBase64(bytes.subarray(1, 4))).toBe('AQID');
    });

    test('a complete ordinary backing buffer is reused', () => {
        const bytes = new Uint8Array([1, 2, 3]);
        expect(uint8ArrayToArrayBuffer(bytes)).toBe(bytes.buffer);
    });

    test('a partial ordinary view is compacted and isolated', () => {
        const bytes = new Uint8Array([88, 1, 2, 3, 99]);
        const buffer = uint8ArrayToArrayBuffer(bytes.subarray(1, 4));
        expect(buffer.byteLength).toBe(3);
        bytes[1] = 9;
        expect([...new Uint8Array(buffer)]).toStrictEqual([1, 2, 3]);
    });

    test('a shared view becomes an ordinary ArrayBuffer with exactly its bytes', () => {
        const bytes = new Uint8Array(new SharedArrayBuffer(5));
        bytes.set([88, 1, 2, 3, 99]);
        const buffer = uint8ArrayToArrayBuffer(bytes.subarray(1, 4));
        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(buffer.byteLength).toBe(3);
        bytes[1] = 9;
        expect([...new Uint8Array(buffer)]).toStrictEqual([1, 2, 3]);
    });

    test('base64 accepts shared buffers and shared byte views', () => {
        const bytes = new Uint8Array(new SharedArrayBuffer(5));
        bytes.set([88, 1, 2, 3, 99]);
        expect(arrayBufferToBase64(bytes.subarray(1, 4))).toBe('AQID');
        expect(arrayBufferToBase64(new SharedArrayBuffer(3))).toBe('AAAA');
    });

    test('a pooled Node buffer exports only its logical bytes', () => {
        const pooled = Buffer.from([0, 65, 66, 255]).subarray(1, 3);
        expect([...new Uint8Array(uint8ArrayToArrayBuffer(pooled))]).toStrictEqual([65, 66]);
        expect(arrayBufferToBase64(pooled)).toBe('QUI=');
    });

    test('an empty subview exports no bytes from its backing allocation', () => {
        const view = new Uint8Array([65, 66]).subarray(1, 1);
        expect(uint8ArrayToArrayBuffer(view).byteLength).toBe(0);
        expect(arrayBufferToBase64(view)).toBe('');
    });
});
