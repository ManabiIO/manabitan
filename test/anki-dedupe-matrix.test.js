/*
 * Copyright (C) 2026  Yomitan Authors
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
import {isExpectedWriteResult} from './e2e/anki-dedupe-matrix.js';

describe('Anki dedupe write result oracle', () => {
    test('requires the expected successful add or update response', () => {
        expect(isExpectedWriteResult('addNote', [{action: 'addNote', error: null, result: 123}])).toBe(true);
        expect(isExpectedWriteResult('updateNoteFields', [{action: 'updateNoteFields', error: null, result: null}])).toBe(true);
        expect(isExpectedWriteResult('addNote', [{action: 'addNote', error: 'Anki rejected the note', result: null}])).toBe(false);
        expect(isExpectedWriteResult('addNote', [{action: 'addNote', error: null, result: 0}])).toBe(false);
        expect(isExpectedWriteResult('addNote', [{action: 'addNote', error: null, result: Number.MAX_SAFE_INTEGER + 1}])).toBe(false);
        expect(isExpectedWriteResult('updateNoteFields', [{action: 'updateNoteFields', error: null, result: false}])).toBe(false);
    });

    test('rejects missing, duplicate, unexpected, and failed writes for no-write expectations', () => {
        expect(isExpectedWriteResult('addNote', [])).toBe(false);
        expect(isExpectedWriteResult('updateNoteFields', [])).toBe(false);
        expect(isExpectedWriteResult('addNote', [
            {action: 'addNote', error: null, result: 123},
            {action: 'addNote', error: 'duplicate', result: null},
        ])).toBe(false);
        expect(isExpectedWriteResult('addNote', [
            {action: 'addNote', error: null, result: 123},
            {action: 'updateNoteFields', error: null, result: null},
        ])).toBe(false);
        expect(isExpectedWriteResult('none', [])).toBe(true);
        expect(isExpectedWriteResult('none', [{action: 'addNote', error: 'rejected', result: null}])).toBe(false);
    });
});
