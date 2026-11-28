/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker as NodeWorker} from 'node:worker_threads'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Set<(event: import('core').SafeAny) => void>>} */
        this.listeners = new Map()
        /** @type {Record<string, unknown>[]} */
        this.calls = []
        this.terminateCount = 0
        this.throwOnDispatch = false
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    addEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }

    /**
     * @param {string} type
     * @param {unknown} event
     */
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) { listener(event) }
    }

    /**
     * @param {Record<string, unknown>} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        if (this.throwOnDispatch) { throw new Error('injected dispatch failure') }
        this.calls.push(structuredClone(message, {transfer}))
    }

    /**
     * @param {number} index
     * @param {Record<string, unknown>} [response]
     */
    reply(index, response = {}) {
        const call = this.calls[index]
        const content = /** @type {Uint8Array} */ (call.content)
        this.emit('message', {data: {id: call.id, compressed: Uint8Array.from(content).buffer, envelopeMs: 1, ...response}})
    }

    terminate() { ++this.terminateCount }
}

/**
 * @param {ControlledWorker[]} workers
 * @returns {TermContentCompressionPool}
 */
function createPool(workers) {
    return new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
}

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('packing blocks at compression dispatch', () => {
    test('transfers every block before creating the next and preserves round-robin result order', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker(), new ControlledWorker()]
        const pool = createPool(workers)
        /** @type {Uint8Array[]} */
        const allocations = []
        const lengths = Uint32Array.of(2, 3, 4, 5, 6, 7, 8)
        try {
            const pending = pool.compressWrappedBlocks(lengths, (index) => {
                expect(workers.reduce((count, worker) => count + worker.calls.length, 0)).toBe(index)
                expect(allocations.every((allocation) => allocation.byteLength === 0)).toBe(true)
                const bytes = new Uint8Array(lengths[index]).fill(index + 1)
                allocations.push(bytes)
                return bytes
            }, 'jmdict')
            expect(workers.map(({calls}) => calls.length)).toEqual([3, 2, 2])
            expect(allocations.every((allocation) => allocation.byteLength === 0)).toBe(true)
            for (let index = lengths.length - 1; index >= 0; --index) {
                workers[index % 3].reply(Math.floor(index / 3))
            }
            const result = await pending
            expect(result.chunks.map((bytes) => [...bytes])).toEqual(Array.from(lengths, (length, index) => new Array(length).fill(index + 1)))
            expect(result.envelopeMs).toBe(3)
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test.each(['first-error', 'middle-error', 'dispatch-throw', 'invalid-reply'])('drains every job after %s before rejecting', async (failure) => {
        const workers = [new ControlledWorker(), new ControlledWorker(), new ControlledWorker()]
        const pool = createPool(workers)
        workers[1].throwOnDispatch = failure === 'dispatch-throw'
        let settled = false
        const pending = pool.compressWrappedBlocks(Uint32Array.of(1, 1, 1), (index) => Uint8Array.of(index), 'jmdict')
        void pending.finally(() => { settled = true }).catch(() => {})
        try {
            if (failure === 'first-error') { workers[0].reply(0, {error: 'first failure'}) }
            if (failure === 'middle-error') { workers[1].reply(0, {error: 'middle failure'}) }
            if (failure === 'invalid-reply') { workers[1].reply(0, {compressed: []}) }
            await flush()
            expect(settled).toBe(false)
            workers[2].reply(0)
            await flush()
            expect(settled).toBe(false)
            if (failure === 'first-error') {
                workers[1].reply(0)
            } else {
                workers[0].reply(0)
            }
            await expect(pending).rejects.toThrow()
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test('drains a dispatched prefix when a later packing allocation fails', async () => {
        const worker = new ControlledWorker()
        const pool = createPool([worker])
        let settled = false
        const failure = new RangeError('packing allocation failed')
        const pending = pool.compressWrappedBlocks(Uint32Array.of(1, 1, 1, 1), (index) => {
            if (index === 2) { throw failure }
            return Uint8Array.of(index)
        }, 'jmdict')
        void pending.finally(() => { settled = true }).catch(() => {})
        try {
            expect(worker.calls).toHaveLength(2)
            worker.reply(1, {error: 'peer failed too'})
            await flush()
            expect(settled).toBe(false)
            worker.reply(0)
            await expect(pending).rejects.toBe(failure)
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test.each(['view', 'shared', 'wrong-length'])('rejects %s packing output without transferring it', async (kind) => {
        const worker = new ControlledWorker()
        const pool = createPool([worker])
        const bytes = kind === 'shared' ? new Uint8Array(new SharedArrayBuffer(4)) : new Uint8Array(4)
        try {
            await expect(pool.compressWrappedBlocks(Uint32Array.of(kind === 'wrong-length' ? 3 : 4), () => (
                kind === 'view' ? bytes.subarray(1) : bytes
            ), 'jmdict')).rejects.toThrow()
            expect(worker.calls).toHaveLength(0)
            expect(bytes.byteLength).toBe(4)
        } finally { pool.close() }
    })

    test('closing the pool settles pending jobs and prevents another factory invocation', async () => {
        const worker = new ControlledWorker()
        const pool = createPool([worker])
        const createBlock = vi.fn(() => Uint8Array.of(1))
        const pending = pool.compressWrappedBlocks(Uint32Array.of(1, 1), createBlock, null)
        pool.close()
        await expect(pending).rejects.toThrow('closed')
        await expect(pool.compressWrappedBlocks(Uint32Array.of(1), createBlock, null)).rejects.toThrow('unavailable')
        expect(createBlock).toHaveBeenCalledTimes(2)
        expect(worker.terminateCount).toBe(1)
        expect(Reflect.get(pool, '_pending').size).toBe(0)
    })
})

/** @returns {Promise<typeof import('../ext/js/dictionary/zstd-term-content.js')>} */
async function loadCodec() {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const resource = new URL(String(input))
        if (resource.protocol !== 'file:') { throw new Error('Unexpected codec resource') }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}})
    })
    const api = await import('../ext/js/dictionary/zstd-term-content.js')
    await api.initializeTermContentZstd()
    return api
}

/**
 * @param {boolean} ready
 * @returns {Promise<{api: typeof import('../ext/js/dictionary/zstd-term-content.js'), workers: ControlledWorker[]}>}
 */
async function loadControlledCodec(ready) {
    /** @type {ControlledWorker[]} */
    const workers = []
    class CodecWorker extends ControlledWorker {
        constructor() { super(); workers.push(this) }
    }
    vi.stubGlobal('Worker', CodecWorker)
    const api = await loadCodec()
    expect(workers).toHaveLength(4)
    if (ready) {
        for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
        await flush()
    }
    return {api, workers}
}

describe('single packed block with an already ready compression pool', () => {
    test.each([null, 'jmdict'])('transfers one %s block and waits for its worker result', async (dictName) => {
        vi.resetModules()
        const {api, workers} = await loadControlledCodec(true)
        const source = new Uint8Array(4096).fill(7)
        const options = {experimentalGenericSpanCompression: true}
        const expected = api.compressWrappedTermContentZstd(source, dictName, options).bytes
        let settled = false
        try {
            const pending = api.compressWrappedTermContentZstdBlocks(Uint32Array.of(source.length), () => source, dictName, options)
            void pending.then(() => { settled = true }, () => { settled = true })
            expect(workers.map(({calls}) => calls.length)).toEqual([1, 0, 0, 0])
            expect(source.byteLength).toBe(0)
            await flush()
            expect(settled).toBe(false)
            workers[0].reply(0, {compressed: expected.buffer, envelopeMs: 0})
            const result = await pending
            expect(result.wrapped).toBe(true)
            expect(result.chunks).toEqual([expected])
            expect(api.decompressTermContentZstd(result.chunks[0].subarray(12), dictName)).toEqual(new Uint8Array(4096).fill(7))
            expect(workers).toHaveLength(4)
        } finally {
            for (const worker of workers) { worker.emit('error', {message: 'test cleanup'}) }
        }
    })

    test.each(['absent', 'starting', 'failed'])('keeps one block synchronous when the pool is %s', async (state) => {
        vi.resetModules()
        /** @type {ControlledWorker[]} */
        let workers = []
        /** @type {typeof import('../ext/js/dictionary/zstd-term-content.js')} */
        let api
        if (state === 'absent') {
            // eslint-disable-next-line unicorn/no-useless-undefined -- Initialize without a pool, then make workers available.
            vi.stubGlobal('Worker', undefined)
            api = await loadCodec()
            class UnexpectedWorker extends ControlledWorker {
                constructor() { super(); workers.push(this) }
            }
            vi.stubGlobal('Worker', UnexpectedWorker)
        } else {
            ({api, workers} = await loadControlledCodec(state === 'failed'))
            if (state === 'failed') { workers[0].emit('error', {message: 'injected idle worker failure'}) }
        }
        try {
            const source = new Uint8Array(4096).fill(8)
            const expected = api.compressWrappedTermContentZstd(source, null).bytes
            let settled = false
            const pending = api.compressWrappedTermContentZstdBlocks(Uint32Array.of(source.length), () => source, null)
            void pending.then(() => { settled = true }, () => { settled = true })
            await flush()
            expect(settled).toBe(true)
            expect(source.byteLength).toBe(4096)
            expect((await pending).chunks).toEqual([expected])
            expect(workers).toHaveLength(state === 'absent' ? 0 : 4)
            expect(workers.every(({calls}) => calls.length === 0)).toBe(true)
        } finally {
            for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
            await flush()
            for (const worker of workers) { worker.emit('error', {message: 'test cleanup'}) }
        }
    })

    test.each(['dispatch-throw', 'error-reply', 'invalid-reply'])('repacks the original source after a single-block %s', async (failure) => {
        vi.resetModules()
        const {api, workers} = await loadControlledCodec(true)
        const {TermContentOpfsStore} = await import('../ext/js/dictionary/term-content-opfs-store.js')
        const {TermContentBlockStore} = await import('../ext/js/dictionary/term-content-block-store.js')
        const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes: 8192, minInputBytes: 0})
        const source = Uint8Array.from({length: 4096}, (_, index) => index & 255)
        const offsets = Uint32Array.of(4, 1024, 2500)
        const lengths = Uint32Array.of(1000, 1000, 1000)
        const expected = Array.from(offsets, (offset, index) => source.slice(offset, offset + lengths[index]))
        workers[0].throwOnDispatch = failure === 'dispatch-throw'
        try {
            const pending = blockStore.tryAppendSpans(source, offsets, lengths, null, true)
            expect(workers[0].calls).toHaveLength(failure === 'dispatch-throw' ? 0 : 1)
            if (failure !== 'dispatch-throw') {
                const received = /** @type {Uint8Array} */ (workers[0].calls[0].content)
                expect(received).toEqual(Uint8Array.from(expected.flatMap((bytes) => [...bytes])))
                workers[0].reply(0, failure === 'error-reply' ? {error: 'injected worker failure'} : {compressed: []})
            }
            const result = await pending
            if (result === null) { throw new Error('Expected fallback block storage') }
            for (let index = 0; index < expected.length; ++index) {
                expect(await blockStore.read(result.contentOffsets[index], lengths[index], result.contentDictName)).toEqual(expected[index])
            }
            expect(source.byteLength).toBe(4096)
            expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1, 1, 1])
            await api.compressWrappedTermContentZstdBlocks(Uint32Array.of(4), () => Uint8Array.of(1, 2, 3, 4), null)
            expect(workers).toHaveLength(4)
        } finally {
            for (const worker of workers) { worker.emit('error', {message: 'test cleanup'}) }
        }
    })
})

