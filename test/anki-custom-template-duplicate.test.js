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

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js';
import {TemplateRenderer} from '../ext/js/templates/template-renderer.js';

const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ext/data/templates/default-anki-field-templates.handlebars');
const defaultTemplate = readFileSync(templatePath, 'utf8');

function createBuilder() {
    const renderer = new TemplateRenderer();
    renderer.registerDataType('ankiNote', {
        modifier: ({marker, commonData}) => createAnkiNoteData(marker, commonData),
        composeData: ({marker}, commonData) => ({marker, commonData}),
    });
    renderer.setRenderCallbacks(() => ({requirements: []}), null);
    return new AnkiNoteBuilder({
        injectAnkiNoteMedia: async () => ({
            screenshotFileName: null,
            clipboardImageFileName: null,
            clipboardText: null,
            audioFileName: null,
            dictionaryMedia: [],
            errors: [],
        }),
        parseText: async () => [],
    }, renderer);
}

const context = {url: 'chrome-extension://test/search.html', sentence: {text: '読む', offset: 0}, documentTitle: 'title', query: '読む', fullQuery: '読む'};
const term = /** @type {import('dictionary').DictionaryEntry} */ ({
    type: 'term',
    isPrimary: true,
    textProcessorRuleChainCandidates: [],
    inflectionRuleChainCandidates: [],
    score: 0,
    frequencyOrder: 0,
    dictionaryIndex: 0,
    dictionaryAlias: 'fixture',
    sourceTermExactMatchCount: 1,
    matchPrimaryReading: true,
    maxOriginalTextLength: 2,
    headwords: [{index: 0, headwordIndex: 0, term: '読む', reading: 'よむ', sources: [{originalText: '読む', transformedText: '読む', deinflectedText: '読む', matchType: 'exact', matchSource: 'term', isPrimary: true}], tags: [], wordClasses: []}],
    definitions: [{index: 0, headwordIndices: [0], dictionary: 'fixture', dictionaryIndex: 0, dictionaryAlias: 'fixture', id: 1, score: 0, frequencyOrder: 0, sequences: [-1], isPrimary: true, tags: [], entries: ['to read']}],
    pronunciations: [],
    frequencies: [],
});
const kanji = /** @type {import('dictionary').DictionaryEntry} */ (/** @type {unknown} */ ({type: 'kanji', character: '字', dictionary: 'fixture', dictionaryAlias: 'fixture', dictionaryIndex: 0, onyomi: ['ジ'], kunyomi: ['あざ'], tags: [], stats: [], frequencies: [], definitions: ['character']}));

/**
 * @param {import('dictionary').DictionaryEntry} entry
 * @param {string} fieldValue
 * @param {string} template
 * @returns {import('anki-note-builder').CreateNoteDetails}
 */
function details(entry, fieldValue, template) {
    return /** @type {import('anki-note-builder').CreateNoteDetails} */ ({
        dictionaryEntry: entry,
        cardFormat: {type: entry.type, name: 'fixture', deck: 'Qualification::Probe', model: 'Qualification Probe', fields: {Front: {value: fieldValue, overwriteMode: 'overwrite'}}, icon: 'big-circle'},
        context,
        template,
        tags: [],
        requirements: [],
        duplicateScope: 'collection',
        duplicateScopeCheckAllModels: false,
        resultOutputMode: 'split',
        glossaryLayoutMode: 'default',
        compactTags: false,
        mediaOptions: null,
        dictionaryStylesMap: new Map(),
    });
}

describe('custom Anki field template duplicate probes', () => {
    test.each([
        ['term expression', term, '{expression}', 'expression', 'CUSTOM-EXPRESSION'],
        ['kanji character', kanji, '{character}', 'character', 'CUSTOM-CHARACTER'],
    ])('renders the configured %s first field for duplicate checks', async (_label, entry, firstField, partial, prefix) => {
        const builder = createBuilder();
        const template = `${defaultTemplate}\n\n{{#*inline "${partial}"}}${prefix}[{{definition.${partial}}}]{{/inline}}\n`;
        const noteDetails = details(/** @type {import('dictionary').DictionaryEntry} */ (entry), /** @type {string} */ (firstField), template);
        const saved = await builder.createNote(noteDetails);
        const duplicate = await builder.createDuplicateCheckNote(noteDetails);
        expect(saved.errors).toStrictEqual([]);
        expect(saved.requirements).toStrictEqual([]);
        expect(saved.note.fields.Front).toMatch(new RegExp(`^${prefix}\\[`));
        expect(duplicate.fields.Front).toBe(saved.note.fields.Front);
        expect(builder.createDuplicateCheckNoteFast(noteDetails)).toBeNull();
    });

    test('keeps the default marker shortcut opt-in and preserves literal fields', async () => {
        const builder = createBuilder();
        const defaultDetails = details(term, '{expression}', defaultTemplate);
        const saved = await builder.createNote(defaultDetails);
        const duplicate = await builder.createDuplicateCheckNote(defaultDetails);
        expect(saved.errors).toStrictEqual([]);
        expect(duplicate.fields.Front).toBe(saved.note.fields.Front);
        expect(builder.createDuplicateCheckNoteFast({...defaultDetails, allowStandardFieldMarkerFastPath: true})?.fields.Front).toBe(saved.note.fields.Front);

        const literalDetails = details(term, 'literal-front-control', defaultTemplate);
        expect(builder.createDuplicateCheckNoteFast(literalDetails)?.fields.Front).toBe('literal-front-control');
    });
});
