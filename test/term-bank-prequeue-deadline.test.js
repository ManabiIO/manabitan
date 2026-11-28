/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {setImmediate as turn} from 'node:timers/promises'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {
    disposeParallelTermBankParser,
    getParallelTermBankParserWorkerCount,
    parseTermBankWithWasmColumnChunksParallelLazy,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

afterEach(async () => {
    await disposeParallelTermBankParser()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    let resolve = () => {}
    /** @type {Promise<void>} */
    const promise = new Promise((callback) => { resolve = callback })
    return {promise, resolve}
}

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
    const deadline = Date.now() + 2000
    while (!predicate()) {
        if (Date.now() > deadline) { throw new Error('Parser queue fixture did not reach the required state') }
        await turn()
    }
}

/** @typedef {{type: string, id?: number}} Request */
/** @typedef {{workers: Array<{terminated: boolean, pending: Request[]}>, workerCount: number, requests: number[], acknowledgements: number[], loaded: number[], scores: number[], sourceCount: number, firstSink: Promise<void>, release: () => void, outcome: Promise<Error|null>, cancel: () => void, finished: () => boolean}} QueueSchedule */

/**
 * This worker models only the public queue protocol. Its blocked successor
 * lets fake time advance beyond a parse deadline while a valid sink is active.
 * Native worker ownership and actual shared bytes are covered by the separate
 * borrowed-content fixture.
 * @param {boolean} [hangSuccessors]
 * @returns {QueueSchedule}
 */
function createSchedule(hangSuccessors = false) {
    vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
    const workerCount = getParallelTermBankParserWorkerCount()
    /** @type {QueuedWorker[]} */
    const workers = []
    /** @type {number[]} */
    const requests = []
    /** @type {number[]} */
    const acknowledgements = []
    class QueuedWorker extends EventTarget {
        constructor() {
            super()
            this.terminated = false
            /** @type {number|null} */
            this.blockedId = null
            /** @type {Request[]} */
            this.pending = []
            workers.push(this)
        }

        /** @param {Request} request */
        postMessage(request) {
            if (this.terminated) { return }
            if (request.type === 'initialize') {
                queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {type: 'ready', supportsQueuedParse: true}})))
            } else if (request.type === 'parse') {
                requests.push(/** @type {number} */ (request.id))
                this.pending.push(request)
                this.drain()
            } else if (request.type === 'consume' && request.id === this.blockedId) {
                acknowledgements.push(/** @type {number} */ (request.id))
                this.blockedId = null
                this.drain()
            }
        }

        drain() {
            if (this.terminated || this.blockedId !== null || this.pending.length === 0) { return }
            const id = /** @type {number} */ (this.pending.shift()?.id)
            this.blockedId = id
            if (hangSuccessors && id > workerCount) { return }
            queueMicrotask(() => {
                if (this.terminated) { return }
                this.dispatchEvent(new MessageEvent('message', {data: {
                    type: 'result',
                    id,
                    rowCount: 1,
                    resultSentEpochMs: Date.now(),
                    borrowsWorkerMemory: true,
                    chunk: {rowCount: 1, contentBytesBuffer: new Uint8Array(new SharedArrayBuffer(1)), scoreList: new Int32Array([id - 1])},
                    profile: {rowCount: 1, chunkDispatchMs: 0},
                }}))
            })
        }

        terminate() {
            this.terminated = true
            this.pending.length = 0
        }
    }
    vi.stubGlobal('Worker', QueuedWorker)
    // Keep cancellation polling real: queue wait must remain cancellable even
    // though its native parse deadline has not started.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    const sourceCount = hangSuccessors ? workerCount * 2 : workerCount * 8
    const bytes = new TextEncoder().encode('[["head","","","",0,["definition"],0,""]]')
    /** @type {number[]} */
    const loaded = []
    /** @type {number[]} */
    const scores = []
    const firstSink = deferred()
    const releaseSink = deferred()
    let cancelled = false
    const importing = parseTermBankWithWasmColumnChunksParallelLazy(
        Array.from({length: sourceCount}, (_, index) => async () => {
            loaded.push(index)
            return Uint8Array.from(bytes)
        }),
        new Array(sourceCount).fill(24 * 1024 * 1024),
        3,
        async (chunk) => {
            scores.push(/** @type {Int32Array} */ (chunk.scoreList)[0])
            if (scores.length !== 1) { return }
            firstSink.resolve()
            await releaseSink.promise
        },
        {emitContentSlab: true},
        () => cancelled,
    )
    let finished = false
    const outcome = importing.then(() => {
        finished = true
        return null
    }, (error) => {
        finished = true
        return error
    })
    return {workers,
        workerCount,
        requests,
        acknowledgements,
        loaded,
        scores,
        sourceCount,
        firstSink: firstSink.promise,
        release: releaseSink.resolve,
        outcome,
        cancel: () => { cancelled = true },
        finished: () => finished}
}

test('queued parse deadlines exclude borrowed sink time and preserve the existing source window', async () => {
    const run = createSchedule()
    try {
        await run.firstSink
        await waitFor(() => run.requests.length === run.workerCount * 2)
        expect(run.loaded).toEqual(Array.from({length: run.workerCount * 4}, (_, index) => index))
        await vi.advanceTimersByTimeAsync(300_001)
        expect(run.finished()).toBe(false)
        expect(run.scores).toEqual([0])
        expect(run.acknowledgements).toEqual([])
        expect(run.requests).toHaveLength(run.workerCount * 2)
    } finally { run.release() }
    await expect(run.outcome).resolves.toBeNull()
    expect(run.scores).toEqual(Array.from({length: run.sourceCount}, (_, index) => index))
    expect(vi.getTimerCount()).toBe(0)
})

test('cancellation settles queued waiters without acknowledging an active borrowed result', async () => {
    const run = createSchedule()
    try {
        await run.firstSink
        await waitFor(() => run.requests.length === run.workerCount * 2)
        await vi.advanceTimersByTimeAsync(300_001)
        run.cancel()
    } finally { run.release() }
    await expect(run.outcome).resolves.toMatchObject({name: 'AbortError'})
    expect(run.acknowledgements).toEqual([])
    expect(run.scores).toEqual([0])
    expect(run.workers.every((worker) => worker.terminated && worker.pending.length === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
})

test('a successor that never responds after consumption retains the bounded parse deadline', async () => {
    const run = createSchedule(true)
    await run.firstSink
    await waitFor(() => run.requests.length === run.workerCount * 2)
    run.release()
    await waitFor(() => run.acknowledgements.length === run.workerCount)
    await vi.advanceTimersByTimeAsync(300_001)
    await expect(run.outcome).resolves.toMatchObject({message: 'Term-bank parser worker timed out after 300000ms'})
    expect(run.workers.every((worker) => worker.terminated && worker.pending.length === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
})
