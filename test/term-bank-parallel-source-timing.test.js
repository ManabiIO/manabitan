/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {expect, test} from 'vitest';
import {getMaximumNumericProperty, getParallelSourceReadWallMs} from '../ext/js/dictionary/term-bank-wasm-parser.js';

test('parallel source wall timing preserves ordinary timing semantics', () => {
    expect(getParallelSourceReadWallMs([], 100)).toBe(0);
    expect(getParallelSourceReadWallMs([
        {resolvedAt: 90},
        {resolvedAt: 140},
        {resolvedAt: 120},
    ], 100)).toBe(40);
    expect(getParallelSourceReadWallMs([{resolvedAt: Number.NaN}], 100)).toBe(Number.NaN);
});

test('parallel source wall timing supports source counts above function argument limits', () => {
    const sourceCount = 130_000;
    const startedAt = 1_000;
    const sources = Array.from({length: sourceCount}, (_, index) => ({
        resolvedAt: startedAt + (index % 10_001),
    }));
    expect(getParallelSourceReadWallMs(sources, startedAt)).toBe(10_000);
});

test('profile maxima support profile counts above function argument limits', () => {
    const profiles = Array.from({length: 130_000}, (_, index) => ({
        maxWasmHeapBytes: index % 65_537,
    }));
    expect(getMaximumNumericProperty(profiles, 'maxWasmHeapBytes')).toBe(65_536);
});
