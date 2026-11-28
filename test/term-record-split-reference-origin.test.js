/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import assert from 'node:assert/strict'
import {prepareTermLookupIndexesFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @typedef {Parameters<TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']>[0]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} ContentReferences */

/**
 * @param {number} [count=128]
 * @returns {ArtifactChunk & {resolvedContentReferences: ContentReferences}}
 */
function fixture(count = 128) {
    const expression = new TextEncoder().encode('辞書')
    const builder = createTermRecordPreinternedPlanBuilder(1)
    builder.internStringBytes(expression)
    const keys = new Uint32Array(count)
    return createArtifactTermRecordChunkWithResolvedContent(
        {
            dictionary: 'Split reference origin',
            dictionaryTotalRows: 528299,
            rowCount: count,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList: new Uint8Array(count).fill(1),
            scoreList: Int32Array.from({length: count}, (_, i) => i % 5),
            sequenceList: new Int32Array(count).fill(-1),
            termRecordPreinternedPlan: builder.buildPlan(keys, keys),
        },
        Uint32Array.from({length: count}, (_, i) => (i < count / 2 ? 0 : 1)),
        Float64Array.of(16, 16 + 0xffffffff),
        Uint32Array.of(7, 9),
    )
}

/**
 * Exercise the real encoders and observe only their offset-column staging.
 * Storage writes are intercepted after the complete immutable bytes exist.
 * @param {(() => void|Promise<void>)|null} [afterAppend=null]
 * @returns {{store: TermRecordOpfsStore, append: import('vitest').MockInstance<TermRecordOpfsStore['_appendEncodedChunk']>, stagedRows: number[]}}
 */
function createStore(afterAppend = null) {
    const store = new TermRecordOpfsStore()
    const encodeFields = store._encodeArtifactRecordFields.bind(store)
    /** @type {number[]} */
    const stagedRows = []
    vi.spyOn(store, '_encodeArtifactRecordFields').mockImplementation((...args) => {
        const copy = vi.spyOn(Uint32Array.prototype, 'set')
        try {
            const bytes = encodeFields(...args)
            stagedRows.push(copy.mock.calls.reduce((total, [values]) => total + values.length, 0))
            return bytes
        } finally { copy.mockRestore() }
    })
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => { await afterAppend?.() })
    return {store, append, stagedRows}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 */
async function encode(store, chunk) {
    await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        [],
        [],
        chunk.termRecordPreinternedPlan ?? null,
        'raw',
        chunk.preparedLookupIndexes ?? null,
    )
}

afterEach(() => { vi.restoreAllMocks() })

describe('resolved reference origin through internal record splits', () => {
    test('reference tables keep original IDs and decline a split whose unused offset precedes its base', async () => {
        const chunk = fixture(65536)
        chunk.resolvedContentReferences.offsets[1] = 100
        chunk.preparedLookupIndexes = prepareTermLookupIndexesFromPreinternedPlan(chunk)?.indexes
        const candidate = createStore()
        candidate.store.setImportExperiments({experimentalReferenceTableFields: true})
        await candidate.store.beginImportSession()
        await encode(candidate.store, chunk)
        expect(candidate.append.mock.calls.map((args) => args[2])).toEqual([30000, 30000, 5536])
        expect(candidate.append.mock.calls.map((args) => args[7])).toEqual([4, 4, 2])
        for (const args of candidate.append.mock.calls) {
            const count = args[2]
            const first = args[1] - 1
            const fields = /** @type {Uint8Array} */ (args[6])
            const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength)
            const scores = view.getUint32(8, true)
            const references = args[7] === 4 ? view.getUint32(16, true) : count
            const offsetStart = (args[7] === 4 ? 20 : 16) + scores * 4
            const keysStart = offsetStart + references * 4 + Math.ceil(references / 2) * 4
            for (const row of [0, count - 1]) {
                const key = args[7] === 4 ? view.getUint16(keysStart + row * 2, true) : row
                const offset = /** @type {number} */ (args[4]) + view.getUint32(offsetStart + key * 4, true)
                expect(offset).toBe(chunk.resolvedContentReferences.offsets[chunk.resolvedContentReferences.uniqueIndexList[first + row]])
            }
        }
    })

    test('reference-table selection does not survive the await between two actual splits', async () => {
        const chunk = fixture(65536)
        chunk.resolvedContentReferences.offsets[1] = 100
        chunk.preparedLookupIndexes = prepareTermLookupIndexesFromPreinternedPlan(chunk)?.indexes
        const candidate = createStore(() => { chunk.resolvedContentReferences.offsets[1] = Number.NaN })
        candidate.store.setImportExperiments({experimentalReferenceTableFields: true})
        await candidate.store.beginImportSession()
        await expect(encode(candidate.store, chunk)).rejects.toThrow('Invalid term content offset')
        expect(candidate.append).toHaveBeenCalledTimes(1)
        expect(candidate.append.mock.calls[0][7]).toBe(4)
    })

    test('keeps direct output columns through the 30,000-row prepared-index segments', async () => {
        const chunk = fixture(65536)
        chunk.resolvedContentReferences.offsets[1] = 100
        chunk.preparedLookupIndexes = prepareTermLookupIndexesFromPreinternedPlan(chunk)?.indexes
        expect(chunk.preparedLookupIndexes?.size).toBe(3)
        const baseline = createStore()
        await encode(baseline.store, {...chunk})
        const candidate = createStore()
        await encode(candidate.store, chunk)
        expect(candidate.append.mock.calls.map((args) => args[2])).toEqual([30000, 30000, 5536])
        expect(baseline.stagedRows).toEqual([30000, 30000, 5536])
        expect(candidate.stagedRows).toEqual([0, 0, 0])
        assert.deepStrictEqual(candidate.append.mock.calls, baseline.append.mock.calls)
    })

    test('keeps direct output columns across content-offset splits', async () => {
        const chunk = fixture()
        const baseline = createStore()
        await encode(baseline.store, {...chunk})
        const candidate = createStore()
        await encode(candidate.store, chunk)
        expect(candidate.append.mock.calls.map((args) => args[2])).toEqual([64, 64])
        expect(baseline.stagedRows).toEqual([64, 64])
        expect(candidate.stagedRows).toEqual([0, 0])
        assert.deepStrictEqual(candidate.append.mock.calls, baseline.append.mock.calls)
    })

    test('keeps direct output columns across content-dictionary and subsequent offset splits', async () => {
        const chunk = fixture(256)
        chunk.resolvedContentReferences.uniqueIndexList.set(Uint32Array.from({length: 256}, (_, i) => (i >>> 6) % 2))
        const names = Array.from({length: 256}, (_, i) => (i < 128 ? 'raw' : 'other'))
        const baseline = createStore()
        const candidate = createStore()
        for (const {store} of [baseline, candidate]) {
            await store.beginImportSession()
            vi.spyOn(store, '_getOrCreateShardState').mockResolvedValue(
                /** @type {Awaited<ReturnType<TermRecordOpfsStore['_getOrCreateShardState']>>} */ ({}),
            )
        }
        await baseline.store.appendBatchFromArtifactChunkResolvedContent({...chunk}, [], [], names)
        await candidate.store.appendBatchFromArtifactChunkResolvedContent(chunk, [], [], names)
        expect(candidate.append.mock.calls.map((args) => args[2])).toEqual([64, 64, 64, 64])
        expect(baseline.stagedRows).toEqual([64, 64, 64, 64])
        expect(candidate.stagedRows).toEqual([0, 0, 0, 0])
        assert.deepStrictEqual(candidate.append.mock.calls, baseline.append.mock.calls)
    })

    test.each(['external', 'proxy', 'reference-proxy', 'shared', 'subclass', 'accessor', 'replacement'])('does not confer origin on a %s parent through slicing', async (kind) => {
        let chunk = fixture()
        if (kind === 'external') { chunk = {...chunk} }
        if (kind === 'proxy') { chunk = new Proxy(chunk, {}) }
        if (kind === 'reference-proxy') { chunk.resolvedContentReferences = new Proxy(chunk.resolvedContentReferences, {}) }
        if (kind === 'shared') {
            const offsets = new Float64Array(new SharedArrayBuffer(16))
            offsets.set(chunk.resolvedContentReferences.offsets)
            chunk.resolvedContentReferences.offsets = offsets
        }
        if (kind === 'subclass') {
            class Offsets extends Float64Array {}
            chunk.resolvedContentReferences.offsets = new Offsets(chunk.resolvedContentReferences.offsets)
        }
        if (kind === 'accessor') {
            const references = chunk.resolvedContentReferences
            Object.defineProperty(chunk, 'resolvedContentReferences', {get: () => references})
        }
        if (kind === 'replacement') { chunk.resolvedContentReferences = {...chunk.resolvedContentReferences} }
        const candidate = createStore()
        await encode(candidate.store, chunk)
        expect(candidate.stagedRows).toEqual([64, 64])
    })

    test('does not inherit a slice whose custom subarray returned unrelated indexes', async () => {
        const chunk = fixture()
        chunk.resolvedContentReferences.uniqueIndexList.subarray = (start, end) => new Uint32Array((end ?? 128) - (start ?? 0)).fill(1)
        const baseline = createStore()
        await encode(baseline.store, {...chunk})
        const candidate = createStore()
        await encode(candidate.store, chunk)
        expect(candidate.stagedRows).toEqual([64, 64])
        assert.deepStrictEqual(candidate.append.mock.calls, baseline.append.mock.calls)
    })

    test('does not inherit reference columns replaced by another column slice callback', async () => {
        const chunk = fixture()
        const original = chunk.resolvedContentReferences
        chunk.scoreList.slice = () => {
            chunk.resolvedContentReferences = {...original}
            return new Int32Array(64)
        }
        const candidate = createStore()
        await encode(candidate.store, chunk)
        expect(candidate.stagedRows).toEqual([64, 64])
    })

    test.each(['offset', 'length', 'index', 'replacement'])('revalidates %s after the first encoded split settles', async (kind) => {
        const chunk = fixture()
        const candidate = createStore(async () => {
            await Promise.resolve()
            const references = chunk.resolvedContentReferences
            if (kind === 'offset') { references.offsets[1] = Number.NaN }
            if (kind === 'length') { references.lengths[1] = 0xffffffff }
            if (kind === 'index') { references.uniqueIndexList[64] = 2 }
            if (kind === 'replacement') { chunk.resolvedContentReferences = {...references, offsets: Float64Array.of(16, Number.NaN)} }
        })
        await expect(encode(candidate.store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/)
        expect(candidate.append).toHaveBeenCalledTimes(1)
        expect(candidate.stagedRows).toEqual([0])
    })
})
