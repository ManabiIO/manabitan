/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {DictionaryDatabase} database
 * @param {number} hash
 * @param {number} id
 */
function set(database, hash, id) {
    database._setTermEntryContentMetaByHashPair(hash, hash, {id, offset: 1000 + hash, length: 1, dictName: 'raw'})
}

/**
 * @param {DictionaryDatabase} database
 * @param {number} hash
 * @returns {ReturnType<DictionaryDatabase['_getTermEntryContentMetaByHashPair']>}
 */
function get(database, hash) {
    return database._getTermEntryContentMetaByHashPair(hash, hash)
}

/**
 * @param {DictionaryDatabase} database
 * @param {number[]} values
 * @returns {{hashes: Uint32Array, lengths: Uint32Array, staged: ReturnType<DictionaryDatabase['_stageArtifactTermContentMetadata']>, state: Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]}}
 */
function prepare(database, values) {
    const hashes = Uint32Array.from(values)
    const lengths = new Uint32Array(values.length).fill(1)
    const spans = {buffer: Uint8Array.from(values), offsets: Uint32Array.from(values, (_, i) => i), lengths}
    const staged = database._stageArtifactTermContentMetadata(hashes, hashes, [], spans)
    const state = {
        count: values.length,
        contentOffsets: new Float64Array(values.length),
        contentLengths: new Uint32Array(values.length),
        resolvedContentDictNames: 'raw',
        pendingRowToUniqueIndex: Int32Array.from(values, (_, i) => i),
        pendingContentBytes: [],
        pendingContentHash1s: hashes,
        pendingContentHash2s: hashes,
        pendingOffsets: Float64Array.from(values, (hash) => 1000 + hash),
        pendingLengths: lengths,
        pendingResolvedDictNames: 'raw',
        pendingContentSpans: spans,
        stagedContentMetadata: staged,
    }
    return {hashes, lengths, staged, state}
}

/** @returns {() => void} */
function failIdAllocation() {
    vi.stubGlobal('Float64Array', new Proxy(Float64Array, {
        construct() { throw new RangeError('injected ID allocation failure') },
    }))
    return () => { vi.unstubAllGlobals() }
}

