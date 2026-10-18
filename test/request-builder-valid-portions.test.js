/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';

test.each([
    {name: 'one partially used buffer', items: [{array: [1, 2, 99], length: 2}], expected: [1, 2]},
    {name: 'oversized first backing buffer', items: [{array: [1, 2, 99, 99, 99], length: 2}, {array: [3], length: 1}], expected: [1, 2, 3]},
    {name: 'partially used final buffer', items: [{array: [1], length: 1}, {array: [2, 3, 99, 99], length: 2}], expected: [1, 2, 3]},
    {name: 'empty valid portion', items: [{array: [99, 99, 99], length: 0}, {array: [1], length: 1}], expected: [1]},
    {name: 'exact buffers', items: [{array: [1, 2], length: 2}, {array: [3], length: 1}], expected: [1, 2, 3]},
])('joins only valid bytes: $name', ({items, expected}) => {
    const buffers = items.map(({array, length}) => ({array: Uint8Array.from(array), length}));
    const originals = buffers.map(({array}) => Uint8Array.from(array));
    expect(RequestBuilder._joinUint8Arrays(buffers, expected.length)).toEqual(Uint8Array.from(expected));
    for (let i = 0; i < buffers.length; ++i) {
        expect(buffers[i].array).toEqual(originals[i]);
    }
});
