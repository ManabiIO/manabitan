/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: [error, never] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} Publication */

/**
 * @param {boolean} [ordinary]
 * @returns {{database: DictionaryDatabase, state: Publication, staged: ReturnType<DictionaryDatabase['_stageArtifactTermContentMetadata']>}}
 */
function createFixture(ordinary = false) {
    const database = new DictionaryDatabase()
    database._setTermEntryContentMetaByHashPair(7, 8, {id: 9, offset: 90, length: 4, dictName: 'prior'})
    const bytes = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7]), new Uint8Array([8, 9, 10, 11, 12])]
    const hash1s = new Uint32Array([101, 303, 505])
    const hash2s = new Uint32Array([202, 404, 606])
    const staged = database._stageArtifactTermContentMetadata(hash1s, hash2s, bytes, null)
    /** @type {Publication} */
    const state = {
        count: 3,
        contentOffsets: new Float64Array(3),
        contentLengths: new Uint32Array(3),
        resolvedContentDictNames: 'raw-v6',
        pendingRowToUniqueIndex: new Int32Array([0, 1, 2]),
        pendingContentBytes: bytes,
        pendingContentHash1s: hash1s,
        pendingContentHash2s: hash2s,
        pendingOffsets: new Float64Array([2 ** 32 + 1, 2 ** 40 + 3, Number.MAX_SAFE_INTEGER]),
        pendingLengths: new Uint32Array(bytes.map((value) => value.length)),
        pendingResolvedDictNames: 'raw-v6',
        pendingContentSpans: null,
        stagedContentMetadata: staged,
        metadataValidated: true,
    }
    if (ordinary) {
        vi.spyOn(database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false)
    }
    return {database, state, staged}
}

/**
 * @param {DictionaryDatabase} database
 * @returns {object}
 */
function snapshot(database) {
    const names = [
        '_termEntryContentMetaHashPairTable',
        '_termEntryContentMetaHash1Table',
        '_termEntryContentMetaHash2Table',
        '_termEntryContentMetaStateTable',
        '_termEntryContentMetaLengthTable',
        '_termEntryContentMetaIdTable',
        '_termEntryContentMetaOffsetTable',
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
        dense: database._termEntryContentMetaDenseCount,
        pending: database._termEntryContentMetaHashPairPendingCount,
        published: database._termEntryContentMetaHashPairCount,
        free: [...database._termEntryContentMetaFreeIndexes],
        dictNames: [...database._termEntryContentMetaDictNames],
        collisions: [...database._termEntryContentMetaCollisionsByHashPair],
    }
}

