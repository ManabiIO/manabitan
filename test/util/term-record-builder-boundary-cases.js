/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
    compactTermRecordPreinternedPlan,
    createTermRecordPreinternedPlanBuilder,
    getValidatedStringOffsets,
} from '../../ext/js/dictionary/term-record-preinterned-plan.js'

const encoder = new TextEncoder()

function createBuilder() {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    assert.equal(builder.internStringBytes(encoder.encode('猫')), 0)
    assert.equal(builder.internStringBytes(encoder.encode('ねこ')), 1)
    return builder
}

/** @type {[string, number][]} */
const invalidIndexes = [
    ['negative', -1],
    ['negative fraction', -0.5],
    ['fraction truncating to zero', 0.5],
    ['fraction truncating to one', 1.5],
    ['first out-of-range ID', 2],
    ['uint32 wrap to zero', 2 ** 32],
    ['uint32 wrap to one', 2 ** 32 + 1],
    ['unsafe number', 2 ** 53],
    ['NaN', Number.NaN],
    ['positive infinity', Infinity],
    ['negative infinity', -Infinity],
]

for (const [label, value] of invalidIndexes) {
    for (const column of ['expression', 'reading']) {
        test(`buildPlan rejects ${label} in ${column} before uint32 narrowing`, () => {
            const builder = createBuilder()
            const expression = [0, 1]
            const reading = [1, 0]
            const indexes = column === 'expression' ? expression : reading
            indexes[1] = value
            assert.throws(() => builder.buildPlan(expression, reading), RangeError)
        })
    }
}

for (const column of ['expression', 'reading']) {
    test(`buildPlan rejects a sparse ${column} array instead of producing ID zero`, () => {
        const builder = createBuilder()
        const sparse = new Array(1)
        assert.throws(() => builder.buildPlan(
            column === 'expression' ? sparse : [0],
            column === 'reading' ? sparse : [1],
        ), RangeError)
    })
    test(`typed ${column} IDs keep their view and remain checked by compaction`, () => {
        const builder = createBuilder()
        const expression = new Uint32Array([column === 'expression' ? 2 : 0])
        const reading = new Uint32Array([column === 'reading' ? 2 : 1])
        const plan = builder.buildPlan(expression, reading)
        assert.equal(plan.expressionIndexes.buffer, expression.buffer)
        assert.equal(plan.readingIndexes.buffer, reading.buffer)
        assert.throws(() => compactTermRecordPreinternedPlan(plan, 0, 1, new Uint32Array(2)), RangeError)
    })
}

test('zero-string builder rejects an admitted row', () => {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    assert.throws(() => builder.buildPlan([0], [0]), RangeError)
})

test('invalid uint32-wrapped IDs cannot become apparently valid compacted headwords', () => {
    const builder = createBuilder()
    assert.throws(() => {
        const plan = builder.buildPlan([2 ** 32], [1])
        compactTermRecordPreinternedPlan(plan, 0, 1, new Uint32Array(2))
    }, RangeError)
})

test('valid arrays preserve IDs and exact UTF-8 arena bytes', () => {
    const builder = createBuilder()
    const plan = builder.buildPlan([0, 1, 0], [1, 1, 0])
    assert.deepEqual(plan.expressionIndexes, new Uint32Array([0, 1, 0]))
    assert.deepEqual(plan.readingIndexes, new Uint32Array([1, 1, 0]))
    assert.deepEqual(plan.stringsBuffer, encoder.encode('猫ねこ'))
    assert.deepEqual(getValidatedStringOffsets(plan), new Uint32Array([0, 3]))
})

test('valid typed-array subviews remain zero-copy', () => {
    const builder = createBuilder()
    const expressionBacking = new Uint32Array([99, 0, 1, 99])
    const readingBacking = new Uint32Array([99, 1, 0, 99])
    const expression = expressionBacking.subarray(1, 3)
    const reading = readingBacking.subarray(1, 3)
    const plan = builder.buildPlan(expression, reading, 1)
    assert.equal(plan.expressionIndexes.buffer, expression.buffer)
    assert.equal(plan.expressionIndexes.byteOffset, expression.byteOffset)
    assert.equal(plan.readingIndexes.buffer, reading.buffer)
    assert.equal(plan.readingIndexes.byteOffset, reading.byteOffset)
    assert.deepEqual(plan.expressionIndexes, new Uint32Array([0]))
    assert.deepEqual(plan.readingIndexes, new Uint32Array([1]))
})

