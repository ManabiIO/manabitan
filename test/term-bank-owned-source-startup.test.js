/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint-disable @stylistic/semi */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {RawZipPayloadReader, TermBankSourcePipeline} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {
    disposeParallelTermBankParser,
    parseTermBankWithWasmColumnChunksParallelCompressedLazy,
    parseTermBankWithWasmColumnChunksParallelCompressedPlan,
    parseTermBankWithWasmColumnChunksParallelLazy,
    prewarmParallelTermBankParser,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {NonNullable<ReturnType<TermBankSourcePipeline['createCompressedImportRunPlan']>>} SourcePlan */
/** @typedef {{type: string, id?: number, [key: string]: unknown}} WorkerMessage */
/** @typedef {{file: import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile, signal: AbortSignal} & PromiseWithResolvers<Uint8Array>} ReadCall */
/** @typedef {{listeners: Map<string, Set<(event: MessageEvent<unknown>) => void>>, initialized: boolean, readySent: boolean, terminated: boolean, sendReady: () => void, emit: (data: unknown) => void}} StartupWorkerState */

/** @augments {Array<import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile>} */
class AliasedSourceFiles extends Array {
    /**
     * @override
     * @returns {this}
     */
    slice() { return this }
}

/** @type {Promise<unknown>[]} */
let pendingRuns
/** @type {Array<() => void>} */
let cleanupGates
/** @type {ReturnType<typeof createPipeline>[]} */
let pipelines
/** @type {ReturnType<typeof createWorkers>} */
let workers

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 60; ++i) { await Promise.resolve() }
}

/** @returns {PromiseWithResolvers<void>} */
function gate() {
    const value = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers())
    cleanupGates.push(() => value.resolve())
    return value
}

/**
 * @param {Promise<unknown>} promise
 * @returns {{settled: boolean, value: unknown, error: unknown, promise: Promise<void>}}
 */
function observe(promise) {
    const state = {
        settled: false,
        value: /** @type {unknown} */ (void 0),
        error: /** @type {unknown} */ (void 0),
        promise: Promise.resolve(),
    }
    state.promise = promise.then((value) => {
        state.settled = true
        state.value = value
    }, (error) => {
        state.settled = true
        state.error = error
    })
    pendingRuns.push(state.promise)
    return state
}

/**
 * Mock only the transport boundary. Real parser pool readiness, run admission,
 * source ownership and cancellation execute unchanged; native byte parsing is
 * outside these lifecycle tests.
 * @returns {{Worker: new () => StartupWorkerState, instances: StartupWorkerState[], parses: WorkerMessage[], readyAll: () => void, fail: () => void}}
 */
