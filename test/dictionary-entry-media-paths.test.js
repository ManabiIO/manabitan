/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {getDictionaryEntryMedia} from '../ext/js/pages/settings/anki-deck-generator-controller.js';

const schema = new JsonSchema(/** @type {import('ext/json-schema').Schema} */ (JSON.parse(readFileSync(new URL('../ext/data/schemas/dictionary-term-bank-v3-schema.json', import.meta.url), 'utf8'))));

/**
 * @param {string} dictionary
 * @param {import('dictionary-data').TermGlossaryContent[]} entries
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function entry(dictionary, entries) {
    return /** @type {import('dictionary').TermDictionaryEntry} */ ({
        type: 'term',
        headwords: [{term: '語', reading: 'ご'}],
        definitions: [{dictionary, entries}],
    });
}

describe('dictionary-entry image media paths', () => {
    test.each(['images/cat.png', 'images/"cat".png', 'images/slash\\cat.png', 'images/line\ncat.png', 'images/猫😀.png'])('preserves the exact path %j', (path) => {
        /** @type {import('dictionary-data').TermGlossaryContent[]} */
        const glossary = [
            {type: 'image', path, width: 1, height: 1},
            {type: 'structured-content', content: {tag: 'span', content: {tag: 'img', path}}},
        ];
        expect(() => schema.validate([['語', 'ご', '', '', 0, glossary, 1, '']])).not.toThrow();
        const result = getDictionaryEntryMedia(entry('Images', glossary));
        expect(result).toEqual([{type: 'dictionaryMedia', dictionary: 'Images', path}]);
    });

    test('ignores unrelated path data and glossary strings', () => {
        const result = getDictionaryEntryMedia(entry('Images', [
            'A literal description: {"path":"not-media.png"}',
            {
                type: 'structured-content',
                content: [
                    {
                        tag: 'span',
                        data: {path: 'not-media.png'},
                        content: 'text',
                    },
                    {tag: 'img', path: 'actual.png', data: {path: 'also-not-media.png'}},
                ],
            },
        ]));
        expect(result).toEqual([{type: 'dictionaryMedia', dictionary: 'Images', path: 'actual.png'}]);
    });

    test('preserves traversal order and dictionary identity', () => {
        const first = entry('First', [{type: 'structured-content', content: [{tag: 'img', path: 'a.png'}, {tag: 'span', content: [{tag: 'img', path: 'b.png'}, {tag: 'img', path: 'a.png'}]}]}]);
        const second = entry('Second', [{type: 'image', path: 'a.png', width: 1, height: 1}]);
        first.definitions.push(...second.definitions);
        expect(getDictionaryEntryMedia(first)).toEqual([
            {type: 'dictionaryMedia', dictionary: 'First', path: 'a.png'},
            {type: 'dictionaryMedia', dictionary: 'First', path: 'b.png'},
            {type: 'dictionaryMedia', dictionary: 'Second', path: 'a.png'},
        ]);
    });

    test('kanji definitions have no image requirements', () => {
        expect(getDictionaryEntryMedia(/** @type {import('dictionary').KanjiDictionaryEntry} */ ({type: 'kanji', definitions: ['plain text']}))).toEqual([]);
    });
});
