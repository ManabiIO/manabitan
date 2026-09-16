/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {readFile} from 'node:fs/promises';
import {beforeAll, describe, expect, test, vi} from 'vitest';
import {
    compressUsingCDictWithPrefix,
    createCCtx,
    createCDict,
    createDCtx,
    decompressUsingDict,
    finishPreparedSpanCompressionUsingCDict,
    freeCCtx,
    freeCDict,
    freeDCtx,
    init,
    prepareSpanCompressionUsingCDict,
} from '../dev/lib/zstd-wasm.js';

vi.mock('../dev/lib/zstd-simd-module.js', async (importOriginal) => {
    const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await importOriginal());
    const wasmBinary = new Uint8Array(await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url)));
    return {default: () => create({wasmBinary})};
});

beforeAll(async () => { await init(); });

/**
 * @param {number} seed
 * @param {number} length
 * @returns {Uint8Array}
 */
function bytes(seed, length) {
    const value = new Uint8Array(length);
    for (let i = 0; i < length; ++i) { value[i] = (Math.imul(i + seed, 131) ^ (i >>> 3)) & 255; }
    return value;
}

describe('compiled Zstd dictionary reuse', () => {
    test('reuses one CDict for repeated owned frames and decodes with the raw dictionary', () => {
        const dictionary = new TextEncoder().encode('Japanese dictionary definition noun verb expression reading glossary '.repeat(20));
        const cctx = createCCtx();
        const dctx = createDCtx();
        const cdict = createCDict(dictionary, -1);
        try {
            for (let i = 0; i < 40; ++i) {
                const input = bytes(i, 500 + i * 37);
                const output = compressUsingCDictWithPrefix(cctx, input, cdict, 0, false);
                expect(decompressUsingDict(dctx, output, dictionary)).toEqual(input);
            }
        } finally {
            freeCDict(cdict);
            freeCCtx(cctx);
            freeDCtx(dctx);
        }
    });

    test('prepared span input owns source bytes before compression and preserves envelope', () => {
        const dictionary = new TextEncoder().encode('Japanese dictionary content '.repeat(40));
        const cctx = createCCtx();
        const dctx = createDCtx();
        const cdict = createCDict(dictionary, -1);
        try {
            const source = bytes(7, 9000);
            const expected = new Uint8Array(6000);
            expected.set(source.subarray(31, 3031), 0);
            expected.set(source.subarray(5000, 8000), 3000);
            const operation = prepareSpanCompressionUsingCDict(cctx, source, new Uint32Array([31, 5000]), new Uint32Array([3000, 3000]), 6000, cdict, 12, true);
            source.fill(0);
            const wrapped = finishPreparedSpanCompressionUsingCDict(operation);
            expect(wrapped.byteLength).toBeGreaterThan(12);
            expect(decompressUsingDict(dctx, wrapped.subarray(12), dictionary)).toEqual(expected);
        } finally {
            freeCDict(cdict);
            freeCCtx(cctx);
            freeDCtx(dctx);
        }
    });
});
