/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {readCodePointsBackward, readCodePointsForward} from '../ext/js/data/string-util.js';

describe('String code point readers', () => {
    test('empty strings never produce the literal "undefined"', () => {
        expect(readCodePointsForward('', 0, 1)).toBe('');
        expect(readCodePointsBackward('', 0, 1)).toBe('');
        expect(readCodePointsForward('', -1, 3)).toBe('');
        expect(readCodePointsBackward('', -1, 3)).toBe('');
    });

    test('out-of-range offsets return empty reads in both directions', () => {
        for (const offset of [-10, -1, 3, 4, 100]) {
            expect(readCodePointsForward('abc', offset, 2)).toBe('');
            expect(readCodePointsBackward('abc', offset, 2)).toBe('');
        }
    });

    test('fractional offsets are not used as string indices', () => {
        expect(readCodePointsForward('abc', 1.5, 1)).toBe('');
        expect(readCodePointsBackward('abc', 1.5, 1)).toBe('');
    });

    test('zero and negative count always return an empty string', () => {
        expect(readCodePointsForward('abc', 0, 0)).toBe('');
        expect(readCodePointsForward('abc', 0, -2)).toBe('');
        expect(readCodePointsBackward('abc', 2, 0)).toBe('');
        expect(readCodePointsBackward('abc', 2, -2)).toBe('');
    });

    test('valid forward reads preserve UTF-16 surrogate pairs as one code point', () => {
        const text = 'A𠮷B';
        expect(readCodePointsForward(text, 0, 1)).toBe('A');
        expect(readCodePointsForward(text, 1, 1)).toBe('𠮷');
        expect(readCodePointsForward(text, 1, 2)).toBe('𠮷B');
        expect(readCodePointsForward(text, 0, 10)).toBe(text);
    });

    test('valid backward reads preserve UTF-16 surrogate pairs as one code point', () => {
        const text = 'A𠮷B';
        expect(readCodePointsBackward(text, 3, 1)).toBe('B');
        expect(readCodePointsBackward(text, 2, 1)).toBe('𠮷');
        expect(readCodePointsBackward(text, 2, 2)).toBe('A𠮷');
        expect(readCodePointsBackward(text, 3, 10)).toBe(text);
    });
});
