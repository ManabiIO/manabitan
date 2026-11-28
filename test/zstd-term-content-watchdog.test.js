/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        /** @type {Record<string, unknown>[]} */
        this.calls = []
        this.throwOnDispatch = false
        this.dispatchError = new Error('injected dispatch failure')
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

    /** @param {Record<string, unknown>} message */
    postMessage(message) {
        this.calls.push(message)
        if (this.throwOnDispatch) { throw this.dispatchError }
    }

    /**
     * @param {number} call
     * @param {Record<string, unknown>} response
     */
    reply(call, response) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {id: this.calls[call].id, ...response}}))
        }
    }

    /** @param {number} call */
    finish(call) { this.reply(call, {compressed: Uint8Array.of(call).buffer}) }

    terminate() { ++this.terminateCount }
}

/** @type {TermContentCompressionPool[]} */
let pools = []

/**
 * @param {number} [count]
 * @returns {{pool: TermContentCompressionPool, workers: ControlledWorker[], worker: ControlledWorker}}
 */
function createPool(count = 1) {
    const workers = Array.from({length: count}, () => new ControlledWorker())
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
    pools.push(pool)
    return {pool, workers, worker: workers[0]}
}

/**
 * @param {TermContentCompressionPool} pool
 * @returns {Promise<Uint8Array[]>}
 */
function dispatch(pool) {
    const completion = pool.compress([Uint8Array.of(7)], 'jmdict')
    void completion.catch(() => {})
    return completion
}

/**
 * @param {TermContentCompressionPool} pool
 * @param {number} count
 * @returns {ReturnType<TermContentCompressionPool['beginCompressWrappedSpans']>}
 */
function dispatchShared(pool, count) {
    return pool.beginCompressWrappedSpans(
        new Uint8Array(new SharedArrayBuffer(count)).fill(7),
        Uint32Array.from({length: count}, (_, i) => i),
        new Uint32Array(count).fill(1),
        Uint32Array.from({length: count + 1}, (_, i) => i),
        new Uint32Array(count).fill(1),
        'jmdict',
    )
}

/**
 * @param {unknown} callback
 * @returns {() => void}
 * @throws {TypeError} If the callback is not a function.
 */
function requireCallback(callback) {
    if (typeof callback !== 'function') { throw new TypeError('Expected a timer callback') }
    return /** @type {() => void} */ (callback)
}

beforeEach(() => {
    vi.useFakeTimers()
    pools = []
})

