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
import {
    compactTermRecordPreinternedPlan,
    compactTermRecordPreinternedPlanRuns,
    getOwnedCompactionScratch,
    hasCompletePreparedTermRecordPreinternedPlan,
    hasCompleteTermRecordPreinternedPlan,
    selectTermRecordPreinternedPlan,
    sliceTermRecordPreinternedPlan,
} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {prepareTermLookupIndexesFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/** @returns {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} */
function makePlan() {
    return {
        stringLengths: new Uint16Array([1, 1, 1, 1, 1]),
        stringsBuffer: new TextEncoder().encode('abcde'),
        expressionIndexes: new Uint16Array([0, 2, 4, 0]),
        readingIndexes: new Uint32Array([1, 3, 4, 0]),
    }
}

const equals = new Uint8Array([0, 0, 1, 1])
const sequences = new Int32Array([8, 9, -1, 8])

describe('compact expression columns in prepared term plans', () => {
    test('preserves uint16 row views when slicing and values when selecting', () => {
        const plan = makePlan()
        expect(hasCompleteTermRecordPreinternedPlan(plan, 4)).toBe(true)
        expect(hasCompletePreparedTermRecordPreinternedPlan(plan, 4, true)).toBe(true)
        const sliced = sliceTermRecordPreinternedPlan(plan, 1, 2)
        expect(sliced?.expressionIndexes).toBeInstanceOf(Uint16Array)
        expect(sliced?.expressionIndexes.buffer).toBe(plan.expressionIndexes.buffer)
        expect([...sliced?.expressionIndexes ?? []]).toEqual([2, 4])
        expect([...selectTermRecordPreinternedPlan(plan, [3, 1])?.expressionIndexes ?? []]).toEqual([0, 2])
        plan.expressionIndexes[1] = 1
        expect(sliced?.expressionIndexes[0]).toBe(1)
        expect(() => sliceTermRecordPreinternedPlan(plan, 3, 2)).toThrow('Invalid preinterned plan row range')
    })

    test('preserves complete lookup bytes and the distinct reading sentinel', () => {
        const plan = makePlan()
        const wide = {...plan, expressionIndexes: Uint32Array.from(plan.expressionIndexes)}
        const actual = encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, sequences, 4)
        expect(actual).toEqual(encodePersistedTermLookupIndexFromPreinternedPlan(wide, equals, sequences, 4))
        const index = parsePersistedTermLookupIndex(actual)
        expect([...index.expressionKeys]).toEqual([0, 2, 4, 0])
        expect([...index.readingKeys]).toEqual([1, 3, 0xffff, 0xffff])
        expect([...plan.readingIndexes]).toEqual([1, 3, 4, 0])
        const prepared = prepareTermLookupIndexesFromPreinternedPlan({rowCount: 4, readingEqualsExpressionList: equals, sequenceList: sequences, termRecordPreinternedPlan: plan})
        expect(prepared?.indexes.get('0:4')?.bytes).toEqual(actual)
    })

    test('keeps partial and consecutive compactions equivalent to uint32 inputs', () => {
        const plan = makePlan()
        const wide = {...plan, expressionIndexes: Uint32Array.from(plan.expressionIndexes)}
        expect(compactTermRecordPreinternedPlan(plan, 1, 3, new Uint32Array(5), equals))
            .toEqual(compactTermRecordPreinternedPlan(wide, 1, 3, new Uint32Array(5), equals))
        expect(compactTermRecordPreinternedPlanRuns(plan, 4, 2, new Uint32Array(5), equals))
            .toEqual(compactTermRecordPreinternedPlanRuns(wide, 4, 2, new Uint32Array(5), equals))
    })

    test('rejects a late invalid uint16 ID and resets scratch before recovery', () => {
        const plan = makePlan()
        const scratch = new Uint32Array(5)
        plan.expressionIndexes[3] = 0xffff
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 4, scratch, equals))
            .toThrow('Preinterned string index out of bounds: 65535')
        expect(scratch).toEqual(new Uint32Array(5))
        expect(() => encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, sequences, 4))
            .toThrow('Invalid preinterned term-record key reference')
        plan.expressionIndexes[3] = 0
        expect(compactTermRecordPreinternedPlan(plan, 0, 4, scratch, equals)).not.toBeNull()
    })

    test('validates compact expression IDs at the uint16 boundary', () => {
        const plan = {
            stringLengths: new Uint16Array(0xffff).fill(1),
            stringsBuffer: new Uint8Array(0xffff).fill(65),
            expressionIndexes: new Uint16Array([0xfffe]),
            readingIndexes: new Uint32Array([0xfffe]),
        }
        const scratch = new Uint32Array(0xffff)
        expect(compactTermRecordPreinternedPlan(plan, 0, 1, scratch)?.expressionIndexes).toEqual(new Uint32Array([0]))
        plan.expressionIndexes[0] = 0xffff
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 1, scratch))
            .toThrow('Preinterned string index out of bounds: 65535')
        expect(scratch).toEqual(new Uint32Array(0xffff))
        const widerKeyRange = {
            ...plan,
            stringLengths: new Uint16Array(0x10000).fill(1),
            stringsBuffer: new Uint8Array(0x10000).fill(65),
        }
        expect(compactTermRecordPreinternedPlan(widerKeyRange, 0, 1, new Uint32Array(0x10000))?.expressionIndexes)
            .toEqual(new Uint32Array([0]))
    })

    test('rejects overlapping scratch before writing shared compact expression bytes', () => {
        const plan = makePlan()
        const buffer = new ArrayBuffer(24)
        const expressions = new Uint16Array(buffer, 2, 4)
        expressions.set(plan.expressionIndexes)
        plan.expressionIndexes = expressions
        const before = new Uint8Array(buffer).slice()
        expect(() => getOwnedCompactionScratch(plan, new Uint32Array(buffer, 0, 5), equals))
            .toThrow('Preinterned plan compaction scratch overlaps source storage')
        expect(new Uint8Array(buffer)).toEqual(before)
    })

    test('rejects detached compact columns and retains transferred values', () => {
        const plan = makePlan()
        const expressionBuffer = plan.expressionIndexes.buffer
        if (!(expressionBuffer instanceof ArrayBuffer)) { throw new Error('Expected an owned expression buffer') }
        const moved = structuredClone(plan, {transfer: [expressionBuffer]})
        expect(hasCompleteTermRecordPreinternedPlan(plan, 4)).toBe(false)
        expect(hasCompletePreparedTermRecordPreinternedPlan(plan, 4)).toBe(false)
        expect(hasCompletePreparedTermRecordPreinternedPlan(moved, 4)).toBe(true)
        expect(moved.expressionIndexes).toEqual(new Uint16Array([0, 2, 4, 0]))
    })

    test.each([Uint8Array, Int16Array, Float32Array])('does not admit other expression element types: %s', (ArrayType) => {
        const plan = makePlan()
        Reflect.set(plan, 'expressionIndexes', new ArrayType([0, 2, 4, 0]))
        expect(hasCompleteTermRecordPreinternedPlan(plan, 4)).toBe(false)
        expect(hasCompletePreparedTermRecordPreinternedPlan(plan, 4)).toBe(false)
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 4, new Uint32Array(5)))
            .toThrow('Invalid preinterned plan row range')
    })

    test.each([false, true])('materializes compact plan strings with an existing lookup index: %s', async (existingIndex) => {
        const store = new TermRecordOpfsStore()
        const dictionary = 'Compact append'
        if (existingIndex) { expect(store.findTermIds(dictionary, 'a', 'expression')).toEqual([]) }
        await store.appendBatchFromArtifactChunkResolvedContent({
            dictionary,
            rowCount: 4,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList: equals,
            scoreList: new Int32Array([3, 4, 3, 0]),
            sequenceList: sequences,
            termRecordPreinternedPlan: makePlan(),
        }, [0, 16, 32, 0], [16, 16, 16, 16], 'raw')
        const records = store.getByIds([1, 2, 3, 4])
        expect([...records.values()].map((record) => [record.expression, record.reading]))
            .toEqual([['a', 'b'], ['c', 'd'], ['e', 'e'], ['a', 'a']])
        expect(store.findTermIds(dictionary, 'a', 'expression')).toEqual([1, 4])
        expect(store.findTermIds(dictionary, 'd', 'reading')).toEqual([2])
        expect(records.get(2)).toMatchObject({score: 4, sequence: 9, entryContentOffset: 16, entryContentLength: 16})
    })

    test('retains production record-field and lookup encoding for compact plans', async () => {
        const plan = makePlan()
        const wide = {...plan, expressionIndexes: Uint32Array.from(plan.expressionIndexes)}
        const store = new TermRecordOpfsStore()
        const chunk = {
            dictionary: 'Compact expressions',
            rowCount: 4,
            expressionBytesList: [],
            readingBytesList: [],
            readingEqualsExpressionList: equals,
            scoreList: new Int32Array([3, 4, 3, 0]),
            sequenceList: sequences,
        }
        const offsets = new Float64Array([0, 16, 32, 0])
        const lengths = new Uint32Array([16, 16, 16, 16])
        const actual = await store._encodeArtifactChunkRecords(chunk, offsets, lengths, plan)
        const expected = await store._encodeArtifactChunkRecords(chunk, offsets, lengths, wide)
        expect(actual.lookupIndexBytes).toEqual(expected.lookupIndexBytes)
        expect(actual.recordFields).toEqual(expected.recordFields)
        expect(actual.recordFieldsFormat).toBe(expected.recordFieldsFormat)
        expect(actual.contentOffsetBase).toBe(expected.contentOffsetBase)
    })
})
