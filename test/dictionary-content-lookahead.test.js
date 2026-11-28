/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
/* eslint-disable no-underscore-dangle -- Exercise the private import owner and inspect its rollback journal. */

import {readFile} from 'node:fs/promises'
import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'

/** @typedef {Parameters<DictionaryDatabase['_bulkAddArtifactTermsChunkWithContentDedup']>[0]} Chunk */
const nativeModule = WebAssembly.compile(new Uint8Array(await readFile(new URL('../dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm', import.meta.url))))
const blockProfile = {packMs: 0, compressMs: 0, envelopeMs: 0, referenceMs: 0, opfsAppendMs: 0, initialSelectionSavingsMiss: false}
const recordProfile = {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0}

/**
 * @param {DictionaryDatabase} database
 * @param {number[]} values
 * @param {number} [hash1]
 * @param {number} [hash2]
 * @returns {Chunk}
 */
function createChunk(database, values, hash1 = 10, hash2 = 20) {
    const bytes = new Uint8Array(new SharedArrayBuffer(values.length))
    bytes.set(values)
    const lastOffset = Math.max(0, bytes.length - 4)
    const signatures = [0, Math.floor(lastOffset / 2), lastOffset].map((offset) => database._readTermContentSignature(bytes, offset))
    return {
        dictionary: 'JMdict',
        rowCount: 1,
        dictionaryTotalRows: 3,
        contentRowStart: 0,
        expressionBytesList: [],
        readingBytesList: [],
        readingEqualsExpressionList: new Uint8Array([1]),
        scoreList: new Int32Array(1),
        sequenceList: new Int32Array([-1]),
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: bytes,
        contentBytesBaseOffset: 0,
        contentMetaList: new Uint32Array([0, bytes.length, hash1, hash2]),
        contentUniqueIndexList: new Uint32Array([0]),
        contentDedupPlan: {
            uniqueCount: 1,
            sourceRowCount: 1,
            uniqueRowIndexes: new Uint32Array([0]),
            uniqueSignatures: new Uint32Array(signatures),
            resolutionDeferred: true,
            resolvedFlags: new Uint8Array(0),
            resolvedOffsets: new Float64Array(0),
            resolvedLengths: new Uint32Array(0),
            resolvedDictNames: null,
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: null,
        },
        useResolvedContentReferences: true,
        contentDictNameList: null,
        uniformContentDictName: 'raw-v6',
        releaseBorrowedContent: vi.fn(),
    }
}

/** @param {number[]} [values] */
async function createHarness(values = [1, 2, 3]) {
    const database = new DictionaryDatabase()
    database._bulkImportTransactionOpen = true
    database._deferTermsVirtualTableSync = true
    database._termContentZstdInitialized = true
    database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => await nativeModule})
    /** @type {Array<PromiseWithResolvers<typeof blockProfile>>} */
    const contentOperations = []
    /** @type {Array<PromiseWithResolvers<typeof recordProfile>>} */
    const recordOperations = []
    const appendSpans = vi.fn((/** @type {string} */ _dictionary, /** @type {Uint8Array} */ _buffer, /** @type {Uint32Array} */ _offsets, /** @type {Uint32Array} */ lengths) => {
        /** @type {PromiseWithResolvers<typeof blockProfile>} */
        const completion = Promise.withResolvers()
        contentOperations.push(completion)
        const storage = {
            contentOffsets: new Float64Array([100 + (contentOperations.length - 1) * 100]),
            contentLengths: new Uint32Array(lengths),
            contentDictName: 'raw-block-v2:jmdict',
        }
        return {
            initialSelection: false,
            storage: Promise.resolve(storage),
            completion: completion.promise.then((profile) => ({...storage, ...profile})),
        }
    })
    const appendRecords = vi.fn(() => {
        /** @type {PromiseWithResolvers<typeof recordProfile>} */
        const completion = Promise.withResolvers()
        recordOperations.push(completion)
        return completion.promise
    })
    Reflect.set(database, '_termContentBlockImportSession', {tryBeginAppendSpans: appendSpans})
    Reflect.set(database, '_termRecordStore', {appendBatchFromArtifactChunkResolvedContent: appendRecords})
    const chunk = createChunk(database, values)
    return {
        database,
        chunk,
        appendSpans,
        appendRecords,
        contentOperations,
        recordOperations,
        finish(index = 0) {
            contentOperations[index]?.resolve(blockProfile)
            recordOperations[index]?.resolve(recordProfile)
        },
        run(next = chunk) { return database._bulkAddArtifactTermsChunkWithContentDedup(next) },
    }
}

