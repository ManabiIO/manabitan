/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
    compactTermRecordPreinternedPlan as compact,
    compactTermRecordPreinternedPlanRuns as compactRuns,
} from '../../ext/js/dictionary/term-record-preinterned-plan.js'
import {expectedCopyPlan, makeCopyFixture} from './preinterned-copy-fixture.js'

const encoder = new TextEncoder()
const textKeys = ['前', '', '猫', '\ufeffねこ', '', '', '\0𠮷', '後'].map((key) => encoder.encode(key))

for (const offsets of [true, false]) {
    for (const hashes of [true, false]) {
        for (const padding of [0, 3, 17]) {
            test(`exact independent output with offsets=${offsets}, hashes=${hashes}, padding=${padding}`, () => {
                const plan = makeCopyFixture(textKeys, [2, 3, 6, 2, 0, 7], [3, 6, 0, 7, 2, 1], {offsets, hashes, padding})
                const before = Uint8Array.from(new Uint8Array(plan.stringsBuffer.buffer))
                const scratch = new Uint32Array(textKeys.length + 4)
                scratch.fill(0xdead, textKeys.length)
                const expected = expectedCopyPlan(textKeys, plan, 1, 4)
                const result = compact(plan, 1, 4, scratch)
                assert.ok(result)
                assert.deepEqual(result, expected)
                assert.notEqual(result.stringsBuffer.buffer, plan.stringsBuffer.buffer)
                assert.deepEqual(new Uint8Array(plan.stringsBuffer.buffer), before)
                assert.ok(scratch.subarray(0, textKeys.length).every((value) => value === 0))
                assert.ok(scratch.subarray(textKeys.length).every((value) => value === 0xdead))
                result.stringsBuffer.fill(0xff)
                assert.deepEqual(new Uint8Array(plan.stringsBuffer.buffer), before)
                assert.deepEqual(compact(plan, 1, 4, scratch), expected)
            })
        }
    }
}

const orders = [
    [], [0], [1, 4, 5], [1, 4, 5, 7], [2, 3, 4, 5, 6], [3, 4, 5, 2],
    [7, 6, 5, 4, 3, 2, 1, 0], [0, 7, 1, 6, 2, 5, 3, 4], [4, 5, 1, 6, 3, 2, 0],
]
for (const [index, order] of orders.entries()) {
    test(`empty keys, contiguous spans and discontinuities preserve order ${index}`, () => {
        const plan = makeCopyFixture(textKeys, order)
        assert.deepEqual(compact(plan, 0, order.length, new Uint32Array(textKeys.length)), expectedCopyPlan(textKeys, plan, 0, order.length))
    })
}

for (const count of [0, 1, 8]) {
    test(`all-empty source preserves distinct key identities with ${count} rows`, () => {
        const keys = Array.from({length: 8}, () => new Uint8Array(0))
        const order = Array.from({length: count}, (_, i) => 7 - i)
        const plan = makeCopyFixture(keys, order, order, {padding: 3})
        assert.deepEqual(compact(plan, 0, count, new Uint32Array(8)), expectedCopyPlan(keys, plan, 0, count))
    })
}

test('an empty arena and zero rows remain valid', () => {
    const plan = makeCopyFixture([], [])
    assert.deepEqual(compact(plan, 0, 0, new Uint32Array(0)), expectedCopyPlan([], plan, 0, 0))
    assert.deepEqual(compactRuns(plan, 0, 3, new Uint32Array(0), []), [])
    assert.equal(compact(null, 0, 0, new Uint32Array(0)), null)
})

for (const equal of [[false, true, true, false], new Uint8Array([0, 1, 1, 0])]) {
    test(`reading-equality override preserves hidden invalid readings (${equal.constructor.name})`, () => {
        const keys = textKeys.slice(0, 4)
        const plan = makeCopyFixture(keys, [0, 2, 3, 2], [3, 0xffffffff, 0xffffffff, 0])
        const scratch = new Uint32Array(keys.length)
        assert.deepEqual(compact(plan, 1, 2, scratch, equal), expectedCopyPlan(keys, plan, 1, 2, equal))
        assert.ok(scratch.every((value) => value === 0))
    })
}

for (const runLimit of [1, 2, 3, 8, 19]) {
    test(`run compaction retains independent output arenas with run limit ${runLimit}`, () => {
        const order = [2, 3, 6, 7, 6, 1, 0, 2, 3]
        const plan = makeCopyFixture(textKeys, order, order.map((_, i) => i % textKeys.length), {padding: 5})
        const equal = new Uint8Array(order.map((_, i) => i % 3 === 0 ? 1 : 0))
        const scratch = new Uint32Array(textKeys.length)
        const runs = compactRuns(plan, order.length, runLimit, scratch, equal)
        assert.equal(runs.length, Math.ceil(order.length / runLimit))
        for (let i = 0; i < runs.length; ++i) {
            assert.deepEqual(runs[i], expectedCopyPlan(textKeys, plan, i * runLimit, Math.min(runLimit, order.length - i * runLimit), equal))
            assert.notEqual(runs[i].stringsBuffer.buffer, plan.stringsBuffer.buffer)
            for (let j = 0; j < i; ++j) { assert.notEqual(runs[i].stringsBuffer.buffer, runs[j].stringsBuffer.buffer) }
        }
        assert.ok(scratch.every((value) => value === 0))
    })
}

