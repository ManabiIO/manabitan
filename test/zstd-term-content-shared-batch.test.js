/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker as NodeWorker} from 'node:worker_threads'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {
    compressWrappedTermContentZstd,
    decompressTermContentZstd,
    initializeTermContentZstd,
    TermContentCompressionPool,
} from '../ext/js/dictionary/zstd-term-content.js'

beforeAll(async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- Initialize the local reference codec without creating a browser worker pool.
    vi.stubGlobal('Worker', undefined)
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => new Response(await readFile(new URL(String(input))), {headers: {'Content-Type': 'application/wasm'}}))
    await initializeTermContentZstd()
})
afterAll(() => { vi.unstubAllGlobals() })

const bridge = `
    import {parentPort, workerData} from 'node:worker_threads'
    import {readFile} from 'node:fs/promises'
    const gate = new Int32Array(workerData.gate)
    globalThis.self = {
        addEventListener(type, listener) {
            if (type === 'message') parentPort.on('message', (data) => {
                if (workerData.blockBeforeHandle) {
                    parentPort.postMessage({type: 'test-blocked'})
                    Atomics.wait(gate, 0, 0, 30000)
                }
                listener({data})
            })
        },
        postMessage(message, transfer = []) {
            parentPort.postMessage(message, transfer)
            if (workerData.gateOnConsumed && (message.type === 'sources-consumed' || message.type === 'source-consumed')) {
                Atomics.wait(gate, 0, 0, 30000)
            }
        }
    }
    globalThis.fetch = async (input) => {
        if (workerData.failInitialization && String(input).endsWith('.zdict')) throw new Error('injected codec initialization failure')
        return new Response(await readFile(new URL(String(input))), {headers: {'Content-Type': 'application/wasm'}})
    }
    await import(workerData.moduleUrl)
`

/**
 * @param {number} count
 * @param {{gateOnConsumed?: boolean, failInitialization?: boolean, blockBeforeHandle?: boolean}} [options]
 * @returns {Promise<{pool: TermContentCompressionPool, calls: Array<Array<Record<string, unknown>>>, replies: Array<Array<Record<string, unknown>>>, nativeWorkers: NodeWorker[], gate: Int32Array, close: () => Promise<void>}>}
 */
