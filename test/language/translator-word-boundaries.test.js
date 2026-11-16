/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {Translator} from '../../ext/js/language/translator.js';

test.each(/** @type {[language: string, source: string, term: string, shouldMatch: boolean][]} */ ([
    ['hi', 'कामिनी', 'काम', false],
    ['en', 'a\u0301bc', 'a', false],
    ['hi', 'काम अज्ञात', 'काम', true],
    ['en', 'word unknown', 'word', true],
]))('word-resolution lookup preserves marks in %s: %s', async (language, source, term, shouldMatch) => {
    const dictionary = 'Word boundary fixture';
    const translator = new Translator(/** @type {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
        /**
         * @param {string[]} queries
         * @returns {Promise<import('dictionary-database').TermEntry[]>}
         */
        async findTermsBulk(queries) {
            return queries.flatMap((query, index) => {
                if (query !== term) { return []; }
                return [{
                    index,
                    matchType: /** @type {const} */ ('exact'),
                    matchSource: /** @type {const} */ ('term'),
                    term,
                    reading: '',
                    definitionTags: [],
                    termTags: [],
                    rules: [],
                    definitions: ['A complete dictionary word'],
                    score: 1,
                    dictionary,
                    id: 1,
                    sequence: -1,
                }];
            });
        },
    })));
    translator.prepare();
    const result = await translator.findTerms('simple', source, {
        matchType: 'exact',
        deinflect: true,
        mainDictionary: dictionary,
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'descending',
        removeNonJapaneseCharacters: false,
        primaryReading: '',
        textReplacements: [null],
        excludeDictionaryDefinitions: null,
        searchResolution: 'word',
        language,
        useAllFrequencyDictionaries: false,
        enabledDictionaryMap: new Map([[dictionary, {
            index: 0, alias: dictionary, allowSecondarySearches: false, partsOfSpeechFilter: false, useDeinflections: true,
        }]]),
    });

    expect(result.dictionaryEntries.map(({headwords}) => headwords[0].term)).toEqual(shouldMatch ? [term] : []);
    expect(result.originalTextLength).toBe(shouldMatch ? term.length : 0);
});
