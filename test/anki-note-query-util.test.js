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
import {createAnkiNoteDuplicateSearchDetails} from '../ext/js/data/anki-note-query-util.js';

/**
 * @param {{
 *   field?: string,
 *   fieldName?: string,
 *   fields?: Record<string, string>,
 *   deckName?: string,
 *   modelName?: string,
 *   duplicateScope?: import('settings').AnkiDuplicateScope,
 *   checkChildren?: boolean,
 *   checkAllModels?: boolean,
 * }} [overrides]
 * @returns {import('anki').Note}
 */
function createNote(overrides = {}) {
    const {
        field = 'value',
        fieldName = 'Front',
        fields = {[fieldName]: field},
        deckName = 'Deck',
        modelName = 'Model',
        duplicateScope = 'collection',
        checkChildren = false,
        checkAllModels = false,
    } = overrides;
    return {
        fields,
        tags: [],
        deckName,
        modelName,
        options: {
            allowDuplicate: false,
            duplicateScope,
            duplicateScopeOptions: {
                deckName: null,
                checkChildren,
                checkAllModels,
            },
        },
    };
}

describe('Anki duplicate search query escaping', () => {
    test.each([
        {name: 'quote', value: 'say "hi"', escaped: 'say \\"hi\\"'},
        {name: 'star', value: 'a*b', escaped: 'a\\*b'},
        {name: 'underscore', value: 'a_b', escaped: 'a\\_b'},
        {name: 'backslash', value: 'a\\\\b', escaped: 'a\\\\\\\\b'},
        {name: 'combined specials', value: 'a*_b\\\\c"d', escaped: 'a\\*\\_b\\\\\\\\c\\"d'},
        {name: 'space', value: 'a b', escaped: 'a b'},
        {name: 'parentheses', value: '(a)', escaped: '(a)'},
        {name: 'leading hyphen', value: '-a', escaped: '-a'},
        {name: 'colon', value: 'a:b', escaped: 'a\\:b'},
        {name: 'unicode', value: '猫😀', escaped: '猫😀'},
    ])('preserves literal primary-field $name', ({value, escaped}) => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({field: value}))?.query)
            .toBe(`"note:Model" "front:${escaped}"`);
    });

    test.each([
        {name: 'quote', value: 'Model "A"', escaped: 'Model \\"A\\"'},
        {name: 'star', value: 'Model*', escaped: 'Model\\*'},
        {name: 'underscore', value: 'Model_', escaped: 'Model\\_'},
        {name: 'backslash', value: 'Model\\\\A', escaped: 'Model\\\\\\\\A'},
    ])('preserves literal model-name $name', ({value, escaped}) => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({modelName: value}))?.query)
            .toBe(`"note:${escaped}" "front:value"`);
    });

    test.each([
        {name: 'plain', value: 'Parent', escaped: 'Parent'},
        {name: 'space', value: 'Parent Deck', escaped: 'Parent Deck'},
        {name: 'star', value: 'Parent*Deck', escaped: 'Parent\\*Deck'},
        {name: 'underscore', value: 'Parent_Deck', escaped: 'Parent\\_Deck'},
        {name: 'backslash', value: 'Parent\\\\Deck', escaped: 'Parent\\\\\\\\Deck'},
        {name: 'quote', value: 'Parent "Deck"', escaped: 'Parent \\"Deck\\"'},
    ])('keeps deck $name literal while excluding child decks', ({value, escaped}) => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({duplicateScope: 'deck', deckName: value}))?.query)
            .toBe(`"deck:${escaped}" -"deck:${escaped}::*" "note:Model" "front:value"`);
    });

    test('keeps the child wildcard intentional when child decks are excluded', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({
            duplicateScope: 'deck',
            deckName: 'Parent*Deck',
        }))?.query).toContain('-"deck:Parent\\*Deck::*"');
    });

    test('omits child exclusion when child decks are included', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({
            duplicateScope: 'deck',
            deckName: 'Parent*Deck',
            checkChildren: true,
        }))?.query).toBe('"deck:Parent\\*Deck" "note:Model" "front:value"');
    });

    test('normalizes deck-root scope without turning a literal star into a wildcard', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({
            duplicateScope: 'deck-root',
            deckName: 'Parent*::Child',
        }))?.query).toBe('"deck:Parent\\*" "note:Model" "front:value"');
    });

    test('omits the model constraint when all models are enabled', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({checkAllModels: true}))?.query)
            .toBe('"front:value"');
    });

    test('keeps the intentional any-value field wildcard', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({field: 'a*b_c\\\\d"e'}), 'any')?.query)
            .toBe('"note:Model" "front:*"');
    });

    test('collection scope does not add a deck constraint', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({deckName: 'Parent*Deck'}))?.query)
            .toBe('"note:Model" "front:value"');
    });

    test('supports an empty exact primary field', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({field: ''}))?.query)
            .toBe('"note:Model" "front:"');
    });

    test('rejects an empty model when the query requires one', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({modelName: ''}))).toBeNull();
    });

    test('rejects an empty deck for deck-scoped checks', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({duplicateScope: 'deck', deckName: ''}))).toBeNull();
    });

    test('rejects a note without a string primary field', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({fields: {}}))).toBeNull();
    });

    test('all-model mode permits an empty model name', () => {
        expect(createAnkiNoteDuplicateSearchDetails(createNote({modelName: '', checkAllModels: true}))?.query)
            .toBe('"front:value"');
    });
});
