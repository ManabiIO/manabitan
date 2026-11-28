/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

/** @typedef {{source: Uint8Array, sourceOffsets: Uint32Array, sourceLengths: Uint32Array, blockStartIndexes: Uint32Array, blockLengths: Uint32Array, nextBlock: Uint32Array, remainingSources: Uint32Array, batchId: number, jobIds: number[]}} SpanBatch */

class ControlledBatchWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        /** @type {SpanBatch[]} */
        this.calls = []
        this.claimed = new Set()
        this.throwOnDispatch = false
        this.terminateCount = 0
        /** @type {(() => void)|null} */
        this.onDispatch = null
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

    /** @param {Record<string, unknown>} message */
    postMessage(message) {
        if (this.throwOnDispatch) { throw new Error('injected batch dispatch failure') }
        expect(message.type).toBe('compress-spans-batch')
        this.calls.push(/** @type {SpanBatch} */ (structuredClone(message)))
        this.onDispatch?.()
    }

    /** @returns {number|null} */
    claim() {
        expect(this.terminateCount).toBe(0)
        const {nextBlock, jobIds} = this.calls[0]
        const block = Atomics.load(nextBlock, 0)
        if (block >= jobIds.length) { return null }
        Atomics.store(nextBlock, 0, block + 1)
        this.claimed.add(block)
        return block
    }

    /**
     * @param {number} block
     * @param {Record<string, unknown>} response
     */
    reply(block, response) {
        expect(this.claimed.has(block)).toBe(true)
        this.emit({id: this.calls[0].jobIds[block], ...response})
    }

    /** @param {number} block */
    gather(block) {
        expect(this.claimed.has(block)).toBe(true)
        const batch = this.calls[0]
        const previous = Atomics.sub(batch.remainingSources, 0, 1)
        expect(previous).toBeGreaterThan(0)
        if (previous === 1) { this.emit({type: 'source-consumed-batch', batchId: batch.batchId}) }
    }

    /** @param {Record<string, unknown>} data */
    emit(data) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data}))
        }
    }

    terminate() { ++this.terminateCount }
}

/**
 * @param {ControlledBatchWorker[]} workers
 * @returns {{pool: TermContentCompressionPool, source: Uint8Array, offsets: Uint32Array, lengths: Uint32Array, starts: Uint32Array, sizes: Uint32Array, operation: ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}}
 */
