/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {WeightedLruMap} from '../../ext/js/core/weighted-lru-map.js'

/** @param {unknown} value */
function weightOf(value) {
    return typeof value === 'number' ? value : 0
}

for (const key of ['missing-value', void 0, NaN, 0, {}]) {
    test(`reading stored undefined promotes ${String(key)} without changing weight`, () => {
        const cache = new WeightedLruMap(2, 10, weightOf)
        cache.set(key, void 0).set('other', 3)
        assert.equal(cache.get(key), void 0)
        assert.deepEqual([...cache.keys()], ['other', key])
        assert.equal(cache.weight, 3)
        cache.set('new', 4)
        assert.equal(cache.has('other'), false)
        assert.equal(cache.has(key), true)
        assert.equal(cache.weight, 4)
    })
}

test('misses do not create entries or change eviction order', () => {
    const cache = new WeightedLruMap(2, 10, weightOf)
    cache.set('a', 2).set('b', 3)
    assert.equal(cache.get('absent'), void 0)
    assert.deepEqual([...cache], [['a', 2], ['b', 3]])
    assert.equal(cache.weight, 5)
})

test('a throwing weight estimator preserves the existing entry and recency', () => {
    const error = new Error('cannot estimate')
    const cache = new WeightedLruMap(3, 20, (value) => {
        if (value === 'reject') { throw error }
        return weightOf(value)
    })
    cache.set('a', 2).set('b', 3)
    assert.throws(() => cache.set('a', 'reject'), (thrown) => thrown === error)
    assert.deepEqual([...cache], [['a', 2], ['b', 3]])
    assert.equal(cache.weight, 5)
    cache.set('c', 4).set('d', 5)
    assert.deepEqual([...cache.keys()], ['b', 'c', 'd'])
    assert.equal(cache.weight, 12)
})

test('reentrant replacement weighting accounts only for the final entry', () => {
    let reentered = false
    const cache = new WeightedLruMap(3, 10, (value, key) => {
        if (value === 4 && !reentered) {
            reentered = true
            cache.set(key, 2)
        }
        return weightOf(value)
    })
    cache.set('a', 1).set('b', 3)
    cache.set('a', 4)
    assert.deepEqual([...cache], [['b', 3], ['a', 4]])
    assert.equal(cache.weight, 7)
    cache.set('c', 3)
    assert.deepEqual([...cache.keys()], ['b', 'a', 'c'])
    assert.equal(cache.weight, 10)
    assert.equal(cache.delete('a'), true)
    assert.equal(cache.weight, 6)
})

test('reentrant insertion weighting removes the intermediate weight', () => {
    let first = true
    const cache = new WeightedLruMap(2, 10, (value, key) => {
        if (first) {
            first = false
            cache.set(key, 3)
        }
        return weightOf(value)
    })
    cache.set('new', 5)
    assert.deepEqual([...cache], [['new', 5]])
    assert.equal(cache.weight, 5)
    cache.clear()
    assert.equal(cache.weight, 0)
})

test('oversized replacement still removes the old value but preserves other entries', () => {
    const cache = new WeightedLruMap(3, 10, weightOf)
    cache.set('a', 2).set('b', 3)
    assert.equal(cache.set('a', 11), cache)
    assert.deepEqual([...cache], [['b', 3]])
    assert.equal(cache.weight, 3)
})

test('falsey values other than undefined retain normal hit promotion', () => {
    const cache = new WeightedLruMap(8, 10, weightOf)
    for (const value of [null, false, '', 0, NaN]) { cache.set(value, value) }
    for (const value of [null, false, '', 0, NaN]) {
        assert.equal(cache.get(value), value)
        assert.equal([...cache.keys()].at(-1), value)
    }
})

test('mixed operations match an independent recomputed-weight model', () => {
    const cache = new WeightedLruMap(17, 53, weightOf)
    /** @type {Map<unknown, unknown>} */
    const model = new Map()
    const keys = [void 0, NaN, -0, {}, ...Array.from({length: 31}, (_, i) => `key-${i}`)]
    let seed = 0x53276914
    const sum = () => [...model.values()].reduce((total, value) => /** @type {number} */ (total) + weightOf(value), 0)
    for (let i = 0; i < 20000; ++i) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const key = keys[(seed >>> 8) % keys.length]
        switch (seed & 15) {
            case 0:
                cache.clear()
                model.clear()
                break
            case 1:
            case 2:
                assert.equal(cache.delete(key), model.delete(key))
                break
            case 3:
            case 4:
            case 5:
            case 6: {
                const expected = model.get(key)
                if (model.has(key)) {
                    model.delete(key)
                    model.set(key, expected)
                }
                assert.equal(cache.get(key), expected)
                break
            }
            default: {
                const value = seed % 5 === 0 ? void 0 : (seed >>> 20) % 61
                cache.set(key, value)
                model.delete(key)
                if (weightOf(value) <= 53) { model.set(key, value) }
                while (model.size > 17 || /** @type {number} */ (sum()) > 53) {
                    model.delete(model.keys().next().value)
                }
                break
            }
        }
        assert.deepEqual([...cache], [...model], `operation ${i}`)
        assert.equal(cache.weight, sum(), `weight after operation ${i}`)
    }
})
