/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const zstd = vi.hoisted(() => ({
    createCCtx: vi.fn(),
    createDCtx: vi.fn(),
    freeCCtx: vi.fn(),
    freeDCtx: vi.fn(),
    init: vi.fn(async () => {}),
}));

vi.mock('../ext/lib/zstd-wasm.js', () => ({
    ...zstd,
    compress: vi.fn(),
    compressUsingDict: vi.fn(),
    decompress: vi.fn(),
    decompressUsingDict: vi.fn(),
}));

describe('term content zstd initialization', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('does not allocate native contexts before dictionary loading succeeds', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 503})));
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('503');
        expect(zstd.createCCtx).not.toHaveBeenCalled();
        expect(zstd.createDCtx).not.toHaveBeenCalled();
    });

    test('rejects an empty dictionary before allocating native contexts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array())));
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('dictionary is empty');
        expect(zstd.createCCtx).not.toHaveBeenCalled();
        expect(zstd.createDCtx).not.toHaveBeenCalled();
    });

    test('frees a partial allocation and permits a clean retry', async () => {
        zstd.createCCtx.mockReturnValueOnce(11).mockReturnValueOnce(12);
        zstd.createDCtx.mockReturnValueOnce(0).mockReturnValueOnce(22);
        const {initializeTermContentZstd} = await import('../ext/js/dictionary/zstd-term-content.js');

        await expect(initializeTermContentZstd()).rejects.toThrow('decompression context');
        expect(zstd.freeCCtx).toHaveBeenCalledOnce();
        expect(zstd.freeCCtx).toHaveBeenCalledWith(11);

        await expect(initializeTermContentZstd()).resolves.toBeUndefined();
        expect(zstd.createCCtx).toHaveBeenCalledTimes(2);
        expect(zstd.createDCtx).toHaveBeenCalledTimes(2);
        expect(zstd.freeCCtx).toHaveBeenCalledTimes(1);
    });
});