function start(workers) {
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
    const source = new Uint8Array(new SharedArrayBuffer(20))
    for (let block = 0; block < 5; ++block) { source.fill(block + 1, block * 4, (block + 1) * 4) }
    const offsets = Uint32Array.of(0, 4, 8, 12, 16)
    const lengths = Uint32Array.of(4, 4, 4, 4, 4)
    const starts = Uint32Array.of(0, 1, 2, 3, 4, 5)
    const sizes = Uint32Array.of(4, 4, 4, 4, 4)
    const operation = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, sizes, 'jmdict')
    return {pool, source, offsets, lengths, starts, sizes, operation}
}

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('shared compression batch claims', () => {
    test('acknowledges all sources at the last gather while final results remain pending', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, source, operation} = start(workers)
        let consumed = false
        let completed = false
        void operation.sourceConsumed.then(() => { consumed = true })
        void operation.completion.then(() => { completed = true })
        try {
            expect(workers[0].claim()).toBe(0)
            for (let block = 1; block < 5; ++block) {
                expect(workers[1].claim()).toBe(block)
                workers[1].gather(block)
                if (block < 4) { workers[1].reply(block, {compressed: Uint8Array.of(block + 1).buffer}) }
            }
            await flush()
            expect(consumed).toBe(false)
            expect(completed).toBe(false)
            workers[0].gather(0)
            await operation.sourceConsumed
            expect(completed).toBe(false)
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
            expect(Reflect.get(pool, '_pending').size).toBe(2)
            source.fill(0)
            workers[1].reply(4, {compressed: Uint8Array.of(5).buffer})
            workers[0].reply(0, {compressed: Uint8Array.of(1).buffer})
            expect((await operation.completion).chunks.map((bytes) => [...bytes])).toEqual([[1], [2], [3], [4], [5]])
        } finally { pool.close() }
    })

    test('fulfills an already-gathered source on error before the final batch acknowledgement', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        try {
            expect(workers[0].claim()).toBe(0)
            workers[0].gather(0)
            workers[0].reply(0, {error: 'compression failed after gathering', hasGathered: true})
            for (let block = 1; block < 5; ++block) {
                expect(workers[1].claim()).toBe(block)
                workers[1].gather(block)
                if (block < 4) { workers[1].reply(block, {compressed: Uint8Array.of(block + 1).buffer}) }
            }
            await expect(operation.sourceConsumed).resolves.toBeUndefined()
            expect(Reflect.get(pool, '_pending').size).toBe(1)
            workers[1].reply(4, {compressed: Uint8Array.of(5).buffer})
            await expect(operation.completion).rejects.toThrow('compression failed after gathering')
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
        } finally { pool.close() }
    })

    test('delays a pre-gather source failure until all ordinary job replies drain', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        let settled = false
        void operation.sourceConsumed.finally(() => { settled = true }).catch(() => {})
        try {
            expect(workers[0].claim()).toBe(0)
            workers[0].reply(0, {error: 'gather failed', hasGathered: false})
            for (let block = 1; block < 5; ++block) {
                expect(workers[1].claim()).toBe(block)
                workers[1].gather(block)
            }
            expect(Atomics.load(workers[0].calls[0].remainingSources, 0)).toBe(1)
            await flush()
            expect(settled).toBe(false)
            for (let block = 1; block < 4; ++block) { workers[1].reply(block, {compressed: Uint8Array.of(block + 1).buffer}) }
            await flush()
            expect(settled).toBe(false)
            workers[1].reply(4, {compressed: Uint8Array.of(5).buffer})
            await expect(operation.sourceConsumed).rejects.toThrow('gather failed')
            await expect(operation.completion).rejects.toThrow('gather failed')
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
        } finally { pool.close() }
    })

    test('keeps concurrent batches isolated and retires completed, duplicate and late acknowledgements', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, source, offsets, lengths, starts, sizes, operation: first} = start(workers)
        const second = pool.beginCompressWrappedSpans(source, offsets, lengths, starts, sizes, 'jmdict')
        let secondConsumed = false
        void second.sourceConsumed.then(() => { secondConsumed = true }).catch(() => {})
        try {
            const [a, b] = workers[0].calls
            expect(a.batchId).not.toBe(b.batchId)
            expect(a.remainingSources.buffer).not.toBe(b.remainingSources.buffer)
            workers[0].emit({type: 'source-consumed-batch', batchId: b.batchId + 100})
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(2)
            Atomics.store(a.nextBlock, 0, 5)
            Atomics.store(a.remainingSources, 0, 0)
            workers[0].emit({type: 'source-consumed-batch', batchId: a.batchId})
            await first.sourceConsumed
            expect(secondConsumed).toBe(false)
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(1)
            workers[1].emit({type: 'source-consumed-batch', batchId: a.batchId})
            for (const id of a.jobIds) { workers[0].emit({id, compressed: Uint8Array.of(id).buffer}) }
            await first.completion
            workers[0].emit({id: b.jobIds[0], error: 'second batch gather failed'})
            for (const id of b.jobIds.slice(1)) { workers[1].emit({id, compressed: Uint8Array.of(id).buffer}) }
            await expect(second.sourceConsumed).rejects.toThrow('second batch gather failed')
            await expect(second.completion).rejects.toThrow('second batch gather failed')
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
            workers[0].emit({type: 'source-consumed-batch', batchId: b.batchId})
            expect(pool.failed).toBe(false)
        } finally { pool.close() }
    })

    test.each(['unread', 'unclaimed', 'invalid id'])('terminates every reader before rejecting a malformed %s batch acknowledgement', async (condition) => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        let terminationsAtRelease
        void operation.sourceConsumed.finally(() => { terminationsAtRelease = workers.map(({terminateCount}) => terminateCount) }).catch(() => {})
        const batch = workers[0].calls[0]
        if (condition === 'unclaimed') { Atomics.store(batch.remainingSources, 0, 0) }
        workers[0].emit({type: 'source-consumed-batch', batchId: condition === 'invalid id' ? 'invalid' : batch.batchId})
        await expect(operation.sourceConsumed).rejects.toThrow()
        await expect(operation.completion).rejects.toThrow()
        expect(terminationsAtRelease).toEqual([1, 1])
        expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
        expect(Reflect.get(pool, '_pending').size).toBe(0)
    })

    test('clears immediate result timers while a gathered but unfinished block keeps its admission deadline', async () => {
        vi.useFakeTimers()
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        try {
            for (let block = 0; block < 5; ++block) {
                expect(workers[0].claim()).toBe(block)
                workers[0].gather(block)
                if (block < 4) { workers[0].reply(block, {compressed: Uint8Array.of(block).buffer}) }
            }
            await operation.sourceConsumed
            expect(vi.getTimerCount()).toBe(1)
            await vi.advanceTimersByTimeAsync(60_000)
            await expect(operation.completion).rejects.toThrow('timed out after 60000ms')
            expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
            expect(Reflect.get(pool, '_sourceBatches').size).toBe(0)
        } finally { pool.close(); vi.useRealTimers() }
    })

    test('lets a free worker claim later blocks, snapshots metadata and restores ordered output', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, source, offsets, lengths, starts, sizes, operation} = start(workers)
        let consumed = false
        let completed = false
        void operation.sourceConsumed.then(() => { consumed = true })
        void operation.completion.then(() => { completed = true })
        try {
            for (const column of [offsets, lengths, starts, sizes]) { column.fill(99) }
            expect(workers[0].claim()).toBe(0)
            for (let block = 1; block < 5; ++block) {
                expect(workers[1].claim()).toBe(block)
                const batch = workers[1].calls[0]
                expect(batch.blockStartIndexes[block]).toBe(block)
                expect(batch.blockLengths[block]).toBe(4)
                expect(batch.sourceLengths[block]).toBe(4)
                expect(batch.source[batch.sourceOffsets[block]]).toBe(block + 1)
                workers[1].reply(block, {type: 'source-consumed'})
                workers[1].reply(block, {compressed: Uint8Array.of(block + 1).buffer, envelopeMs: block + 1})
            }
            expect(workers[1].claim()).toBeNull()
            expect(workers.map(({calls}) => calls.length)).toEqual([1, 1])
            await flush()
            expect(consumed).toBe(false)
            expect(completed).toBe(false)
            workers[0].reply(0, {type: 'source-consumed'})
            await operation.sourceConsumed
            source.fill(0)
            expect(completed).toBe(false)
            workers[0].reply(0, {compressed: Uint8Array.of(1).buffer, envelopeMs: 1})
            const result = await operation.completion
            expect(result.chunks.map((bytes) => [...bytes])).toEqual([[1], [2], [3], [4], [5]])
            expect(result.envelopeMs).toBe(14)
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test('holds both barriers after a first-block error while sibling and unclaimed blocks drain', async () => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        let consumed = false
        let completed = false
        void operation.sourceConsumed.finally(() => { consumed = true }).catch(() => {})
        void operation.completion.finally(() => { completed = true }).catch(() => {})
        try {
            expect(workers[0].claim()).toBe(0)
            expect(workers[1].claim()).toBe(1)
            workers[0].reply(0, {error: 'first block failed before source copy'})
            await flush()
            expect(consumed).toBe(false)
            expect(completed).toBe(false)
            workers[1].reply(1, {compressed: Uint8Array.of(2).buffer})
            for (let block = 2; block < 5; ++block) {
                expect(workers[0].claim()).toBe(block)
                workers[0].reply(block, {type: 'source-consumed'})
                if (block < 4) { workers[0].reply(block, {compressed: Uint8Array.of(block + 1).buffer}) }
            }
            await expect(operation.sourceConsumed).rejects.toThrow('first block failed before source copy')
            expect(completed).toBe(false)
            workers[0].reply(4, {error: 'later block failed after source copy'})
            await expect(operation.completion).rejects.toThrow('first block failed before source copy')
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test.each(['dispatch', 'protocol', 'close'])('%s failure terminates every reader before releasing unclaimed sources', async (failure) => {
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        workers[1].throwOnDispatch = failure === 'dispatch'
        if (failure === 'dispatch') {
            workers[0].onDispatch = () => { expect(workers[0].claim()).toBe(0) }
        }
        const {pool, operation} = start(workers)
        let terminationsAtRelease
        void operation.sourceConsumed.finally(() => { terminationsAtRelease = workers.map(({terminateCount}) => terminateCount) }).catch(() => {})
        if (failure === 'protocol') {
            expect(workers[0].claim()).toBe(0)
            workers[0].emit({type: 'batch-error', error: 'invalid shared batch'})
        } else if (failure === 'close') {
            expect(workers[0].claim()).toBe(0)
            pool.close()
        }
        await expect(operation.sourceConsumed).rejects.toThrow()
        await expect(operation.completion).rejects.toThrow()
        expect(terminationsAtRelease).toEqual([1, 1])
        expect(workers[0].claimed.has(0)).toBe(true)
        expect(Reflect.get(pool, '_pending').size).toBe(0)
        expect(pool.failed).toBe(true)
        pool.close()
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
    })

    test('keeps the admission deadline for blocks claimed late', async () => {
        vi.useFakeTimers()
        const workers = [new ControlledBatchWorker(), new ControlledBatchWorker()]
        const {pool, operation} = start(workers)
        try {
            expect(workers[0].claim()).toBe(0)
            await vi.advanceTimersByTimeAsync(40_000)
            workers[0].reply(0, {compressed: Uint8Array.of(1).buffer})
            expect(workers[0].claim()).toBe(1)
            await vi.advanceTimersByTimeAsync(20_000)
            await expect(operation.sourceConsumed).rejects.toThrow('timed out after 60000ms')
            await expect(operation.completion).rejects.toThrow('timed out after 60000ms')
            expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally {
            pool.close()
            vi.useRealTimers()
        }
    })
})
