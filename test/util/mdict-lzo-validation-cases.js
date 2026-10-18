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

import assert from 'node:assert/strict';
import {test} from 'node:test';
import lzo1x from '../../ext/js/dictionary/mdx/vendor/js-mdict/lzo1x-wrapper.js';

/**
 * Static LZO1X streams generated independently with liblzo2 lzo1x_1_compress
 * and verified with lzo1x_decompress_safe. They exercise literal and backref
 * paths without relying on the vendored JavaScript compressor.
 * @type {Array<{packed: string, unpacked: Uint8Array}>}
 */
const vectors = [
    {
        packed: '036162636162632a14000f616263616263616263616263616263616263110000',
        unpacked: new TextEncoder().encode('abcabcabcabcabcabcabcabcabcabcabcabc'),
    },
    {
        packed: '024141414141204b10000c414141414141414141414141414141110000',
        unpacked: new Uint8Array(128).fill(65),
    },
    {
        packed: '002e000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f200bfc0000022c2d2e2f303132333435363738393a3b3c3d3e3f110000',
        unpacked: Uint8Array.from({length: 128}, (_, index) => index % 64),
    },
];

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function fromHex(value) {
    return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

for (const [index, vector] of vectors.entries()) {
    test(`independent liblzo vector ${index + 1} survives strict bounds`, () => {
        assert.deepEqual(
            lzo1x.decompress(fromHex(vector.packed), vector.unpacked.byteLength),
            vector.unpacked,
        );
    });
}

test('every truncated prefix of an independent backreference stream fails closed', () => {
    const vector = vectors[1];
    const packed = fromHex(vector.packed);
    for (let length = 0; length < packed.length; ++length) {
        assert.throws(
            () => lzo1x.decompress(packed.subarray(0, length), vector.unpacked.byteLength),
            /MDict LZO (?:input|lookbehind|output)|decompression failed/u,
            `prefix length ${length} must not decode successfully`,
        );
    }
});

test('empty LZO input is rejected before reading its first control byte', () => {
    assert.throws(
        () => lzo1x.decompress(new Uint8Array(0), 0),
        /LZO input overrun/u,
    );
});

test('truncated initial literal run is rejected before reading beyond input', () => {
    // First byte declares four initial literals, but only two follow.
    assert.throws(
        () => lzo1x.decompress(Uint8Array.of(21, 1, 2), 4),
        /LZO input overrun/u,
    );
});

test('unterminated extended literal length is rejected at end of input', () => {
    assert.throws(
        () => lzo1x.decompress(Uint8Array.of(0, 0, 0, 0), 64),
        /LZO input overrun/u,
    );
});

test('match before any output is rejected as a lookbehind overrun', () => {
    // Control 17 with offset 1 is not the EOF marker and points before output.
    assert.throws(
        () => lzo1x.decompress(Uint8Array.of(17, 4, 0), 64),
        /LZO lookbehind overrun/u,
    );
});

test('all one-byte control inputs terminate with a bounded decoding error', () => {
    for (let control = 0; control <= 0xff; ++control) {
        assert.throws(
            () => lzo1x.decompress(Uint8Array.of(control), 64),
            /MDict LZO (?:input|lookbehind|output)|decompression failed/u,
            `control byte ${control} must fail closed`,
        );
    }
});

test('valid LZO stream rejects trailing compressed bytes after the EOF marker', () => {
    const vector = vectors[0];
    const packed = fromHex(vector.packed);
    const withTrailingByte = new Uint8Array(packed.byteLength + 1);
    withTrailingByte.set(packed);
    withTrailingByte[packed.byteLength] = 0x42;

    assert.throws(
        () => lzo1x.decompress(withTrailingByte, vector.unpacked.byteLength),
        /decompression failed with status -8/u,
    );
});

test('valid backreference output remains bounded to the exact decoded size', () => {
    const vector = vectors[0];
    assert.throws(
        () => lzo1x.decompress(fromHex(vector.packed), vector.unpacked.byteLength - 1),
        /LZO output exceeds declared size/u,
    );
});