function createWorkers() {
    /** @type {StartupWorker[]} */
    const instances = []
    /** @type {WorkerMessage[]} */
    const parses = []
    let ready = false
    class StartupWorker {
        constructor() {
            /** @type {Map<string, Set<(event: MessageEvent<unknown>) => void>>} */
            this.listeners = new Map()
            this.initialized = false
            this.readySent = false
            this.terminated = false
            instances.push(this)
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

        /** @param {unknown} data */
        emit(data) {
            for (const listener of this.listeners.get('message') ?? []) {
                listener(/** @type {MessageEvent<unknown>} */ ({data}))
            }
        }

        sendReady() {
            if (!this.initialized || this.readySent || this.terminated) { return }
            this.readySent = true
            this.emit({type: 'ready'})
        }

        /** @param {WorkerMessage} message */
        postMessage(message) {
            if (message.type === 'initialize') {
                this.initialized = true
                if (ready) { queueMicrotask(() => this.sendReady()) }
                return
            }
            if (message.type !== 'parse' || !this.readySent || this.terminated) {
                throw new Error('Parse dispatched before readiness or after termination')
            }
            parses.push(message)
            queueMicrotask(() => this.emit({
                type: 'result',
                id: message.id,
                rowCount: 1,
                resultSentEpochMs: Date.now(),
                chunk: {rowCount: 1},
                profile: {rowCount: 1, chunkDispatchMs: 0},
            }))
        }

        terminate() { this.terminated = true }
    }
    return {
        Worker: StartupWorker,
        instances,
        parses,
        readyAll: () => {
            ready = true
            for (const worker of instances) { worker.sendReady() }
        },
        fail: () => instances[0].emit({type: 'initialization-error', error: {name: 'Error', message: 'Controlled worker startup failure'}}),
    }
}

/**
 * @param {number} [count]
 * @param {number} [estimatedBytes]
 * @param {boolean} [aliasSlices]
 * @returns {{pipeline: TermBankSourcePipeline, plan: SourcePlan, files: import('../ext/js/dictionary/term-bank-source-pipeline.js').TermBankSourceFile[], calls: ReadCall[], resolveAll: () => void, rejectAll: (error: unknown) => void}}
 */
function createPipeline(count = 4, estimatedBytes = 2, aliasSlices = false) {
    const files = Array.from({length: count}, (_, index) => ({
        filename: `term_bank_${index + 1}.json`,
        getData() {},
        offset: index * 64,
        compressionMethod: 8,
        compressedSize: 2,
        uncompressedSize: estimatedBytes,
        signature: 0,
    }))
    /** @type {ReadCall[]} */
    const calls = []
    let automatic = false
    const pipeline = new TermBankSourcePipeline({
        termFiles: aliasSlices ? new AliasedSourceFiles(...files) : files,
        enabled: true,
        deviceMemory: 8,
        read: async () => { throw new Error('Unexpected uncompressed source read') },
        readCompressed: (file, signal) => {
            const completion = /** @type {PromiseWithResolvers<Uint8Array>} */ (Promise.withResolvers())
            calls.push({file, signal, ...completion})
            if (automatic) { completion.resolve(Uint8Array.of(91, 93)) }
            return completion.promise
        },
    })
    const plan = pipeline.createCompressedImportRunPlan(0)
    if (plan === null) { throw new Error('Expected compressed source plan') }
    const harness = {
        pipeline,
        plan,
        files,
        calls,
        resolveAll: () => {
            automatic = true
            for (const call of calls) { call.resolve(Uint8Array.of(91, 93)) }
        },
        /** @param {unknown} error */
        rejectAll: (error) => { for (const call of calls) { call.reject(error) } },
    }
    pipelines.push(harness)
    return harness
}

beforeEach(() => {
    pendingRuns = []
    cleanupGates = []
    pipelines = []
    workers = createWorkers()
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']})
    vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 8})
    vi.stubGlobal('Worker', workers.Worker)
    // Only a compiled module token crosses this mock worker boundary.
    setTermBankWasmModule(new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)))
})

