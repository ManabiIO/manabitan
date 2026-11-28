/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {initializeTermContentPlanResolution} from '../ext/js/dictionary/term-content-plan-resolution.js'

/** @typedef {Parameters<DictionaryDatabase['_resolveArtifactTermContentDedup']>[0]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['contentDedupPlan']>} ContentPlan */

/** @type {WebAssembly.Module} */
let canonicalModule
/** @type {WebAssembly.Module} */
let parserModule

beforeAll(async () => {
    canonicalModule = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v2.wasm', import.meta.url)))
    parserModule = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
})

/**
 * @param {boolean} deferred
 * @returns {ContentPlan}
 */
function createPlan(deferred) {
    return {
        uniqueCount: 3,
        sourceRowCount: 4,
        uniqueRowIndexes: new Uint32Array([0, 2, 3]),
        uniqueSignatures: new Uint32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
        resolutionDeferred: deferred,
        resolvedFlags: new Uint8Array(deferred ? 0 : 3),
        resolvedOffsets: new Float64Array(deferred ? 0 : 3),
        resolvedLengths: new Uint32Array(deferred ? 0 : 3),
        resolvedDictNames: null,
        pendingEpochs: null,
        pendingIndexes: null,
        nextEpoch: 1,
        nextUnresolvedUniqueIndex: 0,
        persistedLookupRequired: null,
    }
}

/**
 * @param {ContentPlan} plan
 * @returns {ArtifactChunk}
 */
function createChunk(plan) {
    return {
        rowCount: 4,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: new Uint8Array([1, 2, 3]),
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, 1, 10, 20, 0, 1, 10, 20, 1, 1, 30, 40, 2, 1, 50, 60]),
        contentUniqueIndexList: new Uint32Array([0, 0, 1, 2]),
        contentDedupPlan: plan,
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
        useResolvedContentReferences: true,
    }
}

/**
 * @param {boolean} native
 * @returns {DictionaryDatabase}
 */
function createDatabase(native) {
    const database = new DictionaryDatabase()
    Reflect.set(database, '_nativeCanonicalScanner', new NativeCanonicalScanner({loadModule: async () => {
        if (!native) { throw new Error('Use JavaScript canonical fallback') }
        return canonicalModule
    }}))
    return database
}

/**
 * @param {Awaited<ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>>} result
 * @returns {Record<string, unknown>}
 */
function semanticResult(result) {
    const fields = Object.fromEntries(Object.entries(result).filter(([key]) => !key.endsWith('Ms')))
    if (result.nativeScanMetrics) {
        fields.nativeScanMetrics = Object.fromEntries(
            Object.entries(result.nativeScanMetrics).filter(([key]) => !key.endsWith('Ms')),
        )
    }
    return fields
}

