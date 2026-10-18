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
import {generateAnkiNoteMediaFileName, isNoteDataValid} from '../ext/js/data/anki-util.js';

describe('Anki note validation', () => {
    test('accepts a note with a non-empty fields object', () => {
        expect(isNoteDataValid(/** @type {any} */ ({
            deckName: 'Default',
            modelName: 'Basic',
            fields: {Front: 'text'},
        }))).toBe(true);
    });

    test.each([null, undefined, [], ['value'], 'value'])('rejects malformed fields: %s', (fields) => {
        expect(isNoteDataValid(/** @type {any} */ ({
            deckName: 'Default',
            modelName: 'Basic',
            fields,
        }))).toBe(false);
    });

    test('rejects empty field objects', () => {
        expect(isNoteDataValid(/** @type {any} */ ({
            deckName: 'Default',
            modelName: 'Basic',
            fields: {},
        }))).toBe(false);
    });
});

describe('Anki media filenames', () => {
    test('uses one-based UTC calendar months in January and December', () => {
        expect(generateAnkiNoteMediaFileName('audio', '.mp3', Date.UTC(2026, 0, 2, 3, 4, 5, 6))).toBe(
            'audio_2026-01-02-03-04-05-006.mp3',
        );
        expect(generateAnkiNoteMediaFileName('audio', '.mp3', Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(
            'audio_2026-12-31-23-59-59-999.mp3',
        );
    });
});
