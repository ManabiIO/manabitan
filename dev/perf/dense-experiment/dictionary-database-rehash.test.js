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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/**
 * @param {DictionaryDatabase} database
 */
function assertLiveSlots(database) {
    const states = database._termEntryContentMetaStateTable
    const denseCount = database._termEntryContentMetaDenseCount
    const active = []
    for (let index = 0; index < denseCount; ++index) {
        if (states[index] !== 0) { active.push(index + 1) }
    }
    const slots = [...database._termEntryContentMetaHashPairTable].filter((value) => value !== 0)
    expect(slots.sort((a, b) => a - b)).toEqual(active)
    expect(new Set(slots).size).toBe(slots.length)
    expect(slots.length).toBe(database._termEntryContentMetaHashPairCount + database._termEntryContentMetaHashPairPendingCount)
}

describe('dense content metadata rehash', () => {
    test.each([false, true])('preserves publication, holes, reuse, and stable indexes; collision=%s', (collide) => {
        const database = new DictionaryDatabase()
        if (collide) {
            // Start at the end of each table to exercise wrap-around probes.
            database._getTermEntryContentMetaHashPairSlot = (_hash1, _hash2, mask) => mask
        }
        for (let i = 0; i < 40; ++i) {
            database._setTermEntryContentMetaByHashPair(i, ~i, {id: i, offset: 2 ** 32 + i, length: i, dictName: 'raw'})
        }
        const bytes = new Uint8Array([1, 2, 3, 4])
        const first = database._stageArtifactTermContentMetadata([100, 101, 102], [200, 201, 202], [bytes, bytes, bytes], null)
        const second = database._stageArtifactTermContentMetadata([110, 111], [210, 211], [bytes, bytes], null)
        const stable = [...second.indexes]
        database._rollbackStagedArtifactTermContentMetadata(first)
        for (let i = 0; i < 2; ++i) {
            database._setTermEntryContentMetaByHashPair(50 + i, 60 + i, {id: i, offset: i, length: 4, dictName: 'other'})
        }
        for (const capacity of [4096, 42, 8192, 42]) {
            database._ensureTermEntryContentMetaHashPairCapacity(capacity, true)
            assertLiveSlots(database)
            for (let i = 0; i < 40; ++i) {
                expect(database._getTermEntryContentMetaByHashPair(i, ~i)).toMatchObject({id: i, offset: 2 ** 32 + i, length: i})
                expect(database._findTermEntryContentMetaHashPairIndex(i, ~i)).toBe(i)
            }
            for (const hash of [100, 101, 102, 110, 111]) {
                expect(database._getTermEntryContentMetaByHashPair(hash, hash + 100)).toBeUndefined()
            }
            expect([...second.indexes]).toEqual(stable)
            expect(database._reservePreparedArtifactTermContentMetadata(110, 210, 4, 0, 0, 0)).toBe(-1)
        }
        database._rollbackStagedArtifactTermContentMetadata(second)
        assertLiveSlots(database)
        expect(database._termEntryContentMetaHashPairPendingCount).toBe(0)
    })

    test('does not resurrect rolled-back entries when every dense slot is free', () => {
        const database = new DictionaryDatabase()
        const bytes = new Uint8Array([1])
        const staged = database._stageArtifactTermContentMetadata([0, 0xffffffff], [0xffffffff, 0], [bytes, bytes], null)
        database._rollbackStagedArtifactTermContentMetadata(staged)
        expect(database._termEntryContentMetaDenseCount).toBe(2)
        for (const capacity of [1024, 0, 2048, 0]) {
            database._ensureTermEntryContentMetaHashPairCapacity(capacity, true)
            assertLiveSlots(database)
            expect(database._getTermEntryContentMetaByHashPair(0, 0xffffffff)).toBeUndefined()
        }
        database._setTermEntryContentMetaByHashPair(1, 2, {id: 3, offset: 4, length: 5, dictName: 'raw'})
        expect(database._termEntryContentMetaDenseCount).toBe(2)
        expect(database._getTermEntryContentMetaByHashPair(1, 2)).toMatchObject({id: 3, offset: 4, length: 5})
        assertLiveSlots(database)
    })

    test('retains existing reservations when a later staged batch fails partway through', () => {
        const database = new DictionaryDatabase()
        const bytes = new Uint8Array([1])
        const retained = database._stageArtifactTermContentMetadata([7], [9], [bytes], null)
        expect(() => database._stageArtifactTermContentMetadata([20, 21], [30, 31], [], {
            buffer: bytes,
            offsets: new Uint32Array([0, 3]),
            lengths: new Uint32Array([1, 1]),
        })).toThrow(RangeError)
        database._ensureTermEntryContentMetaHashPairCapacity(1024, true)
        assertLiveSlots(database)
        expect(database._reservePreparedArtifactTermContentMetadata(7, 9, 1, 0, 0, 0)).toBe(-1)
        database._rollbackStagedArtifactTermContentMetadata(retained)
        assertLiveSlots(database)
    })
})