async function createWorkers(count, options = {}) {
    const gate = new Int32Array(new SharedArrayBuffer(4))
    const moduleUrl = new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href
    const nativeWorkers = Array.from({length: count}, () => new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`), {
        workerData: {moduleUrl, gate: gate.buffer, ...options},
    }))
    /** @type {Array<Array<Record<string, unknown>>>} */
    const calls = Array.from({length: count}, () => [])
    /** @type {Array<Array<Record<string, unknown>>>} */
    const replies = Array.from({length: count}, () => [])
    const workers = nativeWorkers.map((worker, index) => {
        worker.on('message', (message) => { replies[index].push(message) })
        return {
            addEventListener(/** @type {string} */ type, /** @type {(event: import('core').SafeAny) => void} */ listener) {
                worker.on(type, (data) => listener(type === 'message' ? {data} : data))
            },
            postMessage(/** @type {Record<string, unknown>} */ message, /** @type {ArrayBuffer[]} */ transfer = []) {
                calls[index].push(message)
                worker.postMessage(message, transfer)
            },
            terminate() { void worker.terminate() },
        }
    })
    try {
        await Promise.all(nativeWorkers.map((worker) => /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            worker.once('error', reject)
            worker.once('message', (message) => {
                if (message.type === (options.failInitialization ? 'initialization-error' : 'ready')) {
                    resolve()
                } else {
                    reject(new Error(JSON.stringify(message)))
                }
            })
        }))))
    } catch (error) {
        await Promise.all(nativeWorkers.map((worker) => worker.terminate()))
        throw error
    }
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
    return {
        pool,
        calls,
        replies,
        nativeWorkers,
        gate,
        async close() {
            pool.close()
            Atomics.store(gate, 0, 1)
            Atomics.notify(gate, 0)
            await Promise.all(nativeWorkers.map((worker) => worker.terminate()))
        },
    }
}

/**
 * @param {number[]} sizes
 * @returns {{source: Uint8Array, offsets: Uint32Array, lengths: Uint32Array, starts: Uint32Array, blockLengths: Uint32Array, packed: Uint8Array[]}}
 */
function createPlan(sizes) {
    /** @type {number[]} */
    const offsets = []
    /** @type {number[]} */
    const lengths = []
    const starts = [0]
    let position = 0
    for (const size of sizes) {
        const first = Math.ceil(size / 2)
        offsets.push(position)
        lengths.push(first)
        position += first + 7
        if (size > first) {
            offsets.push(position)
            lengths.push(size - first)
            position += size - first + 11
        }
        starts.push(offsets.length)
    }
    const source = new Uint8Array(new SharedArrayBuffer(position + 23), 9, position)
    for (let index = 0; index < source.length; ++index) { source[index] = (index * 131 + (index >>> 7)) & 255 }
    const packed = sizes.map((size, block) => {
        const content = new Uint8Array(size)
        let cursor = 0
        for (let index = starts[block]; index < starts[block + 1]; ++index) {
            content.set(source.subarray(offsets[index], offsets[index] + lengths[index]), cursor)
            cursor += lengths[index]
        }
        return content
    })
    return {source, offsets: new Uint32Array(offsets), lengths: new Uint32Array(lengths), starts: new Uint32Array(starts), blockLengths: new Uint32Array(sizes), packed}
}

describe('actual shared-span compression transport', () => {
    test.each([null, 'jmdict'])('keeps %s frames exact after caller metadata and acknowledged source reuse', async (dictName) => {
        const state = await createWorkers(3, {gateOnConsumed: true})
        const {pool, gate, calls, replies} = state
        try {
            const plan = createPlan([1, 1023, 1024, 65_537, 1_048_585, 11, 87, 4096, 65_536])
            const options = {experimentalGenericSpanCompression: true}
            const expected = plan.packed.map((content) => compressWrappedTermContentZstd(content, dictName, options).bytes)
            const operation = pool.beginCompressWrappedSpans(plan.source, plan.offsets, plan.lengths, plan.starts, plan.blockLengths, dictName, options)
            plan.offsets.fill(0)
            plan.lengths.fill(0)
            plan.starts.fill(0)
            plan.blockLengths.fill(0)
            options.experimentalGenericSpanCompression = false
            let completed = false
            void operation.completion.then(() => { completed = true })
            await operation.sourceConsumed
            expect(completed).toBe(false)
            plan.source.fill(0)
            Atomics.store(gate, 0, 1)
            Atomics.notify(gate, 0)
            const result = await operation.completion
            expect(result.wrapped).toBe(true)
            expect(calls.map((workerCalls) => workerCalls.length)).toEqual([1, 1, 1])
            expect(calls.map(([message]) => /** @type {unknown[]} */ (message.spanBatch).length)).toEqual([3, 3, 3])
            expect(replies.map((messages) => messages.map(({type}) => type))).toEqual(Array.from({length: 3}, () => ['ready', 'sources-consumed', 'compression-results']))
            for (let index = 0; index < expected.length; ++index) {
                expect(Buffer.compare(Buffer.from(result.chunks[index]), Buffer.from(expected[index]))).toBe(0)
                expect(decompressTermContentZstd(result.chunks[index].subarray(12), dictName)).toEqual(plan.packed[index])
            }
            const later = createPlan([17, 19, 23, 29, 31, 37])
            await pool.compressWrappedSpans(later.source, later.offsets, later.lengths, later.starts, later.blockLengths, dictName, {experimentalGenericSpanCompression: true})
            for (let index = 0; index < expected.length; ++index) {
                expect(Buffer.compare(Buffer.from(result.chunks[index]), Buffer.from(expected[index]))).toBe(0)
            }
            expect(Reflect.get(pool, '_pending').size).toBe(0)
            expect(Reflect.get(pool, '_sharedTimeouts').size).toBe(0)
        } finally { await state.close() }
    }, 30_000)

    test('drains valid later jobs on every worker after a native gather failure', async () => {
        const state = await createWorkers(2)
        const {pool, calls, replies} = state
        try {
            const plan = createPlan([32, 33, 34, 35, 36, 37])
            plan.offsets[plan.starts[1]] = plan.source.length + 1
            const operation = pool.beginCompressWrappedSpans(plan.source, plan.offsets, plan.lengths, plan.starts, plan.blockLengths, 'jmdict')
            await expect(operation.sourceConsumed).rejects.toThrow('bounds')
            plan.source.fill(0)
            await expect(operation.completion).rejects.toThrow('bounds')
            const failedBatch = /** @type {Array<{id: number}>} */ (calls[1][0].spanBatch)
            const laterIds = replies[1].flatMap((message) => (Array.isArray(message.results) ? message.results.map((result) => result.id) : []))
            expect(laterIds).toEqual(failedBatch.slice(1).map(({id}) => id))
            expect(Reflect.get(pool, '_pending').size).toBe(0)
            expect(Reflect.get(pool, '_sharedTimeouts').size).toBe(0)
            const valid = createPlan([41, 43, 47, 53])
            const result = await pool.compressWrappedSpans(valid.source, valid.offsets, valid.lengths, valid.starts, valid.blockLengths, 'jmdict')
            expect(result.chunks).toHaveLength(4)
        } finally { await state.close() }
    }, 30_000)

    test('rejects every batched job when the actual worker codec cannot initialize', async () => {
        const state = await createWorkers(1, {failInitialization: true})
        try {
            const plan = createPlan([17, 19, 23])
            const operation = state.pool.beginCompressWrappedSpans(plan.source, plan.offsets, plan.lengths, plan.starts, plan.blockLengths, 'jmdict')
            await expect(operation.sourceConsumed).rejects.toThrow('injected codec initialization failure')
            await expect(operation.completion).rejects.toThrow('injected codec initialization failure')
            expect(Reflect.get(state.pool, '_pending').size).toBe(0)
            expect(Reflect.get(state.pool, '_sharedTimeouts').size).toBe(0)
        } finally { await state.close() }
    }, 30_000)

    test('cancels an actual worker while its shared batch is still unread', async () => {
        const state = await createWorkers(1, {blockBeforeHandle: true})
        try {
            const blocked = new Promise((resolve) => { state.nativeWorkers[0].once('message', resolve) })
            const plan = createPlan([17, 19, 23])
            const original = new Uint8Array(plan.source)
            const operation = state.pool.beginCompressWrappedSpans(plan.source, plan.offsets, plan.lengths, plan.starts, plan.blockLengths, 'jmdict')
            await expect(blocked).resolves.toEqual({type: 'test-blocked'})
            state.pool.close()
            await expect(operation.sourceConsumed).rejects.toThrow('pool closed')
            await expect(operation.completion).rejects.toThrow('pool closed')
            expect(plan.source).toEqual(original)
            expect(Reflect.get(state.pool, '_pending').size).toBe(0)
            expect(Reflect.get(state.pool, '_sharedTimeouts').size).toBe(0)
        } finally { await state.close() }
    }, 30_000)
})