afterEach(() => {
    for (const pool of pools) { pool.close() }
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('compression pool deadline ownership', () => {
    test('one alarm covers overlapping jobs and survives out-of-order completion', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const clears = vi.spyOn(globalThis, 'clearTimeout')
        const {pool, worker} = createPool()
        const jobs = [dispatch(pool), dispatch(pool), dispatch(pool)]
        expect(timers).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(1)

        worker.finish(0)
        worker.finish(2)
        await Promise.all([jobs[0], jobs[2]])
        expect(timers).toHaveBeenCalledTimes(1)
        expect(clears).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)

        worker.finish(1)
        await expect(Promise.all(jobs)).resolves.toEqual([[Uint8Array.of(0)], [Uint8Array.of(1)], [Uint8Array.of(2)]])
        expect(clears).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        expect(pool.failed).toBe(false)
    })

    test('completing the first job preserves the later job dispatch deadline', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const {pool, worker} = createPool()
        const first = dispatch(pool)
        await vi.advanceTimersByTimeAsync(10_000)
        const later = dispatch(pool)
        worker.finish(0)
        await first

        await vi.advanceTimersByTimeAsync(50_000)
        expect(pool.failed).toBe(false)
        expect(worker.terminateCount).toBe(0)
        expect(timers).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(9_999)
        expect(pool.failed).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await expect(later).rejects.toThrow('timed out after 60000ms')
        expect(worker.terminateCount).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('a later completion cannot renew an earlier queued job deadline', async () => {
        const {pool, worker} = createPool()
        const first = dispatch(pool)
        await vi.advanceTimersByTimeAsync(10_000)
        const later = dispatch(pool)
        worker.finish(1)
        await later
        await vi.advanceTimersByTimeAsync(49_999)
        expect(pool.failed).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await expect(first).rejects.toThrow('timed out after 60000ms')
        expect(worker.terminateCount).toBe(1)
    })

    test('an early alarm re-arms the remaining deadline instead of failing work', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const {pool, worker} = createPool()
        const completion = dispatch(pool)
        const callback = requireCallback(timers.mock.calls[0][0])
        const handle = timers.mock.results[0].value
        await vi.advanceTimersByTimeAsync(1_000)
        clearTimeout(handle)
        callback()
        expect(pool.failed).toBe(false)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(58_999)
        expect(pool.failed).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await expect(completion).rejects.toThrow('timed out after 60000ms')
        expect(worker.terminateCount).toBe(1)
    })

    test('idle reuse rejects stale callbacks from the previous nonempty epoch', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const {pool, worker} = createPool()
        const first = dispatch(pool)
        const stale = requireCallback(timers.mock.calls[0][0])
        worker.finish(0)
        await first
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(10_000)
        const next = dispatch(pool)
        stale()
        expect(pool.failed).toBe(false)
        expect(vi.getTimerCount()).toBe(1)
        worker.finish(1)
        await next
        expect(vi.getTimerCount()).toBe(0)
        expect(worker.terminateCount).toBe(0)
    })

    test('a failed first dispatch retires its alarm and leaves the pool reusable', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const {pool, worker} = createPool()
        worker.throwOnDispatch = true
        await expect(dispatch(pool)).rejects.toBe(worker.dispatchError)
        const stale = requireCallback(timers.mock.calls[0][0])
        expect(pool.failed).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        worker.throwOnDispatch = false
        const next = dispatch(pool)
        stale()
        expect(pool.failed).toBe(false)
        worker.finish(1)
        await next
        expect(vi.getTimerCount()).toBe(0)
    })

    test('a failed later dispatch cannot remove the surviving job watchdog', async () => {
        const {pool, worker} = createPool()
        const first = dispatch(pool)
        await vi.advanceTimersByTimeAsync(100)
        worker.throwOnDispatch = true
        await expect(dispatch(pool)).rejects.toBe(worker.dispatchError)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(59_900)
        await expect(first).rejects.toThrow('timed out after 60000ms')
        expect(worker.terminateCount).toBe(1)
    })

    test('failure to create the first alarm rejects both barriers without dispatch', async () => {
        const failure = new Error('timer allocation failed')
        vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => { throw failure })
        const {pool, worker} = createPool()
        const operation = dispatchShared(pool, 1)
        await expect(operation.sourceConsumed).rejects.toBe(failure)
        await expect(operation.completion).rejects.toBe(failure)
        expect(worker.calls).toHaveLength(0)
        expect(pool.failed).toBe(false)
        expect(vi.getTimerCount()).toBe(0)

        const next = dispatch(pool)
        worker.finish(0)
        await next
        expect(vi.getTimerCount()).toBe(0)
    })

    test('failure to re-arm rejects surviving source and completion barriers', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const failure = new Error('timer re-arm failed')
        const {pool, worker} = createPool()
        const first = dispatchShared(pool, 1)
        await vi.advanceTimersByTimeAsync(10_000)
        const later = dispatchShared(pool, 1)
        worker.finish(0)
        await first.completion
        timers.mockImplementationOnce(() => { throw failure })

        await vi.advanceTimersByTimeAsync(50_000)
        await expect(later.sourceConsumed).rejects.toBe(failure)
        await expect(later.completion).rejects.toBe(failure)
        expect(worker.terminateCount).toBe(1)
        expect(pool.failed).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('source consumption does not retire the terminal-completion deadline', async () => {
        const {pool, worker} = createPool()
        const operation = dispatchShared(pool, 1)
        worker.reply(0, {type: 'source-consumed'})
        await expect(operation.sourceConsumed).resolves.toBeUndefined()
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(60_000)
        await expect(operation.completion).rejects.toThrow('timed out after 60000ms')
        await expect(operation.sourceConsumed).resolves.toBeUndefined()
        expect(worker.terminateCount).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('disposal drains both barriers once and invalidates a queued callback', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const {pool, workers} = createPool(2)
        const operation = dispatchShared(pool, 2)
        const stale = requireCallback(timers.mock.calls[0][0])
        workers[0].reply(0, {type: 'source-consumed'})
        pool.close()
        const [sourceError, completionError] = await Promise.all([
            operation.sourceConsumed.catch((error) => error),
            operation.completion.catch((error) => error),
        ])
        expect(sourceError).toBe(completionError)
        expect(sourceError).toEqual(new Error('Term content compression pool closed'))
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
        expect(vi.getTimerCount()).toBe(0)
        stale()
        pool.close()
        expect(workers.map(({terminateCount}) => terminateCount)).toEqual([1, 1])
        expect(vi.getTimerCount()).toBe(0)
    })
})
