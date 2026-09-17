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
import {describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @type {Array<[keyof Experiments, '_sparseMetadataSlots'|'_denseMetadataAllocation'|'_metadataLastDictionary']>} */
const flags = [['experimentalSparseMetadataSlots', '_sparseMetadataSlots'], ['experimentalDenseMetadataAllocation', '_denseMetadataAllocation'], ['experimentalMetadataLastDictionary', '_metadataLastDictionary']]

describe('metadata import experiments', () => {
    test.each(flags)('%s is opt-in and resets on the next import', (key, field) => {
        const db = new DictionaryDatabase()
        expect(db[field]).toBe(false)
        for (const value of [false, 0, 1, 'true', null, undefined, {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({[key]: value}))
            expect(snapshotTermBankExperiments(options)[key]).toBe(false)
            db.setImportOptimizationFlags(options)
            expect(db[field]).toBe(false)
        }
        db.setImportOptimizationFlags({[key]: true})
        expect(db[field]).toBe(true)
        db.setImportOptimizationFlags()
        expect(db[field]).toBe(false)
    })
    test('allocates identical dense indexes across growth and free-list reuse', () => {
        const a = new DictionaryDatabase()
        const b = new DictionaryDatabase()
        b.setImportOptimizationFlags({experimentalDenseMetadataAllocation: true})
        for (let round = 0; round < 5; round++) {
            for (let i = 0; i < 1237; i++) {
                expect(b._allocateTermEntryContentMetaIndex()).toBe(a._allocateTermEntryContentMetaIndex())
                expect(b._termEntryContentMetaStateTable.length).toBe(a._termEntryContentMetaStateTable.length)
            }
            for (const db of [a, b]) {
                db._termEntryContentMetaFreeIndexes.push(4, 7, 21)
                for (const index of [4, 7, 21]) {
                    db._termEntryContentMetaRecentSourceBatchIdTable[index] = 900
                    db._termEntryContentMetaRecentSourceOffsetTable[index] = 100
                }
            }
        }
        expect(b._termEntryContentMetaRecentSourceBatchIdTable).toEqual(a._termEntryContentMetaRecentSourceBatchIdTable)
        expect(b._termEntryContentMetaDenseCount).toBe(a._termEntryContentMetaDenseCount)
    })
    test('dictionary IDs match for repeats, alternation and cache resets', () => {
        const a = new DictionaryDatabase()
        const b = new DictionaryDatabase()
        b.setImportOptimizationFlags({experimentalMetadataLastDictionary: true})
        for (let round = 0; round < 3; round++) {
            for (const name of ['raw', 'jmdict', 'jmdict', '', '', '日本語', 'raw', '日本語', 'jmdict']) {
                expect(b._internTermEntryContentMetaDictName(name)).toBe(a._internTermEntryContentMetaDictName(name))
            }
            expect(b._termEntryContentMetaDictNames).toEqual(a._termEntryContentMetaDictNames)
            expect(b._termEntryContentMetaDictNameIdByValue).toEqual(a._termEntryContentMetaDictNameIdByValue)
            a._clearTermEntryContentMetaCaches()
            b._clearTermEntryContentMetaCaches()
        }
    })
    test.each([false, true])('preserves pending visibility, colliding probe chains and rollback, sparse=%s', (sparse) => {
        const db = new DictionaryDatabase()
        db.setImportOptimizationFlags({experimentalSparseMetadataSlots: sparse, experimentalDenseMetadataAllocation: true, experimentalMetadataLastDictionary: true})
        const count = 128
        db._ensureTermEntryContentMetaHashPairCapacity(count)
        expect(db._termEntryContentMetaHashPairTable.length).toBe(count * (sparse ? 4 : 2))
        const content = Uint8Array.of(1, 2, 3, 4)
        const mask = db._termEntryContentMetaHashPairMask
        /** @type {Array<[number, number]>} */
        const pairs = []
        for (let value = 1; pairs.length < count; value++) {
            if (db._getTermEntryContentMetaHashPairSlot(value, 31, mask) === 0) { pairs.push([value, 31]) }
        }
        const staged = db._stageArtifactTermContentMetadata(pairs.map(([h1]) => h1), pairs.map(([, h2]) => h2), Array.from({length: count}, () => content), null)
        expect(db._termEntryContentMetaHashPairPendingCount).toBe(count)
        for (const [h1, h2] of pairs) { expect(db._getTermEntryContentMetaByHashPair(h1, h2)).toBeUndefined() }
        db._rollbackStagedArtifactTermContentMetadata(staged)
        expect(db._termEntryContentMetaHashPairPendingCount).toBe(0)
        for (const [index, [h1, h2]] of pairs.entries()) {
            db._setTermEntryContentMetaByHashPair(h1, h2, {id: index, offset: index * 4, length: 4, dictName: 'jmdict'})
        }
        db._ensureTermEntryContentMetaHashPairCapacity(count * 3, true)
        for (const [index, [h1, h2]] of pairs.entries()) {
            expect(db._getTermEntryContentMetaByHashPair(h1, h2)).toMatchObject({id: index, offset: index * 4, length: 4, dictName: 'jmdict'})
        }
    })
})
