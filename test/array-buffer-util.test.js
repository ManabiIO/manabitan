/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {
    arrayBufferToBase64,
    arrayBufferToBinaryString,
    base64ToArrayBuffer,
} from '../ext/js/data/array-buffer-util.js';

describe('Binary string encoding', () => {
    test('empty buffers produce empty binary and base64 strings', () => {
        const empty = new ArrayBuffer(0);
        expect(arrayBufferToBinaryString(empty)).toBe('');
        expect(arrayBufferToBase64(empty)).toBe('');
        expect(base64ToArrayBuffer('').byteLength).toBe(0);
    });

    test('all byte values round-trip without Unicode reinterpretation', () => {
        const buffer = new ArrayBuffer(256);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; ++i) { bytes[i] = i; }
        const binary = arrayBufferToBinaryString(buffer);
        expect(binary.length).toBe(bytes.length);
        for (let i = 0; i < bytes.length; ++i) {
            expect(binary.charCodeAt(i)).toBe(i);
        }
        expect(new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(buffer)))).toStrictEqual(bytes);
    });

    test.each([0x7fff, 0x8000, 0x8001, 0x10000, 0x10001, 1_000_000])(
        'large buffer of %i bytes is converted exactly',
        (length) => {
            const buffer = new ArrayBuffer(length);
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < length; ++i) {
                bytes[i] = (i * 73 + 41) & 0xff;
            }
            const binary = arrayBufferToBinaryString(buffer);
            expect(binary.length).toBe(length);
            let mismatchIndex = -1;
            for (let i = 0; i < length; ++i) {
                if (binary.charCodeAt(i) !== bytes[i]) {
                    mismatchIndex = i;
                    break;
                }
            }
            expect(mismatchIndex).toBe(-1);
        },
    );

    test('base64 round-trips a buffer exceeding engine argument limits', () => {
        const buffer = new ArrayBuffer(200_000);
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; ++i) {
            bytes[i] = i & 0xff;
        }
        const output = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
        expect(output).toStrictEqual(bytes);
    });
});
