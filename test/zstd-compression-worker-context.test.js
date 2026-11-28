/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {{type?: string, id?: number, error?: string, compressed?: ArrayBuffer, compressedBatch?: ArrayBuffer[]}} WorkerResponse */

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
 * sendBatch: (message: Record<string, unknown> & {id: number}) => Promise<Uint8Array[]>,
 * bridge: {messages: WorkerResponse[], onSourceConsumed: (() => void)|null},
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
        onSourceConsumed: /** @type {(() => void)|null} */ (null),
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
            if (message.type === 'source-consumed') { bridge.onSourceConsumed?.() }
            if (message.type === 'ready' || message.type === 'initialization-error') {
                bridge.onReady?.(message)
            }
        },
    })
    const workerUrl = new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href
    // eslint-disable-next-line no-unsanitized/method -- The URL names a fixed repository-owned worker entry.
    const initialization = import(workerUrl).then(() => ready)
    workerInitializations.push(initialization)
    const initialized = await initialization
    expect(bridge.messages).toHaveLength(1)
    expect(initialized.type).toBe(failFirstContext ? 'initialization-error' : 'ready')
    const api = await import('../ext/js/dictionary/zstd-term-content.js')
    const native = await import('../dev/lib/zstd-wasm.js')
    /**
     * @param {Record<string, unknown> & {id: number}} message
     * @param {Transferable[]} [transfer]
     * @returns {Promise<WorkerResponse>}
     */
    const request = async (message, transfer = []) => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
        bridge.listener(/** @type {MessageEvent} */ ({data: structuredClone(message, {transfer})}))
        await vi.waitFor(() => {
            expect(bridge.messages.some((response) => response.id === message.id && (response.compressed || response.compressedBatch || response.error))).toBe(true)
        })
        const response = bridge.messages.find((entry) => entry.id === message.id && (entry.compressed || entry.compressedBatch || entry.error))
        if (typeof response?.error === 'string') { throw new Error(response.error) }
        if (!response) { throw new Error('Worker did not return a response') }
        return response
    }
    /**
     * @param {Record<string, unknown> & {id: number}} message
     * @param {Transferable[]} [transfer]
     * @returns {Promise<Uint8Array>}
     */
    const send = async (message, transfer = []) => {
        const response = await request(message, transfer)
        if (!(response?.compressed instanceof ArrayBuffer)) { throw new Error('Worker did not return owned compressed bytes') }
        return new Uint8Array(response.compressed)
    }
    /**
     * @param {Record<string, unknown> & {id: number}} message
     * @returns {Promise<Uint8Array[]>}
     */
    const sendBatch = async (message) => {
        const response = await request(message)
        if (!Array.isArray(response.compressedBatch)) { throw new Error('Worker did not return owned compressed blocks') }
        return response.compressedBatch.map((buffer) => new Uint8Array(buffer))
    }
    return {api, native, dictionary, createDecoder, createEncoder, send, sendBatch, bridge}
}

