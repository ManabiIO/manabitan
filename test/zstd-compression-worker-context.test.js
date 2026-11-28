/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {{type?: string, id?: number, error?: string, compressed?: ArrayBuffer}} WorkerResponse */

const state = vi.hoisted(() => ({create: vi.fn()}))
vi.mock('../dev/lib/zstd-simd-module.js', () => ({default: state.create}))
const workerInitializations = /** @type {Promise<unknown>[]} */ ([])

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

afterEach(async () => {
    // Drain actual worker initialization before replacing its globals or mocks.
    await Promise.allSettled(workerInitializations.splice(0))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/**
 * Runs the production worker entry point and codec against the checked native
 * module. Only browser event transport and file fetching are replaced.
 * @param {boolean} [failFirstContext]
 * @returns {Promise<{
 * api: typeof import('../ext/js/dictionary/zstd-term-content.js'),
 * native: typeof import('../dev/lib/zstd-wasm.js'),
 * dictionary: Uint8Array,
 * createDecoder: import('vitest').MockInstance<() => number>,
 * createEncoder: import('vitest').MockInstance<() => number>,
 * send: (message: Record<string, unknown> & {id: number}, transfer?: Transferable[]) => Promise<Uint8Array>,
 * bridge: {messages: WorkerResponse[]},
 * }>}
 */
async function loadWorker(failFirstContext = false) {
    const {default: create} = /** @type {typeof import('../dev/lib/zstd-simd-module.js')} */ (await vi.importActual('../dev/lib/zstd-simd-module.js'))
    const wasmBinary = await readFile(new URL('../dev/data/zstd-simd.wasm', import.meta.url))
    const module = await create({wasmBinary})
    const createDecoder = vi.spyOn(module, '_ZSTD_createDCtx')
    const createEncoder = vi.spyOn(module, '_ZSTD_createCCtx')
    if (failFirstContext) { createEncoder.mockReturnValueOnce(0) }
    state.create.mockResolvedValue(module)
    vi.doMock('../ext/lib/zstd-wasm.js', async () => await import('../dev/lib/zstd-wasm.js'))
    const dictionary = await readFile(new URL('../dev/data/zstd-dicts/jmdict.zdict', import.meta.url))
    const bridge = {
        listener: /** @type {((event: MessageEvent) => void)|null} */ (null),
        messages: /** @type {WorkerResponse[]} */ ([]),
        onReady: /** @type {((message: WorkerResponse) => void)|null} */ (null),
    }
    const ready = /** @type {Promise<WorkerResponse>} */ (new Promise((resolve) => { bridge.onReady = resolve }))
    vi.stubGlobal('__manabitanTermContentCompressionWorker', false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from(dictionary))))
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {(event: MessageEvent) => void} listener
         */
        addEventListener(type, listener) {
            if (type === 'message') { bridge.listener = listener }
        },
        /**
         * @param {typeof bridge.messages[number]} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer = []) {
            bridge.messages.push(structuredClone(message, {transfer}))
            if (message.type === 'ready' || message.type === 'initialization-error') {
                bridge.onReady?.(message)
            }
        },
    })
    const workerUrl = new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href
    // eslint-disable-next-line no-unsanitized/method -- The URL names a fixed repository-owned worker entry.
    const initialization = import(workerUrl).then(async () => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
        bridge.listener(/** @type {MessageEvent} */ ({data: {
            type: 'initialize',
            module: await WebAssembly.compile(wasmBinary),
            dictionary: Uint8Array.from(dictionary),
        }}))
        return await ready
    })
    workerInitializations.push(initialization)
    const initialized = await initialization
    expect(bridge.messages).toHaveLength(1)
    expect(initialized.type).toBe(failFirstContext ? 'initialization-error' : 'ready')
    const api = await import('../ext/js/dictionary/zstd-term-content.js')
    const native = await import('../dev/lib/zstd-wasm.js')
    /**
     * @param {Record<string, unknown> & {id: number}} message
     * @param {Transferable[]} [transfer]
     * @returns {Promise<Uint8Array>}
     */
    const send = async (message, transfer = []) => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
        bridge.listener(/** @type {MessageEvent} */ ({data: structuredClone(message, {transfer})}))
        await vi.waitFor(() => {
            expect(bridge.messages.some((response) => response.id === message.id && (response.compressed || response.error))).toBe(true)
        })
        const response = bridge.messages.find((entry) => entry.id === message.id && (entry.compressed || entry.error))
        if (typeof response?.error === 'string') { throw new Error(response.error) }
        if (!(response?.compressed instanceof ArrayBuffer)) { throw new Error('Worker did not return owned compressed bytes') }
        return new Uint8Array(response.compressed)
    }
    return {api, native, dictionary, createDecoder, createEncoder, send, bridge}
}

