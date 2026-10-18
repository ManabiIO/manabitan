/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeEach, describe, expect, test, vi} from 'vitest'

const state = vi.hoisted(() => ({create: vi.fn()}))
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}))

/** @typedef {typeof import('../dev/lib/zstd-wasm.js')} API */

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

/**
 * @param {Uint8Array} heap
 * @returns {import('core').SafeAny}
 */
function fakeModule(heap) {
    return {
        HEAPU8: heap,
        _malloc: vi.fn(),
        _free: vi.fn(),
        _ZSTD_compressBound: vi.fn(() => 64),
        _ZSTD_compress_usingDict: vi.fn(() => 0),
        _ZSTD_isError: vi.fn(() => 0),
        _ZSTD_freeCCtx: vi.fn(() => 0),
    }
}

/**
 * @param {Uint8Array} bytes
 */
function fillInput(bytes) {
    for (let i = 0; i < bytes.length; ++i) { bytes[i] = (Math.imul(i, 131) + (i >>> 8)) & 255 }
}

/**
 * Independent per-byte gather oracle; no candidate helper or word views.
 * @param {Uint8Array} source
 * @param {number[]} offsets
 * @param {number[]} lengths
 * @returns {Uint8Array}
 */
function gatherOracle(source, offsets, lengths) {
    const output = new Uint8Array(lengths.reduce((sum, n) => sum + n, 0))
    let cursor = 0
    for (let i = 0; i < offsets.length; ++i) {
        for (let j = 0; j < lengths[i]; ++j) { output[cursor++] = source[offsets[i] + j] }
    }
    return output
}

/**
 * Compare every byte, not sampled positions or a digest.
 * @param {Uint8Array} actual
 * @param {Uint8Array} expected
 */
function equalBytes(actual, expected) {
    expect(actual.byteLength).toBe(expected.byteLength)
    expect(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength))).toBe(0)
}

