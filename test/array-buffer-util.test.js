/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {Buffer} from 'node:buffer';
import {describe, expect, test} from 'vitest';
import {arrayBufferToBase64, arrayBufferToBinaryString, base64ToArrayBuffer} from '../ext/js/data/array-buffer-util.js';

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function fixture(length) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; ++i) {
        bytes[i] = (i * 73 + 19) & 0xff;
    }
    return bytes;
}

describe('ArrayBuffer conversion across chunk boundaries', () => {
    for (const length of [0, 1, 2, 3, 24_575, 24_576, 24_577, 49_152, 49_153, 131_073]) {
        test(`base64 encodes ${length} bytes identically to Node`, () => {
            const bytes = fixture(length);
            const expected = Buffer.from(bytes).toString('base64');

            const encoded = arrayBufferToBase64(bytes.buffer);

            expect(encoded).toBe(expected);
            expect(new Uint8Array(base64ToArrayBuffer(encoded))).toStrictEqual(bytes);
        });
    }

    for (const length of [0, 1, 32_767, 32_768, 32_769, 150_001]) {
        test(`binary string encodes ${length} bytes without spreading the entire buffer`, () => {
            const bytes = fixture(length);
            const binary = arrayBufferToBinaryString(bytes.buffer);
            expect(binary).toBe(Buffer.from(bytes).toString('latin1'));
        });
    }
});