describe('packed source snapshot boundary', () => {
    test.each([false, true])('snapshots source before await with workers ready=%s', async (ready) => {
        vi.resetModules()
        /** @type {ControlledWorker[]} */
        const workers = []
        class CodecWorker extends ControlledWorker {
            constructor() { super(); workers.push(this) }
            /**
             * @param {Record<string, unknown>} message
             * @param {Transferable[]} transfer
             */
            postMessage(message, transfer) {
                super.postMessage(message, transfer)
                const data = this.calls[this.calls.length - 1]
                const result = api.compressWrappedTermContentZstd(/** @type {Uint8Array} */ (data.content), 'jmdict')
                queueMicrotask(() => this.emit('message', {data: {id: data.id, compressed: result.bytes.buffer}}))
            }
        }
        vi.stubGlobal('Worker', CodecWorker)
        const api = await loadCodec()
        try {
            expect(workers).toHaveLength(4)
            if (ready) {
                for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
                await flush()
            }
            const {TermContentOpfsStore} = await import('../ext/js/dictionary/term-content-opfs-store.js')
            const {TermContentBlockStore} = await import('../ext/js/dictionary/term-content-block-store.js')
            const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes: 4, minInputBytes: 0})
            const source = Uint8Array.of(91, 2, 3, 4, 5, 6, 7, 8, 92)
            const offsets = Uint32Array.of(1, 5, 2)
            const lengths = Uint32Array.of(4, 3, 2)
            const expected = Array.from(offsets, (offset, index) => source.slice(offset, offset + lengths[index]))
            await expect(blockStore.tryAppendSpans(source, Uint32Array.of(1, 5, 8), lengths, 'jmdict', true)).rejects.toThrow('out of bounds')
            expect(workers.every(({calls}) => calls.length === 0)).toBe(true)
            const pending = blockStore.tryAppendSpans(source, offsets, lengths, 'jmdict', true)
            source.fill(0)
            structuredClone(source, {transfer: [source.buffer]})
            if (!ready) {
                expect(workers.every(({calls}) => calls.length === 0)).toBe(true)
                for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
            }
            const result = await pending
            if (result === null) { throw new Error('Expected block storage') }
            for (let index = 0; index < expected.length; ++index) {
                expect(await blockStore.read(result.contentOffsets[index], lengths[index], result.contentDictName)).toEqual(expected[index])
            }
            expect(workers.reduce((count, worker) => count + worker.calls.length, 0)).toBe(3)
        } finally {
            for (const worker of workers) { worker.emit('error', {message: 'test cleanup'}) }
        }
    })
})

