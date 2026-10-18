/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeEach, describe, expect, test, vi} from 'vitest'

const state = vi.hoisted(() => ({create: vi.fn()}))
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

/**
 * @returns {Promise<{api: typeof import('../dev/lib/zstd-wasm.js'), module: import('./../dev/lib/zstd-simd-module.js').ZstdModule}>}
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

/**
 * @param {typeof import('../dev/lib/zstd-wasm.js')} api
 * @param {number} context
 * @param {Uint8Array} source
 * @returns {ReturnType<typeof import('../dev/lib/zstd-wasm.js').prepareSpanCompression>}
 */
function prepare(api, context, source) {
    return api.prepareSpanCompression(context, source, new Uint32Array([0]), new Uint32Array([source.length]), source.length, new Uint8Array(), 0)
}

const first = new TextEncoder().encode('first first first first first first first first first first first first')
const second = new TextEncoder().encode('SECOND SECOND SECOND SECOND SECOND SECOND SECOND SECOND SECOND SECOND')

describe('prepared Zstd buffer lifetime', () => {
    test.each([false, true])('rejects superseded input before native compression (growth=%s)', async (growth) => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const stale = prepare(api, context, first)
            const currentBytes = growth ? new Uint8Array(8193).fill(71) : second.subarray(0, first.length)
            const current = prepare(api, context, currentBytes)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression(stale)).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
            const compressed = api.finishPreparedSpanCompression(current)
            expect(api.decompress(compressed)).toEqual(currentBytes)
        } finally { api.freeCCtx(context) }
    })

    test('rejects a prepared handle after ordinary context compression overwrites its input', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const stale = prepare(api, context, first)
            const compressed = api.compressUsingDict(context, second, new Uint8Array())
            expect(api.decompress(compressed)).toEqual(second)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression(stale)).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
        } finally { api.freeCCtx(context) }
    })

    test('invalidates old input even when a replacement fails after partially copying', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const stale = prepare(api, context, first)
            expect(() => api.prepareSpanCompression(context, second, new Uint32Array([0, second.length + 1]), new Uint32Array([2, 1]), 3, new Uint8Array(), 0)).toThrow(RangeError)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression(stale)).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
            const current = prepare(api, context, first)
            expect(api.decompress(api.finishPreparedSpanCompression(current))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('invalidates old pointers when a replacement allocation fails, then permits recovery', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const stale = prepare(api, context, first)
            const malloc = vi.spyOn(module, '_malloc').mockReturnValueOnce(0)
            expect(() => prepare(api, context, new Uint8Array(8193))).toThrow('source buffer')
            malloc.mockRestore()
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression(stale)).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
            expect(api.decompress(api.finishPreparedSpanCompression(prepare(api, context, second)))).toEqual(second)
        } finally { api.freeCCtx(context) }
    })

    test('consumes a prepared handle once, while the returned result stays independently owned', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = prepare(api, context, first)
            const compressed = api.finishPreparedSpanCompression(prepared)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
            api.compressUsingDict(context, second, new Uint8Array())
            expect(api.decompress(compressed)).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('a failed native compression consumes the handle instead of allowing an unsafe retry', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = prepare(api, context, first)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict').mockImplementationOnce(() => { throw new Error('injected native failure') })
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow('injected native failure')
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow(/no longer active/)
            expect(native).toHaveBeenCalledOnce()
            expect(api.decompress(api.finishPreparedSpanCompression(prepare(api, context, first)))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('a native error result consumes the handle', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = prepare(api, context, first)
            vi.spyOn(module, '_ZSTD_isError').mockReturnValueOnce(1)
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow('Zstd operation failed')
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow(/no longer active/)
            expect(api.decompress(api.finishPreparedSpanCompression(prepare(api, context, first)))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('a failed integrity envelope consumes the handle', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = api.prepareSpanCompression(context, first, new Uint32Array([0]), new Uint32Array([first.length]), first.length, new Uint8Array(), 12, 1, true)
            vi.spyOn(module, '_manabitan_write_block_envelope').mockReturnValueOnce(0)
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow('integrity envelope')
            expect(() => api.finishPreparedSpanCompression(prepared)).toThrow(/no longer active/)
            expect(api.decompress(api.finishPreparedSpanCompression(prepare(api, context, first)))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('an invalid request rejected before touching retained buffers does not destroy a valid handle', async () => {
        const {api} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = prepare(api, context, first)
            expect(() => api.prepareSpanCompression(context, second, new Uint32Array([0]), new Uint32Array(), second.length, new Uint8Array(), 0)).toThrow(RangeError)
            expect(api.decompress(api.finishPreparedSpanCompression(prepared))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('a copied handle is not the active operation and cannot consume it', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        try {
            const prepared = prepare(api, context, first)
            const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
            expect(() => api.finishPreparedSpanCompression({...prepared})).toThrow(/no longer active/)
            expect(native).not.toHaveBeenCalled()
            expect(api.decompress(api.finishPreparedSpanCompression(prepared))).toEqual(first)
        } finally { api.freeCCtx(context) }
    })

    test('independent contexts can finish in either order and survive shared module heap growth', async () => {
        const {api} = await setup()
        const a = api.createCCtx()
        const b = api.createCCtx()
        try {
            const before = prepare(api, a, first)
            const large = new Uint8Array(4 * 1024 * 1024).fill(91)
            const after = prepare(api, b, large)
            expect(Buffer.compare(Buffer.from(api.decompress(api.finishPreparedSpanCompression(after))), Buffer.from(large))).toBe(0)
            expect(api.decompress(api.finishPreparedSpanCompression(before))).toEqual(first)
        } finally { api.freeCCtx(a); api.freeCCtx(b) }
    })

    test('rejects a freed context handle without calling the native compressor', async () => {
        const {api, module} = await setup()
        const context = api.createCCtx()
        const stale = prepare(api, context, first)
        api.freeCCtx(context)
        const native = vi.spyOn(module, '_ZSTD_compress_usingDict')
        expect(() => api.finishPreparedSpanCompression(stale)).toThrow(/no longer active/)
        expect(native).not.toHaveBeenCalled()
    })
})
