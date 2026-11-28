/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {DictionaryDatabase} database
 * @param {number[]} values
 * @param {number} hashBase
 * @param {boolean} [sparse]
 * @returns {{source: Uint8Array, offsets: Uint32Array, staged: {indexes: Int32Array, active: boolean}}}
 */
function publish(database, values, hashBase, sparse = false) {
    const source = Uint8Array.from(values)
    const count = values.length
    const offsets = Uint32Array.from(values, (_, i) => i)
    const lengths = new Uint32Array(count).fill(1)
    const hashes = Uint32Array.from(values, (_, i) => hashBase + i + 1)
    // A same-hash, unequal-byte row uses the existing collision path and makes
    // the primary IDs sparse without manufacturing a foreign cache mapping.
    if (sparse) { hashes[1] = hashes[0] }
    const spans = {buffer: source, offsets, lengths}
    const staged = database._stageArtifactTermContentMetadata(hashes, hashes, [], spans)
    database._publishArtifactTermContentMetadata({
        count,
        contentOffsets: new Float64Array(count),
        contentLengths: new Uint32Array(count),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: Int32Array.from(values, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s: hashes,
        pendingContentHash2s: hashes,
        pendingOffsets: Float64Array.from(values, (_, i) => 1000 + hashBase + i),
        pendingLengths: lengths,
        pendingResolvedDictNames: 'raw',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    })
    return {source, offsets, staged}
}

/**
 * @param {DictionaryDatabase} database
 * @param {number} hash
 * @returns {number[]|null}
 */
function cached(database, hash) {
    const meta = database._getTermEntryContentMetaByHashPair(hash, hash)
    if (typeof meta === 'undefined') { return null }
    const span = database._findRecentTermContentSource(meta)
    return typeof span === 'undefined' ? null : [...span.buffer.subarray(span.offset, span.offset + span.length)]
}

describe('bounded recent-content range descriptors', () => {
    test.each([0.5, -1, Number.NaN, Infinity])('rejects malformed table index %s', (tableIndex) => {
        const database = new DictionaryDatabase()
        publish(database, [1, 2], 100)
        const meta = database._getTermEntryContentMetaByHashPair(101, 101)
        if (typeof meta === 'undefined') { throw new Error('Missing metadata') }
        expect(database._findRecentTermContentSource({...meta, tableIndex})).toBeUndefined()
    })

    test('retains owned offsets only for live published ranges across metadata growth', () => {
        const database = new DictionaryDatabase()
        database._ensureTermEntryContentMetaDenseCapacity(4096)
        const first = publish(database, [11, 22, 33], 100)
        expect(database._termEntryContentMetaRecentSourceBatchIdTable.byteLength).toBe(0)
        expect(database._termEntryContentMetaRecentSourceOffsetTable.byteLength).toBe(0)
        expect(database._recentTermContentSourceRanges).toHaveLength(1)
        expect(database._recentTermContentSourceRanges[0].offsets.byteLength).toBe(12)
        first.offsets.fill(99)
        first.source.fill(0)
        database._ensureTermEntryContentMetaDenseCapacity(8192)
        expect([101, 102, 103].map((hash) => cached(database, hash))).toEqual([[11], [22], [33]])
        expect(database._termEntryContentMetaRecentSourceBatchIdTable.byteLength).toBe(0)
    })

    test('evicts mappings with source bytes and searches surviving range boundaries', () => {
        const database = new DictionaryDatabase()
        database._recentTermContentSourceCacheMaxBytes = 5
        publish(database, [1, 2], 100)
        publish(database, [3, 4], 200)
        publish(database, [5, 6], 300)
        expect(database._recentTermContentSourceRanges).toHaveLength(2)
        expect(database._recentTermContentSourceBatchBytes).toBe(4)
        expect([101, 102, 201, 202, 301, 302].map((hash) => cached(database, hash))).toEqual([null, null, [3], [4], [5], [6]])
        database._clearTermEntryContentMetaCaches()
        expect(database._recentTermContentSourceRanges).toHaveLength(0)
        expect(database._recentTermContentSourceBatches.size).toBe(0)
    })

    test('materializes existing mappings before sparse collision publication', () => {
        const database = new DictionaryDatabase()
        publish(database, [1, 2], 100)
        publish(database, [3, 4, 5], 200, true)
        expect(database._recentTermContentSourceRanges).toHaveLength(0)
        expect(database._termEntryContentMetaRecentSourceBatchIdTable.length).toBeGreaterThan(0)
        expect([101, 102, 201, 203].map((hash) => cached(database, hash))).toEqual([[1], [2], [3], [5]])
    })

    test('rollback retires its range and reused IDs preserve unrelated cached bytes', () => {
        const database = new DictionaryDatabase()
        const first = publish(database, [1, 2], 100)
        publish(database, [3, 4], 200)
        database._rollbackStagedArtifactTermContentMetadata(first.staged)
        expect(database._recentTermContentSourceRanges).toHaveLength(1)
        expect(database._recentTermContentSourceBatchBytes).toBe(2)
        publish(database, [5, 6], 300)
        expect([101, 102, 201, 202, 301, 302].map((hash) => cached(database, hash))).toEqual([null, null, [3], [4], [5], [6]])
        expect(database._recentTermContentSourceRanges).toHaveLength(0)
    })

    test.each([1, 2])('allocation failure %s keeps ranges and reusable IDs retryable', (failureIndex) => {
        const database = new DictionaryDatabase()
        const first = publish(database, [1], 100)
        publish(database, [2, 3], 200)
        database._rollbackStagedArtifactTermContentMetadata(first.staged)
        const ranges = [...database._recentTermContentSourceRanges]
        const free = [...database._termEntryContentMetaFreeIndexes]
        let allocations = 0
        vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {
            construct(target, args, newTarget) {
                if (++allocations === failureIndex) { throw new RangeError('range materialization failure') }
                return Reflect.construct(target, args, newTarget)
            },
        }))
        try {
            expect(() => database._allocateTermEntryContentMetaIndex()).toThrow('range materialization failure')
        } finally {
            vi.unstubAllGlobals()
        }
        expect(database._recentTermContentSourceRanges).toEqual(ranges)
        expect(database._termEntryContentMetaFreeIndexes).toEqual(free)
        expect(database._termEntryContentMetaRecentSourceBatchIdTable).toHaveLength(0)
        expect([201, 202].map((hash) => cached(database, hash))).toEqual([[2], [3]])
        expect(database._allocateTermEntryContentMetaIndex()).toBe(free[0])
        expect([201, 202].map((hash) => cached(database, hash))).toEqual([[2], [3]])
    })

    test('batch-ID wrap clears range mappings before accepting a new owner', () => {
        const database = new DictionaryDatabase()
        publish(database, [1, 2], 100)
        database._nextRecentTermContentSourceBatchId = 0x100000000
        publish(database, [3, 4], 200)
        expect(database._recentTermContentSourceRanges).toHaveLength(1)
        expect([101, 102, 201, 202].map((hash) => cached(database, hash))).toEqual([null, null, [3], [4]])
    })
})