describe('bounded canonical content lookahead', () => {
    test('prepares only the next ready group after publication and consumes its native result once', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [4, 5, 6], 11, 21)
        const peek = vi.fn(() => next)
        h.chunk.peekNextContentChunk = peek
        const first = h.run()
        await vi.waitFor(() => expect(h.database._preparedArtifactTermContent?.result).toBeTruthy())
        expect(h.database._nativeCanonicalScanner.stats.calls).toBe(2)
        expect(h.database._termEntryContentMetaHashPairCount).toBe(1)
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(1)
        expect(h.appendSpans).toHaveBeenCalledOnce()
        expect(h.appendRecords).toHaveBeenCalledOnce()
        expect(h.chunk.releaseBorrowedContent).not.toHaveBeenCalled()
        expect(next.releaseBorrowedContent).not.toHaveBeenCalled()
        expect(h.database._tryPrepareArtifactTermContent(h.chunk)).toBeNull()
        expect(peek).toHaveBeenCalledOnce()

        h.finish()
        await first
        expect(h.database.getLastBulkAddTermsMetrics()?.dedupLookaheadPreparedCount).toBe(1)
        const second = h.run({...next})
        await vi.waitFor(() => expect(h.appendRecords).toHaveBeenCalledTimes(2))
        expect(h.database._nativeCanonicalScanner.stats.calls).toBe(2)
        h.finish(1)
        await second
        expect(h.database.getLastBulkAddTermsMetrics()?.dedupLookaheadConsumedCount).toBe(1)
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(h.database._preparedArtifactTermContent).toBeNull()
    })

    test('compares current in-flight bytes exactly without reading incomplete storage', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [1, 2, 3])
        h.chunk.peekNextContentChunk = () => next
        vi.spyOn(h.database, '_cacheRecentPublishedTermContentSources').mockReturnValue(0)
        const read = vi.spyOn(h.database, '_readTermEntryContentBytesDetailedBatch')
        const first = h.run()
        await vi.waitFor(() => expect(h.database._preparedArtifactTermContent?.result?.persistedHitCount).toBe(1))
        expect(read).not.toHaveBeenCalled()
        expect(next.contentDedupPlan?.resolvedOffsets[0]).toBe(100)
        expect(h.database._preparedArtifactTermContent?.result?.pendingContentCount).toBe(0)
        h.finish()
        await first
        const second = h.run(next)
        await vi.waitFor(() => expect(h.appendRecords).toHaveBeenCalledTimes(2))
        expect(h.appendSpans).toHaveBeenCalledOnce()
        h.recordOperations[1].resolve(recordProfile)
        await second
    })

    test('keeps hash/signature collisions distinct during preparation', async () => {
        const values = Array.from({length: 20}, () => 1)
        const h = await createHarness(values)
        const different = [...values]
        different[5] = 2
        const next = createChunk(h.database, different)
        h.chunk.peekNextContentChunk = () => next
        const first = h.run()
        await vi.waitFor(() => expect(h.database._preparedArtifactTermContent?.result?.pendingContentCount).toBe(1))
        expect(h.database._preparedArtifactTermContent?.result?.persistedHitCount).toBe(0)
        expect(next.contentDedupPlan?.resolvedFlags[0]).toBe(0)
        h.finish()
        await first
        h.database._discardPreparedArtifactTermContent()
        expect(h.database._getTermEntryContentMetaByHashPair(10, 20)?.offset).toBe(100)
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
    })

    test('retains only scalar current-source matches across another content readback await', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [7, 8, 9, 1, 2, 3])
        next.rowCount = 2
        next.contentMetaList = new Uint32Array([0, 3, 12, 22, 3, 3, 10, 20])
        next.contentUniqueIndexList = new Uint32Array([0, 1])
        next.scoreList = new Int32Array(2)
        next.sequenceList = new Int32Array([-1, -1])
        next.readingEqualsExpressionList = new Uint8Array([1, 1])
        const plan = next.contentDedupPlan
        if (!plan) { throw new Error('Expected a deferred content plan') }
        plan.uniqueCount = 2
        plan.sourceRowCount = 2
        plan.uniqueRowIndexes = new Uint32Array([0, 1])
        plan.uniqueSignatures = new Uint32Array([0x090807, 0x090807, 0x090807, 0x030201, 0x030201, 0x030201])
        h.database._cacheTermEntryContentMeta(null, 400, 3, 'raw-v6', 0, 12, 22)
        h.chunk.peekNextContentChunk = () => next
        vi.spyOn(h.database, '_cacheRecentPublishedTermContentSources').mockReturnValue(0)
        /** @type {PromiseWithResolvers<void>} */
        const readStarted = Promise.withResolvers()
        /** @type {PromiseWithResolvers<Array<{status: 'ok', bytes: Uint8Array}>>} */
        const readGate = Promise.withResolvers()
        const read = vi.spyOn(h.database, '_readTermEntryContentBytesDetailedBatch').mockImplementation(async (requests) => {
            expect(requests).toEqual([{contentOffset: 400, contentLength: 3, contentDictName: 'raw-v6'}])
            readStarted.resolve()
            return await readGate.promise
        })
        h.chunk.releaseBorrowedContent = vi.fn(() => { h.chunk.contentBytesBuffer?.fill(0) })
        const first = h.run()
        await readStarted.promise
        h.contentOperations[0].resolve(blockProfile)
        await vi.waitFor(() => expect(h.chunk.releaseBorrowedContent).toHaveBeenCalledOnce())
        expect(h.chunk.contentBytesBuffer).toEqual(new Uint8Array(3))
        expect(next.releaseBorrowedContent).not.toHaveBeenCalled()
        readGate.resolve([{status: 'ok', bytes: new Uint8Array([7, 8, 9])}])
        h.recordOperations[0].resolve(recordProfile)
        await first
        expect(read).toHaveBeenCalledOnce()
        expect(h.database._preparedArtifactTermContent?.result?.persistedHitCount).toBe(2)
        expect(plan.resolvedOffsets).toEqual(new Float64Array([400, 100]))
        const second = h.run(next)
        await vi.waitFor(() => expect(h.appendRecords).toHaveBeenCalledTimes(2))
        expect(h.appendSpans).toHaveBeenCalledOnce()
        h.recordOperations[1].resolve(recordProfile)
        await second
    })

    test.each(['content', 'records'])('joins next-group work before rolling back a %s failure', async (failure) => {
        const h = await createHarness()
        const next = createChunk(h.database, [4, 5, 6], 11, 21)
        h.chunk.peekNextContentChunk = () => next
        /** @type {PromiseWithResolvers<void>} */
        const gate = Promise.withResolvers()
        const resolve = h.database._resolveArtifactTermContentDedup.bind(h.database)
        /** @type {PromiseWithResolvers<void>} */
        const started = Promise.withResolvers()
        vi.spyOn(h.database, '_resolveArtifactTermContentDedup').mockImplementation(async (chunk, reserve) => {
            if (chunk === next) {
                started.resolve()
                await gate.promise
            }
            return await resolve(chunk, reserve)
        })
        let settled = false
        const first = h.run().finally(() => { settled = true })
        void first.catch(() => {})
        await started.promise
        if (failure === 'content') {
            h.contentOperations[0].reject(new Error('current content failure'))
            h.recordOperations[0].resolve(recordProfile)
        } else {
            h.contentOperations[0].resolve(blockProfile)
            h.recordOperations[0].reject(new Error('current records failure'))
        }
        await Promise.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(next.releaseBorrowedContent).not.toHaveBeenCalled()
        gate.resolve()
        await expect(first).rejects.toThrow(`current ${failure} failure`)
        expect(h.database._getTermEntryContentMetaByHashPair(10, 20)).toBeUndefined()
        expect(h.database._getTermEntryContentMetaByHashPair(11, 21)).toBeUndefined()
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(next.contentDedupPlan?.resolvedFlags[0]).toBe(0)
        expect(h.database._preparedArtifactTermContent).toBeNull()
    })

    test('joins persistence before reporting a lookahead readback failure', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [7, 8, 9], 12, 22)
        h.database._cacheTermEntryContentMeta(null, 400, 3, 'raw-v6', 0, 12, 22)
        h.chunk.peekNextContentChunk = () => next
        vi.spyOn(h.database, '_readTermEntryContentBytesDetailedBatch').mockRejectedValue(new Error('lookahead read failed'))
        let settled = false
        const first = h.run().finally(() => { settled = true })
        void first.catch(() => {})
        await vi.waitFor(() => expect(h.appendRecords).toHaveBeenCalledOnce())
        await Promise.resolve()
        expect(settled).toBe(false)
        h.finish()
        await expect(first).rejects.toThrow('lookahead read failed')
        expect(h.database._getTermEntryContentMetaByHashPair(10, 20)).toBeUndefined()
        expect(h.database._getTermEntryContentMetaByHashPair(12, 22)?.offset).toBe(400)
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
    })

    test('retires an unused prepared group when cancellation clears the import cache', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [4, 5, 6], 11, 21)
        h.chunk.peekNextContentChunk = () => next
        const first = h.run()
        await vi.waitFor(() => expect(h.database._preparedArtifactTermContent?.result).toBeTruthy())
        h.finish()
        await first
        h.database._clearTermEntryContentMetaCaches()
        expect(h.database._preparedArtifactTermContent).toBeNull()
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(next.contentDedupPlan?.resolvedFlags[0]).toBe(0)
        expect(next.releaseBorrowedContent).not.toHaveBeenCalled()
    })

    test('discards a prepared reservation when the next callback supplies different content', async () => {
        const h = await createHarness()
        const next = createChunk(h.database, [4, 5, 6], 11, 21)
        h.chunk.peekNextContentChunk = () => next
        const first = h.run()
        await vi.waitFor(() => expect(h.database._preparedArtifactTermContent?.result).toBeTruthy())
        h.finish()
        await first
        expect(h.database._takePreparedArtifactTermContent({...next, contentMetaList: new Uint32Array(next.contentMetaList)})).toBeNull()
        expect(h.database._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(h.database._getTermEntryContentMetaByHashPair(11, 21)).toBeUndefined()
        expect(next.contentDedupPlan?.resolvedFlags[0]).toBe(0)
    })

    test('does not wait for an unavailable next result', async () => {
        const h = await createHarness()
        h.chunk.peekNextContentChunk = () => null
        const first = h.run()
        await vi.waitFor(() => expect(h.appendRecords).toHaveBeenCalledOnce())
        h.finish()
        await first
        expect(h.database.getLastBulkAddTermsMetrics()?.dedupLookaheadPreparedCount).toBe(0)
        expect(h.database._preparedArtifactTermContent).toBeNull()
    })
})
