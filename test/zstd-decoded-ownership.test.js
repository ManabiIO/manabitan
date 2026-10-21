/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

const state = vi.hoisted(() => ({create: vi.fn()}))
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

afterEach(() => { vi.restoreAllMocks() })

/**
 * @returns {Promise<{api: typeof import('../dev/lib/zstd-wasm.js'), module: import('../dev/lib/zstd-simd-module.js').ZstdModule}>}
 */
async function setup() {
    const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
    const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))
    const module = await create({wasmBinary})
    state.create.mockResolvedValue(module)
    const api = await import('../dev/lib/zstd-wasm.js')
    await api.init()
    return {api, module}
}

describe('decoded Zstd output ownership', () => {
    test.each([false, true])('releases decode buffers and retries after owned-output allocation failure (dictionary=%s)', async (useDictionary) => {
        const {api, module} = await setup()
        const cctx = api.createCCtx()
        const dctx = api.createDCtx()
        const payload = new TextEncoder().encode('再試行できる説明 '.repeat(64))
        const dictionary = new TextEncoder().encode('説明 dictionary content that remains healthy after allocation failure')
        try {
            const compressed = useDictionary ? api.compressUsingDict(cctx, payload, dictionary) : api.compress(payload)
            const decode = () => (useDictionary ? api.decompressUsingDict(dctx, compressed, dictionary) : api.decompress(compressed))
            const release = vi.spyOn(module, '_free')
            const failure = new RangeError('Array buffer allocation failed')
            vi.spyOn(module.HEAPU8, 'slice').mockImplementationOnce(() => { throw failure })
            expect(decode).toThrow(failure)
            expect(release).toHaveBeenCalledTimes(useDictionary ? 3 : 2)
            expect(new Set(release.mock.calls.map(([pointer]) => pointer)).size).toBe(useDictionary ? 3 : 2)
            expect(decode()).toEqual(payload)
            expect(release).toHaveBeenCalledTimes(useDictionary ? 6 : 4)
        } finally {
            api.freeCCtx(cctx)
            api.freeDCtx(dctx)
        }
    })

    test.each([false, true])('retains independent bytes across decode, encode and heap growth (dictionary=%s)', async (useDictionary) => {
        const {api, module} = await setup()
        const cctx = api.createCCtx()
        const dctx = api.createDCtx()
        const dictionary = new TextEncoder().encode('dictionary words for retained definitions and independent decoded content')
        const first = new TextEncoder().encode('最初の説明 '.repeat(128))
        const second = new TextEncoder().encode('異なる説明と独立した内容 '.repeat(192))
        let allocation = 0
        try {
            const compressedFirst = useDictionary ? api.compressUsingDict(cctx, first, dictionary) : api.compress(first)
            const decodedFirst = useDictionary ? api.decompressUsingDict(dctx, compressedFirst, dictionary) : api.decompress(compressedFirst)
            expect(decodedFirst).toEqual(first)
            expect(decodedFirst.buffer).not.toBe(module.HEAPU8.buffer)
            const compressedSecond = useDictionary ? api.compressUsingDict(cctx, second, dictionary) : api.compress(second)
            const decodedSecond = useDictionary ? api.decompressUsingDict(dctx, compressedSecond, dictionary) : api.decompress(compressedSecond)
            expect(decodedSecond).toEqual(second)
            expect(decodedSecond.buffer).not.toBe(decodedFirst.buffer)
            expect(decodedFirst).toEqual(first)
            const heapBefore = module.HEAPU8.buffer
            allocation = module._malloc(module.HEAPU8.byteLength)
            expect(allocation).not.toBe(0)
            expect(module.HEAPU8.buffer).not.toBe(heapBefore)
            module.HEAPU8.fill(71, allocation, allocation + 4096)
            expect(decodedFirst).toEqual(first)
            expect(decodedSecond).toEqual(second)
        } finally {
            if (allocation !== 0) { module._free(allocation) }
            api.freeCCtx(cctx)
            api.freeDCtx(dctx)
        }
    })
})
