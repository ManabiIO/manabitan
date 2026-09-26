/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {ObjectPropertyAccessor} from '../../ext/js/general/object-property-accessor.js'

for (const key of ['__proto__', 'constructor', 'toString', 'missing']) {
    for (const reverse of [false, true]) {
        test(`swap rejects a non-own ${key} leaf (${reverse ? 'second' : 'first'}) without writing`, () => {
            const payload = {retained: true}
            const target = {value: payload}
            const accessor = new ObjectPropertyAccessor(target)
            const paths = reverse ? [['value'], [key]] : [[key], ['value']]
            assert.throws(() => accessor.swap(paths[0], paths[1]), /Invalid path/)
            assert.deepEqual(Object.keys(target), ['value'])
            assert.equal(target.value, payload)
            assert.equal(Object.getPrototypeOf(target), Object.prototype)
        })
    }
}

test('a failed swap cannot expose Object.prototype through an own __proto__ alias', () => {
    const target = {}
    Object.defineProperty(target, 'locked', {value: 42, writable: false})
    const accessor = new ObjectPropertyAccessor(target)
    assert.throws(() => accessor.swap(['__proto__'], ['locked']))
    assert.equal(Object.getOwnPropertyDescriptor(target, '__proto__'), undefined)
    assert.throws(() => accessor.get(['__proto__']), /Invalid path/)
    assert.equal(Object.getPrototypeOf(target), Object.prototype)
    assert.equal(Reflect.get(target, 'locked'), 42)
})

test('rejects an inherited nested swap leaf before modifying either target', () => {
    const left = {}
    const right = {value: 2}
    const accessor = new ObjectPropertyAccessor({left, right})
    assert.throws(() => accessor.swap(['left', '__proto__'], ['right', 'value']), /Invalid path/)
    assert.deepEqual(Object.keys(left), [])
    assert.equal(right.value, 2)
})

test('rejects an out-of-range array leaf before extending its length', () => {
    const array = [1]
    const target = {array, value: 2}
    const accessor = new ObjectPropertyAccessor(target)
    assert.throws(() => accessor.swap(['array', 1], ['value']), /Invalid path/)
    assert.deepEqual(array, [1])
    assert.equal(target.value, 2)
})

test('existing own undefined values remain valid swap leaves', () => {
    const target = {left: undefined, right: 2}
    new ObjectPropertyAccessor(target).swap(['left'], ['right'])
    assert.deepEqual(target, {left: 2, right: undefined})
})

test('existing own __proto__ payloads swap without changing either prototype', () => {
    const left = {['__proto__']: {left: true}}
    const right = {['__proto__']: {right: true}}
    const a = Object.getOwnPropertyDescriptor(left, '__proto__')?.value
    const b = Object.getOwnPropertyDescriptor(right, '__proto__')?.value
    const accessor = new ObjectPropertyAccessor({left, right})
    accessor.swap(['left', '__proto__'], ['right', '__proto__'])
    assert.equal(accessor.get(['left', '__proto__']), b)
    assert.equal(accessor.get(['right', '__proto__']), a)
    assert.equal(Object.getPrototypeOf(left), Object.prototype)
    assert.equal(Object.getPrototypeOf(right), Object.prototype)
})

test('a rejecting second write rolls back an existing own __proto__ value', () => {
    const original = {retained: true}
    const target = {['__proto__']: original}
    Object.defineProperty(target, 'locked', {value: 42, writable: false})
    const descriptor = Object.getOwnPropertyDescriptor(target, '__proto__')
    assert.throws(() => new ObjectPropertyAccessor(target).swap(['__proto__'], ['locked']), TypeError)
    assert.deepEqual(Object.getOwnPropertyDescriptor(target, '__proto__'), descriptor)
    assert.equal(Object.getOwnPropertyDescriptor(target, '__proto__')?.value, original)
})

test('preserves own setter invocation and propagates the original second-write failure', () => {
    const expected = new Error('second setter rejected')
    let stored = 1
    const target = {}
    Object.defineProperty(target, '__proto__', {get: () => stored, set: (value) => { stored = value }})
    Object.defineProperty(target, 'other', {get: () => 2, set: () => { throw expected }})
    assert.throws(() => new ObjectPropertyAccessor(target).swap(['__proto__'], ['other']), (error) => error === expected)
    assert.equal(stored, 1)
    assert.equal(Object.getPrototypeOf(target), Object.prototype)
})

test('set still creates new prototype-named data; it does not require an existing leaf', () => {
    const target = {}
    const accessor = new ObjectPropertyAccessor(target)
    const value = {independent: true}
    accessor.set(['__proto__'], value)
    assert.equal(accessor.get(['__proto__']), value)
    assert.equal(Object.getPrototypeOf(target), Object.prototype)
})

test('set respects a nonwritable own __proto__ descriptor', () => {
    const target = {}
    Object.defineProperty(target, '__proto__', {value: 1, writable: false})
    const accessor = new ObjectPropertyAccessor(target)
    assert.throws(() => accessor.set(['__proto__'], 2), TypeError)
    assert.equal(accessor.get(['__proto__']), 1)
})

test('ordinary array swaps retain their original semantics', () => {
    const target = [1, 2]
    new ObjectPropertyAccessor(target).swap([0], [1])
    assert.deepEqual(target, [2, 1])
})
