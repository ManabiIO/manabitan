/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {registerOwnedTermContent, takeOwnedTermContent} from '../ext/js/dictionary/term-content-ownership.js'

/**
 * @param {DictionaryDatabase} database
 * @param {Uint8Array} source
 * @param {number[]} offsets
 * @param {number[]} lengths
 * @param {number} [hashBase]
 * @returns {{indexes: Int32Array, active: boolean}}
 */
function publish(database, source, offsets, lengths, hashBase = 0) {
    const count = lengths.length
    const hash1s = Uint32Array.from(lengths, (_, i) => hashBase + 10 + i)
    const hash2s = Uint32Array.from(lengths, (_, i) => hashBase + 20 + i)
    const spans = {buffer: source, offsets: Uint32Array.from(offsets), lengths: Uint32Array.from(lengths)}
    const staged = database._stageArtifactTermContentMetadata(hash1s, hash2s, [], spans)
    database._publishArtifactTermContentMetadata({
        count,
        contentOffsets: new Float64Array(count),
        contentLengths: new Uint32Array(count),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: Int32Array.from(lengths, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s: hash1s,
        pendingContentHash2s: hash2s,
        pendingOffsets: Float64Array.from(offsets, (offset) => 1000 + offset),
        pendingLengths: Uint32Array.from(lengths),
        pendingResolvedDictNames: 'raw',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    })
    return staged
}

/**
 * @param {DictionaryDatabase} database
 * @param {number} index
 * @param {number} [hashBase]
 * @returns {{buffer: Uint8Array, offset: number, length: number}|undefined}
 */
function find(database, index, hashBase = 0) {
    const meta = database._getTermEntryContentMetaByHashPair(hashBase + 10 + index, hashBase + 20 + index)
    if (typeof meta === 'undefined') { throw new Error('Missing published metadata') }
    return database._findRecentTermContentSource(meta)
}

describe('large-definition boundary cache', () => {
    test.each([false, true])('retains only the final copied span with shared=%s', (shared) => {
        const database = new DictionaryDatabase()
        const source = shared ? new Uint8Array(new SharedArrayBuffer(8192), 3, 4096) : new Uint8Array(8192)
        source.set(new Uint8Array(600).fill(7), 2)
        source.set(new Uint8Array(700).fill(9), 800)
        const stage = publish(database, source, [2, 800], [600, 700])
        expect(find(database, 0)).toBeUndefined()
        const retained = find(database, 1)
        expect(retained).toMatchObject({offset: 0, length: 700})
        expect(retained?.buffer.buffer).not.toBe(source.buffer)
        const expectedBytes = source.slice(800, 1500)
        source.fill(0)
        expect(retained?.buffer).toEqual(expectedBytes)
        expect(database._recentTermContentSourceBatchBytes).toBe(shared ? 703 : 700)
        expect(database._recentTermContentSourceBatches.size).toBe(1)
        database._rollbackStagedArtifactTermContentMetadata(stage)
        expect(database._recentTermContentSourceBatches.size).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
        expect(database._recentTermContentBoundaryBatchId).toBe(0)
    })

    test('never adopts a complete owned slab for a single boundary span', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(1024 * 1024).fill(7)
        registerOwnedTermContent(source)
        publish(database, source, [0, 2048], [600, 700])
        expect(find(database, 0)).toBeUndefined()
        expect(find(database, 1)?.buffer.buffer).not.toBe(source.buffer)
        expect(database._recentTermContentSourceBatchBytes).toBe(700)
        expect(takeOwnedTermContent(source)).toBe(true)
    })

    test('preserves exact collision checks and clears snapshots with the import metadata', async () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(1400).fill(4)
        publish(database, source, [0, 700], [700, 700])
        const meta = database._getTermEntryContentMetaByHashPair(11, 21)
        if (typeof meta === 'undefined') { throw new Error('Missing published metadata') }
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailed')
        await expect(database._findMatchingPersistedTermEntryContentMeta([meta], new Uint8Array(700).fill(4))).resolves.toBe(meta)
        const collision = new Uint8Array(700).fill(4)
        collision[351] = 5
        await expect(database._findMatchingPersistedTermEntryContentMeta([meta], collision)).resolves.toBeUndefined()
        expect(read).not.toHaveBeenCalled()
        database._clearTermEntryContentMetaCaches()
        expect(database._findRecentTermContentSource(meta)).toBeUndefined()
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
        expect(database._recentTermContentBoundaryBatchId).toBe(0)
    })

    test('replaces a boundary snapshot without retiring unrelated short-definition batches', () => {
        const database = new DictionaryDatabase()
        publish(database, new Uint8Array(16).fill(1), [0], [16])
        publish(database, new Uint8Array(700).fill(2), [0], [700], 100)
        expect(database._recentTermContentSourceBatchBytes).toBe(716)
        publish(database, new Uint8Array(800).fill(3), [0], [800], 200)
        expect(find(database, 0)?.buffer).toEqual(new Uint8Array(16).fill(1))
        expect(find(database, 0, 100)).toBeUndefined()
        expect(find(database, 0, 200)?.buffer).toEqual(new Uint8Array(800).fill(3))
        expect(database._recentTermContentSourceBatchBytes).toBe(816)
        publish(database, new Uint8Array(24).fill(4), [0], [24], 300)
        expect(find(database, 0, 200)).toBeUndefined()
        expect(find(database, 0)?.buffer).toEqual(new Uint8Array(16).fill(1))
        expect(find(database, 0, 300)?.buffer).toEqual(new Uint8Array(24).fill(4))
        expect(database._recentTermContentSourceBatchBytes).toBe(40)
        expect(database._recentTermContentBoundaryBatchId).toBe(0)
    })

    test('does not pin more than the existing block target for an arbitrarily large boundary', () => {
        const database = new DictionaryDatabase()
        const length = 1024 * 1024 + 1
        const source = new Uint8Array(length)
        registerOwnedTermContent(source)
        publish(database, source, [0], [length])
        expect(database._recentTermContentSourceBatches.size).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
        expect(takeOwnedTermContent(source)).toBe(true)
    })

    test('clears boundary tracking when batch IDs wrap before reusing an ID for a normal batch', () => {
        const database = new DictionaryDatabase()
        publish(database, new Uint8Array(700), [0], [700])
        expect(database._recentTermContentBoundaryBatchId).toBe(1)
        database._nextRecentTermContentSourceBatchId = 0x100000000
        publish(database, new Uint8Array(16).fill(3), [0], [16], 100)
        expect(database._recentTermContentBoundaryBatchId).toBe(0)
        expect(find(database, 0)).toBeUndefined()
        publish(database, new Uint8Array(800).fill(4), [0], [800], 200)
        expect(find(database, 0, 100)?.buffer).toEqual(new Uint8Array(16).fill(3))
        expect(find(database, 0, 200)?.buffer).toEqual(new Uint8Array(800).fill(4))
        expect(database._recentTermContentSourceBatchBytes).toBe(816)
    })

    test('skips trailing unpublished and collision slots without reading their invalid spans', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(1400).fill(7)
        const stage = publish(database, source, [0, 700], [700, 700])
        const pending = database._stageArtifactTermContentMetadata([30], [40], [source], null)
        expect(database._cacheRecentPublishedTermContentSources({
            indexes: new Int32Array([...stage.indexes, pending.indexes[0], -1]), active: true,
        }, {
            buffer: source,
            offsets: new Uint32Array([0, 700, 0xffffffff, 0xffffffff]),
            lengths: new Uint32Array([700, 700, 0xffffffff, 0xffffffff]),
        })).toBe(700)
        expect(find(database, 0)).toBeUndefined()
        expect(find(database, 1)?.buffer).toEqual(new Uint8Array(700).fill(7))
        database._rollbackStagedArtifactTermContentMetadata(pending)
        expect(database._recentTermContentSourceBatchBytes).toBe(700)
    })

    test('declines an invalid selected boundary and retires the old snapshot', () => {
        const database = new DictionaryDatabase()
        const source = new Uint8Array(1400)
        const stage = publish(database, source, [0, 700], [700, 700])
        expect(database._cacheRecentPublishedTermContentSources(stage, {
            buffer: source, offsets: new Uint32Array([0, 1400]), lengths: new Uint32Array([700, 700]),
        })).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
        expect(database._recentTermContentBoundaryBatchId).toBe(0)
    })

    test('does not retain an empty final span from a large-definition group', () => {
        const database = new DictionaryDatabase()
        publish(database, new Uint8Array(1600), [0, 800, 1600], [800, 800, 0])
        expect(database._recentTermContentSourceBatches.size).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
    })

    test('declines an oversized boundary without consuming source ownership', () => {
        const database = new DictionaryDatabase()
        database._recentTermContentSourceCacheMaxBytes = 699
        const source = new Uint8Array(1400)
        registerOwnedTermContent(source)
        publish(database, source, [0, 700], [700, 700])
        expect(database._recentTermContentSourceBatches.size).toBe(0)
        expect(database._recentTermContentSourceBatchBytes).toBe(0)
        expect(takeOwnedTermContent(source)).toBe(true)
    })

    test('uses the exact whole-batch average when sparse sampling misses large definitions', () => {
        const count = 128
        const sampled = new Set(Array.from({length: 64}, (_, i) => Math.floor(i * (count - 1) / 63)))
        const lengths = Array.from({length: count}, (_, i) => (sampled.has(i) ? 16 : 2048))
        let end = 0
        const offsets = lengths.map((length) => {
            const offset = end
            end += length
            return offset
        })
        const database = new DictionaryDatabase()
        const source = new Uint8Array(end).fill(5)
        publish(database, source, offsets, lengths)
        for (let i = 0; i < count - 1; ++i) { expect(find(database, i)).toBeUndefined() }
        expect(find(database, count - 1)?.buffer).toEqual(new Uint8Array(16).fill(5))
        expect(database._recentTermContentSourceBatchBytes).toBe(16)
    })
})
