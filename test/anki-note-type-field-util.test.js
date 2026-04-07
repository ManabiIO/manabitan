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
import {buildAnkiFieldsForModel} from '../ext/js/data/anki-note-type-field-util.js';

describe('buildAnkiFieldsForModel', () => {
    test('builds the Kiku preset and blanks unspecified fields', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Kiku',
            fieldNames: ['Expression', 'MainDefinition', 'Sentence', 'Mystery'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-frequency-number-a', 'single-glossary-primary'],
        });

        expect(fields).toStrictEqual({
            Expression: {value: '{expression}', overwriteMode: 'coalesce'},
            MainDefinition: {value: '{single-glossary-primary}', overwriteMode: 'coalesce'},
            Sentence: {value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', overwriteMode: 'coalesce'},
            Mystery: {value: '', overwriteMode: 'coalesce'},
        });
    });

    test('builds the Lapis preset', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Lapis',
            fieldNames: ['ExpressionReading', 'SelectionText', 'PitchCategories', 'MiscInfo'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-glossary-primary'],
        });

        expect(fields).toStrictEqual({
            ExpressionReading: {value: '{reading}', overwriteMode: 'coalesce'},
            SelectionText: {value: '{popup-selection-text}', overwriteMode: 'coalesce'},
            PitchCategories: {value: '{pitch-accent-categories}', overwriteMode: 'coalesce'},
            MiscInfo: {value: '{document-title}', overwriteMode: 'coalesce'},
        });
    });

    test('builds the Senren preset', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Senren・洗練',
            fieldNames: ['word', 'sentence', 'definition', 'pitchAccents', 'dictionaryPreference'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-frequency-number-a', 'single-glossary-primary', 'single-glossary-secondary'],
        });

        expect(fields).toStrictEqual({
            word: {value: '{expression}', overwriteMode: 'coalesce'},
            sentence: {value: '<span class="group">{cloze-prefix}<span class="highlight">{cloze-body}</span>{cloze-suffix}</span>', overwriteMode: 'coalesce'},
            definition: {value: '{single-glossary-primary}', overwriteMode: 'coalesce'},
            pitchAccents: {value: '{pitch-accents}', overwriteMode: 'coalesce'},
            dictionaryPreference: {value: '', overwriteMode: 'coalesce'},
        });
    });

    test('builds the Crop Theft Vocab preset', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Crop Theft Vocab',
            fieldNames: ['Word', 'Definition', 'Example Sentence', 'Example Target', 'Notes'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-glossary-primary'],
        });

        expect(fields).toStrictEqual({
            Word: {value: '{expression}', overwriteMode: 'coalesce'},
            Definition: {value: '{glossary-brief}', overwriteMode: 'coalesce'},
            'Example Sentence': {value: '{sentence}', overwriteMode: 'coalesce'},
            'Example Target': {value: '{search-query}', overwriteMode: 'coalesce'},
            Notes: {value: '', overwriteMode: 'coalesce'},
        });
    });

    test('uses the legacy heuristic for unknown models', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Custom Model',
            fieldNames: ['Front', 'Reading', 'Meaning'],
            dictionaryEntryType: 'term',
            oldFields: {
                Reading: {value: 'existing-reading', overwriteMode: 'skip'},
            },
        });

        expect(fields).toStrictEqual({
            Front: {value: '{expression}', overwriteMode: 'coalesce'},
            Reading: {value: 'existing-reading', overwriteMode: 'coalesce'},
            Meaning: {value: '{glossary}', overwriteMode: 'coalesce'},
        });
    });

    test('uses the first available single glossary marker for primary dictionary fields', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Lapis',
            fieldNames: ['MainDefinition'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-frequency-number-a', 'single-glossary-first', 'single-glossary-second'],
        });

        expect(fields.MainDefinition.value).toBe('{single-glossary-first}');
    });

    test('leaves primary dictionary fields blank when no single glossary marker is available', () => {
        const fields = buildAnkiFieldsForModel({
            modelName: 'Senren',
            fieldNames: ['definition'],
            dictionaryEntryType: 'term',
            dynamicFieldMarkers: ['single-frequency-number-a'],
        });

        expect(fields.definition.value).toBe('');
    });
});
