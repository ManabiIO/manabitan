/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {WeightedLruMap} from '../ext/js/core/weighted-lru-map.js';

describe('WeightedLruMap', () => {
    test('evicts by weight and promotes reads', () => {
        const cache = new WeightedLruMap(3, 6, (value) => String(value).length);
        cache.set('a', 'aaa');
        cache.set('b', 'bbb');
        expect(cache.get('a')).toBe('aaa');
        cache.set('c', 'ccc');
        expect(cache.has('b')).toBe(false);
        expect(cache.has('a')).toBe(true);
        expect(cache.has('c')).toBe(true);
        expect(cache.weight).toBe(6);
    });

    test('rejects an entry larger than the whole budget', () => {
        const cache = new WeightedLruMap(3, 2, (value) => String(value).length);
        cache.set('large', 'abc');
        expect(cache.size).toBe(0);
        expect(cache.weight).toBe(0);
    });

    test('updates and clears tracked weight', () => {
        const cache = new WeightedLruMap(3, 10, (value) => String(value).length);
        cache.set('a', 'a');
        cache.delete('a');
        cache.set('a', 'aaaa');
        expect(cache.weight).toBe(4);
        cache.clear();
        expect(cache.weight).toBe(0);
    });
});