describe('stable shared spans gathered into compression memory', () => {
    test.each(Array.from({length: 8}, (_, i) => i))('preserves every byte and both guards at source alignment %i', async (sourceAlignment) => {
        const heap = new Uint8Array(new ArrayBuffer(300000), 3, 299990)
        const module = fakeModule(heap)
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        for (const shared of [false, true]) {
            for (let destinationAlignment = 0; destinationAlignment < 8; ++destinationAlignment) {
                for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 255, 1023, 1024, 1025, 1030, 1031, 1032, 8193, 65537]) {
                    const buffer = shared ? new SharedArrayBuffer(length + 64) : new ArrayBuffer(length + 64)
                    const source = new Uint8Array(buffer, sourceAlignment + 7, length + 16)
                    fillInput(source)
                    const before = Uint8Array.from(source)
                    const expected = gatherOracle(source, [5], [length])
                    heap.fill(165)
                    const allocations = length === 0 ? [512, 1024] : [131072 + destinationAlignment, 512, 1024]
                    module._malloc.mockImplementation(() => allocations.shift())
                    const prepared = api.prepareSpanCompression(23, source, new Uint32Array([5]), new Uint32Array([length]), length, new Uint8Array([31, 32]), 12)
                    const start = prepared.buffers.source
                    equalBytes(heap.subarray(start, start + length), expected)
                    equalBytes(source, before)
                    if (length > 0) {
                        equalBytes(heap.subarray(start - 16, start), new Uint8Array(16).fill(165))
                        equalBytes(heap.subarray(start + length, start + length + 16), new Uint8Array(16).fill(165))
                    }
                    source.fill(0)
                    equalBytes(heap.subarray(start, start + length), expected)
                    expect(module._ZSTD_compress_usingDict).not.toHaveBeenCalled()
                    api.freeCCtx(23)
                }
            }
        }
    })

    test('preserves ordering across contiguous, reversed, gapped, repeated and empty spans', async () => {
        const heap = new Uint8Array(40000)
        const module = fakeModule(heap)
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const source = new Uint8Array(new SharedArrayBuffer(17000), 3, 16000)
        fillInput(source)
        const offsets = [7, 8, 1032, 3099, 3100, 0, 15000, 8, 8201, 8202]
        const lengths = [1, 1024, 1025, 0, 4099, 1024, 0, 4097, 1, 17]
        const expected = gatherOracle(source, offsets, lengths)
        heap.fill(165)
        const allocations = [4099, 512, 1024]
        module._malloc.mockImplementation(() => allocations.shift())
        const prepared = api.prepareSpanCompression(23, source, new Uint32Array(offsets), new Uint32Array(lengths), expected.length, new Uint8Array([42]), 12)
        equalBytes(heap.subarray(prepared.buffers.source, prepared.buffers.source + expected.length), expected)
        expect(heap[prepared.buffers.source - 1]).toBe(165)
        expect(heap[prepared.buffers.source + expected.length]).toBe(165)
        source.fill(0)
        equalBytes(heap.subarray(prepared.buffers.source, prepared.buffers.source + expected.length), expected)
    })

    test('bounds each source and destination word at actual backing-buffer ends', async () => {
        for (let alignment = 0; alignment < 8; ++alignment) {
            for (const length of [1024, 1025, 1031, 8193]) {
                vi.resetModules()
                const heap = new Uint8Array(2048 + alignment + length)
                const module = fakeModule(heap)
                const allocations = [2048 + alignment, 512]
                module._malloc.mockImplementation(() => allocations.shift())
                state.create.mockResolvedValue(module)
                const api = await import('../dev/lib/zstd-wasm.js')
                await api.init()
                const source = new Uint8Array(new SharedArrayBuffer(alignment + length), alignment, length)
                fillInput(source)
                heap.fill(165)
                const expected = Uint8Array.from(source)
                const prepared = api.prepareSpanCompression(23, source, new Uint32Array([0]), new Uint32Array([length]), length, new Uint8Array(), 0)
                equalBytes(heap.subarray(prepared.buffers.source), expected)
                expect(heap[prepared.buffers.source - 1]).toBe(165)
            }
        }
    })

    test('keeps shared destinations and ordinary overlapping source on the original copy path', async () => {
        for (const shared of [false, true]) {
            vi.resetModules()
            const heap = new Uint8Array(shared ? new SharedArrayBuffer(16000) : new ArrayBuffer(16000))
            fillInput(heap)
            const source = heap.subarray(4099, 8198)
            const expected = Uint8Array.from(source)
            const module = fakeModule(heap)
            const allocations = [4101, 512]
            module._malloc.mockImplementation(() => allocations.shift())
            state.create.mockResolvedValue(module)
            const api = await import('../dev/lib/zstd-wasm.js')
            await api.init()
            const prepared = api.prepareSpanCompression(23, source, new Uint32Array([0]), new Uint32Array([source.length]), source.length, new Uint8Array(), 0)
            equalBytes(heap.subarray(prepared.buffers.source, prepared.buffers.source + source.length), expected)
        }
    })

    test('refreshes destination memory after allocation and accepts grown shared WASM sources', async () => {
        const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true})
        const source = new Uint8Array(memory.buffer, 5, 8193)
        fillInput(source)
        const expected = Uint8Array.from(source)
        memory.grow(1)
        const module = fakeModule(new Uint8Array(1000))
        const heap = new Uint8Array(20000)
        heap.fill(165)
        let calls = 0
        module._malloc.mockImplementation(() => {
            if (++calls === 1) { return 4097 }
            module.HEAPU8 = heap
            return 512
        })
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const prepared = api.prepareSpanCompression(23, source, new Uint32Array([0]), new Uint32Array([source.length]), source.length, new Uint8Array(), 0)
        source.fill(0)
        equalBytes(heap.subarray(prepared.buffers.source, prepared.buffers.source + expected.length), expected)
        expect(heap[prepared.buffers.source + expected.length]).toBe(165)
    })

    test('preserves rejection of invalid metadata before compression', async () => {
        const module = fakeModule(new Uint8Array(20000))
        module._malloc.mockReturnValue(4096)
        state.create.mockResolvedValue(module)
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const source = new Uint8Array(new SharedArrayBuffer(4097))
        /** @type {Array<[number[], number[], number]>} */
        const cases = [[[0], [], 4097], [[1], [4097], 4097], [[4098], [0], 0], [[0], [4097], 4096], [[0], [4096], 4097], [[0], [4097], -1], [[0], [4097], Number.MAX_SAFE_INTEGER + 1]]
        for (const [offsets, lengths, size] of cases) {
            expect(() => api.prepareSpanCompression(23, source, new Uint32Array(offsets), new Uint32Array(lengths), size, new Uint8Array(), 0)).toThrow(RangeError)
        }
        expect(module._ZSTD_compress_usingDict).not.toHaveBeenCalled()
    })

    test('preserves actual compressed frames, dictionaries, envelopes and decompressed bytes after release', async () => {
        const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
        const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))
        state.create.mockResolvedValue(await create({wasmBinary}))
        const api = await import('../dev/lib/zstd-wasm.js')
        await api.init()
        const ordinary = api.createCCtx()
        const shared = api.createCCtx()
        const decode = api.createDCtx()
        try {
            for (const dictionary of [new Uint8Array(), new TextEncoder().encode('Japanese definition noun adjective content dictionary')]) {
                for (let alignment = 0; alignment < 8; ++alignment) {
                    for (const length of [1023, 1024, 1025, 8193, 65537]) {
                        const source = new Uint8Array(new SharedArrayBuffer(2 * length + 3000), alignment, 2 * length + 2000)
                        fillInput(source)
                        const offsets = [3, 4, 25, length + 25, 2 * length + 40]
                        const lengths = [1, 2, length, 2, 1025]
                        const expected = gatherOracle(source, offsets, lengths)
                        const before = api.compressUsingDictWithPrefix(ordinary, expected, dictionary, 12, 1, true)
                        const prepared = api.prepareSpanCompression(shared, source, new Uint32Array(offsets), new Uint32Array(lengths), expected.length, dictionary, 12, 1, true)
                        source.fill(0)
                        const after = api.finishPreparedSpanCompression(prepared)
                        equalBytes(after, before)
                        equalBytes(api.decompressUsingDict(decode, after.subarray(12), dictionary), expected)
                    }
                }
            }
        } finally {
            api.freeCCtx(ordinary)
            api.freeCCtx(shared)
            api.freeDCtx(decode)
        }
    })
})