describe('compression worker native contexts', {timeout: 10_000}, () => {
    test.each(['jmdict', null])('batched %s spans preserve frame bytes and release the source before the final compression', async (dictName) => {
        const {api, sendBatch, bridge} = await loadWorker()
        const contents = ['独立した圧縮ブロックを保つ'.repeat(128), 'Second block\0with distinct bytes'.repeat(93), '順序と所有権'.repeat(71)]
            .map((text) => new TextEncoder().encode(text))
        const sourceOffsets = new Uint32Array(contents.length)
        const sourceLengths = Uint32Array.from(contents, (content) => content.byteLength)
        let sourceBytes = 3
        for (let index = 0; index < contents.length; ++index) {
            sourceOffsets[index] = sourceBytes
            sourceBytes += contents[index].byteLength + 2
        }
        const source = new Uint8Array(new SharedArrayBuffer(sourceBytes))
        for (let index = 0; index < contents.length; ++index) { source.set(contents[index], sourceOffsets[index]) }
        const compressionExperiments = {experimentalGenericSpanCompression: true}
        const expected = contents.map((content) => api.compressWrappedTermContentZstd(content, dictName, compressionExperiments).bytes)
        const originalFinish = api.finishWrappedTermContentZstdSpans
        /** @type {number[]} */
        const acknowledgementsBeforeFinish = []
        vi.spyOn(api, 'finishWrappedTermContentZstdSpans').mockImplementation((prepared) => {
            acknowledgementsBeforeFinish.push(bridge.messages.filter(({type}) => type === 'source-consumed').length)
            return originalFinish(prepared)
        })
        bridge.onSourceConsumed = () => { source.fill(0) }
        const result = await sendBatch({
            id: 1, type: 'compress-spans-batch', source, sourceOffsets, sourceLengths, dictName, wrap: true, compressionExperiments,
            blocks: [0, 1, 2].map((start) => ({start, end: start + 1, contentBytes: contents[start].byteLength})),
        })
        expect(result).toEqual(expected)
        expect(new Set(result.map(({buffer}) => buffer)).size).toBe(contents.length)
        expect(acknowledgementsBeforeFinish).toEqual([0, 0, 1])
        expect(bridge.messages.filter(({id}) => id === 1)).toHaveLength(2)
        expect(source.every((value) => value === 0)).toBe(true)
    })

    test.each([
        {name: 'empty', blocks: []},
        {name: 'descending', blocks: [{start: 1, end: 0, contentBytes: 1}]},
        {name: 'outside source', blocks: [{start: 0, end: 2, contentBytes: 1}]},
        {name: 'fractional size', blocks: [{start: 0, end: 1, contentBytes: 1.5}]},
        {name: 'negative start', blocks: [{start: -1, end: 1, contentBytes: 1}]},
        {name: 'null block', blocks: [null]},
    ])('rejects a $name batch without acknowledging source use or poisoning later compression', async ({blocks}) => {
        const {sendBatch, send, bridge} = await loadWorker()
        await expect(sendBatch({
            id: 1, type: 'compress-spans-batch', source: new Uint8Array(new SharedArrayBuffer(1)),
            sourceOffsets: Uint32Array.of(0), sourceLengths: Uint32Array.of(1), blocks, wrap: true,
        })).rejects.toThrow('span batch')
        expect(bridge.messages.filter(({id, type}) => id === 1 && type === 'source-consumed')).toHaveLength(0)
        await expect(send({id: 2, content: Uint8Array.of(1), wrap: true})).resolves.toBeInstanceOf(Uint8Array)
    })

    test('a later source-span failure discards partial results without acknowledging unread bytes', async () => {
        const {sendBatch, send, bridge} = await loadWorker()
        await expect(sendBatch({
            id: 1, type: 'compress-spans-batch', source: new Uint8Array(new SharedArrayBuffer(2)),
            sourceOffsets: Uint32Array.of(0, 2), sourceLengths: Uint32Array.of(1, 1),
            blocks: [{start: 0, end: 1, contentBytes: 1}, {start: 1, end: 2, contentBytes: 1}],
            dictName: 'jmdict', wrap: true,
        })).rejects.toThrow()
        expect(bridge.messages.filter(({id}) => id === 1)).toEqual([{id: 1, error: expect.any(String)}])
        await expect(send({id: 2, content: Uint8Array.of(1), wrap: true})).resolves.toBeInstanceOf(Uint8Array)
    })

    test('a final compression failure preserves the source-consumed acknowledgement', async () => {
        const {api, sendBatch, bridge} = await loadWorker()
        const originalFinish = api.finishWrappedTermContentZstdSpans
        let finishes = 0
        vi.spyOn(api, 'finishWrappedTermContentZstdSpans').mockImplementation((prepared) => {
            const result = originalFinish(prepared)
            if (++finishes === 2) { throw new Error('injected final compression failure') }
            return result
        })
        await expect(sendBatch({
            id: 1, type: 'compress-spans-batch', source: new Uint8Array(new SharedArrayBuffer(2)),
            sourceOffsets: Uint32Array.of(0, 1), sourceLengths: Uint32Array.of(1, 1),
            blocks: [{start: 0, end: 1, contentBytes: 1}, {start: 1, end: 2, contentBytes: 1}],
            dictName: 'jmdict', wrap: true,
        })).rejects.toThrow('injected final compression failure')
        expect(bridge.messages.filter(({id}) => id === 1)).toEqual([
            {type: 'source-consumed', id: 1}, {id: 1, error: expect.stringContaining('injected final compression failure')},
        ])
    })

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
})
