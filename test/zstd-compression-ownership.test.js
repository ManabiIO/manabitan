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

describe('plain Zstd compression buffer ownership', () => {
    test.each(['copy', 'compress', 'output'])('releases both allocations after %s failure and permits recovery', async (stage) => {
        const {api, module} = await setup()
        const payload = new TextEncoder().encode('失敗した圧縮から復旧できる説明 '.repeat(64))
        const allocate = vi.spyOn(module, '_malloc')
        const release = vi.spyOn(module, '_free')
        const native = vi.spyOn(module, '_ZSTD_compress')
        const failure = new RangeError(`injected ${stage} failure`)
        if (stage === 'copy') {
            vi.spyOn(module.HEAPU8, 'set').mockImplementationOnce(() => { throw failure })
        } else if (stage === 'compress') {
            native.mockImplementationOnce(() => { throw failure })
        } else {
            vi.spyOn(module.HEAPU8, 'slice').mockImplementationOnce(() => { throw failure })
        }
        expect(() => api.compress(payload)).toThrow(failure)
        expect(allocate).toHaveBeenCalledTimes(2)
        const pointers = allocate.mock.results.map((result) => result.value)
        expect(pointers.every((pointer) => pointer !== 0)).toBe(true)
        expect(release.mock.calls.map(([pointer]) => pointer)).toEqual([pointers[1], pointers[0]])
        expect(native).toHaveBeenCalledTimes(stage === 'copy' ? 0 : 1)

        const compressed = api.compress(payload)
        expect(release).toHaveBeenCalledTimes(4)
        expect(api.decompress(compressed)).toEqual(payload)
    })
})
