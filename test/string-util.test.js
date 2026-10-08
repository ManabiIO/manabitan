/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {readCodePointsBackward, readCodePointsForward} from '../ext/js/data/string-util.js';

describe('Unicode code point scanner boundaries', () => {
    test.each([
        ['empty input', '', 0, 1],
        ['at end of text', '日本語', 3, 1],
        ['before start', '日本語', -1, 1],
        ['too far beyond end', 'abc', 100, 2],
        ['fractional index', 'abc', 0.5, 1],
        ['NaN index', 'abc', Number.NaN, 1],
        ['negative count', 'abc', 0, -1],
        ['zero count', 'abc', 0, 0],
    ])('returns empty for invalid forward range: %s', (_name, text, position, count) => {
        expect(readCodePointsForward(text, position, count)).toBe('');
    });

    test.each([
        ['empty input', '', 0, 1],
        ['before start', '日本語', -1, 1],
        ['at end', '日本語', 3, 1],
        ['too far beyond end', 'abc', 100, 2],
        ['fractional index', 'abc', 1.5, 1],
        ['NaN index', 'abc', Number.NaN, 1],
        ['negative count', 'abc', 2, -1],
        ['zero count', 'abc', 2, 0],
    ])('returns empty for invalid backward range: %s', (_name, text, position, count) => {
        expect(readCodePointsBackward(text, position, count)).toBe('');
    });

    test('preserves whole surrogate pairs and correct partial scans', () => {
        const text = 'A😀B猫';
        expect(readCodePointsForward(text, 0, 3)).toBe('A😀B');
        expect(readCodePointsForward(text, 1, 2)).toBe('😀B');
        expect(readCodePointsForward(text, 4, 3)).toBe('猫');
        expect(readCodePointsBackward(text, 4, 2)).toBe('B猫');
        expect(readCodePointsBackward(text, 3, 3)).toBe('A😀B');
        expect(readCodePointsBackward(text, 2, 1)).toBe('😀');
    });
});
