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

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} PublicationState */
/** @typedef {{database: DictionaryDatabase, state: PublicationState, staged: NonNullable<PublicationState['stagedContentMetadata']>}} Harness */

/**
 * @param {boolean} [collision]
 * @returns {Harness}
 */
function createHarness(collision = false) {
    const database = new DictionaryDatabase()
    const pendingContentHash1s = new Uint32Array([11, 12, collision ? 11 : 13])
    const pendingContentHash2s = new Uint32Array([21, 22, collision ? 21 : 23])
    const pendingContentSpans = {
        buffer: Uint8Array.from({length: 12}, (_, i) => i + 1),
        offsets: new Uint32Array([0, 4, 8]),
        lengths: new Uint32Array([4, 4, 4]),
    }
    const staged = database._stageArtifactTermContentMetadata(pendingContentHash1s, pendingContentHash2s, [], pendingContentSpans)
    const state = {
        count: 3,
        contentOffsets: new Float64Array(3),
        contentLengths: new Uint32Array(3),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: new Int32Array([0, 1, 2]),
        pendingContentBytes: [],
        pendingContentHash1s,
        pendingContentHash2s,
        pendingOffsets: new Float64Array([100, 104, 108]),
        pendingLengths: new Uint32Array([4, 4, 4]),
        pendingResolvedDictNames: 'raw',
        pendingContentSpans,
        stagedContentMetadata: staged,
    }
    return {database, state, staged}
}

/**
 * @param {Harness} harness
 * @returns {Record<string, unknown>}
 */
