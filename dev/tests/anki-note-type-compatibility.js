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

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseJson} from '../../ext/js/core/json.js';
import {buildAnkiFieldsForModel} from '../../ext/js/data/anki-note-type-field-util.js';
import {checkModel, checkReport, contracts} from '../anki-note-type-compatibility.js';

const snapshot = /** @type {import('../anki-note-type-compatibility.js').UpstreamReport} */ (parseJson(readFileSync(new URL('../../test/data/anki-note-types/upstream-snapshot.json', import.meta.url), 'utf8')));

for (const contract of contracts) {
    void test(`${contract.id}: every field from the real downloaded package`, () => {
        const result = snapshot.results.find(({id}) => id === contract.id);
        const model = result?.models?.find(({name}) => contract.modelNames.includes(name));
        assert.ok(model);
        checkModel(contract, model);
        for (const name of contract.modelNames) {
            checkModel(contract, {...model, name});
        }
    });
}

void test('complete report includes unrelated models without selecting the first one', () => {
    checkReport(snapshot);
});

void test('Kiku sentence furigana differs from Lapis; no unavailable media or translations are invented', () => {
    const fieldNames = ['Expression', 'SentenceFurigana', 'SentenceTranslation', 'RelatedExpression', 'SentenceAudio', 'Picture', 'IsAudioCard'];
    for (const [modelName, expected] of [['Kiku', '{sentence-furigana-plain}'], ['Lapis', '']]) {
        const fields = buildAnkiFieldsForModel({modelName, fieldNames, dictionaryEntryType: 'term'});
        assert.equal(fields.SentenceFurigana.value, expected);
        for (const name of fieldNames.slice(2)) {
            assert.equal(fields[name].value, '');
        }
    }
});

void test('recognized names normalize Unicode, punctuation, whitespace and case', () => {
    for (const modelName of ['Ｋｉｋｕ', '  KIKU ', 'kiku']) {
        const fields = buildAnkiFieldsForModel({modelName, fieldNames: ['Expression', 'SentenceFurigana'], dictionaryEntryType: 'term'});
        assert.equal(fields.SentenceFurigana.value, '{sentence-furigana-plain}');
    }
    const fields = buildAnkiFieldsForModel({modelName: ' SENREN・洗練 ', fieldNames: ['word', 'sentence'], dictionaryEntryType: 'term'});
    assert.ok(fields.sentence.value.includes('class="group"'));
});

void test('custom names are not mistaken for the known preset; kanji never gets a term preset', () => {
    const fieldNames = ['Front', 'SentenceFurigana'];
    for (const modelName of ['My Kiku', 'Kiku 2.1.0', 'Kikura']) {
        const fields = buildAnkiFieldsForModel({modelName, fieldNames, dictionaryEntryType: 'term'});
        assert.equal(fields.SentenceFurigana.value, '{sentence-furigana}');
    }
    const fields = buildAnkiFieldsForModel({modelName: 'Kiku', fieldNames, dictionaryEntryType: 'kanji'});
    assert.equal(fields.Front.value, '{character}');
    assert.equal(fields.SentenceFurigana.value, '{sentence-furigana}');
});

void test('primary definitions use the first available glossary, not a frequency or invented dictionary', () => {
    for (const [modelName, fieldName] of [['Kiku', 'MainDefinition'], ['Lapis', 'MainDefinition'], ['Senren', 'definition']]) {
        for (const markers of [[], ['single-frequency-number-only']]) {
            const fields = buildAnkiFieldsForModel({modelName, fieldNames: [fieldName], dictionaryEntryType: 'term', dynamicFieldMarkers: markers});
            assert.equal(fields[fieldName].value, '');
        }
        const fields = buildAnkiFieldsForModel({modelName, fieldNames: [fieldName], dictionaryEntryType: 'term', dynamicFieldMarkers: ['single-frequency-number-only', 'single-glossary-second', 'single-glossary-third']});
        assert.equal(fields[fieldName].value, '{single-glossary-second}');
    }
});

