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

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/**
 * @param {boolean} [compressionWorker]
 * @returns {Promise<{
 * api: typeof import('../ext/js/dictionary/zstd-term-content.js'),
 * native: typeof import('../dev/lib/zstd-wasm.js'),
 * module: import('../dev/lib/zstd-simd-module.js').ZstdModule,
 * dictionary: Uint8Array,
 * }>}
 */
async function setup(compressionWorker = false) {
    const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
    const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))
    const module = await create({wasmBinary})
    state.create.mockResolvedValue(module)
    vi.doMock('../ext/lib/zstd-wasm.js', async () => await import('../dev/lib/zstd-wasm.js'))
    const dictionary = await readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url))
    vi.stubGlobal('__manabitanTermContentCompressionWorker', compressionWorker)
    vi.stubGlobal('Worker', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from(dictionary))))
    const api = await import('../ext/js/dictionary/zstd-term-content.js')
    const native = await import('../dev/lib/zstd-wasm.js')
    await api.initializeTermContentZstd()
    return {api, native, module, dictionary}
}

describe('generic term-content decoder context', () => {
    test('reuses the ordinary decoder across generic and dictionary frames while retaining owned results', async () => {
        const {api, module} = await setup()
        const oneShot = vi.spyOn(module, '_ZSTD_decompress')
        const decode = vi.spyOn(module, '_ZSTD_decompress_usingDict')
        const createDecoder = vi.spyOn(module, '_ZSTD_createDCtx')
        const encoder = new TextEncoder()
        const payloads = [
            encoder.encode('画像の人物説明 '.repeat(1024)),
            encoder.encode('日本語の辞書と読み方 '.repeat(2048)),
            encoder.encode('別の画像の人物説明 '.repeat(384)),
        ]
        const dictionaries = [null, 'jmdict', null]
        const outputs = payloads.map((payload, index) => {
            const frame = api.compressTermContentZstd(payload, dictionaries[index])
            const framedView = new Uint8Array(frame.byteLength + 19)
            framedView.set(frame, 7)
            return api.decompressTermContentZstd(framedView.subarray(7, 7 + frame.byteLength), dictionaries[index])
        })
        expect(outputs).toEqual(payloads)
        expect(oneShot).not.toHaveBeenCalled()
        expect(createDecoder).not.toHaveBeenCalled()
        expect(decode).toHaveBeenCalledTimes(3)
        expect(new Set(decode.mock.calls.map(([context]) => context)).size).toBe(1)
        expect(decode.mock.calls[0].slice(5)).toEqual([0, 0])
        expect(decode.mock.calls[1][5]).not.toBe(0)
        expect(decode.mock.calls[2].slice(5)).toEqual([0, 0])
        for (const output of outputs) {
            expect(output.buffer).not.toBe(module.HEAPU8.buffer)
        }
        const allocation = module._malloc(module.HEAPU8.byteLength)
        try {
            expect(allocation).not.toBe(0)
            module.HEAPU8.fill(42, allocation, allocation + 1024)
            expect(outputs).toEqual(payloads)
        } finally { module._free(allocation) }
    })

    test('preserves size limits and retries valid frames after decode and output allocation failures', async () => {
        const {api, module} = await setup()
        const payload = new TextEncoder().encode('復元する内容 '.repeat(512))
        const frame = api.compressTermContentZstd(payload, null)
        const decode = vi.spyOn(module, '_ZSTD_decompress_usingDict')
        const release = vi.spyOn(module, '_free')
        expect(() => api.decompressTermContentZstd(frame, null, {maxOutputSize: payload.byteLength - 1})).toThrow(/output size/)
        expect(decode).not.toHaveBeenCalled()
        expect(release).toHaveBeenCalledOnce()
        expect(() => api.decompressTermContentZstd(frame.subarray(0, -1), null)).toThrow(/Zstd operation/)
        expect(release).toHaveBeenCalledTimes(3)
        expect(api.decompressTermContentZstd(frame, null, {maxOutputSize: payload.byteLength})).toEqual(payload)
        const failure = new RangeError('Array buffer allocation failed')
        vi.spyOn(module.HEAPU8, 'slice').mockImplementationOnce(() => { throw failure })
        expect(() => api.decompressTermContentZstd(frame, null)).toThrow(failure)
        expect(release).toHaveBeenCalledTimes(7)
        expect(api.decompressTermContentZstd(frame, null)).toEqual(payload)
        expect(release).toHaveBeenCalledTimes(9)
    })

    test('does not inherit a previous raw dictionary when the next decode requests none', async () => {
        const {api, native, dictionary} = await setup()
        const payload = dictionary.subarray(256, 8192)
        const frame = api.compressTermContentZstd(payload, 'jmdict')
        expect(() => native.decompress(frame)).toThrow(/Zstd operation/)
        expect(api.decompressTermContentZstd(frame, 'jmdict')).toEqual(payload)
        expect(() => api.decompressTermContentZstd(frame, null)).toThrow(/Zstd operation/)
        expect(api.decompressTermContentZstd(frame, 'jmdict')).toEqual(payload)
        const generic = api.compressTermContentZstd(payload, null)
        expect(api.decompressTermContentZstd(generic, null)).toEqual(payload)
    })

    test.each(['zero', 'throw'])('retries lazy generic decoding after %s context allocation failure', async (failure) => {
        const {api, module} = await setup(true)
        const payload = new TextEncoder().encode('後から復元する内容 '.repeat(128))
        const frame = api.compressTermContentZstd(payload, null)
        const createDecoder = vi.spyOn(module, '_ZSTD_createDCtx')
        if (failure === 'zero') {
            createDecoder.mockReturnValueOnce(0)
        } else {
            createDecoder.mockImplementationOnce(() => { throw new Error('injected decoder allocation failure') })
        }
        expect(() => api.decompressTermContentZstd(frame, null)).toThrow(/decompression context|decoder allocation/)
        expect(api.compressTermContentZstd(payload, null)).toEqual(frame)
        expect(createDecoder).toHaveBeenCalledOnce()
        expect(api.decompressTermContentZstd(frame, null)).toEqual(payload)
        expect(api.decompressTermContentZstd(frame, null)).toEqual(payload)
        expect(createDecoder).toHaveBeenCalledTimes(2)
    })

    test('keeps the explicit one-shot adapter compatible', async () => {
        const {native, module} = await setup()
        const payload = new TextEncoder().encode('公開アダプターの互換性')
        const frame = native.compress(payload)
        const oneShot = vi.spyOn(module, '_ZSTD_decompress')
        expect(native.decompress(frame)).toEqual(payload)
        expect(oneShot).toHaveBeenCalledOnce()
    })
})
