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

import {describe, expect, test} from 'vitest';
import {clone, deepEqual} from '../ext/js/core/utilities.js';

describe('clone own data properties', () => {
    test.each([
        {name: 'object', value: {enabled: true}},
        {name: 'null', value: null},
        {name: 'array', value: [{value: 1}]},
        {name: 'string', value: 'data'},
        {name: 'number', value: 42},
        {name: 'boolean', value: false},
        {name: 'undefined', value: undefined},
    ])('preserves an own __proto__ property containing $name', ({value}) => {
        const source = {before: 1, ['__proto__']: value, after: 2};
        const result = clone(source);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.keys(result)).toStrictEqual(['before', '__proto__', 'after']);
        expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toStrictEqual({
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
        expect(deepEqual(result, source)).toBe(true);
    });

    test('deep clones prototype-named payloads without creating inherited fields', () => {
        const payload = {enabled: true, nested: {value: 1}};
        const source = {['__proto__']: payload};
        const result = clone(source);
        const descriptor = Object.getOwnPropertyDescriptor(result, '__proto__');
        expect(descriptor?.value).not.toBe(payload);
        expect(Reflect.get(result, 'enabled')).toBe(undefined);
        expect(Reflect.get(Object.prototype, 'enabled')).toBe(undefined);
        payload.nested.value = 2;
        expect(descriptor?.value).toStrictEqual({enabled: true, nested: {value: 1}});
    });

    test('preserves nested prototype-named keys inside arrays and objects', () => {
        const source = {items: [{['__proto__']: {['__proto__']: {leaf: 'value'}}}]};
        const result = clone(source);
        expect(result).toStrictEqual(source);
        expect(result.items[0]).not.toBe(source.items[0]);
        expect(Object.getPrototypeOf(result.items[0])).toBe(Object.prototype);
    });

    test('preserves prototype-named data from null-prototype source objects', () => {
        const source = Object.create(null);
        Object.defineProperty(source, '__proto__', {value: {nested: 1}, enumerable: true});
        const result = clone(source);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toStrictEqual({
            value: {nested: 1},
            writable: true,
            enumerable: true,
            configurable: true,
        });
    });

    test('keeps other prototype-related property names as ordinary data', () => {
        const source = {constructor: {prototype: {value: 1}}, toString: 'text', hasOwnProperty: 'data'};
        expect(clone(source)).toStrictEqual(source);
    });

    test('continues ignoring inherited and non-enumerable keys', () => {
        const source = Object.create({inherited: true});
        Object.defineProperty(source, '__proto__', {value: {hidden: true}, enumerable: false});
        Object.defineProperty(source, 'visible', {value: 1, enumerable: true});
        expect(clone(source)).toStrictEqual({visible: 1});
    });

    test('preserves enumerable accessor evaluation exactly once', () => {
        let reads = 0;
        const source = {};
        Object.defineProperty(source, '__proto__', {
            enumerable: true,
            get() {
                ++reads;
                return {value: 1};
            },
        });
        const result = clone(source);
        expect(reads).toBe(1);
        expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toStrictEqual({value: 1});
    });

    test('still rejects a cycle through the prototype-named data property', () => {
        const source = {};
        Object.defineProperty(source, '__proto__', {value: source, enumerable: true});
        expect(() => clone(source)).toThrow('Circular');
    });

    test('shared sibling values remain cloneable and independently owned', () => {
        const shared = {value: 1};
        const source = {['__proto__']: shared, other: shared};
        const result = clone(source);
        expect(result).toStrictEqual(source);
        expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).not.toBe(result.other);
        expect(result.other).not.toBe(shared);
    });

    test('ordinary JSON-shaped data retains the existing deep-clone behavior', () => {
        const source = {value: [null, true, 1, 'text', {nested: 'value'}]};
        const result = clone(source);
        expect(result).toStrictEqual(source);
        expect(result).not.toBe(source);
        expect(result.value).not.toBe(source.value);
    });

    test('unsupported function values and ordinary cycles still throw', () => {
        expect(() => clone({value: () => {}})).toThrow('Cannot clone object of type function');
        /** @type {unknown[]} */
        const source = [];
        source.push(source);
        expect(() => clone(source)).toThrow('Circular');
    });
});
