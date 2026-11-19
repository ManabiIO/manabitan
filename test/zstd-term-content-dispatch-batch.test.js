/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

class BatchWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        /** @type {Array<{jobs: Record<string, unknown>[]}>} */
        this.envelopes = []
        this.throwOnPost = false
        this.postCount = 0
        this.terminateCount = 0
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
    }

    /** @param {{jobs: Record<string, unknown>[]}} message */
    postMessage(message) {
        ++this.postCount
        if (this.throwOnPost) { throw new Error('injected envelope post failure') }
        this.envelopes.push(structuredClone(message))
    }

    /** @returns {Record<string, unknown>[]} */
    get jobs() { return this.envelopes.flatMap(({jobs}) => jobs) }

    /**
     * @param {Record<string, unknown>} job
     * @param {Record<string, unknown>} response
     */
    reply(job, response) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {id: job.id, ...response}}))
        }
    }

    terminate() { ++this.terminateCount }
}

/**
 * @param {BatchWorker[]} workers
 * @param {number} count
 * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {{pool: TermContentCompressionPool, source: Uint8Array, offsets: Uint32Array, lengths: Uint32Array, operation: ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}}
 */
function start(workers, count, options = {}) {
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
    const source = new Uint8Array(new SharedArrayBuffer(count * (count + 1) / 2)).fill(7)
    const offsets = Uint32Array.from({length: count}, (_, i) => i * (i + 1) / 2)
    const lengths = Uint32Array.from({length: count}, (_, i) => i + 1)
    const starts = Uint32Array.from({length: count + 1}, (_, i) => i)
    const operation = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, new Uint32Array(lengths), 'jmdict', options)
    return {pool, source, offsets, lengths, operation}
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 10; ++i) { await Promise.resolve() }
}

describe('coalesced shared compression dispatch', () => {
    test('posts one envelope per worker with unchanged IDs, block assignment and snapshots', async () => {
        vi.useFakeTimers()
        const workers = [new BatchWorker(), new BatchWorker(), new BatchWorker()]
        const options = {experimentalGenericSpanCompression: false}
        const {pool, offsets, lengths, operation} = start(workers, 8, options)
        try {
            expect(workers.map(({postCount}) => postCount)).toEqual([1, 1, 1])
            expect(workers.map(({jobs}) => jobs.map(({id}) => id))).toEqual([[1, 4, 7], [2, 5, 8], [3, 6]])
            expect(vi.getTimerCount()).toBe(8)
            offsets.fill(99)
            lengths.fill(99)
            options.experimentalGenericSpanCompression = true
            for (const worker of workers) {
                for (const job of worker.jobs) {
                    const index = Number(job.id) - 1
                    expect([...(/** @type {Uint32Array} */ (job.sourceOffsets))]).toEqual([index * (index + 1) / 2])
                    expect([...(/** @type {Uint32Array} */ (job.sourceLengths))]).toEqual([index + 1])
                    expect(job.compressionExperiments).toMatchObject({experimentalGenericSpanCompression: false})
                    worker.reply(job, {type: 'source-consumed'})
                }
            }
            await expect(operation.sourceConsumed).resolves.toBeUndefined()
            for (const worker of [...workers].reverse()) {
                for (const job of [...worker.jobs].reverse()) {
                    worker.reply(job, {compressed: Uint8Array.of(Number(job.id)).buffer, envelopeMs: 1})
                }
            }
            const result = await operation.completion
            expect(result.chunks.map((bytes) => bytes[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
            expect(result.envelopeMs).toBe(3)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            pool.close()
            vi.useRealTimers()
        }
    })

    test.each(['post-failure', 'malformed-result', 'job-error'])(
        '%s drains every job in the other envelopes before rejecting either barrier',
        async (failure) => {
            const workers = [new BatchWorker(), new BatchWorker(), new BatchWorker()]
            workers[1].throwOnPost = failure === 'post-failure'
            const {pool, source, operation} = start(workers, 6)
            let sourceSettled = false
            let completionSettled = false
            void operation.sourceConsumed.finally(() => { sourceSettled = true }).catch(() => {})
            void operation.completion.finally(() => { completionSettled = true }).catch(() => {})
            try {
                if (failure !== 'post-failure') {
                    for (const job of workers[1].jobs) {
                        workers[1].reply(job, failure === 'malformed-result' ? {compressed: []} : {error: 'injected job failure'})
                    }
                }
                await flush()
                expect(workers.map(({postCount}) => postCount)).toEqual([1, 1, 1])
                expect(sourceSettled).toBe(false)
                expect(completionSettled).toBe(false)
                for (const worker of [workers[0], workers[2]]) {
                    for (const job of worker.jobs) { worker.reply(job, {type: 'source-consumed'}) }
                }
                await expect(operation.sourceConsumed).rejects.toThrow()
                expect(completionSettled).toBe(false)
                source.fill(0)
                for (const worker of [workers[0], workers[2]]) {
                    for (const job of worker.jobs) { worker.reply(job, {compressed: Uint8Array.of(Number(job.id)).buffer}) }
                }
                await expect(operation.completion).rejects.toThrow()
                expect(Reflect.get(pool, '_pending').size).toBe(0)
            } finally { pool.close() }
        },
    )

    test('retains per-job timeouts when another job in the same envelope completed', async () => {
        vi.useFakeTimers()
        const workers = [new BatchWorker(), new BatchWorker()]
        const {pool, operation} = start(workers, 4)
        try {
            workers[0].reply(workers[0].jobs[0], {compressed: Uint8Array.of(1).buffer})
            expect(vi.getTimerCount()).toBe(3)
            await vi.advanceTimersByTimeAsync(60_000)
            await expect(operation.sourceConsumed).rejects.toThrow('timed out')
            await expect(operation.completion).rejects.toThrow('timed out')
            expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
            expect(Reflect.get(pool, '_pending').size).toBe(0)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            pool.close()
            vi.useRealTimers()
        }
    })

    test('closing the pool terminates and settles all jobs in every envelope', async () => {
        const workers = [new BatchWorker(), new BatchWorker()]
        const {pool, operation} = start(workers, 6)
        workers[0].reply(workers[0].jobs[0], {type: 'source-consumed'})
        pool.close()
        await expect(operation.sourceConsumed).rejects.toThrow('closed')
        await expect(operation.completion).rejects.toThrow('closed')
        expect(Reflect.get(pool, '_pending').size).toBe(0)
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
    })

    test.each(['error', 'messageerror'])('%s terminates every worker before rejecting unread sources', async (type) => {
        const workers = [new BatchWorker(), new BatchWorker()]
        const {pool, operation} = start(workers, 6)
        for (const listener of workers[0].listeners.get(type) ?? []) { listener(new MessageEvent(type)) }
        await expect(operation.sourceConsumed).rejects.toThrow()
        await expect(operation.completion).rejects.toThrow()
        expect(Reflect.get(pool, '_pending').size).toBe(0)
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
        pool.close()
    })
})
