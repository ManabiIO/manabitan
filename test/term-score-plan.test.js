/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {
    copyOwnedTermScorePlan,
    getSynchronousTermScorePlan,
    isCanonicalTermScorePlan,
    readTermScore,
    sliceTermScoreSource,
} from '../ext/js/dictionary/term-score-plan.js'

/** @typedef {import('../ext/js/dictionary/term-score-plan.js').TermScoreSource} TermScoreSource */

/**
 * @param {number[]} [values]
 * @param {number[]} [keys]
 * @returns {TermScoreSource & {scoreList: null, scorePlan: import('../ext/js/dictionary/term-score-plan.js').TermScorePlan}}
 */
function compact(values = [-2147483648, 0, 2147483647], keys = [0, 1, 2, 0, 2, 1, 0, 1]) {
    const scorePlan = copyOwnedTermScorePlan(new Int32Array(values), new Uint16Array(keys))
    if (scorePlan === null) { throw new Error('Expected compact score plan') }
    return {scoreList: null, scorePlan}
}

describe('private compact term score columns', () => {
    test('owns one exact buffer within the raw score budget and preserves signed values', () => {
        const source = compact()
        const {values, keys} = source.scorePlan
        expect(values.buffer).toBe(keys.buffer)
        expect(values.byteOffset).toBe(0)
        expect(keys.byteOffset).toBe(values.byteLength)
        expect(values.buffer.byteLength).toBe(values.byteLength + keys.byteLength)
        expect(values.buffer.byteLength).toBeLessThanOrEqual(keys.length * 4)
        expect(getSynchronousTermScorePlan(source, keys.length)).toEqual(source.scorePlan)
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(true)
        expect(Array.from({length: keys.length}, (_, i) => readTermScore(source, i))).toEqual([
            -2147483648, 0, 2147483647, -2147483648, 2147483647, 0, -2147483648, 0,
        ])
    })

    test('declines excess cardinality and accepts the exact allocation boundary', () => {
        expect(copyOwnedTermScorePlan(new Int32Array([0, 1, 2]), new Uint16Array([0, 1, 2, 0]))).toBeNull()
        expect(copyOwnedTermScorePlan(new Int32Array([0, 1]), new Uint16Array([0, 1, 0, 1]))?.keys.length).toBe(4)
        expect(copyOwnedTermScorePlan(new Int32Array(), new Uint16Array())).toBeNull()
    })

    test('distinguishes a valid empty view from detached storage', () => {
        const buffer = new ArrayBuffer(0)
        const source = {scoreList: null, scorePlan: {values: new Int32Array(buffer), keys: new Uint16Array(buffer)}}
        expect(getSynchronousTermScorePlan(source, 0)).toEqual(source.scorePlan)
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(true)
        expect(() => readTermScore(source, 0)).toThrow(RangeError)
        structuredClone(buffer, {transfer: [buffer]})
        expect(getSynchronousTermScorePlan(source, 0)).toBeNull()
        expect(() => readTermScore(source, 0)).toThrow(TypeError)
    })

    test.each(['buffer', 'length', 'byteOffset', 'byteLength'])('rejects overridden view %s without invoking it', (field) => {
        const source = compact()
        const getter = vi.fn(() => { throw new Error('Caller getter ran') })
        Object.defineProperty(source.scorePlan.keys, field, {get: getter})
        expect(getSynchronousTermScorePlan(source, 8)).toBeNull()
        expect(() => readTermScore(source, 0)).toThrow(TypeError)
        expect(getter).not.toHaveBeenCalled()
    })

    test('rejects accessor descriptors before reading their values', () => {
        for (const field of ['scorePlan', 'values', 'keys']) {
            const source = compact()
            const target = field === 'scorePlan' ? source : source.scorePlan
            const getter = vi.fn(() => { throw new Error('Caller getter ran') })
            Object.defineProperty(target, field, {get: getter})
            expect(getSynchronousTermScorePlan(source, 8)).toBeNull()
            expect(() => readTermScore(source, 0)).toThrow(TypeError)
            expect(getter).not.toHaveBeenCalled()
        }
    })

    test('rejects shared, subclassed, proxy and unrelated backing views', () => {
        class Keys extends Uint16Array {}
        const invalid = [
            new Uint16Array(new SharedArrayBuffer(16)),
            new Keys(8),
            new Proxy(new Uint16Array(8), {}),
            new Uint16Array(8),
        ]
        for (const keys of invalid) {
            const source = compact()
            source.scorePlan.keys = keys
            expect(getSynchronousTermScorePlan(source, 8)).toBeNull()
            expect(() => readTermScore(source, 0)).toThrow(TypeError)
        }
    })

    test('rejects overlapping views, row mismatches and resizable backing storage', () => {
        const source = compact()
        source.scorePlan.keys = new Uint16Array(source.scorePlan.values.buffer, 0, 8)
        expect(getSynchronousTermScorePlan(source, 8)).toBeNull()
        expect(getSynchronousTermScorePlan(compact(), 7)).toBeNull()
        const ResizableArrayBuffer = /** @type {new (byteLength: number, options: {maxByteLength: number}) => ArrayBuffer} */ (ArrayBuffer)
        const buffer = new ResizableArrayBuffer(24, {maxByteLength: 48})
        expect(getSynchronousTermScorePlan({scoreList: null,
            scorePlan: {
                values: new Int32Array(buffer, 0, 2), keys: new Uint16Array(buffer, 8, 8),
            }}, 8)).toBeNull()
    })

    test('rechecks current canonical order, duplicate values, unused values and late key bounds', () => {
        const source = compact()
        source.scorePlan.keys[0] = 2
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(false)
        expect(readTermScore(source, 0)).toBe(2147483647)
        source.scorePlan.keys[0] = 0
        source.scorePlan.values[2] = source.scorePlan.values[0]
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(false)
        source.scorePlan.values[2] = 2147483647
        source.scorePlan.keys.fill(0)
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(false)
        source.scorePlan.keys[7] = 0xffff
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(false)
        expect(() => readTermScore(source, 7)).toThrow(RangeError)
    })

    test('uses indexed values during canonical validation', () => {
        const source = compact()
        const iterator = vi.fn(() => { throw new Error('Caller iterator ran') })
        Object.defineProperty(source.scorePlan.values, Symbol.iterator, {value: iterator})
        expect(getSynchronousTermScorePlan(source, 8)).not.toBeNull()
        expect(isCanonicalTermScorePlan(source.scorePlan)).toBe(true)
        expect(iterator).not.toHaveBeenCalled()
    })

    test('shares sliced compact storage but does not assume its first-use order', () => {
        const source = compact()
        const subarray = vi.fn(() => { throw new Error('Caller subarray ran') })
        Object.defineProperty(source.scorePlan.keys, 'subarray', {value: subarray})
        const slice = sliceTermScoreSource(source, 1, 6)
        expect(slice.scoreList).toBeNull()
        expect(slice.scorePlan?.values).toBe(source.scorePlan.values)
        expect(slice.scorePlan?.keys.buffer).toBe(source.scorePlan.keys.buffer)
        const plan = getSynchronousTermScorePlan(slice, 5)
        expect(plan).not.toBeNull()
        if (plan === null) { throw new Error('Expected valid slice') }
        expect(isCanonicalTermScorePlan(plan)).toBe(false)
        expect(Array.from({length: 5}, (_, i) => readTermScore(slice, i))).toEqual([0, 2147483647, -2147483648, 2147483647, 0])
        expect(() => sliceTermScoreSource(source, -1, 3)).toThrow(RangeError)
        expect(() => sliceTermScoreSource(source, 0, 9)).toThrow(RangeError)
        expect(subarray).not.toHaveBeenCalled()
    })

    test('keeps raw scalar getters, sparse defaults, floating values and slice behavior', () => {
        const values = [1.5, -0, 2 ** 34]
        const getter = vi.fn(() => values)
        const source = {get scoreList() { return getter() }}
        expect(getSynchronousTermScorePlan(source, 3)).toBeNull()
        expect(getter).not.toHaveBeenCalled()
        expect(readTermScore(source, 0)).toBe(1.5)
        expect(Object.is(readTermScore(source, 1), -0)).toBe(true)
        expect(readTermScore(source, 2)).toBe(2 ** 34)
        expect(readTermScore(source, 8)).toBe(0)
        expect(getter).toHaveBeenCalledTimes(4)
        expect(sliceTermScoreSource(source, 1, 3)).toEqual({scoreList: [-0, 2 ** 34]})
    })
})
