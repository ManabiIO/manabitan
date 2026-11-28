/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {registerOwnedTermContent, takeOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js'

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} PublicationState */
/** @typedef {{database: DictionaryDatabase, state: PublicationState, spans: NonNullable<PublicationState['pendingContentSpans']>, staged: NonNullable<PublicationState['stagedContentMetadata']>}} Harness */

/**
 * @param {{lengths?: number[], shared?: boolean, owned?: boolean}} [options]
 * @returns {Harness}
 */
function createHarness({lengths = [4, 4, 4], shared = false, owned = false} = {}) {
    const database = new DictionaryDatabase()
    const count = lengths.length
    const offsets = new Uint32Array(count)
    let sourceLength = 0
    for (let i = 0; i < count; ++i) {
        offsets[i] = sourceLength
        sourceLength += lengths[i]
    }
    const source = new Uint8Array(shared ? new SharedArrayBuffer(sourceLength) : new ArrayBuffer(sourceLength))
    source.set(Uint8Array.from({length: sourceLength}, (_, i) => i % 251))
    const spans = {buffer: source, offsets, lengths: Uint32Array.from(lengths)}
    const pendingContentHash1s = Uint32Array.from({length: count}, (_, i) => 11 + i)
    const pendingContentHash2s = Uint32Array.from({length: count}, (_, i) => 101 + i)
    const staged = database._stageArtifactTermContentMetadata(pendingContentHash1s, pendingContentHash2s, [], spans)
    if (owned) { registerOwnedTermContent(source) }
    const state = {
        count,
        contentOffsets: new Float64Array(count),
        contentLengths: new Uint32Array(count),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: Int32Array.from({length: count}, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s,
        pendingContentHash2s,
        pendingOffsets: Float64Array.from({length: count}, (_, i) => 100 + i * 12),
        pendingLengths: spans.lengths,
        pendingResolvedDictNames: 'raw',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    }
    return {database, state, spans, staged}
}

/**
 * @param {Harness} harness
 * @returns {Record<string, unknown>}
 */
function snapshot({database, state}) {
    const fields = [
        '_termEntryContentMetaStateTable',
        '_termEntryContentMetaIdTable',
        '_termEntryContentMetaOffsetTable',
        '_termEntryContentMetaDictNameIdTable',
        '_termEntryContentMetaRecentSourceBatchIdTable',
        '_termEntryContentMetaRecentSourceOffsetTable',
    ]
    return {
        tables: Object.fromEntries(fields.map((field) => [field, [...Reflect.get(database, field)]])),
        pendingCount: database._termEntryContentMetaHashPairPendingCount,
        publishedCount: database._termEntryContentMetaHashPairCount,
        recentBatches: [...database._recentTermContentSourceBatches].map(([id, bytes]) => [id, [...bytes], bytes.buffer.byteLength]),
        recentBytes: database._recentTermContentSourceBatchBytes,
        boundaryBatchId: database._recentTermContentBoundaryBatchId,
        nextBatchId: database._nextRecentTermContentSourceBatchId,
        contentOffsets: [...state.contentOffsets],
        contentLengths: [...state.contentLengths],
    }
}

/**
 * @param {Harness} harness
 * @returns {string|null}
 */
function publish(harness) {
    try {
        harness.database._publishArtifactTermContentMetadata(harness.state)
        return null
    } catch (error) {
        if (!(error instanceof Error)) { throw error }
        return `${error.name}: ${error.message}`
    }
}

/**
 * Retain the ordinary contiguous metadata publisher and disable only its
 * optional source summary, so the comparison uses the original cache scan.
 * @param {DictionaryDatabase} database
 */
function disableSourceSummary(database) {
    const original = database._tryPublishContiguousArtifactTermContentMetadata
    vi.spyOn(database, '_tryPublishContiguousArtifactTermContentMetadata').mockImplementation(
        (staged, hash1s, hash2s, offsets, lengths, dictNameId, metadataValidated) => original.call(database, staged, hash1s, hash2s, offsets, lengths, dictNameId, metadataValidated),
    )
}

describe('same-call cache source scan', () => {
    /** @type {Array<{name: string, summary: boolean, change: (harness: Harness) => void}>} */
    const cases = [
        {name: 'all published spans', summary: true, change: () => {}},
        {name: 'nonmonotonic source offsets', summary: true, change: ({spans}) => { spans.offsets.set([8, 0, 4]) }},
        {name: 'overlapping source spans', summary: true, change: ({spans}) => { spans.offsets.set([0, 0, 8]) }},
        {name: 'trimmed source edges',
            summary: true,
            change: ({spans}) => {
                spans.buffer = new Uint8Array(20).fill(42)
                spans.offsets.set([3, 7, 11])
            }},
        {name: 'owned partial source',
            summary: true,
            change: ({spans}) => {
                spans.buffer = new Uint8Array(20).fill(42)
                spans.offsets.set([3, 7, 11])
                registerOwnedTermContent(spans.buffer)
            }},
        {name: 'owned backing allocation over budget',
            summary: true,
            change: ({database, spans}) => {
                spans.buffer = new Uint8Array(20).fill(42)
                spans.offsets.set([3, 7, 11])
                registerOwnedTermContent(spans.buffer)
                database._recentTermContentSourceCacheMaxBytes = 16
            }},
        {name: 'nonidentical length column', summary: false, change: ({state, spans}) => { state.pendingLengths = Uint32Array.from(spans.lengths) }},
        {name: 'shared source offsets',
            summary: false,
            change: ({spans}) => {
                const offsets = new Uint32Array(new SharedArrayBuffer(spans.offsets.byteLength))
                offsets.set(spans.offsets)
                spans.offsets = offsets
            }},
        {name: 'shared publication states',
            summary: false,
            change: ({database}) => {
                const states = new Uint8Array(new SharedArrayBuffer(database._termEntryContentMetaStateTable.byteLength))
                states.set(database._termEntryContentMetaStateTable)
                database._termEntryContentMetaStateTable = states
            }},
        {name: 'generic persisted offsets', summary: false, change: ({state}) => { state.pendingOffsets = [...state.pendingOffsets] }},
        {name: 'invalid final source span', summary: false, change: ({spans}) => { spans.offsets[2] = 99 }},
        {name: 'invalid final persisted offset', summary: false, change: ({state}) => { state.pendingOffsets[2] = Number.NaN }},
        {name: 'invalid final staged length', summary: false, change: ({spans}) => { spans.lengths[2] = 5 }},
        {name: 'short source offset column', summary: false, change: ({spans}) => { spans.offsets = spans.offsets.subarray(0, 2) }},
        {name: 'detached source', summary: false, change: ({spans}) => { structuredClone(spans.buffer.buffer, {transfer: [spans.buffer.buffer]}) }},
        {name: 'resizable source',
            summary: false,
            change: ({spans}) => {
                spans.buffer = new Uint8Array(Reflect.construct(ArrayBuffer, [12, {maxByteLength: 24}]))
            }},
        {name: 'growable shared source',
            summary: false,
            change: ({spans}) => {
                spans.buffer = new Uint8Array(Reflect.construct(SharedArrayBuffer, [12, {maxByteLength: 24}]))
            }},
        {name: 'source offsets overwritten by metadata IDs',
            summary: false,
            change: ({database, spans}) => {
                const ids = database._termEntryContentMetaIdTable
                spans.offsets = new Uint32Array(ids.buffer, ids.byteOffset, 3)
                spans.offsets.set([0, 4, 8])
            }},
        {name: 'source offsets overwritten by persisted offsets',
            summary: false,
            change: ({database, spans}) => {
                const offsets = database._termEntryContentMetaOffsetTable
                spans.offsets = new Uint32Array(offsets.buffer, offsets.byteOffset, 3)
                spans.offsets.set([0, 4, 8])
            }},
        {name: 'source offsets overwritten by dictionary IDs',
            summary: false,
            change: ({database, spans}) => {
                spans.offsets = database._termEntryContentMetaDictNameIdTable.subarray(0, 3)
                spans.offsets.set([0, 4, 8])
            }},
        {name: 'disjoint source offsets in the metadata allocation',
            summary: true,
            change: ({database, spans}) => {
                const ids = database._termEntryContentMetaIdTable
                spans.offsets = new Uint32Array(ids.buffer, ids.byteOffset + 64, 3)
                spans.offsets.set([0, 4, 8])
            }},
        {name: 'cache mapping alias with batch ID wrap',
            summary: true,
            change: ({database, spans}) => {
                spans.offsets = database._termEntryContentMetaRecentSourceBatchIdTable.subarray(0, 3)
                spans.offsets.set([0, 4, 8])
                database._nextRecentTermContentSourceBatchId = 0x100000000
            }},
        {name: 'budget rejection', summary: true, change: ({database}) => { database._recentTermContentSourceCacheMaxBytes = 11 }},
        {name: 'FIFO eviction',
            summary: true,
            change: ({database}) => {
                database._recentTermContentSourceCacheMaxBytes = 12
                database._recentTermContentSourceBatches.set(99, new Uint8Array(4))
                database._recentTermContentSourceBatchBytes = 4
            }},
    ]

    test.each(cases)('matches the original scan for $name', ({change, summary}) => {
        const original = createHarness()
        const candidate = createHarness()
        change(original)
        change(candidate)
        disableSourceSummary(original.database)
        const cache = vi.spyOn(candidate.database, '_cacheRecentPublishedTermContentSources')
        expect(publish(candidate)).toEqual(publish(original))
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(cache.mock.calls.some((args) => args[3] !== null)).toBe(summary)
    })

    test.each([false, true])('retains owned source accounting and rollback; shared=%s', (shared) => {
        const original = createHarness({shared, owned: true})
        const candidate = createHarness({shared, owned: true})
        disableSourceSummary(original.database)
        expect(publish(candidate)).toBeNull()
        expect(publish(original)).toBeNull()
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(candidate.database._recentTermContentSourceBatches.get(1)).toBe(candidate.spans.buffer)
        expect(takeOwnedTermContent(candidate.spans.buffer)).toBe(false)
        expect(takeOwnedTermContent(original.spans.buffer)).toBe(false)
        candidate.database._rollbackStagedArtifactTermContentMetadata(candidate.staged)
        original.database._rollbackStagedArtifactTermContentMetadata(original.staged)
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(candidate.database._recentTermContentSourceBatchBytes).toBe(0)
    })

    test.each([[0], [0, 0, 0], [0, 4, 0], [512, 512, 512]])('preserves zero-length and threshold spans %j', (...lengths) => {
        const original = createHarness({lengths})
        const candidate = createHarness({lengths})
        disableSourceSummary(original.database)
        const cache = vi.spyOn(candidate.database, '_cacheRecentPublishedTermContentSources')
        expect(publish(candidate)).toBeNull()
        expect(publish(original)).toBeNull()
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(cache.mock.calls[0][3]).toMatchObject({count: lengths.length})
    })

    test('keeps the boundary-only sample decision without validating earlier spans', () => {
        const original = createHarness({lengths: [600, 600, 600]})
        const candidate = createHarness({lengths: [600, 600, 600]})
        original.spans.offsets[0] = 99999
        candidate.spans.offsets[0] = 99999
        disableSourceSummary(original.database)
        const cache = vi.spyOn(candidate.database, '_cacheRecentPublishedTermContentSources')
        expect(publish(candidate)).toBeNull()
        expect(publish(original)).toBeNull()
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(cache.mock.calls[0][3]).toBeNull()
        expect(candidate.database._recentTermContentSourceBatchBytes).toBe(600)
    })

    test('preserves boundary retention when sampling underestimates the full average', () => {
        const lengths = new Array(65).fill(4)
        lengths[63] = 40000 // The existing 64 evenly spaced samples omit row 63.
        const original = createHarness({lengths})
        const candidate = createHarness({lengths})
        disableSourceSummary(original.database)
        const cache = vi.spyOn(candidate.database, '_cacheRecentPublishedTermContentSources')
        expect(publish(candidate)).toBeNull()
        expect(publish(original)).toBeNull()
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(cache.mock.calls[0][3]).toMatchObject({count: 65, contentBytes: 40256})
        expect(candidate.database._recentTermContentSourceBatchBytes).toBe(4)
    })

    test('rejects the summary when a source column is replaced before cache consumption', () => {
        const original = createHarness()
        const candidate = createHarness()
        disableSourceSummary(original.database)
        for (const harness of [original, candidate]) {
            const cache = harness.database._cacheRecentPublishedTermContentSources
            vi.spyOn(harness.database, '_cacheRecentPublishedTermContentSources').mockImplementation((staged, spans, metrics, scan) => {
                if (spans === null) { throw new Error('Expected spans') }
                spans.offsets = Uint32Array.of(0, 4, 99)
                return cache.call(harness.database, staged, spans, metrics, scan)
            })
        }
        expect(publish(candidate)).toBeNull()
        expect(publish(original)).toBeNull()
        expect(snapshot(candidate)).toEqual(snapshot(original))
        expect(candidate.database._recentTermContentSourceBatches.size).toBe(0)
    })
})
