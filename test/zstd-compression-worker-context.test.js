/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {{type?: string, id?: number, batchId?: number, error?: string, hasGathered?: boolean, compressed?: ArrayBuffer}} WorkerResponse */

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
 * bridge: {messages: WorkerResponse[], onMessage: ((message: WorkerResponse) => void)|null},
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
        onMessage: /** @type {((message: WorkerResponse) => void)|null} */ (null),
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
            const delivered = structuredClone(message, {transfer})
            bridge.messages.push(delivered)
            bridge.onMessage?.(delivered)
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
     * @returns {Promise<Uint8Array>}
     */
    const send = async (message, transfer = []) => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
        const responseStart = bridge.messages.length
        bridge.listener(/** @type {MessageEvent} */ ({data: structuredClone(message, {transfer})}))
        await vi.waitFor(() => {
            expect(bridge.messages.slice(responseStart).some((response) => response.type === 'batch-error' || (response.id === message.id && (response.compressed || response.error)))).toBe(true)
        })
        const response = bridge.messages.slice(responseStart).find((entry) => entry.type === 'batch-error' || (entry.id === message.id && (entry.compressed || entry.error)))
        if (typeof response?.error === 'string') { throw new Error(response.error) }
        if (!(response?.compressed instanceof ArrayBuffer)) { throw new Error('Worker did not return owned compressed bytes') }
        return new Uint8Array(response.compressed)
    }
    return {api, native, dictionary, createDecoder, createEncoder, send, bridge}
}

