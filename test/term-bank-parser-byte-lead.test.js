/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    disposeParallelTermBankParser,
    parseTermBankWithWasmColumnChunksParallelLazy,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const MiB = 1024 * 1024
const targetBytes = 24 * MiB
const byteBudget = 3 * targetBytes
const emptyBank = new TextEncoder().encode('[]')
/** @typedef {{type: string, id?: number, sourceBuffers?: ArrayBuffer[]}} WorkerRequest */
/** @typedef {{id: number, worker: ControlledWorker, responded: boolean, sourceCount: number}} Job */
/** @typedef {{heldSinks?: number[], delayedSource?: number, sinkFailure?: boolean, groupCount?: number}} HarnessOptions */
/** @type {(() => Promise<void>)|null} */
let cleanupRun = null
/** @type {Job[]} */
let jobs = []
/** @type {ControlledWorker[]} */
let workers = []

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        this.terminated = false
        workers.push(this)
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
    }

    /** @param {WorkerRequest} message */
    postMessage(message) {
        if (message.type === 'initialize') {
            queueMicrotask(() => { this.emit({type: 'ready'}) })
            return
        }
        if (typeof message.id !== 'number') { throw new Error('Missing parser job ID') }
        jobs.push({id: message.id, worker: this, responded: false, sourceCount: message.sourceBuffers?.length ?? 0})
    }

    /** @param {unknown} data */
    emit(data) {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data}))
        }
    }

    terminate() {
        this.terminated = true
    }
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

beforeEach(() => {
    jobs = []
    workers = []
    vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
    vi.stubGlobal('Worker', ControlledWorker)
})

afterEach(async () => {
    await cleanupRun?.()
    cleanupRun = null
    await disposeParallelTermBankParser()
    vi.unstubAllGlobals()
})

/** @returns {Promise<void>} */
async function flushTasks() {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * @param {number} id
 * @returns {Promise<Job>}
 */
async function waitForJob(id) {
    await vi.waitFor(() => { expect(jobs.some((job) => job.id === id)).toBe(true) })
    return /** @type {Job} */ (jobs.find((job) => job.id === id))
}

/**
 * @param {number} id
 * @param {number} [byteLength=1]
 * @param {boolean} [empty=false]
 * @returns {Promise<void>}
 */
async function completeJob(id, byteLength = 1, empty = false) {
    const job = await waitForJob(id)
    expect(job.responded).toBe(false)
    job.responded = true
    const bytes = new Uint8Array(new SharedArrayBuffer(byteLength))
    if (byteLength > 0) {
        bytes[0] = id
        bytes[byteLength - 1] = id
    }
    job.worker.emit({
        type: 'result',
        id,
        rowCount: empty ? 0 : 1,
        resultSentEpochMs: Date.now(),
        ownsContentBytes: !empty,
        chunk: empty ? null : {rowCount: 1, contentBytesBuffer: bytes},
        profile: {rowCount: empty ? 0 : 1, chunkDispatchMs: 0},
    })
    await flushTasks()
}

/**
 * @param {number[]} estimates
 * @param {HarnessOptions} [options]
 * @returns {{outcome: Promise<boolean|Error>, sinkIndexes: number[], releaseSink: (index: number) => void, cancel: () => void, failSource: () => void, settled: () => boolean, finish: () => Promise<boolean|Error>}}
 */
function startRun(estimates, options = {}) {
    let cancelled = false
    let settled = false
    /** @type {number[]} */
    const sinkIndexes = []
    const gates = new Map((options.heldSinks ?? []).map((index) => [index, /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())]))
    const delayedSource = /** @type {PromiseWithResolvers<Uint8Array>} */ (Promise.withResolvers())
    // A delayed source may be prefetched before its parser admission. Keep its
    // rejection observed even if this test ends before the source is requested.
    void delayedSource.promise.catch(() => {})
    const parsing = parseTermBankWithWasmColumnChunksParallelLazy(
        estimates.map((_bytes, index) => async () => (
            index + 1 === options.delayedSource ? delayedSource.promise : new Uint8Array(emptyBank)
        )),
        estimates,
        3,
        async (chunk, progress) => {
            sinkIndexes.push(progress.chunkIndex)
            const bytes = /** @type {Uint8Array} */ (chunk.contentBytesBuffer)
            expect(bytes[0]).toBe(progress.chunkIndex)
            expect(bytes[bytes.length - 1]).toBe(progress.chunkIndex)
            await gates.get(progress.chunkIndex)?.promise
            expect(bytes[0]).toBe(progress.chunkIndex)
            expect(bytes[bytes.length - 1]).toBe(progress.chunkIndex)
            if (options.sinkFailure === true && progress.chunkIndex === 1) { throw new Error('controlled sink failure') }
        },
        {emitContentSlab: true},
        () => cancelled,
    )
    const outcome = parsing.then(
        (value) => { settled = true; return value },
        (/** @type {Error} */ error) => { settled = true; return error },
    )
    cleanupRun = async () => {
        cancelled = true
        delayedSource.resolve(new Uint8Array(emptyBank))
        for (const gate of gates.values()) { gate.resolve() }
        await outcome
    }
    return {
        outcome,
        sinkIndexes,
        releaseSink: (index) => { gates.get(index)?.resolve() },
        cancel: () => { cancelled = true },
        failSource: () => { delayedSource.reject(new Error('controlled source failure')) },
        settled: () => settled,
        finish: async () => {
            for (const gate of gates.values()) { gate.resolve() }
            for (let id = 1; id <= (options.groupCount ?? estimates.length); ++id) {
                const job = await waitForJob(id)
                if (!job.responded) { await completeJob(id) }
            }
            return await outcome
        },
    }
}