describe('compression worker native contexts', {timeout: 10_000}, () => {
    test.each(['owned', 'shared'])('does not allocate a decoder while compressing %s input, then supports later decoding', async (route) => {
        const {api, native, dictionary, createDecoder, createEncoder, send, bridge} = await loadWorker()
        expect(createEncoder).toHaveBeenCalledOnce()
        expect(createDecoder).not.toHaveBeenCalled()
        const content = new TextEncoder().encode('日本語の辞書内容を圧縮する。'.repeat(4096))
        const reference = native.createCCtx()
        let expected
        try {
            expected = native.compressUsingDictWithPrefix(reference, content, dictionary, 12, -1, true)
        } finally { native.freeCCtx(reference) }
        let compressed
        if (route === 'owned') {
            const owned = Uint8Array.from(content)
            compressed = await send({id: 1, content: owned, dictName: 'jmdict', wrap: true}, [owned.buffer])
            expect(owned.byteLength).toBe(0)
        } else {
            const source = new Uint8Array(new SharedArrayBuffer(content.byteLength + 3))
            source.set(content, 3)
            compressed = await send({
                id: 1,
                source,
                sourceOffsets: Uint32Array.of(3),
                sourceLengths: Uint32Array.of(content.byteLength),
                contentBytes: content.byteLength,
                dictName: 'jmdict',
                wrap: true,
            })
            expect(bridge.messages).toContainEqual({type: 'source-consumed', id: 1})
        }
        expect(compressed).toEqual(expected)
        expect(createDecoder).not.toHaveBeenCalled()
        const generic = await send({id: 2, content: content.subarray(0, 50), wrap: false})
        expect(api.decompressTermContentZstd(generic, null)).toEqual(content.subarray(0, 50))
        expect(createDecoder).toHaveBeenCalledOnce()
        expect(api.decompressTermContentZstd(compressed.subarray(12), 'jmdict')).toEqual(content)
        expect(createDecoder).toHaveBeenCalledOnce()
        expect(api.decompressTermContentZstd(compressed.subarray(12), 'jmdict')).toEqual(content)
        expect(createDecoder).toHaveBeenCalledOnce()
    })

    test.each(['zero', 'throw'])('retries a deferred decoder after %s allocation failure without breaking compression', async (failure) => {
        const {api, createDecoder, send} = await loadWorker()
        const content = new TextEncoder().encode('回復できる辞書'.repeat(100))
        const compressed = await send({id: 1, content, dictName: 'jmdict', wrap: true})
        if (failure === 'zero') {
            createDecoder.mockReturnValueOnce(0)
        } else {
            createDecoder.mockImplementationOnce(() => { throw new Error('injected decoder allocation failure') })
        }
        expect(() => api.decompressTermContentZstd(compressed.subarray(12), 'jmdict')).toThrow(/decompression context|decoder allocation/)
        expect(createDecoder).toHaveBeenCalledOnce()
        expect(await send({id: 2, content, dictName: 'jmdict', wrap: true})).toEqual(compressed)
        expect(createDecoder).toHaveBeenCalledOnce()
        expect(api.decompressTermContentZstd(compressed.subarray(12), 'jmdict')).toEqual(content)
        expect(api.decompressTermContentZstd(compressed.subarray(12), 'jmdict')).toEqual(content)
        expect(createDecoder).toHaveBeenCalledTimes(2)
    })

    test('retries failed worker initialization without allocating a decoder', async () => {
        const {api, createDecoder, createEncoder} = await loadWorker(true)
        expect(createEncoder).toHaveBeenCalledOnce()
        expect(createDecoder).not.toHaveBeenCalled()
        expect(() => api.decompressTermContentZstd(new Uint8Array(), null)).toThrow('not initialized')
        await expect(api.initializeTermContentZstd()).resolves.toBeUndefined()
        expect(createEncoder).toHaveBeenCalledTimes(2)
        expect(createDecoder).not.toHaveBeenCalled()
        const content = new TextEncoder().encode('再試行')
        const compressed = api.compressTermContentZstd(content, 'jmdict')
        expect(api.decompressTermContentZstd(compressed, 'jmdict')).toEqual(content)
        expect(createDecoder).toHaveBeenCalledOnce()
    })

    test('observes a module import failure before a delayed initialization message', async () => {
        vi.doMock('../ext/js/dictionary/zstd-term-content.js', () => { throw new Error('injected codec import failure') })
        vi.stubGlobal('__manabitanTermContentCompressionWorker', false)
        const bridge = {
            listener: /** @type {((event: MessageEvent) => void)|null} */ (null),
            messages: /** @type {WorkerResponse[]} */ ([]),
        }
        vi.stubGlobal('self', {
            /**
             * @param {string} type
             * @param {(event: MessageEvent) => void} listener
             */
            addEventListener(type, listener) {
                if (type === 'message') { bridge.listener = listener }
            },
            /** @param {WorkerResponse} message */
            postMessage(message) { bridge.messages.push(message) },
        })
        try {
            // Vitest wraps a failed mock factory. Compare the actual rejection
            // delivered by import so the worker must preserve that same reason.
            const expectedError = await import('../ext/js/dictionary/zstd-term-content.js').then(
                () => '',
                (/** @type {unknown} */ error) => `${error}`,
            )
            expect(expectedError).not.toBe('')
            const workerUrl = new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href
            // eslint-disable-next-line no-unsanitized/method -- The URL names the fixed production worker.
            await import(workerUrl)
            // Let a complete turn pass before handshaking; an unobserved import
            // rejection would be reported by the runner during this interval.
            await new Promise((resolve) => { setTimeout(resolve, 0) })
            expect(bridge.messages).toEqual([])
            if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
            bridge.listener(/** @type {MessageEvent} */ ({data: {
                type: 'initialize',
                module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
                dictionary: Uint8Array.of(1),
            }}))
            await vi.waitFor(() => {
                expect(bridge.messages).toEqual([{
                    type: 'initialization-error',
                    error: expectedError,
                }])
            })
        } finally {
            vi.doUnmock('../ext/js/dictionary/zstd-term-content.js')
        }
    })
})
