/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {Translator} from '../../ext/js/language/translator.js';

const dictionary = 'Unicode Japanese';

/**
 * @param {string} term
 * @param {string} reading
 * @returns {Translator}
 */
function createTranslator(term, reading) {
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
                    reading,
                    definitionTags: [],
                    termTags: [],
                    rules: [],
                    definitions: ['Unicode lookup fixture'],
                    score: 1,
                    dictionary,
                    id: 1,
                    sequence: -1,
                }];
            });
        },
    })));
    translator.prepare();
    return translator;
}

/** @type {import('translation').FindTermsOptions} */
const options = {
    matchType: 'exact',
    deinflect: true,
    mainDictionary: dictionary,
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder: 'descending',
    removeNonJapaneseCharacters: false,
    primaryReading: '',
    textReplacements: [null],
    enabledDictionaryMap: new Map([[dictionary, {
        index: 0,
        alias: dictionary,
        allowSecondarySearches: false,
        partsOfSpeechFilter: false,
        useDeinflections: true,
    }]]),
    excludeDictionaryDefinitions: null,
    searchResolution: 'letter',
    language: 'ja',
    useAllFrequencyDictionaries: false,
};

test.each([
    ['ウ\u3099ィーナス', 'ヴィーナス', 'ゔぃーなす'],
    ['う\u3099ぁいおりん', 'ゔぁいおりん', 'ゔぁいおりん'],
])('decomposed voiced kana %s finds %s and retains the full source span', async (source, term, reading) => {
    const translator = createTranslator(term, reading);
    const result = await translator.findTerms('simple', source, options);

    expect(result.dictionaryEntries).toHaveLength(1);
    expect(result.dictionaryEntries[0].headwords[0].term).toBe(term);
    expect(result.dictionaryEntries[0].headwords[0].sources).toContainEqual(expect.objectContaining({originalText: source}));
    expect(result.originalTextLength).toBe(source.length);
});

test('iteration marks after a supplementary kanji find the explicitly repeated entry', async () => {
    const translator = createTranslator('𠮷𠮷', 'よしよし');
    const result = await translator.findTerms('simple', '𠮷々', options);

    expect(result.dictionaryEntries).toHaveLength(1);
    expect(result.dictionaryEntries[0].headwords[0].term).toBe('𠮷𠮷');
    expect(result.originalTextLength).toBe('𠮷々'.length);
});

test.each([
    ['辻\u{e0100}々', '辻\u{e0100}辻\u{e0100}', 'つじつじ'],
    ['益\ufe00々', '益\ufe00益\ufe00', 'ますます'],
    ['辻\u{e0100}辻\u{e0100}', '辻\u{e0100}々', 'つじつじ'],
    ['益\ufe00益\ufe00', '益\ufe00々', 'ますます'],
])('iteration marks preserve the preceding kanji variation in %s', async (source, term, reading) => {
    const translator = createTranslator(term, reading);
    const result = await translator.findTerms('simple', source, options);

    expect(result.dictionaryEntries).toHaveLength(1);
    expect(result.dictionaryEntries[0].headwords[0].term).toBe(term);
    expect(result.dictionaryEntries[0].headwords[0].sources).toContainEqual(expect.objectContaining({originalText: source}));
    expect(result.originalTextLength).toBe(source.length);
});
