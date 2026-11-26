/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

const zstd = vi.hoisted(() => ({
    init: vi.fn(async () => {}),
    createCCtx: vi.fn(() => 11),
    createDCtx: vi.fn(() => 22),
    freeCCtx: vi.fn(),
    freeDCtx: vi.fn(),
    compressUsingDict: vi.fn(() => Uint8Array.of(7)),
}))

vi.mock('../ext/lib/zstd-wasm.js', () => zstd)

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.stubGlobal('Worker', void 0)
    vi.stubGlobal('__manabitanTermContentCompressionWorker', false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(1, 2, 3))))
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('term content Zstd asset startup overlap', () => {
    test.each([false, true])('overlaps both loads and publishes only after both finish (worker=%s)', async (worker) => {
        vi.stubGlobal('__manabitanTermContentCompressionWorker', worker)
        const moduleReady = Promise.withResolvers()
        const bodyReady = Promise.withResolvers()
        zstd.init.mockImplementationOnce(async () => { await moduleReady.promise })
        const dictionary = Uint8Array.of(4, 5, 6)
        const readBody = vi.fn(async () => {
            await bodyReady.promise
            return dictionary.buffer
        })
        const fetchDictionary = vi.fn(async () => ({ok: true, arrayBuffer: readBody}))
        vi.stubGlobal('fetch', fetchDictionary)
        const api = await import('../ext/js/dictionary/zstd-term-content.js')
        const first = api.initializeTermContentZstd()
        const second = api.initializeTermContentZstd()

        expect(zstd.init).toHaveBeenCalledOnce()
        expect(fetchDictionary).toHaveBeenCalledOnce()
        await vi.waitFor(() => { expect(readBody).toHaveBeenCalledOnce() })
        expect(zstd.createCCtx).not.toHaveBeenCalled()
        moduleReady.resolve(void 0)
        await moduleReady.promise
        expect(zstd.createCCtx).not.toHaveBeenCalled()
        expect(() => api.compressTermContentZstd(Uint8Array.of(8), 'jmdict')).toThrow('not initialized')

        bodyReady.resolve(void 0)
        await Promise.all([first, second])
        expect(zstd.createCCtx).toHaveBeenCalledOnce()
        expect(zstd.createDCtx).toHaveBeenCalledTimes(worker ? 0 : 1)
        api.compressTermContentZstd(Uint8Array.of(8), 'jmdict')
        expect(zstd.compressUsingDict).toHaveBeenCalledWith(11, Uint8Array.of(8), dictionary, -1)
        await api.initializeTermContentZstd()
        expect(zstd.init).toHaveBeenCalledOnce()
        expect(fetchDictionary).toHaveBeenCalledOnce()
    })

    test.each(['module', 'dictionary', 'both'])('joins outstanding loads after %s failure before a clean retry', async (failure) => {
        const moduleReady = Promise.withResolvers()
        const bodyReady = Promise.withResolvers()
        const moduleError = new Error('module load failed')
        const dictionaryError = new Error('dictionary body failed')
        zstd.init.mockImplementationOnce(async () => { await moduleReady.promise })
        const readBody = vi.fn(async () => {
            await bodyReady.promise
            return Uint8Array.of(4, 5, 6).buffer
        })
        const fetchDictionary = vi.fn(async () => ({ok: true, arrayBuffer: readBody}))
        vi.stubGlobal('fetch', fetchDictionary)
        const api = await import('../ext/js/dictionary/zstd-term-content.js')
        let settled = false
        const first = api.initializeTermContentZstd().catch((error) => {
            settled = true
            return error
        })
        await vi.waitFor(() => { expect(readBody).toHaveBeenCalledOnce() })
        if (failure === 'dictionary') {
            bodyReady.reject(dictionaryError)
            await expect(bodyReady.promise).rejects.toBe(dictionaryError)
        } else {
            moduleReady.reject(moduleError)
            await expect(moduleReady.promise).rejects.toBe(moduleError)
        }
        expect(settled).toBe(false)
        const second = api.initializeTermContentZstd().catch((error) => error)
        expect(zstd.init).toHaveBeenCalledOnce()
        expect(fetchDictionary).toHaveBeenCalledOnce()
        expect(zstd.createCCtx).not.toHaveBeenCalled()
        expect(zstd.createDCtx).not.toHaveBeenCalled()

        if (failure === 'dictionary') {
            moduleReady.resolve(void 0)
        } else if (failure === 'both') {
            bodyReady.reject(dictionaryError)
        } else {
            bodyReady.resolve(void 0)
        }
        const expectedError = failure === 'dictionary' ? dictionaryError : moduleError
        expect(await Promise.all([first, second])).toEqual([expectedError, expectedError])
        expect(zstd.createCCtx).not.toHaveBeenCalled()
        expect(zstd.createDCtx).not.toHaveBeenCalled()
        expect(() => api.compressTermContentZstd(Uint8Array.of(8), 'jmdict')).toThrow('not initialized')

        readBody.mockResolvedValue(Uint8Array.of(9).buffer)
        await expect(api.initializeTermContentZstd()).resolves.toBeUndefined()
        expect(zstd.init).toHaveBeenCalledTimes(2)
        expect(fetchDictionary).toHaveBeenCalledTimes(2)
        expect(zstd.createCCtx).toHaveBeenCalledOnce()
        expect(zstd.createDCtx).toHaveBeenCalledOnce()
        api.compressTermContentZstd(Uint8Array.of(8), 'jmdict')
        expect(zstd.compressUsingDict).toHaveBeenCalledWith(11, Uint8Array.of(8), Uint8Array.of(9), -1)
    })
})