describe('actual compression worker block equivalence', () => {
    test('preserves frames, envelopes and output ownership with real transferred messages', async () => {
        vi.resetModules()
        // eslint-disable-next-line unicorn/no-useless-undefined -- Remove the Worker global while initializing the main-thread codec.
        vi.stubGlobal('Worker', undefined)
        const api = await loadCodec()
        const moduleUrl = new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href
        const bridge = `
            import {parentPort, workerData} from 'node:worker_threads'
            import {readFile} from 'node:fs/promises'
            globalThis.self = {
                addEventListener(type, listener) {
                    if (type === 'message') parentPort.on('message', (data) => listener({data}))
                },
                postMessage(message, transfer = []) { parentPort.postMessage(message, transfer) }
            }
            globalThis.fetch = async (input) => new Response(await readFile(new URL(String(input))), {headers: {'Content-Type': 'application/wasm'}})
            await import(workerData.moduleUrl)
        `
        const nativeWorkers = Array.from({length: 3}, () => new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`), {workerData: {moduleUrl}}))
        try {
            await Promise.all(nativeWorkers.map((worker) => /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
                worker.once('error', reject)
                worker.once('message', (message) => {
                    if (message.type === 'ready') {
                        resolve()
                    } else {
                        reject(new Error(JSON.stringify(message)))
                    }
                })
            }))))
            const workers = nativeWorkers.map((worker) => ({
                addEventListener(/** @type {string} */ type, /** @type {(event: unknown) => void} */ listener) {
                    worker.on(type, (data) => listener(type === 'message' ? {data} : data))
                },
                postMessage(/** @type {Record<string, unknown>} */ message, /** @type {ArrayBuffer[]} */ transfer) {
                    worker.postMessage(message, transfer)
                },
                terminate() { void worker.terminate() },
            }))
            const pool = new api.TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
            for (const dictName of [null, 'jmdict']) {
                const lengths = Uint32Array.of(1, 1023, 1024, 65_537, 1_048_585, 11)
                const source = Array.from(lengths, (length, block) => Uint8Array.from({length}, (_, index) => (index * 131 + block + (index >>> 7)) & 255))
                const options = {experimentalGenericSpanCompression: true}
                const expected = source.map((content) => api.compressWrappedTermContentZstd(content, dictName, options).bytes)
                const result = await pool.compressWrappedBlocks(lengths, (index) => Uint8Array.from(source[index]), dictName, options)
                expect(result.wrapped).toBe(true)
                for (let index = 0; index < expected.length; ++index) {
                    expect(Buffer.compare(Buffer.from(result.chunks[index]), Buffer.from(expected[index]))).toBe(0)
                    expect(api.decompressTermContentZstd(result.chunks[index].subarray(12), dictName)).toEqual(source[index])
                }
                await pool.compressWrappedBlocks(Uint32Array.of(4, 4), () => Uint8Array.of(9, 8, 7, 6), dictName, options)
                for (let index = 0; index < expected.length; ++index) {
                    expect(Buffer.compare(Buffer.from(result.chunks[index]), Buffer.from(expected[index]))).toBe(0)
                }
            }
            pool.close()
        } finally { await Promise.all(nativeWorkers.map((worker) => worker.terminate())) }
    }, 30_000)
})
