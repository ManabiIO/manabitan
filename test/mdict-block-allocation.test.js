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
import {afterEach, describe, expect, test, vi} from 'vitest';
import {Mdict} from '../ext/js/dictionary/mdx/vendor/js-mdict/mdict.js';

afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {number} size
 * @param {boolean} [compressed]
 * @returns {{block: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>}}
 */
function createBlock(size, compressed = false) {
    const payload = new Uint8Array(size);
    for (let index = 0; index < size; ++index) { payload[index] = (index * 73) & 255; }
    const zipped = deflateSync(payload);
    const content = compressed ? zipped : payload;
    const block = new Uint8Array(8 + content.byteLength);
    block[0] = compressed ? 2 : 0;
    // zlib's Adler-32 trailer is independent of the MDict checksum helper.
    new DataView(block.buffer).setUint32(4, zipped.readUInt32BE(zipped.length - 4), false);
    block.set(content, 8);
    return {block, payload};
}

/**
 * @param {Uint8Array} block
 * @param {number} unpackSize
 * @returns {Uint8Array}
 */
function decode(block, unpackSize) {
    return Mdict.prototype.decompressBuff.call({
        options: {maxDecompressedBlockBytes: 16 * 1024 * 1024},
        meta: {encrypt: 0},
    }, block, unpackSize);
}

describe('MDict block allocation and validation', () => {
    test.each([0, 1, 256, 2000, 65536])('preserves stored bytes and ownership for %i bytes', (size) => {
        const {block, payload} = createBlock(size);
        const before = new Uint8Array(block);
        const copy = vi.spyOn(block, 'slice');
        const result = decode(block, size);
        expect(result).toEqual(payload);
        expect(result.buffer).not.toBe(block.buffer);
        expect(copy).toHaveBeenCalledExactlyOnceWith(8);
        copy.mockRestore();
        if (result.length > 0) { result[0] ^= 255; }
        expect(block).toEqual(before);
    });

    test.each([0, 1, 1023, 1025])('rejects stored size %i before copying a 1024-byte payload', (size) => {
        const {block} = createBlock(1024);
        const copy = vi.spyOn(block, 'slice');
        expect(() => decode(block, size)).toThrow('MDict decompressed block size mismatch');
        expect(copy).not.toHaveBeenCalled();
    });

    test('retains the stored-block checksum check', () => {
        const {block} = createBlock(1024);
        block[4] ^= 1;
        expect(() => decode(block, 1024)).toThrow('MDict record block checksum mismatch');
    });

    test.each([0, 1, 65536])('preserves zlib decoding for %i bytes', (size) => {
        const {block, payload} = createBlock(size, true);
        expect(decode(block, size)).toEqual(payload);
    });

    test('retains compressed-block size and checksum validation', () => {
        const {block} = createBlock(1024, true);
        expect(() => decode(block, 1025)).toThrow('MDict decompressed block size mismatch');
        block[4] ^= 1;
        expect(() => decode(block, 1024)).toThrow('MDict record block checksum mismatch');
    });

    test('rejects unsupported compression types', () => {
        const {block} = createBlock(1024);
        block[0] = 3;
        expect(() => decode(block, 1024)).toThrow('cannot determine the record compression type');
    });
});
