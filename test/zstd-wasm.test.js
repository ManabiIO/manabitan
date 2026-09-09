/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs/promises';

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

    test.each(Array.from({length: 8}, (_, index) => index))('owns exact gathered bytes for source alignment %i and every destination alignment', async (sourceAlignment) => {
        for (const shared of [false, true]) {
            for (let destinationAlignment = 0; destinationAlignment < 8; ++destinationAlignment) {
                const module = createMockModule({heap: new Uint8Array(65536), allocations: [512 + destinationAlignment, 40000, 41000]});
                module.HEAPU8.fill(165);
                mockState.createModule.mockResolvedValue(module);
                vi.resetModules();
                const {init, prepareSpanCompression} = await import('../dev/lib/zstd-wasm.js');
                await init();
                const backing = shared ? new SharedArrayBuffer(20000) : new ArrayBuffer(20000);
                const source = new Uint8Array(backing, 16 + sourceAlignment, 19000);
                for (let i = 0; i < source.length; ++i) { source[i] = (i * 131 + Math.floor(i / 256)) & 255; }
                const offsets = new Uint32Array([3, 4, 9, 1032, 2056, 4000, 12200]);
                const lengths = new Uint32Array([1, 2, 1023, 1024, 1025, 8193, 0]);
                const expected = Uint8Array.from([...offsets].flatMap((offset, i) => [...source.subarray(offset, offset + lengths[i])]));
                const before = Uint8Array.from(source);
                const prepared = prepareSpanCompression(23, source, offsets, lengths, expected.length, new Uint8Array([30, 31]), 12, 1, true);
                const start = prepared.buffers.source;
                expect(module.HEAPU8.subarray(start, start + expected.length)).toEqual(expected);
                expect(source).toEqual(before);
                expect(module.HEAPU8[start - 1]).toBe(165);
                expect(module.HEAPU8[start + expected.length]).toBe(165);
                expect(module._malloc).toHaveBeenNthCalledWith(1, expected.length);
                expect(module._malloc).toHaveBeenNthCalledWith(2, 76);
                expect(module._malloc).toHaveBeenNthCalledWith(3, 2);
                source.fill(0);
                expect(module.HEAPU8.subarray(start, start + expected.length)).toEqual(expected);
                expect(module._ZSTD_compress_usingDict).not.toHaveBeenCalled();
            }
        }
    });

    test('keeps shared-destination gathers on the ordinary set path', async () => {
        const module = createMockModule({heap: new Uint8Array(new SharedArrayBuffer(16384))});
        const copyWithin = vi.spyOn(module.HEAPU8, 'copyWithin');
        mockState.createModule.mockResolvedValue(module);
        const {init, prepareSpanCompression} = await import('../dev/lib/zstd-wasm.js');
        await init();
        const source = new Uint8Array(new SharedArrayBuffer(4100), 1, 4097);
        source.fill(57);
        const prepared = prepareSpanCompression(23, source, new Uint32Array([0]), new Uint32Array([4097]), 4097, new Uint8Array(), 0);
        expect(module.HEAPU8.subarray(prepared.buffers.source, prepared.buffers.source + 4097)).toEqual(Uint8Array.from(source));
        expect(copyWithin).not.toHaveBeenCalled();
    });

    test('handles a nonzero destination view offset without touching its guards', async () => {
        const heap = new Uint8Array(new ArrayBuffer(16384), 3, 16000);
        heap.fill(165);
        const copyWithin = vi.spyOn(heap, 'copyWithin');
        const module = createMockModule({heap});
        mockState.createModule.mockResolvedValue(module);
        const {init, prepareSpanCompression} = await import('../dev/lib/zstd-wasm.js');
        await init();
        const source = new Uint8Array(new SharedArrayBuffer(4100), 1, 4097);
        for (let i = 0; i < source.length; ++i) { source[i] = i & 255; }
        const prepared = prepareSpanCompression(23, source, new Uint32Array([0]), new Uint32Array([4097]), 4097, new Uint8Array(), 0);
        const start = prepared.buffers.source;
        expect(copyWithin).toHaveBeenCalledOnce();
        expect(heap.subarray(start, start + 4097)).toEqual(Uint8Array.from(source));
        expect(heap[start - 1]).toBe(165);
        expect(heap[start + 4097]).toBe(165);
    });

    test('rejects malformed large shared spans before compression', async () => {
        const module = createMockModule({heap: new Uint8Array(16384)});
        mockState.createModule.mockResolvedValue(module);
        const {compressSpansUsingDictWithPrefix, init} = await import('../dev/lib/zstd-wasm.js');
        await init();
        const source = new Uint8Array(new SharedArrayBuffer(4100), 1, 4097);
        /** @type {Array<[number[], number[], number]>} */
        const cases = [
            [[0], [], 4097],
            [[4098], [0], 0],
            [[1], [4097], 4097],
            [[0], [4097], 4096],
            [[0], [4096], 4097],
            [[0], [1], -1],
        ];
        for (const [offsets, lengths, contentBytes] of cases) {
            expect(() => compressSpansUsingDictWithPrefix(23, source, new Uint32Array(offsets), new Uint32Array(lengths), contentBytes, new Uint8Array(), 0)).toThrow(RangeError);
        }
        expect(module._ZSTD_compress_usingDict).not.toHaveBeenCalled();
    });

    test('preserves real compressed bytes and envelopes after shared source release', async () => {
        const {default: createZstdModule} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'));
        const wasmBinary = await fs.readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url));
        const module = await createZstdModule({wasmBinary});
        mockState.createModule.mockResolvedValue(module);
        const api = await import('../dev/lib/zstd-wasm.js');
        await api.init();
        const ordinaryContext = api.createCCtx();
        const sharedContext = api.createCCtx();
        const decodeContext = api.createDCtx();
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
        try {
            for (const dictionary of [new Uint8Array(), new TextEncoder().encode('Japanese dictionary term content dictionary dictionary')]) {
                for (let alignment = 0; alignment < 8; ++alignment) {
                    for (const length of [1023, 1024, 8193]) {
                        const source = new Uint8Array(memory.buffer, alignment, 2 * length + 2000);
                        for (let i = 0; i < source.length; ++i) { source[i] = (i * 131 + Math.floor(i / 256)) & 255; }
                        const offsets = new Uint32Array([3, 4, 25, 25 + length, 2 * length + 40]);
                        const lengths = new Uint32Array([1, 2, length, 2, 1025]);
                        const expected = Uint8Array.from([...offsets].flatMap((offset, i) => [...source.subarray(offset, offset + lengths[i])]));
                        const baseline = api.compressUsingDictWithPrefix(ordinaryContext, expected, dictionary, 12, 1, true);
                        const prepared = api.prepareSpanCompression(sharedContext, source, offsets, lengths, expected.length, dictionary, 12, 1, true);
                        source.fill(0);
                        if (dictionary.length === 0 && alignment === 0 && length === 8193) { memory.grow(1); }
                        const candidate = api.finishPreparedSpanCompression(prepared);
                        expect(candidate).toEqual(baseline);
                        expect(api.decompressUsingDict(decodeContext, candidate.subarray(12), dictionary)).toEqual(expected);
                    }
                }
            }
        } finally {
            api.freeCCtx(ordinaryContext);
            api.freeCCtx(sharedContext);
            api.freeDCtx(decodeContext);
        }
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

    test('can release span sources before finishing prepared compression', async () => {
        const module = createMockModule();
        mockState.createModule.mockResolvedValue(module);
        const {finishPreparedSpanCompression, init, prepareSpanCompression} = await import('../dev/lib/zstd-wasm.js');
        await init();
        const sourceBytes = new Uint8Array([20, 21, 22, 23, 24]);

        const prepared = prepareSpanCompression(
            23,
            sourceBytes,
            new Uint32Array([1, 4]),
            new Uint32Array([2, 1]),
            3,
            new Uint8Array([30, 31]),
            2,
            1,
        );
        sourceBytes.fill(0);
        const result = finishPreparedSpanCompression(prepared);

        const compressedSource = module._ZSTD_compress_usingDict.mock.calls[0][3];
        expect([...module.HEAPU8.subarray(compressedSource, compressedSource + 3)]).toEqual([21, 22, 24]);
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
        expect(module._free.mock.calls.map(
            /**
             * @param {[number]} args
             * @returns {number}
             */
            ([pointer]) => pointer,
        )).toEqual([40, 16]);
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
 * @param {{allocations?: number[], heap?: Uint8Array}} [options]
 * @returns {import('core').SafeAny}
 */
function createMockModule({allocations = [], heap = new Uint8Array(4096)} = {}) {
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
