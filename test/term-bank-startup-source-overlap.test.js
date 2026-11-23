/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, expect, test, vi} from 'vitest'
import {AbortableZipReadPool} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {}
    /** @type {(reason: unknown) => void} */
    let reject = () => {}
    /** @type {Promise<T>} */
    const promise = new Promise((yes, no) => {
        resolve = yes
        reject = no
    })
    return {promise, resolve, reject}
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** @returns {Promise<{parser: typeof import('../ext/js/dictionary/term-bank-wasm-parser.js'), workers: StartupWorker[], initialized: Promise<void>}>} */
async function setup() {
    vi.resetModules()
    vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8})
    /** @type {StartupWorker[]} */
    const workers = []
    const initialized = deferred()
    const parser = await import('../ext/js/dictionary/term-bank-wasm-parser.js')
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    parser.setTermBankWasmModule(module)
    const workerCount = parser.getParallelTermBankParserWorkerCount()
    vi.stubGlobal('Worker', class extends StartupWorker {
        constructor() {
            super()
            workers.push(this)
        }

        /**
         * @param {{type: string, id?: number}} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer) {
            super.postMessage(message, transfer)
            if (message.type === 'initialize' && workers.length === workerCount) { initialized.resolve(void 0) }
        }
    })
    return {parser, workers, initialized: /** @type {Promise<void>} */ (initialized.promise)}
}

class StartupWorker {
    constructor() {
        /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        this.terminated = false
        this.ready = false
        /** @type {number[]} */
        this.jobs = []
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }

    /**
     * @param {{type: string, id?: number}} message
     * @param {Transferable[]} [transfer]
     */
    postMessage(message, transfer) {
        if (message.type === 'initialize') { return }
        expect(this.ready).toBe(true)
        expect(message.type).toBe('parse')
        const copy = structuredClone(message, {transfer: transfer ?? []})
        this.jobs.push(/** @type {number} */ (copy.id))
        queueMicrotask(() => this.emit({
            type: 'result',
            id: copy.id,
            rowCount: 0,
            resultSentEpochMs: Date.now(),
            borrowsWorkerMemory: false,
            chunk: null,
            profile: {rowCount: 0},
        }))
    }

    /** @param {Record<string, unknown>} data */
    emit(data) {
        if (data.type === 'ready') { this.ready = true }
        for (const listener of this.listeners.get('message') ?? []) {
            listener(new MessageEvent('message', {data}))
        }
    }

    terminate() { this.terminated = true }
}

test('overlaps only the admitted first group with startup and reuses each read exactly once', async () => {
    const {parser, workers, initialized} = await setup()
    /** @type {number[]} */
    const loaded = []
    const first = deferred()
    const loaders = Array.from({length: 24}, (_, index) => vi.fn(async () => {
        loaded.push(index)
        if (index < 2) { await first.promise }
        return new TextEncoder().encode('[]')
    }))
    const sink = vi.fn()
    const run = parser.parseTermBankWithWasmColumnChunksParallelLazy(loaders, Array.from({length: 24}, () => 2), 3, sink, {emitContentSlab: true})
    try {
        await initialized
        // Twenty-four equal banks form twelve groups. Only group zero's two reads may
        // begin before readiness; no parse or sink may start at this point.
        expect(loaded).toEqual([0, 1])
        expect(workers.every((worker) => worker.jobs.length === 0)).toBe(true)
        const busyLoaders = Array.from({length: 4}, () => vi.fn(async () => new TextEncoder().encode('[]')))
        await expect(parser.parseTermBankWithWasmColumnChunksParallelLazy(busyLoaders, [2, 2, 2, 2], 3, sink, {emitContentSlab: true})).resolves.toBe(false)
        expect(busyLoaders.every((load) => load.mock.calls.length === 0)).toBe(true)
        first.resolve(void 0)
        for (const worker of workers) { worker.emit({type: 'ready'}) }
        await expect(run).resolves.toBe(true)
        expect(loaders.every((load) => load.mock.calls.length === 1)).toBe(true)
        expect(workers.flatMap((worker) => worker.jobs).sort((a, b) => a - b)).toEqual(Array.from({length: 12}, (_, index) => index + 1))
        expect(sink).not.toHaveBeenCalled()
    } finally {
        first.resolve(void 0)
        for (const worker of workers) { worker.emit({type: 'ready'}) }
        await run.catch(() => {})
        await parser.disposeParallelTermBankParser()
    }
    expect(workers.every((worker) => worker.terminated)).toBe(true)
    expect(workers.every((worker) => [...worker.listeners.values()].every((listeners) => listeners.size === 0))).toBe(true)
})

