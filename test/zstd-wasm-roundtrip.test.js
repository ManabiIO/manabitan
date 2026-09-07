/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs/promises';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {compress, compressUsingDict, createCCtx, createDCtx, decompress, decompressUsingDict, freeCCtx, freeDCtx, init} from '../dev/lib/zstd-wasm.js';

// Supply the checked-in binary without a network fetch. The actual native
// compressor, decoder, allocator and memory-growth machinery are unchanged.
vi.mock('../dev/lib/zstd-simd-module.js', async (importOriginal) => {
    const {default: createModule} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await importOriginal());
    const wasmBinary = await fs.readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url));
    return {default: (/** @type {Record<string, unknown>} */ options) => createModule({...options, wasmBinary})};
});

let cctx = 0;
let dctx = 0;
/** @type {Uint8Array} */
let dictionary;

beforeAll(async () => {
    await init();
    dictionary = new Uint8Array(await fs.readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url)));
    cctx = createCCtx();
    dctx = createDCtx();
    expect(cctx).not.toBe(0);
    expect(dctx).not.toBe(0);
});

afterAll(() => {
    freeCCtx(cctx);
    freeDCtx(dctx);
});

describe.each([false, true])('real Zstd roundtrips, dictionary=%s', (useDictionary) => {
    test.each([0, 1, 31, 127, 128, 255, 256, 1023, 4096, 65536, 1048576, 4194304])('preserves all %s source bytes', (length) => {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; ++i) { bytes[i] = (i * 131 + (i >>> 8)) & 0xff; }
        const compressed = useDictionary ? compressUsingDict(cctx, bytes, dictionary, -1) : compress(bytes, 1);
        const decoded = useDictionary ? decompressUsingDict(dctx, compressed, dictionary) : decompress(compressed);
        expect(decoded.byteLength).toBe(bytes.byteLength);
        expect(Buffer.compare(decoded, bytes)).toBe(0);
    });
});

test('keeps a decoded result stable after native heap growth and context release', () => {
    const context = createDCtx();
    const source = new TextEncoder().encode('日本語の辞書・定義・読み方\u0000\u{1f4d6}');
    const compressed = compressUsingDict(cctx, source, dictionary, -1);
    const held = decompressUsingDict(context, compressed, dictionary);
    const large = new Uint8Array(9 * 1024 * 1024).fill(123);
    const largeCompressed = compressUsingDict(cctx, large, dictionary, -1);
    expect(Buffer.compare(decompressUsingDict(context, largeCompressed, dictionary), large)).toBe(0);
    expect(Buffer.compare(decompressUsingDict(context, compressed, dictionary), source)).toBe(0);
    freeDCtx(context);
    expect(Buffer.compare(held, source)).toBe(0);
});

test('recovers after a malformed frame without poisoning the retained context', () => {
    const compressed = compressUsingDict(cctx, new Uint8Array([1, 2, 3]), dictionary, -1);
    expect(() => decompressUsingDict(dctx, compressed.subarray(0, 2), dictionary)).toThrow();
    expect([...decompressUsingDict(dctx, compressed, dictionary)]).toEqual([1, 2, 3]);
});