function snapshot({database, state, staged}) {
    const names = [
        '_termEntryContentMetaHash1Table',
        '_termEntryContentMetaHash2Table',
        '_termEntryContentMetaStateTable',
        '_termEntryContentMetaIdTable',
        '_termEntryContentMetaOffsetTable',
        '_termEntryContentMetaLengthTable',
        '_termEntryContentMetaDictNameIdTable',
        '_termEntryContentMetaSignaturePresentTable',
        '_termEntryContentMetaSignature1Table',
        '_termEntryContentMetaSignature2Table',
        '_termEntryContentMetaSignature3Table',
        '_termEntryContentMetaRecentSourceBatchIdTable',
        '_termEntryContentMetaRecentSourceOffsetTable',
    ]
    return {
        tables: Object.fromEntries(names.map((name) => [name, name === '_termEntryContentMetaDictNameIdTable' ?
            Array.from({length: Reflect.get(database, '_termEntryContentMetaStateTable').length}, (_, i) => database._readTermEntryContentMetaDictNameId(i)) :
            [...Reflect.get(database, name)]])),
        pendingCount: Reflect.get(database, '_termEntryContentMetaHashPairPendingCount'),
        publishedCount: Reflect.get(database, '_termEntryContentMetaHashPairCount'),
        denseCount: Reflect.get(database, '_termEntryContentMetaDenseCount'),
        freeIndexes: [...Reflect.get(database, '_termEntryContentMetaFreeIndexes')],
        dictNames: [...Reflect.get(database, '_termEntryContentMetaDictNames')],
        collisionEntries: [...Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair')],
        recentBatches: [...Reflect.get(database, '_recentTermContentSourceBatches')],
        recentBytes: Reflect.get(database, '_recentTermContentSourceBatchBytes'),
        nextBatchId: Reflect.get(database, '_nextRecentTermContentSourceBatchId'),
        staged,
        contentOffsets: state.contentOffsets,
        contentLengths: state.contentLengths,
    }
}

/**
 * @param {Harness} harness
 * @returns {{result: string|(string|null)[]|undefined, error: {name: string, message: string}|null}}
 */
function publish(harness) {
    try {
        return {result: harness.database._publishArtifactTermContentMetadata(harness.state), error: null}
    } catch (error) {
        if (!(error instanceof Error)) { throw error }
        return {result: void 0, error: {name: error.name, message: error.message}}
    }
}

describe('contiguous content metadata publication', () => {
    /** @type {Array<{name: string, expectedFast: boolean, collision?: boolean, expectedError?: string, change: (harness: Harness) => void}>} */
    const cases = [
        {name: 'uniform owned typed columns', expectedFast: true, change: () => {}},
        {name: 'validated metadata', expectedFast: true, change: ({state}) => { state.metadataValidated = true }},
        {name: 'generic offset arrays', expectedFast: false, change: ({state}) => { state.pendingOffsets = [...state.pendingOffsets] }},
        {name: 'generic hash arrays', expectedFast: false, change: ({state}) => { state.pendingContentHash1s = [...state.pendingContentHash1s] }},
        {name: 'generic length arrays', expectedFast: false, change: ({state}) => { state.pendingLengths = [...state.pendingLengths] }},
        {name: 'shared offsets',
            expectedFast: false,
            change: ({state}) => {
                const shared = new Float64Array(new SharedArrayBuffer(24))
                shared.set(state.pendingOffsets)
                state.pendingOffsets = shared
            }},
        {name: 'disjoint ranges in one backing buffer',
            expectedFast: true,
            change: ({database, state}) => {
                const ids = new Float64Array(Reflect.get(database, '_termEntryContentMetaStateTable').length)
                Reflect.set(database, '_termEntryContentMetaIdTable', ids)
                const values = state.pendingOffsets
                state.pendingOffsets = ids.subarray(5, 8)
                state.pendingOffsets.set(values)
            }},
        {name: 'short output table',
            expectedFast: false,
            change: ({database}) => {
                const offsets = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaOffsetTable'))
                Reflect.set(database, '_termEntryContentMetaOffsetTable', offsets.subarray(0, 2))
            }},
        {name: 'mixed dictionary names', expectedFast: false, change: ({state}) => { state.pendingResolvedDictNames = ['raw', 'raw-v6', 'raw'] }},
        {name: 'hash collision', expectedFast: false, collision: true, change: () => {}},
        {name: 'nonconsecutive reservations',
            expectedFast: false,
            change: ({state, staged}) => {
                const indexes = [...staged.indexes]
                staged.indexes.set([indexes[1], indexes[2], indexes[0]])
                state.pendingContentHash1s = new Uint32Array([12, 13, 11])
                state.pendingContentHash2s = new Uint32Array([22, 23, 21])
            }},
        {name: 'changed final hash', expectedFast: false, change: ({state}) => { state.pendingContentHash1s[2] = 99 }},
        {name: 'late noninteger offset', expectedFast: false, expectedError: 'RangeError', change: ({state}) => { state.pendingOffsets[2] = 3.5 }},
        {name: 'late negative offset', expectedFast: false, expectedError: 'RangeError', change: ({state}) => { state.pendingOffsets[2] = -1 }},
        {name: 'late nonfinite offset', expectedFast: false, expectedError: 'RangeError', change: ({state}) => { state.pendingOffsets[2] = Infinity }},
        {name: 'late NaN offset', expectedFast: false, expectedError: 'RangeError', change: ({state}) => { state.pendingOffsets[2] = Number.NaN }},
        {name: 'late length mismatch', expectedFast: false, expectedError: 'RangeError', change: ({state}) => { state.pendingLengths[2] = 5 }},
        {name: 'late validated length mismatch',
            expectedFast: false,
            expectedError: 'RangeError',
            change: ({state}) => {
                state.metadataValidated = true
                state.pendingLengths[2] = 5
            }},
        {name: 'late invalid cache source span',
            expectedFast: true,
            change: ({state}) => {
                if (state.pendingContentSpans === null) { throw new Error('Expected source spans') }
                state.pendingContentSpans.offsets[2] = 20
            }},
        {name: 'subarray columns',
            expectedFast: true,
            change: ({state, staged}) => {
                staged.indexes = Int32Array.of(-99, ...staged.indexes, -99).subarray(1, 4)
                state.pendingOffsets = Float64Array.of(-99, ...state.pendingOffsets, -99).subarray(1, 4)
                state.pendingLengths = Uint32Array.of(99, ...state.pendingLengths, 99).subarray(1, 4)
                state.pendingContentHash1s = Uint32Array.of(99, ...state.pendingContentHash1s, 99).subarray(1, 4)
                state.pendingContentHash2s = Uint32Array.of(99, ...state.pendingContentHash2s, 99).subarray(1, 4)
            }},
    ]

    test.each(cases)('matches scalar publication for $name', (fixture) => {
        const scalar = createHarness(fixture.collision)
        const candidate = createHarness(fixture.collision)
        fixture.change(scalar)
        fixture.change(candidate)
        vi.spyOn(scalar.database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false)
        const fast = vi.spyOn(candidate.database, '_tryPublishContiguousArtifactTermContentMetadata')
        const expected = publish(scalar)
        const actual = publish(candidate)
        expect(actual).toEqual(expected)
        expect(actual.error?.name).toBe(fixture.expectedError)
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        expect(fast.mock.results.some((entry) => entry.type === 'return' && entry.value === true)).toBe(fixture.expectedFast)
        if (fixture.expectedError) {
            expect(Reflect.get(candidate.database, '_termEntryContentMetaHashPairCount')).toBe(2)
            expect(Reflect.get(candidate.database, '_termEntryContentMetaHashPairPendingCount')).toBe(1)
        }
    })

    test('failed preflight leaves reservation state unchanged', () => {
        const harness = createHarness()
        harness.state.pendingOffsets[2] = Number.NaN
        const before = snapshot(harness)
        const result = harness.database._tryPublishContiguousArtifactTermContentMetadata(
            harness.staged,
            harness.state.pendingContentHash1s,
            harness.state.pendingContentHash2s,
            harness.state.pendingOffsets,
            harness.state.pendingLengths,
            0,
            false,
        )
        expect(result).toBe(false)
        expect(snapshot(harness)).toEqual(before)
    })

    /** @type {Array<{name: string, change: (harness: Harness) => void}>} */
    const aliasCases = [
        {name: 'offset input overwritten by ID publication',
            change: ({database, state}) => {
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
                const values = state.pendingOffsets
                state.pendingOffsets = ids.subarray(0, 3)
                state.pendingOffsets.set(values)
            }},
        {name: 'shifted offset input and output',
            change: ({database, state}) => {
                const capacity = Reflect.get(database, '_termEntryContentMetaOffsetTable').length
                const buffer = new ArrayBuffer((capacity + 1) * 8)
                Reflect.set(database, '_termEntryContentMetaOffsetTable', new Float64Array(buffer, 8, capacity))
                const values = state.pendingOffsets
                state.pendingOffsets = new Float64Array(buffer, 0, 3)
                state.pendingOffsets.set(values)
            }},
        {name: 'hash input overwritten by ID publication',
            change: ({database, state}) => {
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
                const values = state.pendingContentHash1s
                state.pendingContentHash1s = new Uint32Array(ids.buffer, ids.byteOffset, 3)
                state.pendingContentHash1s.set(values)
            }},
        {name: 'length input overwritten by ID publication',
            change: ({database, state}) => {
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
                const values = state.pendingLengths
                state.pendingLengths = new Uint32Array(ids.buffer, ids.byteOffset, 3)
                state.pendingLengths.set(values)
            }},
        {name: 'reservation indexes overlap dictionary IDs',
            change: ({database, staged}) => {
                const dictIds = database._materializeTermEntryContentMetaDictNameIds()
                const values = staged.indexes
                staged.indexes = new Int32Array(dictIds.buffer, dictIds.byteOffset, 3)
                staged.indexes.set(values)
            }},
        {name: 'metadata lengths overlap published IDs',
            change: ({database}) => {
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
                const values = /** @type {Uint32Array} */ (Reflect.get(database, '_termEntryContentMetaLengthTable'))
                const lengths = new Uint32Array(ids.buffer, ids.byteOffset, values.length)
                lengths.set(values)
                Reflect.set(database, '_termEntryContentMetaLengthTable', lengths)
            }},
        {name: 'metadata hashes overlap published IDs',
            change: ({database}) => {
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
                const values = /** @type {Uint32Array} */ (Reflect.get(database, '_termEntryContentMetaHash1Table'))
                const hashes = new Uint32Array(ids.buffer, ids.byteOffset, values.length)
                hashes.set(values)
                Reflect.set(database, '_termEntryContentMetaHash1Table', hashes)
            }},
        {name: 'output offset and dictionary ID ranges overlap',
            change: ({database}) => {
                const offsets = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaOffsetTable'))
                const values = database._materializeTermEntryContentMetaDictNameIds()
                const dictIds = new Uint32Array(offsets.buffer, offsets.byteOffset, values.length)
                dictIds.set(values)
                Reflect.set(database, '_termEntryContentMetaDictNameIdTable', dictIds)
            }},
    ]

    test.each(aliasCases)('preserves scalar read/write ordering when $name', (fixture) => {
        const scalar = createHarness()
        const candidate = createHarness()
        // These cases exercise physical overlaps after legacy IDs materialize.
        for (const {database} of [scalar, candidate]) {
            Reflect.set(database, '_termEntryContentMetaIdTable', new Float64Array(Reflect.get(database, '_termEntryContentMetaStateTable').length))
        }
        fixture.change(scalar)
        fixture.change(candidate)
        vi.spyOn(scalar.database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false)
        const fast = vi.spyOn(candidate.database, '_tryPublishContiguousArtifactTermContentMetadata')
        expect(publish(candidate)).toEqual(publish(scalar))
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        expect(fast.mock.results).toHaveLength(1)
        expect(fast.mock.results[0]).toMatchObject({type: 'return', value: false})
    })

    test('rollback clears a bulk-published range exactly as scalar publication', () => {
        const scalar = createHarness()
        const candidate = createHarness()
        vi.spyOn(scalar.database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false)
        expect(publish(candidate).error).toBeNull()
        expect(publish(scalar).error).toBeNull()
        expect(Reflect.get(candidate.database, '_termEntryContentMetaHashPairCount')).toBe(3)
        expect(Reflect.get(candidate.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0)
        expect(Reflect.get(candidate.database, '_recentTermContentSourceBatches').size).toBe(1)
        candidate.database._rollbackStagedArtifactTermContentMetadata(candidate.staged)
        scalar.database._rollbackStagedArtifactTermContentMetadata(scalar.staged)
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        expect(Reflect.get(candidate.database, '_termEntryContentMetaHashPairCount')).toBe(0)
        expect(Reflect.get(candidate.database, '_recentTermContentSourceBatchBytes')).toBe(0)
    })
})
