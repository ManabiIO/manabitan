/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {Translator} from '../../ext/js/language/translator.js';

/**
 * @param {string} term
 * @returns {Translator}
 */
function createTranslator(term) {
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
                    definitions: ['Variant spelling'],
                    score: 1,
                    dictionary: 'CJK variants',
                    id: 1,
                    sequence: -1,
                }];
            });
        },
    })));
    translator.prepare();
    return translator;
}

/**
 * @param {string} language
 * @returns {import('translation').FindTermsOptions}
 */
function createOptions(language) {
    return {
        matchType: 'exact',
        deinflect: true,
        mainDictionary: 'CJK variants',
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'descending',
        removeNonJapaneseCharacters: true,
        primaryReading: '',
        textReplacements: [null],
        enabledDictionaryMap: new Map([['CJK variants', {
            index: 0, alias: 'CJK variants', allowSecondarySearches: false, partsOfSpeechFilter: false, useDeinflections: true,
        }]]),
        excludeDictionaryDefinitions: null,
        searchResolution: 'letter',
        language,
        useAllFrequencyDictionaries: false,
    };
}

test.each(['ja', 'zh', 'yue', 'ko'])('CJK-only %s lookup keeps a variation selector attached to its ideograph', async (language) => {
    const term = '葛\u{e0100}飾';
    const result = await createTranslator(term).findTerms('simple', `${term}ABC`, createOptions(language));

    expect(result.dictionaryEntries.map(({headwords}) => headwords[0].term)).toEqual([term]);
    expect(result.originalTextLength).toBe(term.length);
});

test.each(['\ufe00', '\ufe02', '\u{e0100}', '\u{e01ef}'])('CJK-only lookup preserves BMP and supplementary selectors %s', async (selector) => {
    const term = `𠮷${selector}野`;
    const result = await createTranslator(term).findTerms('simple', term, createOptions('ja'));

    expect(result.dictionaryEntries.map(({headwords}) => headwords[0].term)).toEqual([term]);
    expect(result.originalTextLength).toBe(term.length);
});

test.each([
    ['葛A飾', '葛A飾'],
    ['\u{e0100}葛', '\u{e0100}葛'],
    ['1\ufe0f葛', '1\ufe0f葛'],
])('CJK-only lookup still stops before a non-CJK or unattached selector in %s', async (source, term) => {
    const result = await createTranslator(term).findTerms('simple', source, createOptions('ja'));

    expect(result.dictionaryEntries).toEqual([]);
    expect(result.originalTextLength).toBe(0);
});

test('CJK-only kanji lookup continues past a variant glyph to later ideographs', async () => {
    const translator = new Translator(/** @type {import('../../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
        /**
         * @param {string[]} characters
         * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
         */
        async findKanjiBulk(characters) {
            return characters.flatMap((character, index) => {
                if (character !== '葛' && character !== '飾') { return []; }
                return [{index, character, onyomi: [], kunyomi: [], tags: [], definitions: ['Kanji'], stats: {}, dictionary: 'CJK variants'}];
            });
        },
        async findTagMetaBulk() { return []; },
        async findKanjiMetaBulk() { return []; },
        async getDictionaryInfo() { return []; },
    })));
    translator.prepare();
    const {enabledDictionaryMap} = createOptions('ja');
    const entries = await translator.findKanji('葛\u{e0100}飾A猫', {removeNonJapaneseCharacters: true, enabledDictionaryMap});

    expect(entries.map(({character}) => character).sort()).toEqual(['葛', '飾'].sort());
});
