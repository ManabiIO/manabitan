/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

/** @typedef {{packedChunks: Uint8Array[], sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}} Packed */

/**
 * Capture the actual production pack callback after public span validation.
 * Compression and I/O are already covered by the block-store integration tests.
 * @param {Uint8Array} source
 * @param {Uint32Array} offsets
 * @param {Uint32Array} lengths
 * @param {number} target
 * @returns {Promise<Packed>}
 */
async function pack(source, offsets, lengths, target) {
    const store = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes: target});
    /** @type {Packed} */
    let result = {packedChunks: [], sourceChunkIndices: new Uint32Array(), sourceChunkLocalOffsets: new Uint32Array()};
    const capture = vi.spyOn(store, '_tryAppendPacked').mockImplementation(async (createPacked) => {
        result = createPacked();
        return null;
    });
    try {
        await store.tryAppendSpans(source, offsets, lengths, null, true);
    } finally {
        capture.mockRestore();
    }
    return result;
}

/**
 * Independent per-byte oracle, including the existing soft block-size limit.
 * @param {Uint8Array} source
 * @param {Uint32Array} offsets
 * @param {Uint32Array} lengths
 * @param {number} target
 * @returns {Packed}
 */
function oracle(source, offsets, lengths, target) {
    /** @type {number[][]} */
    const blocks = [];
    const indices = new Uint32Array(lengths.length);
    const locals = new Uint32Array(lengths.length);
    for (let i = 0; i < lengths.length; ++i) {
        if (blocks.length === 0 || (blocks[blocks.length - 1].length > 0 && blocks[blocks.length - 1].length + lengths[i] > target)) {
            blocks.push([]);
        }
        const block = blocks[blocks.length - 1];
        indices[i] = blocks.length - 1;
        locals[i] = block.length;
        for (let j = 0; j < lengths[i]; ++j) { block.push(source[offsets[i] + j]); }
    }
    return {packedChunks: blocks.map((block) => Uint8Array.from(block)), sourceChunkIndices: indices, sourceChunkLocalOffsets: locals};
}

/**
 * @param {number} size
 * @returns {Uint8Array}
 */
function bytes(size) {
    return Uint8Array.from({length: size}, (_, i) => (i * 131 + Math.floor(i / 7)) & 255);
}

describe('term content span copy runs', () => {
    test.each([
        {name: 'contiguous', offsets: [0, 2, 5, 9], lengths: [2, 3, 4, 7]},
        {name: 'gaps', offsets: [1, 6, 12, 20], lengths: [2, 3, 4, 5]},
        {name: 'reordering', offsets: [20, 12, 2, 6], lengths: [4, 3, 4, 5]},
        {name: 'overlapping', offsets: [4, 6, 4, 9], lengths: [6, 7, 5, 3]},
        {name: 'empty intervening ranges', offsets: [1, 40, 5, 0, 8, 50], lengths: [4, 0, 3, 0, 4, 0]},
        {name: 'only empty ranges', offsets: [0, 5, 50], lengths: [0, 0, 0]},
        {name: 'oversized single range', offsets: [1, 31, 35], lengths: [30, 4, 10]},
    ])('preserves exact layout for $name', async ({offsets, lengths}) => {
        const source = bytes(50);
        const sourceOffsets = Uint32Array.from(offsets);
        const sourceLengths = Uint32Array.from(lengths);
        for (const target of [1, 7, 16, 100]) {
            const actual = await pack(source, sourceOffsets, sourceLengths, target);
            expect(actual).toEqual(oracle(source, sourceOffsets, sourceLengths, target));
        }
    });

    test('makes one source view per block rather than per adjacent definition', async () => {
        const source = bytes(8192);
        const offsets = Uint32Array.from({length: 4096}, (_, i) => i * 2);
        const lengths = new Uint32Array(4096).fill(2);
        const subarray = vi.spyOn(source, 'subarray');
        const actual = await pack(source, offsets, lengths, 4096);
        expect(actual.packedChunks).toHaveLength(2);
        expect(subarray).toHaveBeenCalledTimes(2);
        expect(subarray.mock.calls).toEqual([[0, 4096], [4096, 8192]]);
        subarray.mockRestore();
        expect(actual).toEqual(oracle(source, offsets, lengths, 4096));
    });

    test.each([false, true])('owns only selected bytes from offset views, shared=%s', async (shared) => {
        const backing = shared ? new SharedArrayBuffer(160) : new ArrayBuffer(160);
        const all = new Uint8Array(backing);
        all.fill(165);
        const source = new Uint8Array(backing, 13, 100);
        source.set(bytes(100));
        const offsets = new Uint32Array([2, 9, 75, 78, 2]);
        const lengths = new Uint32Array([7, 8, 3, 4, 7]);
        const expected = oracle(source, offsets, lengths, 20);
        const actual = await pack(source, offsets, lengths, 20);
        expect(actual).toEqual(expected);
        for (const chunk of actual.packedChunks) {
            expect(chunk.buffer).not.toBe(backing);
            expect(chunk.byteOffset).toBe(0);
            expect(chunk.buffer.byteLength).toBe(chunk.byteLength);
        }
        expect(all.slice(0, 13)).toEqual(new Uint8Array(13).fill(165));
        expect(all.slice(113)).toEqual(new Uint8Array(47).fill(165));
        source.fill(0);
        expect(actual).toEqual(expected);
    });

    test('keeps shared WebAssembly output independent across source reuse and growth', async () => {
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
        const source = new Uint8Array(memory.buffer, 3, 128);
        source.set(bytes(128));
        const offsets = new Uint32Array([0, 32, 64]);
        const lengths = new Uint32Array([32, 32, 32]);
        const expected = oracle(source, offsets, lengths, 64);
        const actual = await pack(source, offsets, lengths, 64);
        memory.grow(1);
        source.fill(0);
        expect(actual).toEqual(expected);
    });

    test('does not read bytes for zero-length spans', async () => {
        const source = bytes(16);
        const subarray = vi.spyOn(source, 'subarray');
        const actual = await pack(source, new Uint32Array([16, 0, 8]), new Uint32Array(3), 4);
        expect(subarray).not.toHaveBeenCalled();
        expect(actual.packedChunks).toEqual([new Uint8Array()]);
        subarray.mockRestore();
    });

    test('validates even an empty out-of-bounds span before packing', async () => {
        const source = bytes(16);
        const subarray = vi.spyOn(source, 'subarray');
        await expect(pack(source, new Uint32Array([0, 17]), new Uint32Array([1, 0]), 32)).rejects.toThrow(RangeError);
        await expect(pack(source, new Uint32Array([0]), new Uint32Array([17]), 32)).rejects.toThrow(RangeError);
        expect(subarray).not.toHaveBeenCalled();
        subarray.mockRestore();
    });

    test('matches independent copying for 300 uneven plans', async () => {
        let state = 0x12345678;
        /** @returns {number} */
        const next = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
        };
        const source = bytes(512);
        for (let iteration = 0; iteration < 300; ++iteration) {
            const size = 1 + next() % 80;
            const offsets = new Uint32Array(size);
            const lengths = new Uint32Array(size);
            for (let i = 0; i < size; ++i) {
                const end = i === 0 ? 0 : offsets[i - 1] + lengths[i - 1];
                offsets[i] = next() % 3 === 0 ? end : next() % 513;
                lengths[i] = next() % (Math.min(30, 512 - offsets[i]) + 1);
            }
            const target = 1 + next() % 150;
            expect(await pack(source, offsets, lengths, target)).toEqual(oracle(source, offsets, lengths, target));
        }
    });
});
