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

import {deflateSync} from 'node:zlib';
import {describe, expect, test} from 'vitest';
import common from '../ext/js/dictionary/mdx/vendor/js-mdict/utils.js';

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function oracle(bytes) {
    const compressed = deflateSync(bytes);
    return compressed.readUInt32BE(compressed.length - 4);
}

describe('MDict Adler-32', () => {
    const sizes = [
        0,
        1,
        2,
        7,
        8,
        9,
        15,
        16,
        17,
        255,
        256,
        257,
        1999,
        2000,
        2001,
        3999,
        4000,
        4001,
        5552,
        65536,
        1048576,
    ];
    const fills = [0, 1, 255, null];
    for (const size of sizes) {
        for (const fill of fills) {
            test(`matches zlib at ${size} bytes with fill ${String(fill)} without mutating the view`, () => {
                const padded = new Uint8Array(size + 39).fill(171);
                const bytes = padded.subarray(13, 13 + size);
                for (let index = 0; index < size; ++index) {
                    bytes[index] = fill ?? (((index * 73) ^ (index >>> 9)) & 255);
                }
                const before = new Uint8Array(bytes);
                const actual = common.adler32(bytes);
                expect(actual).toBe(oracle(bytes));
                expect(actual).toBeGreaterThanOrEqual(0);
                expect(actual).toBeLessThanOrEqual(0xffffffff);
                expect(bytes).toEqual(before);
                expect(padded.subarray(0, 13).every((value) => value === 171)).toBe(true);
                expect(padded.subarray(size + 13).every((value) => value === 171)).toBe(true);
            });
        }
    }

    test('matches 1000 deterministic mixed-byte inputs', () => {
        let seed = 9134291;
        /** @returns {number} */
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed;
        };
        for (let iteration = 0; iteration < 1000; ++iteration) {
            const bytes = new Uint8Array(random() % 20000);
            for (let index = 0; index < bytes.length; ++index) { bytes[index] = random() >>> 24; }
            expect(common.adler32(bytes)).toBe(oracle(bytes));
        }
    });

    test('returns the empty checksum and detects a changed byte', () => {
        expect(common.adler32(new Uint8Array(0))).toBe(1);
        const bytes = new Uint8Array(8001).fill(255);
        const original = common.adler32(bytes);
        bytes[4000] ^= 1;
        expect(common.adler32(bytes)).not.toBe(original);
        expect(common.adler32(bytes)).toBe(oracle(bytes));
    });
});