describe('contiguous artifact metadata publication', () => {
    test.each(['State', 'Hash1', 'Hash2', 'Length'])('leaves every column and counter untouched after a late %s witness mismatch', (column) => {
        const {database, state, staged} = createFixture()
        const table = Reflect.get(database, `_termEntryContentMeta${column}Table`)
        table[staged.indexes[2]] ^= 1
        const dictNameId = database._internTermEntryContentMetaDictName('raw-v6')
        const before = snapshot(database)
        expect(database._tryPublishContiguousArtifactTermContentMetadata(
            staged,
            state.pendingContentHash1s,
            state.pendingContentHash2s,
            state.pendingOffsets,
            state.pendingLengths,
            dictNameId,
        )).toBe(false)
        expect(snapshot(database)).toStrictEqual(before)
    })

    test('owns published offsets after persistence inputs are reused', () => {
        const {database, state} = createFixture()
        database._publishArtifactTermContentMetadata(state)
        state.pendingOffsets.fill(0)
        state.pendingLengths.fill(0)
        expect(database._getTermEntryContentMetaByHashPair(101, 202)).toMatchObject({offset: 2 ** 32 + 1, length: 4})
        expect(database._getTermEntryContentMetaByHashPair(303, 404)).toMatchObject({offset: 2 ** 40 + 3, length: 3})
    })

    test('matches ordinary publication and retains preceding metadata and unused slots', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        const helper = vi.spyOn(fast.database, '_tryPublishContiguousArtifactTermContentMetadata')
        const resolve = vi.spyOn(fast.database, '_resolveStagedArtifactTermContentIndex')
        expect(fast.database._getTermEntryContentMetaByHashPair(101, 202)).toBeUndefined()
        fast.database._publishArtifactTermContentMetadata(fast.state)
        ordinary.database._publishArtifactTermContentMetadata(ordinary.state)
        expect(helper).toHaveReturnedWith(true)
        expect(resolve).not.toHaveBeenCalled()
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect(fast.state.contentOffsets).toStrictEqual(ordinary.state.contentOffsets)
        expect(fast.state.contentLengths).toStrictEqual(ordinary.state.contentLengths)
        expect(fast.database._getTermEntryContentMetaByHashPair(7, 8)).toMatchObject({id: 9, offset: 90, dictName: 'prior'})
        expect(fast.database._getTermEntryContentMetaByHashPair(505, 606)).toMatchObject({offset: Number.MAX_SAFE_INTEGER, length: 5})
    })

    test('uses the current arena after rehash and rolls back the entire published span', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        const oldState = fast.database._termEntryContentMetaStateTable
        for (const fixture of [fast, ordinary]) {
            fixture.database._ensureTermEntryContentMetaHashPairCapacity(128)
            fixture.database._publishArtifactTermContentMetadata(fixture.state)
        }
        expect(fast.database._termEntryContentMetaStateTable).not.toBe(oldState)
        expect([...oldState].slice(1, 4)).toStrictEqual([2, 2, 2])
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        for (const fixture of [fast, ordinary]) {
            fixture.database._rollbackStagedArtifactTermContentMetadata(fixture.staged)
            fixture.database._rollbackStagedArtifactTermContentMetadata(fixture.staged)
        }
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect(fast.database._getTermEntryContentMetaByHashPair(101, 202)).toBeUndefined()
        expect(fast.database._getTermEntryContentMetaByHashPair(7, 8)).toMatchObject({offset: 90})
        expect(fast.database._termEntryContentMetaHashPairPendingCount).toBe(0)
        expect(fast.database._termEntryContentMetaHashPairCount).toBe(1)
    })

    test('preserves a late length failure and the ordinary partially published state', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        for (const fixture of [fast, ordinary]) {
            fixture.state.pendingLengths[1] = 999
            expect(() => fixture.database._publishArtifactTermContentMetadata(fixture.state)).toThrow('Invalid staged term content metadata length: 999')
        }
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect(fast.database._termEntryContentMetaHashPairPendingCount).toBe(2)
        expect(fast.database._termEntryContentMetaHashPairCount).toBe(2)
        for (const fixture of [fast, ordinary]) {
            fixture.database._rollbackStagedArtifactTermContentMetadata(fixture.staged)
        }
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
    })

    test('preserves untrusted offset validation and partial rollback', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        const helper = vi.spyOn(fast.database, '_tryPublishContiguousArtifactTermContentMetadata')
        for (const fixture of [fast, ordinary]) {
            fixture.state.metadataValidated = false
            fixture.state.pendingOffsets[1] = -1
            expect(() => fixture.database._publishArtifactTermContentMetadata(fixture.state)).toThrow('Invalid term content metadata offset: -1')
        }
        expect(helper).not.toHaveBeenCalled()
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
    })

    test('does not mutate metadata when dictionary interning fails', () => {
        const {database, state} = createFixture()
        const before = snapshot(database)
        vi.spyOn(database, '_internTermEntryContentMetaDictName').mockImplementationOnce(() => { throw new Error('intern failure') })
        expect(() => database._publishArtifactTermContentMetadata(state)).toThrow('intern failure')
        expect(snapshot(database)).toStrictEqual(before)
    })

    test.each(['array-hashes', 'array-offsets', 'mixed-dictionaries', 'noncontiguous'])('preserves ordinary publication for %s', (variant) => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        const helper = vi.spyOn(fast.database, '_tryPublishContiguousArtifactTermContentMetadata')
        for (const fixture of [fast, ordinary]) {
            switch (variant) {
                case 'array-hashes':
                    fixture.state.pendingContentHash1s = [...fixture.state.pendingContentHash1s]
                    break
                case 'array-offsets':
                    fixture.state.pendingOffsets = [...fixture.state.pendingOffsets]
                    break
                case 'mixed-dictionaries':
                    fixture.state.pendingResolvedDictNames = ['raw-v6', 'raw', 'raw-v3']
                    break
                default:
                    fixture.staged.indexes.reverse()
                    fixture.state.pendingContentHash1s.reverse()
                    fixture.state.pendingContentHash2s.reverse()
                    fixture.state.pendingLengths.reverse()
                    fixture.state.pendingContentBytes.reverse()
                    break
            }
            fixture.database._publishArtifactTermContentMetadata(fixture.state)
        }
        expect(helper).toHaveReturnedWith(false)
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect(fast.state.contentOffsets).toStrictEqual(ordinary.state.contentOffsets)
    })

    test('preserves sequential writes when persisted offsets alias the destination', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        const helper = vi.spyOn(fast.database, '_tryPublishContiguousArtifactTermContentMetadata')
        for (const fixture of [fast, ordinary]) {
            const table = fixture.database._termEntryContentMetaOffsetTable
            table.set([100, 200, 300])
            fixture.state.pendingOffsets = table.subarray(0, 3)
            fixture.database._publishArtifactTermContentMetadata(fixture.state)
        }
        expect(helper).toHaveReturnedWith(false)
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect([...fast.database._termEntryContentMetaOffsetTable].slice(1, 4)).toStrictEqual([100, 100, 100])
    })

    test('retains exact collision matching and collision rollback', async () => {
        const database = new DictionaryDatabase()
        const first = new Uint8Array([1, 2, 3, 4])
        const second = new Uint8Array([4, 3, 2, 1])
        const hash1s = new Uint32Array([101, 101])
        const hash2s = new Uint32Array([202, 202])
        const staged = database._stageArtifactTermContentMetadata(hash1s, hash2s, [first, second], null)
        vi.spyOn(database, '_readTermEntryContentBytesDetailed').mockImplementation(async (offset) => ({
            status: 'ok', bytes: offset === 100 ? first : second,
        }))
        const helper = vi.spyOn(database, '_tryPublishContiguousArtifactTermContentMetadata')
        database._publishArtifactTermContentMetadata({
            count: 2,
            contentOffsets: new Float64Array(2),
            contentLengths: new Uint32Array(2),
            resolvedContentDictNames: 'raw-v6',
            pendingRowToUniqueIndex: new Int32Array([0, 1]),
            pendingContentBytes: [first, second],
            pendingContentHash1s: hash1s,
            pendingContentHash2s: hash2s,
            pendingOffsets: new Float64Array([100, 200]),
            pendingLengths: new Uint32Array([4, 4]),
            pendingResolvedDictNames: 'raw-v6',
            pendingContentSpans: null,
            stagedContentMetadata: staged,
            metadataValidated: true,
        })
        expect(helper).toHaveReturnedWith(false)
        await expect(database._findMatchingTermEntryContentMeta(101, 202, first)).resolves.toMatchObject({offset: 100})
        await expect(database._findMatchingTermEntryContentMeta(101, 202, second)).resolves.toMatchObject({offset: 200})
        database._rollbackStagedArtifactTermContentMetadata(staged)
        expect(database._termEntryContentMetaCollisionsByHashPair.size).toBe(0)
        expect(database._getTermEntryContentMetaByHashPair(101, 202)).toBeUndefined()
    })

    test('reuses rolled-back dense IDs without changing their new metadata', () => {
        const fast = createFixture()
        const ordinary = createFixture(true)
        for (const fixture of [fast, ordinary]) {
            fixture.database._publishArtifactTermContentMetadata(fixture.state)
            fixture.database._rollbackStagedArtifactTermContentMetadata(fixture.staged)
            const next = fixture.database._stageArtifactTermContentMetadata(new Uint32Array([707, 808, 909]), new Uint32Array([70, 80, 90]), fixture.state.pendingContentBytes, null)
            fixture.state.stagedContentMetadata = next
            fixture.state.pendingContentHash1s = new Uint32Array([707, 808, 909])
            fixture.state.pendingContentHash2s = new Uint32Array([70, 80, 90])
            fixture.database._publishArtifactTermContentMetadata(fixture.state)
        }
        expect(snapshot(fast.database)).toStrictEqual(snapshot(ordinary.database))
        expect(fast.database._getTermEntryContentMetaByHashPair(101, 202)).toBeUndefined()
        expect(fast.database._getTermEntryContentMetaByHashPair(707, 70)).toMatchObject({offset: 2 ** 32 + 1})
    })
})
