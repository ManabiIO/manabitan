/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {beforeEach, describe, expect, test, vi} from 'vitest';

const mockState = vi.hoisted(() => ({
    createModule: vi.fn(),
}));

vi.mock('../dev/lib/zstd-simd-module.js', () => ({
    default: mockState.createModule,
}));

describe('zstd wasm wrapper', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    test('compresses into a prefixed retained buffer with a raw dictionary', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {compressUsingDictWithPrefix, freeCCtx, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        const result = compressUsingDictWithPrefix(
            17,
            new Uint8Array([1, 2, 3]),
            new Uint8Array([7, 8]),
            4,
            1,
        );

        expect([...result]).toEqual([0, 0, 0, 0, 9, 10, 11]);
        expect(module._ZSTD_compress_usingDict).toHaveBeenCalledOnce();
        const [context, destination, destinationSize, source, sourceSize, dictionary, dictionarySize, level] =
            module._ZSTD_compress_usingDict.mock.calls[0];
        expect({context, destinationSize, sourceSize, dictionarySize, level}).toEqual({
            context: 17,
            destinationSize: 64,
            sourceSize: 3,
            dictionarySize: 2,
            level: 1,
        });
        expect([...module.HEAPU8.subarray(source, source + sourceSize)]).toEqual([1, 2, 3]);
        expect([...module.HEAPU8.subarray(dictionary, dictionary + dictionarySize)]).toEqual([7, 8]);
        expect([...module.HEAPU8.subarray(destination, destination + 3)]).toEqual([9, 10, 11]);

        freeCCtx(17);
        expect(module._free).toHaveBeenCalledTimes(3);
        expect(module._ZSTD_freeCCtx).toHaveBeenCalledWith(17);
    });

    test('gathers discontiguous spans directly into the retained source buffer', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {compressSpansUsingDictWithPrefix, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        const result = compressSpansUsingDictWithPrefix(
            23,
            new Uint8Array([20, 21, 22, 23, 24]),
            new Uint32Array([1, 4]),
            new Uint32Array([2, 1]),
            3,
            new Uint8Array([30, 31]),
            2,
            1,
        );

        const source = module._ZSTD_compress_usingDict.mock.calls[0][3];
        expect([...module.HEAPU8.subarray(source, source + 3)]).toEqual([21, 22, 24]);
        expect([...result]).toEqual([0, 0, 9, 10, 11]);
    });

    test('gathers contiguous and discontiguous source runs without changing byte order', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {compressSpansUsingDictWithPrefix, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        compressSpansUsingDictWithPrefix(
            23,
            new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]),
            new Uint32Array([1, 3, 6, 7]),
            new Uint32Array([2, 2, 1, 1]),
            6,
            new Uint8Array([30, 31]),
            0,
            1,
        );

        const source = module._ZSTD_compress_usingDict.mock.calls[0][3];
        expect([...module.HEAPU8.subarray(source, source + 6)]).toEqual([11, 12, 13, 14, 16, 17]);
    });

    test('writes a native integrity envelope before copying compressed bytes', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {compressUsingDictWithPrefix, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        const result = compressUsingDictWithPrefix(
            17,
            new Uint8Array([1, 2, 3]),
            new Uint8Array([7, 8]),
            12,
            1,
            true,
        );

        expect(module._manabitan_write_block_envelope).toHaveBeenCalledOnce();
        expect([...result.subarray(0, 4)]).toEqual([0x4d, 0x42, 0x43, 0x32]);
        expect([...result.subarray(12)]).toEqual([9, 10, 11]);
    });

    test('rejects native integrity envelopes with the wrong prefix size', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {compressUsingDictWithPrefix, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        expect(() => compressUsingDictWithPrefix(
            17,
            new Uint8Array([1]),
            new Uint8Array([2]),
            4,
            1,
            true,
        )).toThrow('requires a 12-byte prefix');
        expect(module._manabitan_write_block_envelope).not.toHaveBeenCalled();
    });

    test('releases a plain-compression source when destination allocation fails', async () => {
        const module = createMockModule({allocations: [16, 0]});
        mockState.createModule.mockResolvedValue(module);
        const {compress, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        expect(() => compress(new Uint8Array([1, 2, 3]))).toThrow('destination buffer');
        expect(module._free).toHaveBeenCalledOnce();
        expect(module._free).toHaveBeenCalledWith(16);
    });

    test('releases decompression buffers when dictionary allocation fails', async () => {
        const module = createMockModule({allocations: [16, 40, 0]});
        mockState.createModule.mockResolvedValue(module);
        const {decompressUsingDict, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        expect(() => decompressUsingDict(29, new Uint8Array([1, 2]), new Uint8Array([3]))).toThrow('dictionary buffer');
        expect(module._free.mock.calls.map(([pointer]) => pointer)).toEqual([40, 16]);
    });

    test('can retry a retained context after a growth allocation fails', async () => {
        const module = createMockModule({allocations: [16, 80, 160, 0, 240]});
        mockState.createModule.mockResolvedValue(module);
        const {compressUsingDict, init} = await import('../dev/lib/zstd-wasm.js');
        await init();

        expect(compressUsingDict(31, new Uint8Array(2), new Uint8Array([1]), 1)).toHaveLength(3);
        expect(() => compressUsingDict(31, new Uint8Array(65), new Uint8Array([1]), 1)).toThrow('source buffer');
        expect(compressUsingDict(31, new Uint8Array(2), new Uint8Array([1]), 1)).toHaveLength(3);
        expect(module._malloc).toHaveBeenCalledTimes(5);
    });
});

/**
 * @param {{allocations?: number[]}} [options]
 * @returns {import('core').SafeAny}
 */
function createMockModule({allocations = []} = {}) {
    const heap = new Uint8Array(4096);
    let nextPointer = 512;
    const allocationQueue = [...allocations];
    const malloc = vi.fn((size) => {
        if (allocationQueue.length > 0) { return allocationQueue.shift(); }
        const pointer = nextPointer;
        nextPointer += Math.max(size, 1) + 16;
        return pointer;
    });
    return {
        HEAPU8: heap,
        _free: vi.fn(),
        _malloc: malloc,
        _ZSTD_compress: vi.fn((destination) => {
            heap.set([9, 10, 11], destination);
            return 3;
        }),
        _ZSTD_compressBound: vi.fn(() => 64),
        _ZSTD_compress_usingDict: vi.fn((context, destination) => {
            heap.set([9, 10, 11], destination);
            return 3;
        }),
        _ZSTD_createCCtx: vi.fn(() => 17),
        _ZSTD_createDCtx: vi.fn(() => 19),
        _ZSTD_decompress: vi.fn(() => 0),
        _ZSTD_decompress_usingDict: vi.fn(() => 0),
        _ZSTD_freeCCtx: vi.fn(() => 0),
        _ZSTD_freeDCtx: vi.fn(() => 0),
        _ZSTD_getFrameContentSize: vi.fn(() => 3),
        _ZSTD_isError: vi.fn(() => 0),
        _manabitan_write_block_envelope: vi.fn((destination, length) => {
            if (length <= 12) { return 0; }
            heap.set([0x4d, 0x42, 0x43, 0x32], destination);
            return 1;
        }),
    };
}
