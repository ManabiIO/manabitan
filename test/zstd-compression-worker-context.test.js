/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {{type?: string, id?: number, error?: string, compressed?: ArrayBuffer}} WorkerResponse */
/** @typedef {WorkerResponse & {responses?: WorkerResponse[]}} WorkerPacket */

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
 * sendBatch: (messages: Array<Record<string, unknown> & {id: number}>) => Promise<WorkerResponse[]>,
 * bridge: {messages: WorkerResponse[], packets: WorkerPacket[], detachedLengths: number[], beforePost: ((message: WorkerPacket) => void)|null},
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
        packets: /** @type {WorkerPacket[]} */ ([]),
        detachedLengths: /** @type {number[]} */ ([]),
        beforePost: /** @type {((message: WorkerPacket) => void)|null} */ (null),
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
         * @param {WorkerPacket} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer = []) {
            bridge.beforePost?.(message)
            const packet = structuredClone(message, {transfer})
            bridge.packets.push(packet)
            bridge.messages.push(...(packet.responses ?? [packet]))
            bridge.detachedLengths.push(...transfer.map((buffer) => /** @type {ArrayBuffer} */ (buffer).byteLength))
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
        bridge.listener(/** @type {MessageEvent} */ ({data: structuredClone(message, {transfer})}))
        await vi.waitFor(() => {
            expect(bridge.messages.some((response) => response.id === message.id && (response.compressed || response.error))).toBe(true)
        })
        const response = bridge.messages.find((entry) => entry.id === message.id && (entry.compressed || entry.error))
        if (typeof response?.error === 'string') { throw new Error(response.error) }
        if (!(response?.compressed instanceof ArrayBuffer)) { throw new Error('Worker did not return owned compressed bytes') }
        return new Uint8Array(response.compressed)
    }
    /**
     * @param {Array<Record<string, unknown> & {id: number}>} messages
     * @returns {Promise<WorkerResponse[]>}
     */
    const sendBatch = async (messages) => {
        if (bridge.listener === null) { throw new Error('Worker listener was not installed') }
        bridge.listener(/** @type {MessageEvent} */ ({data: structuredClone({messages})}))
        await vi.waitFor(() => {
            expect(messages.every(({id}) => bridge.messages.some((response) => response.id === id && (response.compressed || response.error)))).toBe(true)
        })
        return messages.map(({id}) => {
            const response = bridge.messages.find((entry) => entry.id === id && (entry.compressed || entry.error))
            if (typeof response === 'undefined') { throw new Error('Missing batch response') }
            return response
        })
    }
    return {api, native, dictionary, createDecoder, createEncoder, send, sendBatch, bridge}
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
    test('batches real shared blocks with exact bytes and releases source before the final compression', async () => {
        const {api, send, sendBatch, bridge} = await loadWorker()
        const contents = [257, 65_537, 1_048_585].map((length, block) => Uint8Array.from({length}, (_, index) => (index * 131 + block + (index >>> 7)) & 255))
        const expected = []
        for (let index = 0; index < contents.length; ++index) {
            expected.push(await send({id: index + 1, content: contents[index], dictName: 'jmdict', wrap: true}))
        }
        const source = new Uint8Array(new SharedArrayBuffer(contents.reduce((sum, bytes) => sum + bytes.length + 3, 0)))
        let offset = 1
        const messages = contents.map((bytes, index) => {
            source.set(bytes, offset)
            const message = {
                id: index + 10,
                source,
                sourceOffsets: Uint32Array.of(offset),
                sourceLengths: Uint32Array.of(bytes.length),
                contentBytes: bytes.length,
                dictName: 'jmdict',
                wrap: true,
            }
            offset += bytes.length + 3
            return message
        })
        const packetsBefore = bridge.packets.length
        let released = false
        bridge.beforePost = (packet) => {
            if (packet.responses?.every((response) => response.type === 'source-consumed')) {
                expect(packet.responses.map(({id}) => id)).toEqual([10, 11, 12])
                source.fill(0)
                released = true
            }
        }
        const result = await sendBatch(messages)
        expect(released).toBe(true)
        expect(bridge.packets).toHaveLength(packetsBefore + 2)
        for (let index = 0; index < result.length; ++index) {
            expect(result[index].error).toBeUndefined()
            const bytes = new Uint8Array(/** @type {ArrayBuffer} */ (result[index].compressed))
            expect(Buffer.compare(bytes, expected[index])).toBe(0)
            expect(api.decompressTermContentZstd(bytes.subarray(12), 'jmdict')).toEqual(contents[index])
        }
        expect(bridge.detachedLengths.every((length) => length === 0)).toBe(true)
    })

    test.each(['before-copy', 'after-copy'])('drains later batch sources after a middle block fails %s', async (stage) => {
        const {api, sendBatch, bridge} = await loadWorker()
        const source = new Uint8Array(new SharedArrayBuffer(48)).fill(7)
        const messages = [100, 101, 102].map((id, index) => ({
            id,
            source,
            sourceOffsets: Uint32Array.of(index * 16),
            sourceLengths: Uint32Array.of(16),
            contentBytes: 16,
            dictName: 'jmdict',
            wrap: true,
        }))
        if (stage === 'before-copy') {
            messages[1].contentBytes = -1
        } else {
            const finish = api.finishWrappedTermContentZstdSpans
            let calls = 0
            vi.spyOn(api, 'finishWrappedTermContentZstdSpans').mockImplementation((prepared) => {
                if (++calls === 2) { throw new Error('injected native compression failure') }
                return finish(prepared)
            })
        }
        const result = await sendBatch(messages)
        expect(result[0].compressed).toBeInstanceOf(ArrayBuffer)
        expect(result[1].error).toMatch(/span input is invalid|native compression failure/)
        expect(result[2].compressed).toBeInstanceOf(ArrayBuffer)
        const consumed = bridge.messages.filter(({type}) => type === 'source-consumed').map(({id}) => id)
        expect(consumed).toEqual(stage === 'before-copy' ? [100, 102] : [100, 101, 102])
        const firstAck = bridge.messages.findIndex(({type, id}) => type === 'source-consumed' && id === 100)
        const failure = bridge.messages.findIndex(({error, id}) => typeof error === 'string' && id === 101)
        const lastAck = bridge.messages.findIndex(({type, id}) => type === 'source-consumed' && id === 102)
        expect(firstAck).toBeLessThan(failure)
        expect(failure).toBeLessThan(lastAck)
    })

    test('reports a failed grouped result transfer for every buffered job without a timeout', async () => {
        const {sendBatch, bridge} = await loadWorker()
        bridge.beforePost = (packet) => {
            if (packet.responses?.some(({compressed}) => compressed instanceof ArrayBuffer)) {
                throw new DOMException('injected grouped clone failure', 'DataCloneError')
            }
        }
        const source = new Uint8Array(new SharedArrayBuffer(48)).fill(7)
        const result = await sendBatch([200, 201, 202].map((id, index) => ({
            id,
            source,
            sourceOffsets: Uint32Array.of(index * 16),
            sourceLengths: Uint32Array.of(16),
            contentBytes: 16,
            dictName: 'jmdict',
            wrap: true,
        })))
        expect(result.map(({error}) => error)).toEqual(new Array(3).fill('DataCloneError: injected grouped clone failure'))
        expect(bridge.messages.filter(({type}) => type === 'source-consumed').map(({id}) => id)).toEqual([200, 201, 202])
    })
})
