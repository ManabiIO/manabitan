/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {compactTermRecordPreinternedPlan, createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'

/** @typedef {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

/**
 * @param {number} keyCount
 * @param {number[]} expressions
 * @param {number[]} [readings]
 * @returns {Plan}
 */
function createPlan(keyCount, expressions, readings = expressions) {
    const builder = createTermRecordPreinternedPlanBuilder()
    const encoder = new TextEncoder()
    for (let key = 0; key < keyCount; ++key) {
        builder.internStringBytes(encoder.encode(`日🙂${key}${'x'.repeat(key % 19)}`))
    }
    return builder.buildPlan(expressions, readings)
}

/**
 * Row-order oracle uses explicit byte copying, independently of copy grouping.
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {Uint8Array} aliases
 * @returns {Plan}
 */
function expected(plan, start, count, aliases) {
    /** @type {number[]} */
    const oldKeys = []
    const remap = new Map()
    /**
     * @param {number} key
     * @returns {number}
     */
    const intern = (key) => {
        if (!remap.has(key)) {
            remap.set(key, oldKeys.length)
            oldKeys.push(key)
        }
        return remap.get(key)
    }
    const expressionIndexes = new Uint32Array(count)
    const readingIndexes = new Uint32Array(count)
    for (let i = 0; i < count; ++i) {
        const row = start + i
        expressionIndexes[i] = intern(plan.expressionIndexes[row])
        readingIndexes[i] = intern(aliases[row] === 1 ? plan.expressionIndexes[row] : plan.readingIndexes[row])
    }
    const sourceOffsets = new Uint32Array(plan.stringLengths.length)
    let cursor = 0
    for (let i = 0; i < sourceOffsets.length; ++i) {
        sourceOffsets[i] = cursor
        cursor += plan.stringLengths[i]
    }
    const stringLengths = Uint16Array.from(oldKeys, (key) => plan.stringLengths[key])
    const stringOffsets = new Uint32Array(oldKeys.length)
    const stringsBuffer = new Uint8Array(stringLengths.reduce((a, b) => a + b, 0))
    cursor = 0
    for (const [i, key] of oldKeys.entries()) {
        stringOffsets[i] = cursor
        for (let j = 0; j < stringLengths[i]; ++j) { stringsBuffer[cursor++] = plan.stringsBuffer[sourceOffsets[key] + j] }
    }
    return {stringLengths,
        stringOffsets,
        stringHashes: plan.stringHashes ? Uint32Array.from(oldKeys, (key) => /** @type {Uint32Array} */ (plan.stringHashes)[key]) : undefined,
        stringsBuffer,
        expressionIndexes,
        readingIndexes}
}

/**
 * @param {Plan} plan
 * @param {number} [start]
 * @param {number} [count]
 * @param {Uint8Array} [aliases]
 * @returns {Plan}
 */
function check(plan, start = 0, count = plan.expressionIndexes.length, aliases = new Uint8Array(plan.expressionIndexes.length)) {
    const oracle = expected(plan, start, count, aliases)
    const scratch = new Uint32Array(plan.stringLengths.length)
    const actual = compactTermRecordPreinternedPlan(plan, start, count, scratch, aliases)
    expect(actual).toEqual(oracle)
    expect(scratch.every((value) => value === 0)).toBe(true)
    if (actual === null) { throw new Error('Expected a compacted plan') }
    return actual
}

describe('contiguous source string compaction', () => {
    test('copies 1,024 adjacent first-seen keys through one source view', () => {
        const plan = createPlan(1024, Array.from({length: 1024}, (_, i) => i))
        const calls = vi.spyOn(plan.stringsBuffer, 'subarray')
        check(plan)
        expect(calls).toHaveBeenCalledTimes(1)
        expect(calls).toHaveBeenCalledWith(0, plan.stringsBuffer.byteLength)
    })

    test('flushes exactly at source gaps without changing first-seen key order', () => {
        const plan = createPlan(10, [0, 1, 4, 5, 6, 8, 9])
        const calls = vi.spyOn(plan.stringsBuffer, 'subarray')
        check(plan)
        expect(calls).toHaveBeenCalledTimes(3)
    })

    test.each([0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 33, 257, 30001, 70001])('preserves every column for %i irregular rows', (count) => {
        const keys = 311
        const expression = Array.from({length: count}, (_, i) => (i * 7) % keys)
        const reading = Array.from({length: count}, (_, i) => (i * 11 + 23) % keys)
        const plan = createPlan(keys, expression, reading)
        const aliases = Uint8Array.from({length: count}, (_, i) => (i % 3 === 0 ? 1 : 0))
        check(plan, 0, count, aliases)
        const start = Math.floor(count / 3)
        check(plan, start, count - start, aliases)
    })

    test('preserves reversed, repeating and interleaved aliases without assuming sorted keys', () => {
        check(createPlan(8, [7, 6, 5, 4, 3, 2, 1, 0]))
        check(createPlan(8, [0, 7, 1, 6, 2, 5, 3, 4], [7, 0, 6, 1, 5, 2, 4, 3]))
        check(createPlan(8, [7, 7, 7, 7, 7]))
    })

    test('supports reconstructed offsets and absent hashes with the same bytes', () => {
        const plan = createPlan(20, [1, 2, 3, 9, 10, 11, 19])
        delete plan.stringOffsets
        delete plan.stringHashes
        check(plan)
    })

    test('copies from bounded shared views and returns independent owned storage', () => {
        const plan = createPlan(30, [0, 1, 2, 5, 6, 7, 20, 21, 22])
        const backing = new Uint8Array(new SharedArrayBuffer(plan.stringsBuffer.byteLength + 32))
        backing.fill(255)
        backing.set(plan.stringsBuffer, 13)
        plan.stringsBuffer = backing.subarray(13, 13 + plan.stringsBuffer.byteLength)
        const actual = check(plan)
        const retained = Uint8Array.from(actual.stringsBuffer)
        backing.fill(0)
        check(createPlan(3, [0, 1, 2])).stringsBuffer.fill(33)
        expect(actual.stringsBuffer).toEqual(retained)
        expect(actual.stringsBuffer.buffer).not.toBeInstanceOf(SharedArrayBuffer)
    })

    test('retains arena, row and dirty-scratch validation and clears scratch after row failure', () => {
        const plan = createPlan(10, [0, 1, 2, 3])
        const scratch = new Uint32Array(10)
        plan.expressionIndexes[3] = 20
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 4, scratch)).toThrow(RangeError)
        expect([...scratch]).toEqual(new Array(10).fill(0))
        plan.expressionIndexes[3] = 3
        scratch[1] = 7
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 4, scratch)).toThrow('scratch')
        scratch.fill(0)
        if (plan.stringOffsets) { plan.stringOffsets[3] += 1 }
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 4, scratch)).toThrow(RangeError)
    })
})