for (const shared of [false, true]) {
    test(`max-length and byte-distinct keys copy exactly from ${shared ? 'shared' : 'ordinary'} subviews`, () => {
        const keys = [new Uint8Array(65535).fill(253), encoder.encode('same'), encoder.encode('same'), new Uint8Array([0xff, 0xfe, 0x80, 0])]
        const plan = makeCopyFixture(keys, [3, 0, 1, 2], [2, 1, 3, 0], {padding: 7, shared})
        const expected = expectedCopyPlan(keys, plan, 0, 4)
        const result = compact(plan, 0, 4, new Uint32Array(4))
        assert.deepEqual(result, expected)
        plan.stringsBuffer.fill(0)
        assert.deepEqual(result, expected)
    })
}

for (const column of ['expressionIndexes', 'readingIndexes']) {
    test(`invalid ${column} clears admitted scratch before rejecting`, () => {
        const plan = makeCopyFixture(textKeys, [2, 3], [6, 7])
        plan[/** @type {'expressionIndexes'|'readingIndexes'} */ (column)][1] = 0xffffffff
        const scratch = new Uint32Array(textKeys.length)
        assert.throws(() => compact(plan, 0, 2, scratch), RangeError)
        assert.ok(scratch.every((value) => value === 0))
    })
}

test('dirty scratch is rejected without consuming unrelated caller values', () => {
    const plan = makeCopyFixture(textKeys, [2, 3], [6, 7])
    const scratch = new Uint32Array(textKeys.length + 1)
    scratch[3] = 2
    scratch[textKeys.length] = 0xbeef
    assert.throws(() => compact(plan, 0, 2, scratch), /scratch is not clear/)
    assert.equal(scratch[2], 0)
    assert.equal(scratch[6], 0)
    assert.equal(scratch[3], 2)
    assert.equal(scratch[textKeys.length], 0xbeef)
    scratch[3] = 0
    assert.deepEqual(compact(plan, 0, 2, scratch), expectedCopyPlan(textKeys, plan, 0, 2))
})

for (const corruption of ['offset', 'truncated', 'trailing', 'hashes']) {
    test(`complete source validation still rejects ${corruption} before copying`, () => {
        const plan = makeCopyFixture(textKeys, [2, 3])
        if (corruption === 'offset') {
            assert.ok(plan.stringOffsets)
            plan.stringOffsets[7] += 1
        } else if (corruption === 'truncated') {
            plan.stringsBuffer = plan.stringsBuffer.subarray(0, plan.stringsBuffer.length - 1)
        } else if (corruption === 'trailing') {
            const larger = new Uint8Array(plan.stringsBuffer.length + 1)
            larger.set(plan.stringsBuffer)
            plan.stringsBuffer = larger
        } else {
            plan.stringHashes = new Uint32Array(1)
        }
        const scratch = new Uint32Array(textKeys.length)
        assert.throws(() => compact(plan, 0, 2, scratch))
        assert.ok(scratch.every((value) => value === 0))
    })
}

test('source Uint8Array subclasses do not change byte identity', () => {
    const plan = makeCopyFixture(textKeys, [2, 3, 6, 7])
    plan.stringsBuffer = Buffer.from(plan.stringsBuffer)
    assert.deepEqual(compact(plan, 0, 4, new Uint32Array(textKeys.length)), expectedCopyPlan(textKeys, plan, 0, 4))
})

test('seeded arbitrary byte arenas match the independent first-use model', () => {
    let seed = 0x918fb347
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    for (let trial = 0; trial < 1500; ++trial) {
        const keys = Array.from({length: 1 + next() % 65}, () => Uint8Array.from({length: next() % 37}, () => next() >>> 16))
        const count = next() % 91
        const expression = Array.from({length: count}, () => next() % keys.length)
        const reading = Array.from({length: count}, () => next() % keys.length)
        const plan = makeCopyFixture(keys, expression, reading, {offsets: trial % 2 === 0, hashes: trial % 3 === 0, padding: trial % 19})
        const start = count === 0 ? 0 : next() % count
        const size = next() % (count - start + 1)
        const equal = Uint8Array.from({length: count}, () => next() % 5 === 0 ? 1 : 0)
        const scratch = new Uint32Array(keys.length)
        assert.deepEqual(compact(plan, start, size, scratch, equal), expectedCopyPlan(keys, plan, start, size, equal), `trial ${trial}`)
        assert.ok(scratch.every((value) => value === 0))
    }
})

test('one contiguous arena span requires one source byte-copy operation', () => {
    const keys = Array.from({length: 1024}, (_, i) => encoder.encode(`key-${i}`))
    const indexes = Array.from({length: 512}, (_, i) => 128 + i)
    const plan = makeCopyFixture(keys, indexes, indexes, {padding: 7})
    const expected = expectedCopyPlan(keys, plan, 0, indexes.length)
    const originalSet = Uint8Array.prototype.set
    let sourceCopies = 0
    let result
    try {
        /** @param {ArrayLike<number>} source @param {number} [offset] @returns {void} */
        Uint8Array.prototype.set = function (source, offset) {
            if (source instanceof Uint8Array && source.buffer === plan.stringsBuffer.buffer) { ++sourceCopies }
            originalSet.call(this, source, offset)
        }
        result = compact(plan, 0, indexes.length, new Uint32Array(keys.length))
    } finally {
        Uint8Array.prototype.set = originalSet
    }
    assert.deepEqual(result, expected)
    assert.equal(sourceCopies, 1)
})
