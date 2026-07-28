/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {
    createRawTermContentBlockDictName,
    decodeRawTermContentBlockReference,
    encodeRawTermContentBlockReference,
    getRawTermContentBlockCompressionDictName,
    RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES,
    writeRawTermContentBlockReference,
} from '../ext/js/dictionary/raw-term-content.js';

describe('raw term content block references', () => {
    test('round trips safe offsets and lengths', () => {
        const bytes = encodeRawTermContentBlockReference(Number.MAX_SAFE_INTEGER, 12345, 2_000_000, 4567, 890);

        expect(bytes).toHaveLength(RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
        expect(decodeRawTermContentBlockReference(bytes)).toStrictEqual({
            blockOffset: Number.MAX_SAFE_INTEGER,
            blockCompressedLength: 12345,
            blockUncompressedLength: 2_000_000,
            entryOffset: 4567,
            entryLength: 890,
        });
    });

    test('keeps the existing little-endian uint64 offset layout', () => {
        const bytes = encodeRawTermContentBlockReference(0x100000002, 1, 2, 0, 1);
        expect([...bytes.subarray(4, 12)]).toStrictEqual([2, 0, 0, 0, 1, 0, 0, 0]);
    });

    test('writes references directly into a shared slab', () => {
        const slab = new Uint8Array(RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES * 2);
        const view = new DataView(slab.buffer, slab.byteOffset, slab.byteLength);
        writeRawTermContentBlockReference(view, 0, 10, 20, 100, 0, 40);
        writeRawTermContentBlockReference(view, RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES, 30, 40, 200, 50, 60);

        expect(decodeRawTermContentBlockReference(slab.subarray(0, RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES))).toStrictEqual({
            blockOffset: 10,
            blockCompressedLength: 20,
            blockUncompressedLength: 100,
            entryOffset: 0,
            entryLength: 40,
        });
        expect(decodeRawTermContentBlockReference(slab.subarray(RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES))).toStrictEqual({
            blockOffset: 30,
            blockCompressedLength: 40,
            blockUncompressedLength: 200,
            entryOffset: 50,
            entryLength: 60,
        });
    });

    test('rejects malformed and out-of-bounds references', () => {
        const malformed = encodeRawTermContentBlockReference(10, 20, 100, 80, 20);
        malformed[0] = 0;
        expect(decodeRawTermContentBlockReference(malformed)).toBeNull();

        const outOfBounds = encodeRawTermContentBlockReference(10, 20, 100, 80, 21);
        expect(decodeRawTermContentBlockReference(outOfBounds)).toBeNull();
    });

    test('encodes the optional zstd dictionary in the storage name', () => {
        expect(createRawTermContentBlockDictName(null)).toBe('raw-block-v1');
        expect(createRawTermContentBlockDictName('jmdict')).toBe('raw-block-v1:jmdict');
        expect(getRawTermContentBlockCompressionDictName('raw-block-v1')).toBeNull();
        expect(getRawTermContentBlockCompressionDictName('raw-block-v1:jmdict')).toBe('jmdict');
        expect(getRawTermContentBlockCompressionDictName('raw-v2')).toBeUndefined();
    });
});
