/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createAnkiNoteDuplicateSearchDetails} from '../../ext/js/data/anki-note-query-util.js'

/**
 * @param {string} field
 * @param {string} value
 * @returns {import('anki').Note}
 */
function createNote(field, value) {
    return {
        fields: {[field]: value},
        tags: [],
        deckName: 'Deck',
        modelName: 'Model',
        options: {
            allowDuplicate: false,
            duplicateScope: 'collection',
            duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: false},
        },
    }
}

// These are query-generation contracts, not a substitute for Anki's search engine.
// Anki parse_single_field checks re:/nc: BEFORE normal-mode unescaping.
for (const [value, escaped] of [
    ['re:cat', 're\\:cat'],
    ['re:[', 're\\:['],
    ['re:^cat$', 're\\:^cat$'],
    ['nc:は', 'nc\\:は'],
    ['nc:', 'nc\\:'],
    ['RE:cat', 'RE\\:cat'],
    ['re\\:cat', 're\\\\\\:cat'],
    ['a:b:c', 'a\\:b\\:c'],
    ['猫', '猫'],
    ['a*b_c', 'a\\*b\\_c'],
    ['say "hi"', 'say \\"hi\\"'],
    ['', ''],
]) {
    test(`keeps literal field value ${JSON.stringify(value)}`, () => {
        const details = createAnkiNoteDuplicateSearchDetails(createNote('Front', value))
        assert.ok(details)
        assert.equal(details.query, `"note:Model" "front:${escaped}"`)
        assert.equal(details.fieldValue, value)
    })
}

for (const [field, escaped] of [
    ['Front*', 'front\\*'],
    ['Front_', 'front\\_'],
    ['Front"Name', 'front\\"name'],
    ['Front\\Name', 'front\\\\name'],
    ['Front:Part', 'front\\:part'],
    ['Front Name', 'front name'],
    ['(Front)', '(front)'],
    ['-Front', '-front'],
]) {
    for (const mode of /** @type {const} */ (['exact', 'any'])) {
        test(`escapes selector ${JSON.stringify(field)} in ${mode} mode`, () => {
            const details = createAnkiNoteDuplicateSearchDetails(createNote(field, 'value'), mode)
            assert.ok(details)
            assert.equal(details.query, `"note:Model" "${escaped}:${mode === 'any' ? '*' : 'value'}"`)
            assert.equal(details.fieldName, field)
            assert.equal(details.fieldNameLower, field.toLowerCase())
        })
    }
}

test('nested literal decks retain only the intentionally added child wildcard', () => {
    const note = createNote('Front', 're:cat')
    note.deckName = 'Parent*::Child_Name'
    note.options.duplicateScope = 'deck'
    const details = createAnkiNoteDuplicateSearchDetails(note)
    assert.ok(details)
    assert.equal(details.query, '"deck:Parent\\*\\:\\:Child\\_Name" -"deck:Parent\\*\\:\\:Child\\_Name::*" "note:Model" "front:re\\:cat"')
    assert.equal(details.deckName, note.deckName)
})

test('root-deck scope still derives the root before escaping', () => {
    const note = createNote('Front', 'cat')
    note.deckName = 'Parent*::Child'
    note.options.duplicateScope = 'deck-root'
    assert.equal(createAnkiNoteDuplicateSearchDetails(note)?.query, '"deck:Parent\\*" "note:Model" "front:cat"')
})

test('all-model any-field mode keeps one intentional wildcard', () => {
    const note = createNote('Front*', 're:.*')
    note.options.duplicateScopeOptions.checkAllModels = true
    assert.equal(createAnkiNoteDuplicateSearchDetails(note, 'any')?.query, '"front\\*:*"')
})