describe('compression worker native contexts', {timeout: 10_000}, () => {
    test('emits one final-gather acknowledgement before the last unchanged frame is compressed', async () => {
        const {api, send, bridge} = await loadWorker()
        const contents = Array.from({length: 5}, (_, block) => new TextEncoder().encode(`日本語の内容${block}`.repeat(100)))
        const expected = contents.map((content) => api.compressWrappedTermContentZstd(content, 'jmdict').bytes)
        const size = contents[0].length
        const source = new Uint8Array(new SharedArrayBuffer(size * 5))
        for (const [block, content] of contents.entries()) { source.set(content, size * block) }
        const nextBlock = new Uint32Array(new SharedArrayBuffer(4))
        const remainingSources = new Uint32Array(new SharedArrayBuffer(4))
        remainingSources[0] = 5
        const responseStart = bridge.messages.length
        bridge.onMessage = (message) => {
            if (message.type !== 'source-consumed-batch') { return }
            expect(message.batchId).toBe(501)
            expect(bridge.messages.slice(responseStart).filter(({compressed}) => compressed)).toHaveLength(4)
            // The last native prepare already owns its input; the caller may
            // reuse every source byte before that last compression finishes.
            source.fill(0)
        }
        await send({
            type: 'compress-spans-batch',
            id: 505,
            batchId: 501,
            jobIds: [501, 502, 503, 504, 505],
            source,
            sourceOffsets: Uint32Array.from(contents, (_, block) => size * block),
            sourceLengths: Uint32Array.from(contents, () => size),
            blockStartIndexes: Uint32Array.of(0, 1, 2, 3, 4, 5),
            blockLengths: Uint32Array.from(contents, () => size),
            nextBlock,
            remainingSources,
            wrap: true,
            dictName: 'jmdict',
        })
        const responses = bridge.messages.slice(responseStart)
        expect(responses.filter(({type}) => type === 'source-consumed-batch')).toEqual([{type: 'source-consumed-batch', batchId: 501}])
        expect(responses.some(({type}) => type === 'source-consumed')).toBe(false)
        expect(responses.filter(({compressed}) => compressed).map(({id}) => id)).toEqual([501, 502, 503, 504, 505])
        expect(source.every((value) => value === 0)).toBe(true)
        expect(Atomics.load(nextBlock, 0)).toBe(5)
        expect(Atomics.load(remainingSources, 0)).toBe(0)
        for (let block = 0; block < 5; ++block) {
            const result = responses.find(({id, compressed}) => id === 501 + block && compressed)
            if (!(result?.compressed instanceof ArrayBuffer)) { throw new Error('Expected owned compressed bytes') }
            const frame = new Uint8Array(result.compressed)
            expect(frame).toEqual(expected[block])
            expect(api.decompressTermContentZstd(frame.subarray(12), 'jmdict')).toEqual(contents[block])
        }
    })

    test('reports the gathered error phase without delaying later claims or their frames', async () => {
        const {api, send, bridge} = await loadWorker()
        const source = new Uint8Array(new SharedArrayBuffer(12))
        source.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        const remainingSources = new Uint32Array(new SharedArrayBuffer(4))
        remainingSources[0] = 3
        const responseStart = bridge.messages.length
        vi.spyOn(api, 'finishWrappedTermContentZstdSpans').mockImplementationOnce(() => { throw new Error('injected compression failure after gather') })
        await send({
            type: 'compress-spans-batch',
            id: 603,
            batchId: 601,
            jobIds: [601, 602, 603],
            source,
            sourceOffsets: Uint32Array.of(0, 4, 8),
            sourceLengths: Uint32Array.of(4, 4, 4),
            blockStartIndexes: Uint32Array.of(0, 1, 2, 3),
            blockLengths: Uint32Array.of(4, 4, 4),
            nextBlock: new Uint32Array(new SharedArrayBuffer(4)),
            remainingSources,
            wrap: true,
            dictName: 'jmdict',
        })
        const responses = bridge.messages.slice(responseStart)
        expect(responses[0]).toMatchObject({id: 601, hasGathered: true, error: 'Error: injected compression failure after gather'})
        expect(responses.filter(({type}) => type === 'source-consumed-batch')).toEqual([{type: 'source-consumed-batch', batchId: 601}])
        expect(responses.some(({type}) => type === 'source-consumed')).toBe(false)
        expect(Atomics.load(remainingSources, 0)).toBe(0)
        for (const block of [1, 2]) {
            const result = responses.find(({id, compressed}) => id === 601 + block && compressed)
            if (!(result?.compressed instanceof ArrayBuffer)) { throw new Error('Expected owned compressed bytes') }
            expect(api.decompressTermContentZstd(new Uint8Array(result.compressed).subarray(12), 'jmdict')).toEqual(source.subarray(block * 4, block * 4 + 4))
        }
    })

    test('continues claiming a shared batch after first or middle source-copy failures', async () => {
        const {api, send, bridge} = await loadWorker()
        const source = new Uint8Array(new SharedArrayBuffer(12))
        source.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        for (const failedBlock of [0, 1]) {
            const responseStart = bridge.messages.length
            const nextBlock = new Uint32Array(new SharedArrayBuffer(4))
            const remainingSources = new Uint32Array(new SharedArrayBuffer(4))
            remainingSources[0] = 3
            const sourceOffsets = Uint32Array.of(0, 4, 8)
            sourceOffsets[failedBlock] = source.length
            await expect(send({
                type: 'compress-spans-batch',
                id: 10 + failedBlock,
                batchId: 10,
                jobIds: [10, 11, 12],
                source,
                sourceOffsets,
                sourceLengths: Uint32Array.of(4, 4, 4),
                blockStartIndexes: Uint32Array.of(0, 1, 2, 3),
                blockLengths: Uint32Array.of(4, 4, 4),
                nextBlock,
                remainingSources,
                wrap: true,
                dictName: 'jmdict',
            })).rejects.toThrow()
            await vi.waitFor(() => {
                expect(bridge.messages.slice(responseStart).filter(({compressed}) => compressed instanceof ArrayBuffer)).toHaveLength(2)
            })
            const responses = bridge.messages.slice(responseStart)
            expect(Atomics.load(nextBlock, 0)).toBe(3)
            expect(Atomics.load(remainingSources, 0)).toBe(1)
            const successful = [0, 1, 2].filter((block) => block !== failedBlock)
            expect(responses.some(({type}) => type === 'source-consumed' || type === 'source-consumed-batch')).toBe(false)
            expect(responses.find(({id, error}) => id === 10 + failedBlock && error)?.hasGathered).toBe(false)
            expect(responses.some(({type}) => type === 'batch-error')).toBe(false)
            for (const block of successful) {
                const result = responses.find((message) => message.id === block + 10 && message.compressed)
                if (!(result?.compressed instanceof ArrayBuffer)) { throw new Error('Expected a successful block') }
                expect(api.decompressTermContentZstd(new Uint8Array(result.compressed).subarray(12), 'jmdict')).toEqual(source.subarray(block * 4, (block + 1) * 4))
            }
        }
    })

    test('reports malformed shared batches as pool-fatal before reading source bytes', async () => {
        const {send, bridge} = await loadWorker()
        for (const malformed of ['unshared-counter', 'invalid-counter', 'invalid-job-id', 'invalid-span-partition', 'unshared-source-counter', 'overlapping-counter', 'invalid-source-count', 'invalid-batch-id']) {
            const responseStart = bridge.messages.length
            const nextBlock = new Uint32Array(malformed === 'unshared-counter' ? new ArrayBuffer(4) : new SharedArrayBuffer(4))
            if (malformed === 'invalid-counter') { nextBlock[0] = 2 }
            const remainingSources = malformed === 'overlapping-counter' ? nextBlock : new Uint32Array(malformed === 'unshared-source-counter' ? new ArrayBuffer(4) : new SharedArrayBuffer(4))
            if (malformed !== 'overlapping-counter' && malformed !== 'invalid-source-count') { remainingSources[0] = 1 }
            await expect(send({
                type: 'compress-spans-batch',
                id: 10,
                batchId: malformed === 'invalid-batch-id' ? 11 : 10,
                jobIds: [malformed === 'invalid-job-id' ? Number.NaN : 10],
                source: new Uint8Array(new SharedArrayBuffer(4)),
                sourceOffsets: Uint32Array.of(0),
                sourceLengths: Uint32Array.of(4),
                blockStartIndexes: Uint32Array.of(0, malformed === 'invalid-span-partition' ? 2 : 1),
                blockLengths: Uint32Array.of(4),
                nextBlock,
                remainingSources,
                wrap: true,
            })).rejects.toThrow(/batch (input|claim|block|source count) is invalid/)
            const responses = bridge.messages.slice(responseStart)
            expect(responses.filter(({type}) => type === 'batch-error')).toHaveLength(1)
            expect(responses.some(({type}) => type === 'source-consumed' || type === 'source-consumed-batch')).toBe(false)
        }
    })

    test('reports initialization failure for a batch with unclaimed blocks', async () => {
        const {send, bridge} = await loadWorker(true)
        const nextBlock = new Uint32Array(new SharedArrayBuffer(4))
        const remainingSources = new Uint32Array(new SharedArrayBuffer(4))
        remainingSources[0] = 2
        await expect(send({
            type: 'compress-spans-batch',
            id: 10,
            batchId: 10,
            jobIds: [10, 11],
            source: new Uint8Array(new SharedArrayBuffer(8)),
            sourceOffsets: Uint32Array.of(0, 4),
            sourceLengths: Uint32Array.of(4, 4),
            blockStartIndexes: Uint32Array.of(0, 1, 2),
            blockLengths: Uint32Array.of(4, 4),
            nextBlock,
            remainingSources,
            wrap: true,
        })).rejects.toThrow('compression context')
        expect(bridge.messages.filter(({type}) => type === 'batch-error')).toHaveLength(1)
        expect(bridge.messages.some(({type}) => type === 'source-consumed' || type === 'source-consumed-batch')).toBe(false)
        expect(Atomics.load(nextBlock, 0)).toBe(0)
        expect(Atomics.load(remainingSources, 0)).toBe(2)
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