afterEach(async () => {
    for (const resolve of cleanupGates) { resolve() }
    for (const harness of pipelines) { harness.resolveAll() }
    workers.readyAll()
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.allSettled(pendingRuns)
    await disposeParallelTermBankParser()
    await Promise.all(pipelines.map(({pipeline}) => pipeline.dispose()))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('owned compressed source startup', () => {
    test.each(['true', 'throw-then-false', 'throw-then-throw'])('retains the first startup cancellation result without admitting reads: %s', async (mode) => {
        const harness = createPipeline()
        let checks = 0
        const firstError = new Error('First startup cancellation failure')
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}, () => {
            ++checks
            if (checks === 1) { return false }
            if (checks === 2) {
                if (mode === 'true') { return true }
                throw firstError
            }
            if (mode === 'throw-then-throw') { throw new Error('Later cancellation failure') }
            return false
        }))
        await flush()
        expect(harness.calls).toHaveLength(0)
        await result.promise
        expect(result.error).toMatchObject(mode === 'true' ? {name: 'AbortError'} : {message: firstError.message})
        expect(checks).toBe(2)
        expect(workers.parses).toHaveLength(0)
    })

    test('overlaps only the existing bounded lead and waits for readiness and bytes before parsing', async () => {
        const harness = createPipeline(32, 24 * 1024 * 1024)
        const firstSink = gate()
        /** @type {number[]} */
        const order = []
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, async (_chunk, progress) => {
            order.push(progress.chunkIndex)
            if (progress.chunkIndex === 1) { await firstSink.promise }
        }, {emitContentSlab: true}))
        await flush()
        expect(workers.instances).toHaveLength(2)
        // Same established plain-source policy: two workers, four groups each.
        expect(harness.calls).toHaveLength(8)
        expect(harness.calls.map(({file}) => file.filename)).toEqual(harness.files.slice(0, 8).map(({filename}) => filename))
        expect(workers.parses).toHaveLength(0)
        workers.readyAll()
        await flush()
        expect(workers.parses).toHaveLength(0)
        harness.resolveAll()
        await flush()
        expect(order).toEqual([1])
        expect(harness.calls).toHaveLength(8)
        expect(result.settled).toBe(false)
        firstSink.resolve()
        await result.promise
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(true)
        expect(order).toEqual(Array.from({length: 32}, (_, index) => index + 1))
        expect(harness.calls).toHaveLength(32)
        expect(new Set(harness.calls.map(({file}) => file))).toHaveProperty('size', 32)
        expect(harness.calls.every(({signal}) => !signal.aborted)).toBe(true)
    })

    test('completed reads remain private until all parser workers are ready', async () => {
        const harness = createPipeline()
        const sink = vi.fn()
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, sink, {emitContentSlab: true}))
        await flush()
        expect(harness.calls).toHaveLength(4)
        harness.resolveAll()
        await flush()
        expect(result.settled).toBe(false)
        expect(workers.parses).toHaveLength(0)
        expect(sink).not.toHaveBeenCalled()
        workers.instances[0].sendReady()
        await flush()
        expect(workers.parses).toHaveLength(0)
        workers.readyAll()
        await result.promise
        expect(result.value).toBe(true)
        expect(sink).toHaveBeenCalledTimes(4)
    })

    test.each(['cancel', 'callback-error', 'ready-race', 'shared-prewarm'])('aborts and joins started reads while retiring startup workers: %s', async (mode) => {
        const harness = createPipeline()
        let cancelled = false
        const callbackError = new Error('Controlled cancellation callback failure')
        const prewarm = mode === 'shared-prewarm' ? observe(prewarmParallelTermBankParser()) : null
        const sink = vi.fn()
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, sink, {emitContentSlab: true}, () => {
            if (cancelled && mode === 'callback-error') { throw callbackError }
            return cancelled
        }))
        await flush()
        expect(harness.calls).toHaveLength(4)
        if (mode === 'ready-race') { workers.readyAll() }
        cancelled = true
        await vi.advanceTimersByTimeAsync(30)
        expect(harness.calls.every(({signal}) => signal.aborted)).toBe(true)
        expect(workers.instances.every((worker) => worker.terminated)).toBe(true)
        expect(result.settled).toBe(false)
        expect(sink).not.toHaveBeenCalled()
        expect(workers.parses).toHaveLength(0)
        harness.resolveAll()
        await result.promise
        expect(result.error).toMatchObject(mode === 'callback-error' ? {message: callbackError.message} : {name: 'AbortError'})
        if (prewarm !== null) { await prewarm.promise }
        expect(workers.instances.every((worker) => [...worker.listeners.values()].every((listeners) => listeners.size === 0))).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
        if (mode === 'shared-prewarm') {
            const first = createPipeline()
            const firstRun = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(first.plan, 3, () => {}, {emitContentSlab: true}))
            await flush()
            first.resolveAll()
            workers.readyAll()
            await firstRun.promise
            expect(firstRun.value).toBe(true)
            const generationCount = workers.instances.length
            const second = createPipeline()
            const secondRun = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(second.plan, 3, () => {}, {emitContentSlab: true}))
            await flush()
            second.resolveAll()
            await secondRun.promise
            expect(secondRun.value).toBe(true)
            expect(workers.instances).toHaveLength(generationCount)
            expect(workers.instances.slice(-2).every((worker) => !worker.terminated)).toBe(true)
        }
    })

    test('startup failure wins over an observed earlier source rejection', async () => {
        const harness = createPipeline()
        const sourceError = new DictionarySourceIntegrityError('Controlled early source failure')
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        harness.rejectAll(sourceError)
        await flush()
        expect(result.settled).toBe(false)
        workers.fail()
        await result.promise
        expect(result.error).toMatchObject({message: 'Controlled worker startup failure'})
        expect(workers.parses).toHaveLength(0)
        expect(workers.instances.every((worker) => worker.terminated)).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('source rejection is reported after successful readiness without becoming unhandled', async () => {
        const harness = createPipeline()
        const sourceError = new DictionarySourceIntegrityError('Controlled early source failure')
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        harness.rejectAll(sourceError)
        await flush()
        expect(result.settled).toBe(false)
        workers.readyAll()
        await result.promise
        expect(result.error).toMatchObject({name: sourceError.name, message: sourceError.message})
        expect(workers.parses).toHaveLength(0)
    })

    test('worker failure cannot release a noninterruptible read or replace the stable source owner', async () => {
        const harness = createPipeline()
        const substitutedCleanup = vi.spyOn(harness.pipeline, 'abortAndJoin').mockImplementation(async () => { throw new Error('Substituted public cleanup') })
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        expect(harness.calls).toHaveLength(4)
        workers.fail()
        await flush()
        expect(harness.calls.every(({signal}) => signal.aborted)).toBe(true)
        expect(workers.instances.every((worker) => worker.terminated)).toBe(true)
        expect(result.settled).toBe(false)
        expect(substitutedCleanup).not.toHaveBeenCalled()
        harness.resolveAll()
        await result.promise
        expect(result.error).toMatchObject({message: 'Controlled worker startup failure'})
    })

    test.each(['direct', 'abort-listener'])('retains run and prewarm admission through cancelled source cleanup: %s', async (prewarmMode) => {
        const first = createPipeline()
        const second = createPipeline()
        let cancelled = false
        /** @type {ReturnType<typeof observe>|null} */
        let prewarm = null
        const originalPrewarm = observe(prewarmParallelTermBankParser())
        const active = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(first.plan, 3, () => {}, {emitContentSlab: true}, () => cancelled))
        await flush()
        expect(first.calls).toHaveLength(4)
        if (prewarmMode === 'abort-listener') {
            first.calls[0].signal.addEventListener('abort', () => {
                prewarm = observe(prewarmParallelTermBankParser())
            }, {once: true})
        }
        cancelled = true
        await vi.advanceTimersByTimeAsync(30)
        expect(workers.instances.every((worker) => worker.terminated)).toBe(true)
        expect(first.calls.every(({signal}) => signal.aborted)).toBe(true)
        expect(active.settled).toBe(false)
        expect(originalPrewarm.settled).toBe(false)
        if (prewarmMode === 'direct') { prewarm = observe(prewarmParallelTermBankParser()) }
        await flush()
        if (prewarm === null) { throw new Error('Expected cleanup-time prewarm') }
        expect(prewarm.settled).toBe(false)
        const rejected = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(second.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        expect(rejected.settled).toBe(true)
        expect(rejected.value).toBe(false)
        expect(second.calls).toHaveLength(0)
        expect(workers.instances).toHaveLength(2)
        first.resolveAll()
        await active.promise
        expect(active.error).toMatchObject({name: 'AbortError'})
        const next = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(second.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        expect(second.calls).toHaveLength(4)
        second.resolveAll()
        workers.readyAll()
        await next.promise
        await prewarm.promise
        await originalPrewarm.promise
        expect(originalPrewarm.value).toBe(false)
        expect(prewarm.value).toBe(true)
        expect(next.value).toBe(true)
        const generationCount = workers.instances.length
        const third = createPipeline()
        const reused = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(third.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        third.resolveAll()
        await reused.promise
        expect(reused.value).toBe(true)
        expect(workers.instances).toHaveLength(generationCount)
        expect(workers.instances.slice(-2).every((worker) => !worker.terminated)).toBe(true)
    })

    test('caller mutation after the synchronous capture cannot replace admitted loaders', async () => {
        const harness = createPipeline()
        const replacement = vi.fn(async () => { throw new Error('Caller replaced a captured source') })
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}))
        harness.plan.loaders.fill(replacement)
        harness.plan.estimatedByteLengths.fill(Number.MAX_SAFE_INTEGER)
        await flush()
        expect(harness.calls).toHaveLength(4)
        harness.resolveAll()
        workers.readyAll()
        await result.promise
        expect(result.value).toBe(true)
        expect(replacement).not.toHaveBeenCalled()
    })
})