describe('implicit zero content metadata IDs', () => {
    test.each([false, true])('preserves typed-column reads for malformed or missing indexes with a populated arena=%s', (populated) => {
        const database = new DictionaryDatabase()
        if (populated) { set(database, 10, 0) }
        const capacity = database._termEntryContentMetaStateTable.length
        const emptyColumn = database._termEntryContentMetaIdTable
        const denseColumn = new Float64Array(capacity)
        for (const index of [-1, -0, 0, 0.5, 1, Number.NaN, Infinity, capacity - 1, capacity, capacity + 1, Number.MAX_SAFE_INTEGER]) {
            database._termEntryContentMetaIdTable = denseColumn
            const expected = database._readTermEntryContentMetaHashPairIndex(index)
            database._termEntryContentMetaIdTable = emptyColumn
            expect(database._readTermEntryContentMetaHashPairIndex(index)).toEqual(expected)
        }
    })

    test('keeps normal typed, scalar and direct publication IDs implicit across growth', () => {
        const database = new DictionaryDatabase()
        const contiguous = vi.spyOn(database, '_tryPublishContiguousArtifactTermContentMetadata')
        database._publishArtifactTermContentMetadata(prepare(database, [10, 20, 30]).state)
        expect(contiguous).toHaveLastReturnedWith(true)
        const scalar = prepare(database, [40, 50])
        database._publishArtifactTermContentMetadata({...scalar.state, pendingOffsets: [...scalar.state.pendingOffsets]})
        expect(contiguous).toHaveLastReturnedWith(false)
        database._ensureTermEntryContentMetaHashPairCapacity(6)
        database._insertTermEntryContentMetaByHashPairFast(60, 60, 1060, 1, 'raw', 0, Uint8Array.of(60))
        set(database, 70, 0)
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0)
        database._ensureTermEntryContentMetaDenseCapacity(8192)
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0)
        for (const hash of [10, 20, 30, 40, 50, 60, 70]) { expect(get(database, hash)?.id).toBe(0) }
    })

    test.each([1, 0x100000001, Number.MAX_SAFE_INTEGER, -0])('materializes and preserves legacy ID %s including growth and reset', (id) => {
        const database = new DictionaryDatabase()
        set(database, 10, 0)
        set(database, 20, id)
        expect(database._termEntryContentMetaIdTable.length).toBe(database._termEntryContentMetaStateTable.length)
        expect(get(database, 10)?.id).toBe(0)
        expect(Object.is(get(database, 20)?.id, id)).toBe(true)
        database._ensureTermEntryContentMetaDenseCapacity(4096)
        expect(Object.is(get(database, 20)?.id, id)).toBe(true)
        set(database, 20, 0)
        expect(get(database, 20)?.id).toBe(0)
        database._clearTermEntryContentMetaCaches()
        set(database, 30, 0)
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0)
        expect(get(database, 20)).toBeUndefined()
    })

    test.each([-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid legacy ID %s without allocation or partial replacement', (id) => {
        const database = new DictionaryDatabase()
        set(database, 10, 0)
        const previous = get(database, 10)
        expect(() => set(database, 10, id)).toThrow('Invalid term content metadata id')
        expect(get(database, 10)).toEqual(previous)
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0)
    })

    test('failed first allocation leaves an existing entry unchanged and zero updates usable', () => {
        const database = new DictionaryDatabase()
        set(database, 10, 0)
        const previous = get(database, 10)
        const column = database._termEntryContentMetaIdTable
        const restore = failIdAllocation()
        try {
            expect(() => set(database, 10, 7)).toThrow('injected ID allocation failure')
            expect(get(database, 10)).toEqual(previous)
            expect(database._termEntryContentMetaIdTable).toBe(column)
            set(database, 10, 0)
        } finally { restore() }
        set(database, 10, 7)
        expect(get(database, 10)?.id).toBe(7)
    })

    test('failed first allocation returns a new dense index for zero-ID reuse', () => {
        const database = new DictionaryDatabase()
        set(database, 10, 0)
        const restore = failIdAllocation()
        try {
            expect(() => set(database, 20, 7)).toThrow('injected ID allocation failure')
            expect(get(database, 20)).toBeUndefined()
            expect(database._termEntryContentMetaFreeIndexes).toEqual([1])
            set(database, 30, 0)
        } finally { restore() }
        expect(get(database, 30)?.id).toBe(0)
        expect(database._termEntryContentMetaFreeIndexes).toEqual([])
        expect(database._termEntryContentMetaDenseCount).toBe(2)
        expect(database._termEntryContentMetaIdTable.byteLength).toBe(0)
    })

    test('interning failure does not publish a newly allocated legacy column', () => {
        const database = new DictionaryDatabase()
        set(database, 10, 0)
        const previous = get(database, 10)
        const column = database._termEntryContentMetaIdTable
        const fault = vi.spyOn(database, '_internTermEntryContentMetaDictName').mockImplementationOnce(() => { throw new Error('intern failure') })
        try {
            expect(() => set(database, 10, 7)).toThrow('intern failure')
        } finally {
            fault.mockRestore()
        }
        expect(get(database, 10)).toEqual(previous)
        expect(database._termEntryContentMetaIdTable).toBe(column)
        set(database, 10, 7)
        expect(get(database, 10)?.id).toBe(7)
    })

    test.each(['typed', 'scalar', 'direct'])('clears a nonzero legacy ID when rollback reuses it for %s import publication', (mode) => {
        const database = new DictionaryDatabase()
        set(database, 10, 99)
        database._rollbackStagedArtifactTermContentMetadata({indexes: Int32Array.of(0), active: true})
        if (mode === 'direct') {
            database._insertTermEntryContentMetaByHashPairFast(20, 20, 1020, 1, 'raw', 0, Uint8Array.of(20))
        } else {
            const {state} = prepare(database, [20])
            database._publishArtifactTermContentMetadata(mode === 'scalar' ? {...state, pendingOffsets: [...state.pendingOffsets]} : state)
        }
        expect(get(database, 10)).toBeUndefined()
        expect(get(database, 20)).toMatchObject({id: 0, tableIndex: 0})
    })

    test.each(['short', 'input alias', 'destination alias'])('declines contiguous publication with a materialized ID column that has %s', (mode) => {
        const database = new DictionaryDatabase()
        const {hashes, lengths, staged, state} = prepare(database, [10, 20, 30])
        let offsets = state.pendingOffsets
        if (mode === 'short') {
            database._termEntryContentMetaIdTable = new Float64Array(2)
        } else if (mode === 'input alias') {
            database._termEntryContentMetaIdTable = new Float64Array(16)
            offsets = database._termEntryContentMetaIdTable.subarray(0, 3)
            offsets.set(state.pendingOffsets)
        } else {
            database._termEntryContentMetaIdTable = database._termEntryContentMetaOffsetTable
        }
        const previous = new Float64Array(database._termEntryContentMetaIdTable)
        const states = new Uint8Array(database._termEntryContentMetaStateTable)
        expect(database._tryPublishContiguousArtifactTermContentMetadata(staged, hashes, hashes, offsets, lengths, 0, false)).toBe(false)
        expect(database._termEntryContentMetaIdTable).toEqual(previous)
        expect(database._termEntryContentMetaStateTable).toEqual(states)
    })
})