void test('field names remain exact and unrecognized preset fields stay blank', () => {
    const fields = buildAnkiFieldsForModel({modelName: 'Kiku', fieldNames: ['Expression', 'expression', 'CustomField'], dictionaryEntryType: 'term'});
    assert.equal(fields.Expression.value, '{expression}');
    assert.equal(fields.expression.value, '');
    assert.equal(fields.CustomField.value, '');
});

void test('generic mapping preserves same-named values and the existing coalesce policy', () => {
    const oldFields = {Reading: {value: 'custom-reading', overwriteMode: /** @type {const} */ ('skip')}};
    const fields = buildAnkiFieldsForModel({modelName: 'Custom', fieldNames: ['Front', 'Reading', 'Meaning', 'Word Audio', 'Example_Sentence'], dictionaryEntryType: 'term', oldFields});
    assert.equal(fields.Front.value, '{expression}');
    assert.deepEqual(fields.Reading, {value: 'custom-reading', overwriteMode: 'coalesce'});
    assert.equal(fields.Meaning.value, '{glossary}');
    assert.equal(fields['Word Audio'].value, '{audio}');
    assert.equal(fields.Example_Sentence.value, '{sentence}');
    assert.equal(oldFields.Reading.overwriteMode, 'skip');
});

void test('arbitrary Anki field names survive serialization without modifying the object prototype', () => {
    for (const modelName of ['Custom', 'Kiku']) {
        const fieldNames = ['Front', '__proto__', 'constructor', 'hasOwnProperty'];
        const fields = buildAnkiFieldsForModel({modelName, fieldNames, dictionaryEntryType: 'term'});
        assert.deepEqual(Object.keys(fields), fieldNames);
        assert.equal(Object.getPrototypeOf(fields), Object.prototype);
        assert.deepEqual(Object.keys(/** @type {Record<string, unknown>} */ (parseJson(JSON.stringify(fields)))), fieldNames);
    }
});

void test('schema drift is detected for added, missing, renamed and duplicate fields', () => {
    const contract = contracts[0];
    const fields = Object.keys(contract.expected);
    for (const changed of [[...fields, 'NewField'], fields.slice(1), ['RenamedExpression', ...fields.slice(1)], [...fields, fields[0]]]) {
        assert.throws(() => checkModel(contract, {name: 'Kiku', fields: changed}));
    }
});

void test('first-field changes fail even when the set of fields is unchanged', () => {
    const contract = contracts[0];
    const fields = Object.keys(contract.expected);
    assert.throws(() => checkModel(contract, {name: 'Kiku', fields: [...fields.slice(1), fields[0]]}), /first field/);
});

void test('a wrong semantic mapping fails even when the schema still matches', () => {
    const contract = contracts[0];
    const changed = {...contract, expected: {...contract.expected, Expression: '{reading}'}};
    assert.throws(() => checkModel(changed, {name: 'Kiku', fields: Object.keys(changed.expected)}), /incorrect field mapping/);
});

void test('a failed download, missing model or duplicate model is not a compatibility pass', () => {
    const valid = {name: 'Kiku', fields: Object.keys(contracts[0].expected)};
    for (const replacement of [
        {id: 'kiku', status: 'error', error: 'Network unavailable'},
        {id: 'kiku', status: 'downloaded', models: [{name: 'Basic', fields: ['Front', 'Back']}]},
        {id: 'kiku', status: 'downloaded', models: [valid, valid]},
    ]) {
        assert.throws(() => checkReport({results: [replacement, ...snapshot.results.slice(1)]}), AggregateError);
    }
});

void test('missing and duplicate report entries fail', () => {
    assert.throws(() => checkReport({results: snapshot.results.slice(1)}));
    assert.throws(() => checkReport({results: [snapshot.results[0], ...snapshot.results.slice(0, 3)]}));