test('worker readiness opens the normal source window even when group zero is still reading', async () => {
    const {parser, workers, initialized} = await setup()
    const first = deferred()
    const normalWindow = deferred()
    /** @type {number[]} */
    const loaded = []
    const loaders = Array.from({length: 24}, (_, index) => async () => {
        loaded.push(index)
        if (loaded.length === 24) { normalWindow.resolve(void 0) }
        if (index < 2) { await first.promise }
        return new TextEncoder().encode('[]')
    })
    const run = parser.parseTermBankWithWasmColumnChunksParallelLazy(loaders, Array.from({length: 24}, () => 2), 3, () => {}, {emitContentSlab: true})
    try {
        await initialized
        expect(loaded).toEqual([0, 1])
        for (const worker of workers) { worker.emit({type: 'ready'}) }
        await normalWindow.promise
        expect(loaded).toEqual(Array.from({length: 24}, (_, index) => index))
        first.resolve(void 0)
        await expect(run).resolves.toBe(true)
    } finally {
        first.resolve(void 0)
        for (const worker of workers) { worker.emit({type: 'ready'}) }
        await run.catch(() => {})
        await parser.disposeParallelTermBankParser()
    }
})

test.each(['source-error', 'worker-error', 'cancel'])('joins importer-owned reads before archive cleanup after %s during startup', async (mode) => {
    const {parser, workers, initialized} = await setup()
    const first = deferred()
    const peer = deferred()
    const ownerAborting = deferred()
    /** @type {AbortSignal[]} */
    const signals = []
    const files = Array.from({length: 24}, (_, index) => ({filename: `${index}`}))
    const sourcePool = new AbortableZipReadPool(async (file, signal) => {
        signals.push(signal)
        await (file === files[0] ? first.promise : peer.promise)
        // Match an uninterruptible Blob read: abort is observed after the
        // outstanding read settles, and its owner must still join that work.
        signal.throwIfAborted()
        return new TextEncoder().encode('[]')
    })
    const loaders = files.map((file) => async () => await sourcePool.read(file))
    const integrityError = new DictionarySourceIntegrityError('First ZIP entry failed validation')
    let cancelled = false
    let archiveClosed = false
    let settled = false
    /** @type {unknown} */
    let failure = null
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']})
    const run = (async () => {
        try {
            return await parser.parseTermBankWithWasmColumnChunksParallelLazy(loaders, Array.from({length: 24}, () => 2), 3, () => {}, {emitContentSlab: true}, () => cancelled)
        } finally {
            const joining = sourcePool.abortAndJoin()
            ownerAborting.resolve(void 0)
            await joining
            archiveClosed = true
        }
    })().then(() => { settled = true }, (error) => {
        settled = true
        failure = error
    })
    try {
        await initialized
        expect(signals).toHaveLength(2)
        if (mode === 'source-error') {
            first.reject(integrityError)
        } else if (mode === 'worker-error') {
            workers[0].emit({type: 'initialization-error', error: {message: 'Worker initialization failed'}})
        } else {
            cancelled = true
            await vi.advanceTimersByTimeAsync(25)
        }
        await ownerAborting.promise
        expect(signals.every((signal) => signal.aborted)).toBe(true)
        expect(workers.every((worker) => worker.terminated)).toBe(true)
        expect(workers.every((worker) => [...worker.listeners.values()].every((listeners) => listeners.size === 0))).toBe(true)
        expect(settled).toBe(false)
        expect(archiveClosed).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        first.resolve(void 0)
        peer.resolve(void 0)
        await run
        expect(archiveClosed).toBe(true)
        expect(failure).toMatchObject(mode === 'source-error' ?
            {name: 'DictionarySourceIntegrityError', message: integrityError.message} :
            (mode === 'worker-error' ? {message: 'Worker initialization failed'} : {name: 'AbortError'}))
        expect(signals).toHaveLength(2)
    } finally {
        first.resolve(void 0)
        peer.resolve(void 0)
        for (const worker of workers) { worker.emit({type: 'initialization-error', error: {message: 'Test cleanup'}}) }
        await run
        await parser.disposeParallelTermBankParser()
        await sourcePool.dispose()
        vi.clearAllTimers()
    }
})