test('explicit count ignores unused invalid suffixes', () => {
    const plan = createBuilder().buildPlan([0, Number.NaN], [1, 2 ** 32], 1)
    assert.deepEqual(plan.expressionIndexes, new Uint32Array([0]))
    assert.deepEqual(plan.readingIndexes, new Uint32Array([1]))
})

test('zero rows accept an empty arena and ignore unused row values', () => {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    const plan = builder.buildPlan([Number.NaN], [Infinity], 0)
    assert.equal(plan.stringsBuffer.byteLength, 0)
    assert.equal(plan.expressionIndexes.length, 0)
    assert.equal(plan.readingIndexes.length, 0)
})

test('negative zero is a valid index zero', () => {
    const plan = createBuilder().buildPlan([-0], [1])
    assert.equal(plan.expressionIndexes[0], 0)
})

test('a rejected build leaves the builder usable', () => {
    const builder = createBuilder()
    assert.throws(() => builder.buildPlan([2 ** 32], [1]), RangeError)
    assert.equal(builder.internStringBytes(encoder.encode('犬')), 2)
    const plan = builder.buildPlan([0, 2], [1, 2])
    assert.deepEqual(plan.expressionIndexes, new Uint32Array([0, 2]))
    assert.deepEqual(plan.stringsBuffer, encoder.encode('猫ねこ犬'))
})

for (const count of [-1, 0.5, Number.NaN, Infinity, 3]) {
    test(`invalid row count ${String(count)} is still rejected`, () => {
        assert.throws(() => createBuilder().buildPlan([0, 1], [1, 0], count), RangeError)
    })
}

test('typed reading-equality overrides keep their existing compaction semantics', () => {
    const builder = createBuilder()
    const plan = builder.buildPlan(new Uint32Array([0]), new Uint32Array([0xffffffff]))
    const compact = compactTermRecordPreinternedPlan(plan, 0, 1, new Uint32Array(2), [true])
    assert(compact !== null)
    assert.deepEqual(compact.expressionIndexes, new Uint32Array([0]))
    assert.deepEqual(compact.readingIndexes, new Uint32Array([0]))
    assert.deepEqual(compact.stringsBuffer, encoder.encode('猫'))
})

test('ordinary input getters are validated and copied from the same read', () => {
    const builder = createBuilder()
    const indexes = [0]
    let reads = 0
    Object.defineProperty(indexes, 0, {
        get() {
            ++reads
            return reads === 1 ? 0 : 2 ** 32 + 1
        },
    })
    const plan = builder.buildPlan(indexes, [1])
    assert.equal(reads, 1)
    assert.deepEqual(plan.expressionIndexes, new Uint32Array([0]))
})

test('growth, duplicates and hash collisions preserve first-occurrence string identities', () => {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    const expected = []
    const expression = []
    const reading = []
    for (let i = 0; i < 512; ++i) {
        const bytes = encoder.encode(`語𠮷${i}`)
        expected.push(bytes)
        expression.push(builder.internStringBytesWithHash(bytes, 0))
        reading.push(builder.internStringBytesWithHash(Uint8Array.from(bytes), 0))
        assert.equal(expression[i], i)
        assert.equal(reading[i], i)
    }
    const plan = builder.buildPlan(expression, reading)
    const offsets = getValidatedStringOffsets(plan)
    assert(plan.stringHashes instanceof Uint32Array)
    for (let i = 0; i < expected.length; ++i) {
        assert.deepEqual(plan.stringsBuffer.subarray(offsets[i], offsets[i] + plan.stringLengths[i]), expected[i])
        assert.equal(plan.stringHashes[i], 0)
    }
})

test('maximum-length, empty, BOM and NUL keys retain exact bytes', () => {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    const keys = [new Uint8Array(0), new Uint8Array(65535).fill(97), encoder.encode('\ufeff猫'), encoder.encode('\0ねこ')]
    const indexes = keys.map((bytes) => builder.internStringBytes(bytes))
    const plan = builder.buildPlan(indexes, indexes)
    const offsets = getValidatedStringOffsets(plan)
    for (let i = 0; i < keys.length; ++i) {
        assert.deepEqual(plan.stringsBuffer.subarray(offsets[i], offsets[i] + plan.stringLengths[i]), keys[i])
    }
    assert.throws(() => builder.internStringBytes(new Uint8Array(65536)), /binary record limit/)
})