describe('owned source plan admission', () => {
    test('an Array subclass cannot alias the private loader identity snapshot', async () => {
        const harness = createPipeline(4, 2, true)
        const replacement = vi.fn(async () => ({
            bytes: Uint8Array.of(91, 93),
            compressionMethod: /** @type {0} */ (0),
            compressedSize: 2,
            uncompressedSize: 2,
            signature: 0,
            filename: 'replacement.json',
        }))
        harness.plan.loaders[0] = replacement
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        expect(harness.calls).toHaveLength(0)
        expect(replacement).not.toHaveBeenCalled()
        workers.readyAll()
        await flush()
        expect(replacement).toHaveBeenCalledOnce()
        harness.resolveAll()
        await result.promise
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(true)
    })

    test.each(['generic-compressed', 'generic-lazy', 'forged', 'reordered', 'duplicate', 'size', 'appended', 'mixed-plan', 'mixed-pipeline'])('keeps callbacks behind readiness for %s input', async (mode) => {
        const harness = createPipeline()
        let plan = harness.plan
        if (mode === 'forged') { plan = {...plan} }
        if (mode === 'reordered') { plan.loaders.reverse() }
        if (mode === 'duplicate') { plan.loaders[1] = plan.loaders[0] }
        if (mode === 'size') { ++plan.estimatedByteLengths[0] }
        if (mode === 'appended') {
            plan.loaders.push(plan.loaders[0])
            plan.estimatedByteLengths.push(plan.estimatedByteLengths[0])
        }
        if (mode === 'mixed-plan') {
            const other = harness.pipeline.createCompressedImportRunPlan(0)
            if (other === null) { throw new Error('Expected another source plan') }
            plan.loaders[1] = other.loaders[1]
        }
        if (mode === 'mixed-pipeline') { plan.loaders[1] = createPipeline().plan.loaders[1] }
        const parse = mode === 'generic-compressed' ?
                parseTermBankWithWasmColumnChunksParallelCompressedLazy(plan.loaders, plan.estimatedByteLengths, 3, () => {}, {emitContentSlab: true}) :
                (mode === 'generic-lazy' ?
                    parseTermBankWithWasmColumnChunksParallelLazy(plan.loaders.map((load) => async () => (await load()).bytes), plan.estimatedByteLengths, 3, () => {}, {emitContentSlab: true}) :
                    parseTermBankWithWasmColumnChunksParallelCompressedPlan(plan, 3, () => {}, {emitContentSlab: true}))
        const result = observe(parse)
        await flush()
        expect(workers.instances).toHaveLength(2)
        expect(pipelines.every(({calls}) => calls.length === 0)).toBe(true)
        expect(workers.parses).toHaveLength(0)
        workers.readyAll()
        await flush()
        expect(pipelines.reduce((count, {calls}) => count + calls.length, 0)).toBeGreaterThan(0)
        for (const value of pipelines) { value.resolveAll() }
        await result.promise
        expect(result.error).toBeUndefined()
        expect(result.value).toBe(true)
    })

    test.each(['content-disabled', 'workers-unavailable', 'source-count', 'source-size', 'cancelled'])('starts no read when admission is rejected: %s', async (mode) => {
        const harness = createPipeline()
        if (mode === 'workers-unavailable') { vi.stubGlobal('Worker', void 0) }
        if (mode === 'source-count') {
            harness.plan.loaders.length = 3
            harness.plan.estimatedByteLengths.length = 3
        }
        if (mode === 'source-size') { harness.plan.estimatedByteLengths[0] = Number.MAX_SAFE_INTEGER }
        const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(harness.plan, 3, () => {}, {emitContentSlab: mode !== 'content-disabled'}, () => mode === 'cancelled'))
        await result.promise
        expect(harness.calls).toHaveLength(0)
        expect(workers.instances).toHaveLength(0)
        if (mode === 'cancelled') {
            expect(result.error).toMatchObject({name: 'AbortError'})
        } else {
            expect(result.error).toBeUndefined()
            expect(result.value).toBe(false)
        }
    })

    test('a busy parser lease cannot admit or abort another plan', async () => {
        const first = createPipeline()
        const second = createPipeline()
        const active = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(first.plan, 3, () => {}, {emitContentSlab: true}))
        await flush()
        const rejected = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(second.plan, 3, () => {}, {emitContentSlab: true}))
        await rejected.promise
        expect(rejected.value).toBe(false)
        expect(second.calls).toHaveLength(0)
        expect(first.calls).toHaveLength(4)
        expect(first.calls.every(({signal}) => !signal.aborted)).toBe(true)
        first.resolveAll()
        workers.readyAll()
        await active.promise
        expect(active.value).toBe(true)
    })
})

