/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @typedef {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan} Plan */

/**
 * @param {number} [count]
 * @returns {Plan}
 */
function createPlan(count = 8) {
    return /** @type {Plan} */ ({
        resolvedFlags: new Uint8Array(count),
        resolvedOffsets: new Float64Array(count).fill(99),
        resolvedLengths: new Uint32Array(count).fill(88),
        resolvedDictNames: null,
    })
}

/**
 * @param {Plan} plan
 * @param {number|null} start
 * @param {number[]|Uint32Array} indexes
 * @param {number[]|Float64Array} offsets
 * @param {number[]|Uint32Array} lengths
 * @param {string|string[]} [names]
 */
function publish(plan, start, indexes, offsets, lengths, names = 'raw') {
    const database = new DictionaryDatabase()
    Reflect.get(database, '_publishResolvedArtifactTermContentPlan').call(database, plan, start, indexes, offsets, lengths, names)
}

describe('resolved content plan publication', () => {
    test.each([
        {name: 'contiguous start', start: 2, indexes: [], expected: [[2, 10, 1], [3, 20, 2], [4, 30, 3], [5, 40, 4]]},
        {name: 'sparse consecutive runs', start: null, indexes: [0, 1, 4, 5], expected: [[0, 10, 1], [1, 20, 2], [4, 30, 3], [5, 40, 4]]},
        {name: 'reordered runs', start: null, indexes: [4, 5, 0, 1], expected: [[4, 10, 1], [5, 20, 2], [0, 30, 3], [1, 40, 4]]},
        {name: 'repeated destination', start: null, indexes: [2, 3, 2, 4], expected: [[2, 30, 3], [3, 20, 2], [4, 40, 4]]},
        {name: 'out-of-range destination after valid run', start: null, indexes: [1, 2, 100, 4], expected: [[1, 10, 1], [2, 20, 2], [4, 40, 4]]},
    ])('preserves published and untouched values for $name', ({start, indexes, expected}) => {
        const plan = createPlan()
        publish(plan, start, Uint32Array.from(indexes), new Float64Array([10, 20, 30, 40]), new Uint32Array([1, 2, 3, 4]))
        const expectedOffsets = new Float64Array(8).fill(99)
        const expectedLengths = new Uint32Array(8).fill(88)
        const expectedFlags = new Uint8Array(8)
        for (const [index, offset, length] of expected) {
            expectedOffsets[index] = offset
            expectedLengths[index] = length
            expectedFlags[index] = 1
        }
        expect(plan.resolvedOffsets).toEqual(expectedOffsets)
        expect(plan.resolvedLengths).toEqual(expectedLengths)
        expect(plan.resolvedFlags).toEqual(expectedFlags)
        expect(plan.resolvedUniformDictName).toBe('raw')
        expect(plan.resolvedDictNames).toBeNull()
    })

    test('keeps empty publication inert', () => {
        const plan = createPlan()
        publish(plan, null, new Uint32Array(), new Float64Array(), new Uint32Array())
        expect(plan.resolvedUniformDictName).toBeUndefined()
        expect(plan.resolvedOffsets).toEqual(new Float64Array(8).fill(99))
        expect(plan.resolvedFlags).toEqual(new Uint8Array(8))
    })

    test('retains array inputs and independent per-unique codec promotion', () => {
        const plan = createPlan(4)
        plan.resolvedUniformDictName = 'old'
        publish(plan, null, [3, 0, 2], [30, 10, 20], [3, 1, 2], ['raw', 'block', 'raw'])
        expect([...plan.resolvedOffsets]).toEqual([10, 99, 20, 30])
        expect([...plan.resolvedLengths]).toEqual([1, 88, 2, 3])
        expect([...plan.resolvedFlags]).toEqual([1, 0, 1, 1])
        expect(plan.resolvedUniformDictName).toBe('old')
        expect(plan.resolvedDictNames).toEqual(['block', 'old', 'raw', 'raw'])
    })

    test('rechecks uniform codec state for a later synchronous publication', () => {
        const plan = createPlan(4)
        publish(plan, 0, [], new Float64Array([10, 20]), new Uint32Array([1, 2]), 'raw')
        publish(plan, 2, [], new Float64Array([30, 40]), new Uint32Array([3, 4]), 'block')
        expect(plan.resolvedDictNames).toEqual(['raw', 'raw', 'block', 'block'])
        expect(plan.resolvedUniformDictName).toBe('raw')
        expect([...plan.resolvedOffsets]).toEqual([10, 20, 30, 40])
    })

    test('updates existing codec arrays without overwriting unresolved names', () => {
        const plan = createPlan(4)
        plan.resolvedUniformDictName = 'old'
        plan.resolvedDictNames = ['first', 'second', 'third', 'fourth']
        publish(plan, null, new Uint32Array([0, 3]), new Float64Array([10, 40]), new Uint32Array([1, 4]), 'raw')
        expect(plan.resolvedDictNames).toEqual(['raw', 'second', 'third', 'raw'])
        expect(plan.resolvedUniformDictName).toBe('old')
    })

    test('retains scalar behavior for incomplete source columns', () => {
        const plan = createPlan(4)
        publish(plan, null, new Uint32Array([0, 1, 2]), new Float64Array([10, 20]), new Uint32Array([1, 2]))
        expect([...plan.resolvedOffsets]).toEqual([10, 20, Number.NaN, 99])
        expect([...plan.resolvedLengths]).toEqual([1, 2, 0, 88])
        expect([...plan.resolvedFlags]).toEqual([1, 1, 1, 0])
    })

    test.each(['offsets', 'lengths'])('preserves ordered scalar writes when source %s alias a target', (column) => {
        const plan = createPlan(6)
        plan.resolvedOffsets.set([1, 2, 3, 4, 5, 6])
        plan.resolvedLengths.set([1, 2, 3, 4, 5, 6])
        const offsets = column === 'offsets' ? plan.resolvedOffsets.subarray(0, 3) : new Float64Array([10, 20, 30])
        const lengths = column === 'lengths' ? plan.resolvedLengths.subarray(0, 3) : new Uint32Array([10, 20, 30])
        publish(plan, null, new Uint32Array([1, 2, 3]), offsets, lengths)
        expect([...(column === 'offsets' ? plan.resolvedOffsets : plan.resolvedLengths)]).toEqual([1, 1, 1, 1, 5, 6])
    })

    test('preserves scalar ordering when destination columns alias each other', () => {
        const plan = createPlan(2)
        const buffer = new ArrayBuffer(16)
        plan.resolvedOffsets = new Float64Array(buffer)
        plan.resolvedLengths = new Uint32Array(buffer, 0, 2)
        publish(plan, 0, [], new Float64Array([1.5, 2.5]), new Uint32Array([7, 8]))
        expect([...new Uint32Array(buffer)]).toEqual([7, 8, 0, 0x40040000])
    })

    test('retains scalar ordering when pending indexes share flag storage', () => {
        const plan = createPlan(6)
        const buffer = new ArrayBuffer(16)
        plan.resolvedFlags = new Uint8Array(buffer)
        const indexes = new Uint32Array(buffer, 0, 3)
        indexes.set([4, 2, 3])
        publish(plan, null, indexes, new Float64Array([10, 20, 30]), new Uint32Array([1, 2, 3]))
        expect([...plan.resolvedOffsets]).toEqual([99, 20, 99, 30, 10, 99])
    })

    test('rolls back exactly the sparse published slots after bulk copies', () => {
        const plan = createPlan()
        const indexes = new Uint32Array([0, 1, 4, 5])
        publish(plan, null, indexes, new Float64Array([10, 20, 30, 40]), new Uint32Array([1, 2, 3, 4]))
        const database = new DictionaryDatabase()
        Reflect.get(database, '_rollbackArtifactTermContentDedupPlan').call(database, {
            plan, start: null, indexes, count: 4, previousResolvedDictNames: null, previousResolvedUniformDictName: void 0,
        })
        expect([...plan.resolvedOffsets]).toEqual([0, 0, 99, 99, 0, 0, 99, 99])
        expect([...plan.resolvedLengths]).toEqual([0, 0, 88, 88, 0, 0, 88, 88])
        expect([...plan.resolvedFlags]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
        expect(plan.resolvedDictNames).toBeNull()
        expect(plan.resolvedUniformDictName).toBeUndefined()
    })
})
