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
/* eslint-disable unicorn/prefer-spread -- Byte snapshots must retain typed storage for bounded memory comparisons. */

import {readFile} from 'node:fs/promises'
import {Buffer} from 'node:buffer'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} PublicationState */
/** @typedef {{database: DictionaryDatabase, state: PublicationState, staged: NonNullable<PublicationState['stagedContentMetadata']>}} Harness */
/** @type {WebAssembly.Module} */
let canonicalModule

beforeAll(async () => {
    canonicalModule = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)))
})

/**
 * Runs one already resolved row to load the native module without changing any
 * reservation. The callback also exercises publication during a scan's await.
 * @param {Harness} harness
 * @param {() => Promise<void>} [resolveExactCandidates]
 * @returns {{scanner: NativeCanonicalScanner, run: () => Promise<number|null>}}
 */
function scannerHarness({database}, resolveExactCandidates = async () => {}) {
    const scanner = new NativeCanonicalScanner({loadModule: async () => canonicalModule})
    Reflect.set(database, '_nativeCanonicalScanner', scanner)
    /** @type {Parameters<NativeCanonicalScanner['scan']>[1]} */
    const context = {
        chunk: {
            rowCount: 1,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: new Uint8Array(0),
            contentBytesBaseOffset: 0,
            contentMetaList: new Uint32Array(4),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        },
        contentDedupPlan: {
            resolvedFlags: new Uint8Array([1]),
            resolvedOffsets: new Float64Array(1),
            resolvedLengths: new Uint32Array(1),
            resolvedDictNames: null,
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
        },
        uniqueIndexList: new Uint32Array(1),
        uniqueRowIndexes: new Uint32Array(1),
        uniqueSignatures: new Uint32Array(3),
        firstUniqueIndex: 0,
        lastUniqueIndex: 1,
        persistedLookupRequired: false,
        reserveMetadata: false,
        adoptPendingColumns: (_batch, complete) => complete(),
        getPendingCount: () => 0,
        exactCandidates: [],
        resolveExactCandidates,
    }
    return {scanner, run: async () => await scanner.scan(database, context, {})}
}

/**
 * @param {Harness} harness
 * @param {NativeCanonicalScanner} scanner
 * @returns {boolean|null}
 */
