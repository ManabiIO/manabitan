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
import {ObjectPropertyAccessor} from '../ext/js/general/object-property-accessor.js';

describe('ObjectPropertyAccessor prototype-named data properties', () => {
    test.each([
        {name: 'object', value: {enabled: true}},
        {name: 'null', value: null},
        {name: 'array', value: [1, 2]},
        {name: 'string', value: 'data'},
        {name: 'number', value: 42},
        {name: 'boolean', value: false},
        {name: 'undefined', value: undefined},
    ])('sets a new own __proto__ property containing $name', ({value}) => {
        const target = {};
        const accessor = new ObjectPropertyAccessor(target);
        accessor.set(['__proto__'], value);

        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(target, '__proto__')).toStrictEqual({
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
        expect(accessor.get(['__proto__'])).toBe(value);
    });

    test('sets a nested prototype-named property without changing the nested prototype', () => {
        const target = {nested: {value: 1}};
        const nestedPrototype = Object.getPrototypeOf(target.nested);
        const value = {enabled: true};
        const accessor = new ObjectPropertyAccessor(target);

        accessor.set(['nested', '__proto__'], value);

        expect(Object.getPrototypeOf(target.nested)).toBe(nestedPrototype);
        expect(accessor.get(['nested', '__proto__'])).toBe(value);
        expect(Reflect.get(target.nested, 'enabled')).toBe(undefined);
    });

    test('supports null-prototype objects', () => {
        const target = Object.create(null);
        const accessor = new ObjectPropertyAccessor(target);
        accessor.set(['__proto__'], {value: 1});

        expect(Object.getPrototypeOf(target)).toBeNull();
        expect(Object.getOwnPropertyDescriptor(target, '__proto__')?.value).toStrictEqual({value: 1});
    });

    test('updates an existing own prototype-named data property normally', () => {
        const target = {['__proto__']: {before: true}};
        const accessor = new ObjectPropertyAccessor(target);
        const value = {after: true};

        accessor.set(['__proto__'], value);

        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
        expect(accessor.get(['__proto__'])).toBe(value);
    });

    test('swap preserves prototypes when both prototype-named paths are own data', () => {
        const left = {['__proto__']: {side: 'left'}};
        const right = {['__proto__']: {side: 'right'}};
        const root = {left, right};
        const accessor = new ObjectPropertyAccessor(root);
        const leftPrototype = Object.getPrototypeOf(left);
        const rightPrototype = Object.getPrototypeOf(right);

        accessor.swap(['left', '__proto__'], ['right', '__proto__']);

        expect(Object.getPrototypeOf(left)).toBe(leftPrototype);
        expect(Object.getPrototypeOf(right)).toBe(rightPrototype);
        expect(accessor.get(['left', '__proto__'])).toStrictEqual({side: 'right'});
        expect(accessor.get(['right', '__proto__'])).toStrictEqual({side: 'left'});
    });

    test('ordinary new property assignment retains existing behavior', () => {
        const target = {};
        const accessor = new ObjectPropertyAccessor(target);
        const value = {ordinary: true};

        accessor.set(['value'], value);

        expect(accessor.get(['value'])).toBe(value);
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    });
});
