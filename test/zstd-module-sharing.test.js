/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/** @returns {Promise<Uint8Array<ArrayBuffer>>} */
async function loadWasm() {
    return Uint8Array.from(await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url)))
}

describe('sharing compiled Zstd code', () => {
    test('retains streaming compilation once and instantiates a private codec without fetching again', async () => {
        const wasm = await loadWasm()
        const fetchAsset = vi.fn(async () => new Response(wasm, {headers: {'Content-Type': 'application/wasm'}}))
        vi.stubGlobal('fetch', fetchAsset)
        const parent = await import('../dev/lib/zstd-wasm.js')
        const [module, sameModule] = await Promise.all([parent.init('/codec.wasm'), parent.init('/codec.wasm')])
        expect(module).toBeInstanceOf(WebAssembly.Module)
        expect(module).toBe(sameModule)
        expect(fetchAsset).toHaveBeenCalledExactlyOnceWith('/codec.wasm', {credentials: 'same-origin'})
        if (module === null) { throw new Error('Native initialization did not capture compiled code') }
        vi.resetModules()
        const worker = await import('../dev/lib/zstd-wasm.js')
        await expect(worker.init('/must-not-fetch.wasm', module)).resolves.toBe(module)
        expect(fetchAsset).toHaveBeenCalledOnce()
        const source = new TextEncoder().encode('辞書の定義を安全に読み込む'.repeat(2_000))
        const expected = parent.compress(source, 1)
        const compressed = worker.compress(source, 1)
        expect(compressed).toEqual(expected)
        worker.compress(Uint8Array.of(3, 2, 1), 1)
        expect(parent.decompress(expected)).toEqual(source)
        expect(worker.decompress(compressed)).toEqual(source)
    })

    test('falls back from a non-WASM MIME type without fetching the asset twice', async () => {
        const wasm = await loadWasm()
        const fetchAsset = vi.fn(async () => new Response(wasm, {headers: {'Content-Type': 'application/octet-stream'}}))
        vi.stubGlobal('fetch', fetchAsset)
        const api = await import('../dev/lib/zstd-wasm.js')
        await expect(api.init('/codec.wasm')).resolves.toBeInstanceOf(WebAssembly.Module)
        expect(fetchAsset).toHaveBeenCalledOnce()
    })

    test.each(['http', 'invalid-wasm', 'invalid-shared-module'])('settles %s initialization failures and allows a retry', async (failure) => {
        const wasm = await loadWasm()
        let fail = true
        const fetchAsset = vi.fn(async () => {
            if (fail && failure === 'http') { return new Response(null, {status: 503}) }
            return new Response(fail ? Uint8Array.of(1, 2, 3) : wasm, {headers: {'Content-Type': 'application/wasm'}})
        })
        vi.stubGlobal('fetch', fetchAsset)
        const api = await import('../dev/lib/zstd-wasm.js')
        const invalidModule = failure === 'invalid-shared-module' ? /** @type {WebAssembly.Module} */ ({}) : undefined
        await expect(api.init('/codec.wasm', invalidModule)).rejects.toThrow()
        expect(fetchAsset).toHaveBeenCalledTimes(failure === 'invalid-shared-module' ? 0 : 1)
        fail = false
        await expect(api.init('/codec.wasm')).resolves.toBeInstanceOf(WebAssembly.Module)
        const source = Uint8Array.of(1, 3, 5, 7)
        expect(api.decompress(api.compress(source, 1))).toEqual(source)
    })
})
