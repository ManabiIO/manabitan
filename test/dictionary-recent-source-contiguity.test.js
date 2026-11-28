/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {registerOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js'

/** @typedef {Pick<DictionaryDatabase, '_termEntryContentMetaStateTable'|'_termEntryContentMetaRecentSourceBatchIdTable'|'_termEntryContentMetaRecentSourceOffsetTable'|'_recentTermContentSourceBatches'|'_recentTermContentSourceBatchBytes'|'_recentTermContentSourceCacheMaxBytes'|'_recentTermContentBoundaryBatchId'|'_nextRecentTermContentSourceBatchId'>} CacheOwner */

/** @returns {CacheOwner} */
function createOwner() {
    return {
        _termEntryContentMetaStateTable: new Uint8Array(4).fill(1),
        _termEntryContentMetaRecentSourceBatchIdTable: new Uint32Array(4),
        _termEntryContentMetaRecentSourceOffsetTable: new Uint32Array(4).fill(77),
        _recentTermContentSourceBatches: new Map(),
        _recentTermContentSourceBatchBytes: 0,
        _recentTermContentSourceCacheMaxBytes: 48 * 1024 * 1024,
        _recentTermContentBoundaryBatchId: 0,
        _nextRecentTermContentSourceBatchId: 1,
    }
}

/**
 * @param {ReturnType<typeof createOwner>} owner
 * @param {Int32Array} indexes
 */
function retain(owner, indexes) {
    const source = new Uint8Array(new SharedArrayBuffer(12))
    source.set(Uint8Array.from({length: 12}, (_, index) => index + 1))
    expect(registerOwnedTermContent(source)).toBe(true)
    /** @type {Record<string, number>} */
    const metrics = {}
    const cache = Reflect.get(DictionaryDatabase.prototype, '_cacheRecentPublishedTermContentSources')
    expect(cache.call(owner, {indexes, active: true}, {
        buffer: source,
        offsets: Uint32Array.of(0, 4, 8),
        lengths: Uint32Array.of(4, 4, 4),
    }, metrics)).toBe(12)
    expect(owner._recentTermContentSourceBatches.get(1)).toBe(source)
    expect(owner._recentTermContentSourceBatchBytes).toBe(12)
    expect(metrics).toEqual({dedupRecentSourceAdoptedBytes: 12})
}

describe('recent-source contiguous index observation', () => {
    test.each([false, true])('preserves an index view aliased to batch IDs with rollover=%s', (rollover) => {
        const owner = createOwner()
        const indexes = new Int32Array(owner._termEntryContentMetaRecentSourceBatchIdTable.buffer, 0, 3)
        indexes.set([0, 1, 2])
        if (rollover) { owner._nextRecentTermContentSourceBatchId = 0x100000000 }
        retain(owner, indexes)
        expect(owner._termEntryContentMetaRecentSourceBatchIdTable).toEqual(
            Uint32Array.from(rollover ? [1, 0, 0, 0] : [1, 1, 1, 0]),
        )
        expect(owner._termEntryContentMetaRecentSourceOffsetTable).toEqual(
            Uint32Array.from(rollover ? [8, 77, 77, 77] : [0, 4, 8, 77]),
        )
    })

    test('keeps final shared-index validation after a concurrent metadata change', () => {
        const owner = createOwner()
        const indexes = new Int32Array(new SharedArrayBuffer(12))
        indexes.set([0, 1, 2])
        // Model another worker changing shared metadata after the bounds scan.
        const batches = owner._recentTermContentSourceBatches
        const set = Map.prototype.set
        vi.spyOn(batches, 'set').mockImplementation((key, value) => {
            indexes[1] = 0
            return set.call(batches, key, value)
        })
        retain(owner, indexes)
        expect(owner._termEntryContentMetaRecentSourceBatchIdTable).toEqual(Uint32Array.of(1, 0, 1, 0))
        expect(owner._termEntryContentMetaRecentSourceOffsetTable).toEqual(Uint32Array.of(4, 77, 8, 77))
    })
})