test('a cold small-archive Blob read is shared and joined before startup cancellation settles', async () => {
    const bytesReady = gate()
    const encoder = new TextEncoder()
    /** @type {Uint8Array[]} */
    const parts = []
    let offset = 0
    const files = Array.from({length: 4}, (_, index) => {
        const filename = `term_bank_${index + 1}.json`
        const rawFilename = encoder.encode(filename)
        const header = new Uint8Array(30 + rawFilename.length)
        const view = new DataView(header.buffer)
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(26, rawFilename.length, true)
        header.set(rawFilename, 30)
        const file = {filename, rawFilename, offset, compressedSize: 2, uncompressedSize: 2, compressionMethod: 0, signature: 0, getData() {}}
        parts.push(header, Uint8Array.of(91, 93))
        offset += header.byteLength + 2
        return file
    })
    let wholeReads = 0
    class DelayedBlob extends Blob {
        /**
         * @override
         * @returns {Promise<ArrayBuffer>}
         */
        async arrayBuffer() {
            ++wholeReads
            await bytesReady.promise
            return await super.arrayBuffer()
        }
    }
    const rawReader = new RawZipPayloadReader(new DelayedBlob(parts))
    const pipeline = new TermBankSourcePipeline({
        termFiles: files,
        enabled: true,
        deviceMemory: 8,
        read: async () => { throw new Error('Unexpected uncompressed read') },
        readCompressed: async (file, signal) => await rawReader.read(file, signal, true),
    })
    const plan = pipeline.createCompressedImportRunPlan(0)
    if (plan === null) { throw new Error('Expected RawZip compressed plan') }
    expect(rawReader.supportsCachedBatchReads()).toBe(false)
    expect(wholeReads).toBe(0)
    let cancelled = false
    const result = observe(parseTermBankWithWasmColumnChunksParallelCompressedPlan(plan, 3, () => {}, {emitContentSlab: true}, () => cancelled))
    try {
        await flush()
        expect(wholeReads).toBe(1)
        expect(rawReader.supportsCachedBatchReads()).toBe(true)
        expect(workers.parses).toHaveLength(0)
        cancelled = true
        await vi.advanceTimersByTimeAsync(30)
        expect(workers.instances.every((worker) => worker.terminated)).toBe(true)
        expect(result.settled).toBe(false)
        bytesReady.resolve()
        await result.promise
        expect(result.error).toMatchObject({name: 'AbortError'})
        expect(wholeReads).toBe(1)
        expect(workers.parses).toHaveLength(0)
    } finally {
        bytesReady.resolve()
        await pipeline.dispose()
    }
})

/* eslint-enable @stylistic/semi */
