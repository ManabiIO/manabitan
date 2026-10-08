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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test} from 'vitest';
import {readCodePointsBackward, readCodePointsForward} from '../ext/js/data/string-util.js';

describe('code-point readers', () => {
    test('out-of-bounds positions return empty text rather than an undefined suffix or exception', () => {
        for (const value of ['', 'abc', '🐈cat']) {
            const length = value.length;
            for (const position of [-1, length, length + 1, 1.5, Number.NaN]) {
                expect(readCodePointsForward(value, position, 2)).toBe('');
                expect(readCodePointsBackward(value, position, 2)).toBe('');
            }
        }
    });

    test('valid code-point reads preserve surrogate pairs and count bounds', () => {
        const text = 'a🐈文b';
        expect(readCodePointsForward(text, 1, 2)).toBe('🐈文');
        expect(readCodePointsBackward(text, 3, 2)).toBe('🐈文');
        expect(readCodePointsForward(text, 0, 0)).toBe('');
        expect(readCodePointsBackward(text, 4, 0)).toBe('');
        expect(readCodePointsForward(text, 0, 10)).toBe(text);
        expect(readCodePointsBackward(text, text.length - 1, 10)).toBe(text);
    });
});