function validateNative({database, state, staged}, scanner) {
    const arena = Reflect.get(database, '_termContentMetadataArena')
    return scanner.validateReservedMetadata(
        arena,
        staged.indexes,
        /** @type {Uint32Array} */ (state.pendingContentHash1s),
        /** @type {Uint32Array} */ (state.pendingContentHash2s),
        /** @type {Uint32Array} */ (state.pendingLengths),
        staged.indexes[0],
        state.pendingOffsets.length,
    )
}

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
        '_termEntryContentMetaHashPairTable',
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
        tables: Object.fromEntries(names.map((name) => [name, [...Reflect.get(database, name)]])),
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
                const ids = /** @type {Float64Array} */ (Reflect.get(database, '_termEntryContentMetaIdTable'))
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
                const dictIds = /** @type {Uint32Array} */ (Reflect.get(database, '_termEntryContentMetaDictNameIdTable'))
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
                const values = /** @type {Uint32Array} */ (Reflect.get(database, '_termEntryContentMetaDictNameIdTable'))
                const dictIds = new Uint32Array(offsets.buffer, offsets.byteOffset, values.length)
                dictIds.set(values)
                Reflect.set(database, '_termEntryContentMetaDictNameIdTable', dictIds)
            }},
    ]

    test.each(aliasCases)('preserves scalar read/write ordering when $name', (fixture) => {
        const scalar = createHarness()
        const candidate = createHarness()
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

describe('native publication preflight', () => {
    /** @type {Array<{name: string, expectedNative: boolean, change: (harness: Harness) => void}>} */
    const cases = [
        {name: 'valid reservations', expectedNative: true, change: () => {}},
        {name: 'late hash mismatch', expectedNative: false, change: ({state}) => { state.pendingContentHash1s[2] = 99 }},
        {name: 'late length mismatch', expectedNative: false, change: ({state}) => { state.pendingLengths[2] = 5 }},
        {name: 'late nonconsecutive ID', expectedNative: false, change: ({staged}) => { staged.indexes[2] = staged.indexes[1] }},
        {name: 'late published state',
            expectedNative: false,
            change: ({database, staged}) => {
                Reflect.get(database, '_termEntryContentMetaStateTable')[staged.indexes[2]] = 1
            }},
    ]

    test.each(cases)('preserves publication, rollback and retry for $name', async (fixture) => {
        const scalar = createHarness()
        const candidate = createHarness()
        const {scanner, run} = scannerHarness(candidate)
        await run()
        scalar.state.metadataValidated = candidate.state.metadataValidated = true
        fixture.change(scalar)
        fixture.change(candidate)
        const before = snapshot(candidate)
        expect(validateNative(candidate, scanner)).toBe(fixture.expectedNative)
        expect(snapshot(candidate)).toEqual(before)
        vi.spyOn(scalar.database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false)
        const native = vi.spyOn(scanner, 'validateReservedMetadata')
        expect(publish(candidate)).toEqual(publish(scalar))
        expect(native).toHaveReturnedWith(fixture.expectedNative)
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        candidate.database._rollbackStagedArtifactTermContentMetadata(candidate.staged)
        scalar.database._rollbackStagedArtifactTermContentMetadata(scalar.staged)
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        for (const harness of [candidate, scalar]) {
            const staged = harness.database._stageArtifactTermContentMetadata(new Uint32Array([31, 32, 33]),
                new Uint32Array([41, 42, 43]), [], harness.state.pendingContentSpans)
            harness.staged = staged
            harness.state.stagedContentMetadata = staged
            harness.state.pendingContentHash1s = new Uint32Array([31, 32, 33])
            harness.state.pendingContentHash2s = new Uint32Array([41, 42, 43])
            harness.state.pendingLengths = new Uint32Array([4, 4, 4])
        }
        expect(publish(candidate)).toEqual(publish(scalar))
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
    })

    test.each(['indexes', 'hash1', 'hash2', 'lengths', 'offsets', 'Id', 'Offset', 'DictNameId',
        'HashPair', 'Hash1', 'Hash2', 'State', 'Length', 'SignaturePresent', 'Signature1', 'Signature2', 'Signature3',
        'RecentSourceBatchId', 'RecentSourceOffset'])('keeps borrowed arena %s outside native scratch writes', async (column) => {
        const scalar = createHarness()
        const candidate = createHarness()
        const {scanner, run} = scannerHarness(candidate)
        await run()
        const native = vi.spyOn(scanner, 'validateReservedMetadata')
        for (const harness of [scalar, candidate]) {
            harness.state.metadataValidated = true
            const arena = Reflect.get(harness.database, '_termContentMetadataArena')
            const buffer = arena.memory.buffer
            const {state, staged} = harness
            if (column === 'indexes') {
                const values = staged.indexes
                staged.indexes = new Int32Array(buffer, layout.META, values.length)
                staged.indexes.set(values)
            } else if (column === 'hash1' || column === 'hash2' || column === 'lengths' || column === 'offsets') {
                let key = /** @type {'pendingContentHash1s'|'pendingContentHash2s'|'pendingLengths'|'pendingOffsets'} */ ('pendingOffsets')
                if (column === 'hash1') { key = 'pendingContentHash1s' }
                if (column === 'hash2') { key = 'pendingContentHash2s' }
                if (column === 'lengths') { key = 'pendingLengths' }
                const values = state[key]
                const copy = column === 'offsets' ?
                    new Float64Array(buffer, layout.META, values.length) :
                    new Uint32Array(buffer, layout.META, values.length)
                copy.set(values)
                Reflect.set(state, key, copy)
            } else {
                const key = `_termEntryContentMeta${column}Table`
                const values = Reflect.get(harness.database, key)
                let copy
                if (column === 'Id' || column === 'Offset') {
                    copy = new Float64Array(buffer, layout.META, values.length)
                } else if (column === 'State' || column === 'SignaturePresent') {
                    copy = new Uint8Array(buffer, layout.META, values.length)
                } else {
                    copy = new Uint32Array(buffer, layout.META, values.length)
                }
                copy.set(values)
                Reflect.set(harness.database, key, copy)
                const arenaColumn = /** @type {Record<string, string>} */ ({
                    HashPair: 'slots',
                    Hash1: 'hash1',
                    Hash2: 'hash2',
                    State: 'state',
                    Length: 'length',
                    SignaturePresent: 'signaturePresent',
                    Signature1: 'signature1',
                    Signature2: 'signature2',
                    Signature3: 'signature3',
                })[column]
                if (typeof arenaColumn === 'string') { Reflect.set(arena, arenaColumn, copy) }
            }
        }
        expect(publish(candidate)).toEqual(publish(scalar))
        expect(snapshot(candidate)).toEqual(snapshot(scalar))
        expect(native.mock.results.every((result) => result.type === 'return' && result.value === null)).toBe(true)
    })

    test.each([false, true])('releases scratch after an awaited scan, rejection=%s', async (reject) => {
        const harness = createHarness()
        harness.state.metadataValidated = true
        const expectedError = new Error('Exact callback rejected')
        const {scanner, run} = scannerHarness(harness, async () => {
            const arena = Reflect.get(harness.database, '_termContentMetadataArena')
            const prefix = new Uint8Array(arena.memory.buffer, 0, layout.PREFIX).slice()
            expect(validateNative(harness, scanner)).toBeNull()
            expect(Buffer.compare(new Uint8Array(arena.memory.buffer, 0, layout.PREFIX), prefix)).toBe(0)
            if (reject) { throw expectedError }
        })
        await (reject ? expect(run()).rejects.toBe(expectedError) : expect(run()).resolves.toBe(1))
        expect(validateNative(harness, scanner)).toBe(true)
        expect(publish(harness).error).toBeNull()
    })

    test('uses the JavaScript check after an awaited arena replacement', async () => {
        const harness = createHarness()
        const {scanner, run} = scannerHarness(harness, async () => {
            const current = Reflect.get(harness.database, '_termContentMetadataArena')
            harness.database._ensureTermEntryContentMetaHashPairCapacity(100)
            expect(Reflect.get(harness.database, '_termContentMetadataArena')).not.toBe(current)
            expect(validateNative(harness, scanner)).toBeNull()
        })
        await run()
        expect(validateNative(harness, scanner)).toBeNull()
        const next = scannerHarness(harness)
        await next.run()
        expect(validateNative(harness, next.scanner)).toBe(true)
    })

    test('rejects malformed raw memory layouts without changing authoritative bytes', async () => {
        const harness = createHarness()
        const {scanner, run} = scannerHarness(harness)
        await run()
        expect(validateNative(harness, scanner)).toBe(true)
        const arena = Reflect.get(harness.database, '_termContentMetadataArena')
        const buffer = arena.memory.buffer
        const config = new Uint32Array(buffer, 1088, 7)
        const validConfig = config.slice()
        const before = new Uint8Array(buffer, layout.PREFIX).slice()
        const {validate_reserved_metadata: validate} = new WebAssembly.Instance(canonicalModule, {env: {memory: arena.memory}}).exports
        if (typeof validate !== 'function') { throw new Error('Expected native publication validator') }
        const cases = [
            [0, layout.META], // Authoritative column overlaps input scratch.
            [0, arena.hash1.byteOffset + 1], // Misaligned column.
            [0, buffer.byteLength - 4], // Full column exceeds memory.
            [4, 0xffffffff], // Capacity multiplication must not wrap.
            [5, 0xffffffff], // First + count must not wrap.
            [6, layout.MAX + 1], // Fixed scratch column capacity.
        ]
        for (const [word, value] of cases) {
            config.set(validConfig)
            config[word] = value
            expect(validate()).toBe(-1)
            expect(Buffer.compare(new Uint8Array(buffer, layout.PREFIX), before)).toBe(0)
        }
        config.set(validConfig)
        expect(validate()).toBe(0)
        expect(Buffer.compare(new Uint8Array(buffer, layout.PREFIX), before)).toBe(0)
    })
})