describe('byte-aware ordered parser admission', () => {
    test.each([
        {sourceCount: 8, sourcesPerGroup: 1, groupCount: 8},
        {sourceCount: 24, sourcesPerGroup: 2, groupCount: 12},
    ])('reserves every bank in $sourcesPerGroup-bank groups and retains owned bytes until their sinks settle', async ({sourceCount, sourcesPerGroup, groupCount}) => {
        const run = startRun(Array.from({length: sourceCount}, () => targetBytes / sourcesPerGroup), {heldSinks: [1, 2], groupCount})
        await waitForJob(3)
        expect(workers).toHaveLength(3)
        await completeJob(3, targetBytes)
        await completeJob(2, targetBytes)
        await completeJob(1, targetBytes)
        expect(run.sinkIndexes).toEqual([1])
        expect(jobs.map(({id}) => id)).toEqual([1, 2, 3])
        expect(jobs.map((job) => job.sourceCount)).toEqual([sourcesPerGroup, sourcesPerGroup, sourcesPerGroup])
        run.releaseSink(1)
        await waitForJob(4)
        await completeJob(4, targetBytes)
        expect(run.sinkIndexes).toEqual([1, 2])
        expect(jobs.map(({id}) => id)).toEqual([1, 2, 3, 4])
        expect(await run.finish()).toBe(true)
        expect(run.sinkIndexes).toEqual(Array.from({length: groupCount}, (_value, index) => index + 1))
        const profile = consumeLastTermBankWasmParseProfile()
        expect(profile?.parallelContentByteBudget).toBe(byteBudget)
        expect(profile?.parallelPeakOwnedOrReservedContentBytes).toBe(byteBudget)
        expect(profile?.parallelPeakQueuedOwnedContentBytes).toBe(byteBudget)
        expect(profile?.parallelByteBackpressureWaitCount).toBeGreaterThan(0)
    })

    test('later small groups cannot bypass an earlier group blocked by bytes', async () => {
        const run = startRun([targetBytes, targetBytes, 2 * targetBytes, MiB, MiB, MiB], {heldSinks: [1]})
        await waitForJob(2)
        await completeJob(1, targetBytes)
        await completeJob(2, 1)
        expect(jobs.map(({id}) => id)).toEqual([1, 2])
        expect(run.sinkIndexes).toEqual([1])
        run.releaseSink(1)
        await waitForJob(3)
        expect(await run.finish()).toBe(true)
        expect(run.sinkIndexes).toEqual([1, 2, 3, 4, 5, 6])
    })

    test('an indivisible oversized group runs alone and active output underestimates stop further admission', async () => {
        const run = startRun([4 * targetBytes, targetBytes, targetBytes, targetBytes, targetBytes], {heldSinks: [1, 2]})
        await waitForJob(1)
        await flushTasks()
        expect(jobs.map(({id}) => id)).toEqual([1])
        await completeJob(1, 80 * MiB)
        expect(jobs.map(({id}) => id)).toEqual([1])
        run.releaseSink(1)
        await waitForJob(4)
        await completeJob(2, 32 * MiB)
        await completeJob(3, targetBytes)
        await completeJob(4, targetBytes)
        expect(jobs.map(({id}) => id)).toEqual([1, 2, 3, 4])
        expect(run.sinkIndexes).toEqual([1, 2])
        expect(await run.finish()).toBe(true)
        expect(run.sinkIndexes).toEqual([1, 2, 3, 4, 5])
        const profile = consumeLastTermBankWasmParseProfile()
        expect(profile?.parallelContentByteBudget).toBe(byteBudget)
        expect(profile?.parallelPeakOwnedOrReservedContentBytes).toBe(4 * targetBytes)
        expect(profile?.parallelPeakQueuedOwnedContentBytes).toBe(80 * MiB)
    })

    test('an empty oversized result retires its estimate without inventing a sink callback', async () => {
        const run = startRun([4 * targetBytes, targetBytes, targetBytes, targetBytes])
        await completeJob(1, 0, true)
        expect(await run.finish()).toBe(true)
        expect(run.sinkIndexes).toEqual([2, 3, 4])
        expect(consumeLastTermBankWasmParseProfile()?.rowCount).toBe(3)
    })

    test('zero estimates remain ordered and unexpectedly large owned results stop later admission', async () => {
        const run = startRun(Array.from({length: 8}, () => 0), {heldSinks: [1]})
        await waitForJob(3)
        await completeJob(1, byteBudget + 1)
        await completeJob(2, 0, true)
        await completeJob(3, 0, true)
        expect(jobs.map(({id}) => id)).toEqual([1, 2, 3])
        expect(run.sinkIndexes).toEqual([1])
        expect(await run.finish()).toBe(true)
        expect(run.sinkIndexes).toEqual([1, 4, 5, 6, 7, 8])
        const profile = consumeLastTermBankWasmParseProfile()
        expect(profile?.parallelContentByteBudget).toBe(byteBudget)
        expect(profile?.parallelPeakOwnedOrReservedContentBytes).toBe(byteBudget + 1)
        expect(profile?.parallelPeakQueuedOwnedContentBytes).toBe(byteBudget + 1)
    })

    test('pool disposal waits for a successful byte-limited run before terminating its workers', async () => {
        const run = startRun(Array.from({length: 8}, () => targetBytes), {heldSinks: [1]})
        await completeJob(1, targetBytes)
        await completeJob(2, targetBytes)
        await completeJob(3, targetBytes)
        let disposed = false
        const disposing = disposeParallelTermBankParser().then(() => { disposed = true })
        await flushTasks()
        expect(disposed).toBe(false)
        expect(run.settled()).toBe(false)
        expect(workers.every((worker) => !worker.terminated)).toBe(true)
        expect(await run.finish()).toBe(true)
        await disposing
        expect(disposed).toBe(true)
        expect(workers.every((worker) => worker.terminated)).toBe(true)
        expect(run.sinkIndexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    test.each(['cancel', 'sink', 'source', 'worker'])('drains the active sink and releases byte waiters after %s failure', async (failure) => {
        const run = startRun(Array.from({length: 8}, () => targetBytes), {
            heldSinks: [1],
            sinkFailure: failure === 'sink',
            delayedSource: failure === 'source' ? 3 : undefined,
        })
        await waitForJob(failure === 'source' ? 2 : 3)
        await completeJob(1, targetBytes)
        await completeJob(2, targetBytes)
        if (failure === 'source') {
            run.failSource()
        } else if (failure === 'worker') {
            const job = await waitForJob(3)
            job.responded = true
            job.worker.emit({type: 'parse-error', id: 3, error: {message: 'controlled worker failure'}})
        } else {
            await completeJob(3, targetBytes)
            if (failure === 'cancel') { run.cancel() }
        }
        // Allow the existing cancellation poll to run while the ordered sink
        // is still held. Cancellation must not abandon an admitted callback.
        await new Promise((resolve) => { setTimeout(resolve, 40) })
        expect(run.settled()).toBe(false)
        expect(run.sinkIndexes).toEqual([1])
        expect(jobs.length).toBe(failure === 'source' ? 2 : 3)
        run.releaseSink(1)
        const error = await run.outcome
        expect(error).toBeInstanceOf(Error)
        expect(/** @type {Error} */ (error).message).toMatch(failure === 'cancel' ? /cancel/i : new RegExp(`controlled ${failure} failure`))
        expect(workers.every((worker) => worker.terminated)).toBe(true)
        expect(run.sinkIndexes).toEqual([1])
    })
})
