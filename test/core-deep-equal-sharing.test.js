/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {expect, test} from 'vitest';
import {clone, deepEqual} from '../ext/js/core/utilities.js';

/**
 * @param {unknown} lhs
 * @param {unknown} rhs
 * @param {boolean} expected
 */
function checkBoth(lhs, rhs, expected) {
    expect(deepEqual(lhs, rhs)).toBe(expected);
    expect(deepEqual(rhs, lhs)).toBe(expected);
}

test('deepEqual compares a shared object with its clone in both directions', () => {
    const leaf = {term: '単語', score: 1};
    const value = {expression: leaf, reading: leaf};
    checkBoth(value, clone(value), true);
});

test('deepEqual permits shared array elements', () => {
    const leaf = {value: 1};
    checkBoth([leaf, leaf], [{value: 1}, {value: 1}], true);
});

test('deepEqual permits shared empty objects', () => {
    const leaf = {};
    checkBoth({a: leaf, b: leaf}, {a: {}, b: {}}, true);
});

test('deepEqual permits shared nested arrays', () => {
    const leaf = [{value: 1}, null, '日本語'];
    checkBoth([leaf, leaf], clone([leaf, leaf]), true);
});

test('deepEqual permits diamond-shaped sharing at different depths', () => {
    const leaf = {value: [1, 2, 3]};
    const value = {a: {leaf}, b: [{leaf}], c: leaf};
    checkBoth(value, clone(value), true);
});

test('deepEqual permits independent shared references on both sides', () => {
    const left = {value: 1};
    const right = {value: 1};
    checkBoth({a: left, b: left}, {a: right, b: right}, true);
});

test('deepEqual does not require matching sharing topology', () => {
    const left = {value: 1};
    const right = {value: 1};
    checkBoth([left, left, {value: 1}], [{value: 1}, right, right], true);
});

test('deepEqual still checks a later unequal occurrence of a shared object', () => {
    const leaf = {value: 1};
    checkBoth([leaf, leaf], [{value: 1}, {value: 2}], false);
});

test('deepEqual still checks a later unequal property name', () => {
    const leaf = {value: 1};
    checkBoth({a: leaf, b: leaf}, {a: {value: 1}, b: {other: 1}}, false);
});

test('deepEqual still rejects a later unequal nested array length', () => {
    const leaf = [1, 2];
    checkBoth([leaf, leaf], [[1, 2], [1]], false);
});

test('deepEqual still rejects distinct self-referential objects', () => {
    /** @type {{self?: unknown}} */
    const lhs = {};
    /** @type {{self?: unknown}} */
    const rhs = {};
    lhs.self = lhs;
    rhs.self = rhs;
    checkBoth(lhs, rhs, false);
});

test('deepEqual still rejects distinct self-referential arrays', () => {
    /** @type {unknown[]} */
    const lhs = [];
    /** @type {unknown[]} */
    const rhs = [];
    lhs.push(lhs);
    rhs.push(rhs);
    checkBoth(lhs, rhs, false);
});

test('deepEqual still rejects distinct multi-node cycles', () => {
    /** @type {{next?: unknown}} */
    const lhs = {};
    /** @type {{next?: unknown}} */
    const rhs = {};
    lhs.next = {next: lhs};
    rhs.next = {next: rhs};
    checkBoth(lhs, rhs, false);
});

test('deepEqual does not confuse sharing with a cycle on the other side', () => {
    const leaf = {value: 1};
    /** @type {{a?: unknown, b?: unknown}} */
    const cyclic = {a: {value: 1}};
    cyclic.b = cyclic;
    checkBoth({a: leaf, b: leaf}, cyclic, false);
});

test('deepEqual retains the same-object fast path for a cyclic object', () => {
    /** @type {{self?: unknown}} */
    const value = {};
    value.self = value;
    checkBoth(value, value, true);
});

test('deepEqual retains primitive, shape, and ordinary-tree behavior', () => {
    checkBoth(null, null, true);
    checkBoth(null, {}, false);
    checkBoth(void 0, null, false);
    checkBoth(0, -0, true);
    checkBoth(Number.NaN, Number.NaN, false);
    checkBoth(1, '1', false);
    checkBoth({}, [], false);
    checkBoth([], [], true);
    checkBoth([1], [], false);
    checkBoth({a: [true, null]}, {a: [true, null]}, true);
    checkBoth({a: [true]}, {a: [false]}, false);
});

test('deepEqual remains symmetric for 1000 deterministic acyclic shared graphs', () => {
    let state = 0x5eed1234;
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    for (let run = 0; run < 1000; ++run) {
        /** @type {unknown[]} */
        const pool = [null, false, 1, '猫'];
        for (let i = 0; i < 12; ++i) {
            const a = pool[next() % pool.length];
            const b = pool[next() % pool.length];
            pool.push((next() & 1) === 0 ? [a, b, a] : {a, b, c: a});
        }
        const value = pool[pool.length - 1];
        checkBoth(value, clone(value), true);
    }
});
