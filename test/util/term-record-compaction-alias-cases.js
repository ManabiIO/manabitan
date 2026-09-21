/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'

/** @typedef {import('../../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

/** @returns {Plan} */
function makePlan() {
    return {
        stringLengths: new Uint16Array([1, 1, 1]),
        stringOffsets: new Uint32Array([0, 1, 2]),
        stringHashes: new Uint32Array([0, 0, 0]),
        stringsBuffer: new TextEncoder().encode('abc'),
        expressionIndexes: new Uint32Array([0, 0, 0]),
        readingIndexes: new Uint32Array([1, 0, 0]),
    }
}

/**
 * @param {(name: string, fn: () => void) => unknown} test
 * @param {typeof import('../../ext/js/dictionary/term-record-preinterned-plan.js')} api
 */
export function registerCompactionAliasCases(test, api) {
    /** @type {('stringLengths'|'stringOffsets'|'stringHashes'|'stringsBuffer'|'expressionIndexes'|'readingIndexes')[]} */
    const fields = ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']
    for (const runs of [false, true]) {
        /**
         * @param {Plan} plan
         * @param {Uint32Array} scratch
         * @param {boolean[]|Uint8Array} [equal]
         * @param {number} [count]
         */
        const compact = (plan, scratch, equal = [false, false, false], count = 2) => runs ?
            api.compactTermRecordPreinternedPlanRuns(plan, count, 1, scratch, equal) :
            api.compactTermRecordPreinternedPlan(plan, 0, count, scratch, equal)

        for (const field of fields) {
            for (const at of [0, 8]) {
                test(`${runs ? 'runs' : 'slice'} rejects ${field} overlapping scratch at byte ${at}`, () => {
                    const plan = makePlan()
                    const source = plan[field]
                    assert.ok(source)
                    const buffer = new ArrayBuffer(64)
                    new Uint8Array(buffer, at, source.byteLength).set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))
                    const view = field === 'stringLengths' ? new Uint16Array(buffer, at, source.length) :
                        field === 'stringsBuffer' ? new Uint8Array(buffer, at, source.length) : new Uint32Array(buffer, at, source.length)
                    Object.assign(plan, {[field]: view})
                    const before = structuredClone(plan)
                    const bytesBefore = new Uint8Array(buffer).slice()
                    assert.throws(() => compact(plan, new Uint32Array(buffer, 0, 3)), /scratch overlaps source storage/)
                    assert.deepEqual(plan, before)
                    assert.deepEqual(new Uint8Array(buffer), bytesBefore)
                })
            }
        }
        test(`${runs ? 'runs' : 'slice'} rejects equality flags overlapping scratch`, () => {
            const plan = makePlan()
            const scratch = new Uint32Array(3)
            const equal = new Uint8Array(scratch.buffer, 1, 3)
            const before = structuredClone(plan)
            assert.throws(() => compact(plan, scratch, equal), /scratch overlaps source storage/)
            assert.deepEqual(plan, before)
            assert.deepEqual(scratch, new Uint32Array(3))
        })
        for (const sourceAt of [0, 24, 48]) {
            test(`${runs ? 'runs' : 'slice'} accepts disjoint views at ${sourceAt} in one backing buffer`, () => {
                const plan = makePlan()
                const expected = compact(plan, new Uint32Array(3))
                const buffer = new ArrayBuffer(80)
                const expressions = new Uint32Array(buffer, sourceAt, 3)
                expressions.set(plan.expressionIndexes)
                plan.expressionIndexes = expressions
                // At 24 and 48 the source is in the unused suffix of the full scratch view.
                const scratch = sourceAt === 0 ? new Uint32Array(buffer, 12, 3) : new Uint32Array(buffer)
                assert.deepEqual(compact(plan, scratch), expected)
                assert.deepEqual(expressions, new Uint32Array(3))
            })
        }
        test(`${runs ? 'runs' : 'slice'} accepts an overlapping view for zero rows without writing`, () => {
            const plan = makePlan()
            const before = structuredClone(plan)
            compact(plan, plan.expressionIndexes, [], 0)
            assert.deepEqual(plan, before)
        })
        test(`${runs ? 'runs' : 'slice'} supports nonoverlapping shared-backed sources and scratch`, () => {
            const plan = makePlan()
            const expected = compact(plan, new Uint32Array(3))
            const buffer = new SharedArrayBuffer(64)
            plan.expressionIndexes = new Uint32Array(buffer, 0, 3)
            const scratch = new Uint32Array(buffer, 16, 3)
            assert.deepEqual(compact(plan, scratch), expected)
        })
        test(`${runs ? 'runs' : 'slice'} rejects overlapping stable shared-backed views`, () => {
            const plan = makePlan()
            plan.expressionIndexes = new Uint32Array(new SharedArrayBuffer(12))
            assert.throws(() => compact(plan, plan.expressionIndexes), /scratch overlaps source storage/)
            assert.deepEqual(plan.expressionIndexes, new Uint32Array(3))
        })
        test(`${runs ? 'runs' : 'slice'} isolates scratch behind a cloned shared-buffer wrapper`, () => {
            const plan = makePlan()
            const buffer = new SharedArrayBuffer(12)
            plan.expressionIndexes = new Uint32Array(buffer)
            const scratch = new Uint32Array(structuredClone(buffer))
            assert.notEqual(scratch.buffer, buffer)
            const expected = compact(plan, new Uint32Array(3))
            const before = structuredClone(plan.expressionIndexes.slice())
            assert.deepEqual(compact(plan, scratch), expected)
            assert.deepEqual(plan.expressionIndexes, before)
            assert.deepEqual(scratch, new Uint32Array(3))
        })
        test(`${runs ? 'runs' : 'slice'} preserves dirty shared scratch and rejects it`, () => {
            const plan = makePlan()
            const scratch = new Uint32Array(new SharedArrayBuffer(12))
            scratch[1] = 7
            assert.throws(() => compact(plan, scratch), /scratch is not clear/)
            assert.deepEqual(scratch, new Uint32Array([0, 7, 0]))
        })
        test(`${runs ? 'runs' : 'slice'} preserves source and scratch after a late invalid row`, () => {
            const plan = makePlan()
            plan.readingIndexes[1] = 3
            const before = structuredClone(plan)
            const scratch = new Uint32Array(4)
            scratch[3] = 0xdeadbeef
            assert.throws(() => compact(plan, scratch), /index out of bounds/)
            assert.deepEqual(scratch, new Uint32Array([0, 0, 0, 0xdeadbeef]))
            assert.deepEqual(plan, before)
        })
    }
    test('the silent a-to-c substitution is rejected before remapping', () => {
        const plan = makePlan()
        const expected = api.compactTermRecordPreinternedPlan(plan, 0, 2, new Uint32Array(3))
        assert.ok(expected)
        assert.deepEqual(expected.expressionIndexes, new Uint32Array([0, 0]))
        assert.deepEqual(expected.stringsBuffer, new TextEncoder().encode('ab'))
        assert.throws(() => api.compactTermRecordPreinternedPlan(plan, 0, 2, plan.expressionIndexes), /scratch overlaps source storage/)
    })
    test('a null plan retains its no-op behavior', () => {
        assert.equal(api.compactTermRecordPreinternedPlan(null, -1, -1, new Uint32Array()), null)
    })
}