describe('deferred content resolution at storage admission', () => {
    test.each([false, true])('matches eager canonical resolution; native=%s', async (native) => {
        const eager = await createDatabase(native)._resolveArtifactTermContentDedup(createChunk(createPlan(false)))
        const deferred = createPlan(true)
        const actual = await createDatabase(native)._resolveArtifactTermContentDedup(createChunk(deferred))
        expect(semanticResult(actual)).toEqual(semanticResult(eager))
        expect(actual.nativeScanMetrics?.dedupNativeBulkPendingRows ?? 0).toBe(native ? 3 : 0)
        expect(deferred.resolutionDeferred).toBe(false)
        expect(deferred.resolvedFlags).toHaveLength(3)
        expect(deferred.resolvedOffsets).toHaveLength(3)
        expect(deferred.resolvedLengths).toHaveLength(3)
    })

    test('matches eager generic fallback resolution', async () => {
        const eagerChunk = createChunk(createPlan(false))
        const deferredChunk = createChunk(createPlan(true))
        eagerChunk.contentRowStart = deferredChunk.contentRowStart = void 0
        expect(semanticResult(await createDatabase(false)._resolveArtifactTermContentDedup(deferredChunk))).toEqual(
            semanticResult(await createDatabase(false)._resolveArtifactTermContentDedup(eagerChunk)),
        )
    })

    test('preserves eager resolution columns and published values', () => {
        const plan = createPlan(false)
        const fields = [plan.resolvedFlags, plan.resolvedOffsets, plan.resolvedLengths]
        plan.resolvedFlags[1] = 1
        plan.resolvedOffsets[1] = 0x1_0000_0000
        plan.resolvedLengths[1] = 42
        initializeTermContentPlanResolution(plan)
        expect(plan.resolvedFlags).toBe(fields[0])
        expect(plan.resolvedOffsets).toBe(fields[1])
        expect(plan.resolvedLengths).toBe(fields[2])
        expect(plan.resolvedOffsets[1]).toBe(0x1_0000_0000)
        expect(plan.resolvedLengths[1]).toBe(42)
    })

    test('shares one initialized plan across storage splits and preserves earlier publication', async () => {
        const plan = createPlan(true)
        const chunk = createChunk(plan)
        const database = createDatabase(false)
        const first = await database._resolveArtifactTermContentDedup({
            ...chunk,
            rowCount: 2,
            contentMetaList: chunk.contentMetaList?.subarray(0, 8),
            contentUniqueIndexList: chunk.contentUniqueIndexList?.subarray(0, 2),
        })
        expect(first.pendingContentCount).toBe(1)
        database._publishResolvedArtifactTermContentPlan(
            plan,
            first.pendingPlanUniqueStart,
            first.pendingPlanUniqueIndexes,
            new Float64Array([123]),
            new Uint32Array([1]),
            'raw-v6',
        )
        const fields = [plan.resolvedFlags, plan.resolvedOffsets, plan.resolvedLengths]
        const second = await database._resolveArtifactTermContentDedup({
            ...chunk,
            rowCount: 2,
            contentRowStart: 2,
            contentMetaList: chunk.contentMetaList?.subarray(8),
            contentUniqueIndexList: chunk.contentUniqueIndexList?.subarray(2),
        })
        expect(second.pendingContentCount).toBe(2)
        expect(plan.resolvedFlags).toBe(fields[0])
        expect(plan.resolvedOffsets).toBe(fields[1])
        expect(plan.resolvedLengths).toBe(fields[2])
        expect(plan.resolvedFlags[0]).toBe(1)
        expect(plan.resolvedOffsets[0]).toBe(123)
        expect(plan.resolvedLengths[0]).toBe(1)
    })

    test.each(['Uint8Array', 'Float64Array', 'Uint32Array'])('keeps all columns deferred when %s allocation fails, then retries', async (constructorName) => {
        const plan = createPlan(true)
        const chunk = createChunk(plan)
        const original = Reflect.get(globalThis, constructorName)
        const fields = [plan.resolvedFlags, plan.resolvedOffsets, plan.resolvedLengths]
        vi.stubGlobal(constructorName, new Proxy(original, {
            construct(target, args) {
                if (args.length === 1 && args[0] === 3) { throw new RangeError('resolution allocation failed') }
                return Reflect.construct(target, args)
            },
        }))
        try {
            await expect(createDatabase(false)._resolveArtifactTermContentDedup(chunk)).rejects.toThrow('resolution allocation failed')
            expect(plan.resolutionDeferred).toBe(true)
            expect(plan.resolvedFlags).toBe(fields[0])
            expect(plan.resolvedOffsets).toBe(fields[1])
            expect(plan.resolvedLengths).toBe(fields[2])
            expect(plan.nextEpoch).toBe(1)
            expect(plan.nextUnresolvedUniqueIndex).toBe(0)
        } finally {
            vi.unstubAllGlobals()
        }
        const result = await createDatabase(false)._resolveArtifactTermContentDedup(chunk)
        expect(result.pendingContentCount).toBe(3)
        expect(result.pendingHitCount).toBe(1)
        expect(plan.resolutionDeferred).toBe(false)
    })

    test.each([
        ['uniqueCount', -1],
        ['uniqueCount', 1.5],
        ['uniqueCount', 4],
        ['sourceRowCount', 2],
        ['uniqueRowIndexes', new Uint32Array(2)],
        ['resolvedFlags', new Uint8Array(1)],
        ['resolvedOffsets', new Float64Array(1)],
        ['resolvedLengths', new Uint32Array(1)],
        ['nextEpoch', 2],
        ['nextUnresolvedUniqueIndex', 1],
        ['persistedLookupRequired', false],
        ['resolvedDictNames', []],
        ['resolvedUniformDictName', 'raw-v6'],
        ['pendingEpochs', new Uint32Array(3)],
        ['pendingIndexes', new Uint32Array(3)],
    ])('rejects inconsistent deferred %s before allocating', (property, value) => {
        const plan = createPlan(true)
        Reflect.set(plan, /** @type {string} */ (property), value)
        const fields = [plan.resolvedFlags, plan.resolvedOffsets, plan.resolvedLengths]
        expect(() => initializeTermContentPlanResolution(plan)).toThrow('Deferred term content resolution metadata is invalid')
        expect(plan.resolutionDeferred).toBe(true)
        expect(plan.resolvedFlags).toBe(fields[0])
        expect(plan.resolvedOffsets).toBe(fields[1])
        expect(plan.resolvedLengths).toBe(fields[2])
    })

    test('leaves queued production worker results empty through transfer and initializes them at the sink', async () => {
        const worker = new Worker(new URL('fixtures/parser-settlement/worker-node.mjs', import.meta.url), {
            workerData: {url: new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href},
        })
        /**
         * @param {Record<string, unknown>} message
         * @param {ArrayBuffer[]} [transfer]
         * @returns {Promise<Record<string, unknown>>}
         */
        const request = async (message, transfer = []) => await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup()
                reject(new Error('Parser worker timed out'))
            }, 10000)
            const cleanup = () => {
                clearTimeout(timeout)
                worker.off('message', onMessage)
                worker.off('error', onError)
            }
            /** @param {Record<string, unknown>} result */
            const onMessage = (result) => {
                cleanup()
                resolve(result)
            }
            /** @param {Error} error */
            const onError = (error) => {
                cleanup()
                reject(error)
            }
            worker.once('message', onMessage)
            worker.once('error', onError)
            worker.postMessage(message, transfer)
        })
        try {
            expect((await request({type: 'initialize', module: parserModule})).type).toBe('ready')
            const bytes = new TextEncoder().encode(JSON.stringify(Array.from({length: 24}, (_, index) => [
                `word-${index}`, '', '', '', 0, [`definition-${index % 3}`], index, '',
            ])))
            const result = await request({
                type: 'parse',
                id: 1,
                version: 3,
                sourceBuffers: [bytes.buffer],
                options: {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true},
            }, [bytes.buffer])
            expect(bytes.byteLength).toBe(0)
            expect(result.type).toBe('result')
            const chunk = /** @type {ArtifactChunk} */ (/** @type {unknown} */ (result.chunk))
            const plan = /** @type {ContentPlan} */ (chunk.contentDedupPlan)
            expect(plan.resolutionDeferred).toBe(true)
            expect(plan.resolvedFlags).toHaveLength(0)
            expect(plan.resolvedOffsets).toHaveLength(0)
            expect(plan.resolvedLengths).toHaveLength(0)
            const nextBytes = new TextEncoder().encode('[["next","","","",0,["unrelated"],1,""]]')
            expect((await request({
                type: 'parse',
                id: 2,
                version: 3,
                sourceBuffers: [nextBytes.buffer],
                options: {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, prepareLookupIndexes: true},
            }, [nextBytes.buffer])).type).toBe('result')
            expect(plan.resolutionDeferred).toBe(true)
            const resolved = await createDatabase(true)._resolveArtifactTermContentDedup({
                ...chunk, contentDictNameList: null, uniformContentDictName: 'raw-v6',
            })
            expect(resolved.pendingContentCount).toBe(3)
            expect(resolved.pendingHitCount).toBe(21)
            expect(plan.resolutionDeferred).toBe(false)
            expect(plan.resolvedFlags).toHaveLength(3)
            expect(plan.resolvedOffsets).toHaveLength(3)
            expect(plan.resolvedLengths).toHaveLength(3)
        } finally {
            await worker.terminate()
        }
    }, 15000)
})
