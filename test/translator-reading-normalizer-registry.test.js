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
import {Translator} from '../ext/js/language/translator.js';
import {normalizePinyin} from '../ext/js/language/zh/chinese.js';
import {getAllLanguageReadingNormalizers} from '../ext/js/language/languages.js';

const unknownLanguageKeys = ['__proto__', 'constructor', 'toString', 'language-without-a-normalizer'];

/**
 * @returns {Translator}
 */
function createPreparedTranslator() {
    const translator = new Translator(/** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({})));
    translator.prepare();
    return translator;
}

/**
 * @returns {(translator: Translator, language: string, headwordsMap: Map<string, import('dictionary').TermHeadword>, headwords: import('dictionary').TermHeadword[]) => number[]}
 * @throws {Error}
 */
function getAddTermHeadwordsMethod() {
    const method = Reflect.get(Translator.prototype, '_addTermHeadwords');
    if (typeof method !== 'function') {
        throw new Error('Expected Translator._addTermHeadwords');
    }
    const tagAggregator = {mergeTags() {}};
    return (translator, language, headwordsMap, headwords) => Reflect.apply(method, translator, [language, headwordsMap, headwords, tagAggregator]);
}

/**
 * @returns {(translator: Translator, language: string, dictionaryEntries: import('translation-internal').TermDictionaryEntry[]) => import('translation-internal').TermDictionaryEntry[]}
 * @throws {Error}
 */
function getGroupDictionaryEntriesByHeadwordMethod() {
    const method = Reflect.get(Translator.prototype, '_groupDictionaryEntriesByHeadword');
    if (typeof method !== 'function') {
        throw new Error('Expected Translator._groupDictionaryEntriesByHeadword');
    }
    const tagAggregator = {mergeTags() {}};
    return (translator, language, dictionaryEntries) => Reflect.apply(method, translator, [language, dictionaryEntries, tagAggregator, '']);
}

/**
 * @returns {(translator: Translator, language: string, groups: import('translation-internal').DictionaryEntryGroup[], ungrouped: Map<number, import('translation-internal').TermDictionaryEntry>) => Promise<void>}
 * @throws {Error}
 */
function getAddSecondaryRelatedDictionaryEntriesMethod() {
    const method = Reflect.get(Translator.prototype, '_addSecondaryRelatedDictionaryEntries');
    if (typeof method !== 'function') {
        throw new Error('Expected Translator._addSecondaryRelatedDictionaryEntries');
    }
    const tagAggregator = {mergeTags() {}};
    return async (translator, language, groups, ungrouped) => await Reflect.apply(method, translator, [language, groups, ungrouped, new Map(), new Map(), tagAggregator, '', []]);
}

/**
 * @param {string} reading
 * @param {import('dictionary').TermSource[]} [sources]
 * @returns {import('dictionary').TermHeadword}
 */
function createHeadword(reading, sources = []) {
    return {index: 0, headwordIndex: 0, term: '讀', reading, sources, tags: [], wordClasses: []};
}

/**
 * @param {string} reading
 * @param {number} dictionaryIndex
 * @returns {import('translation-internal').TermDictionaryEntry}
 */
function createDictionaryEntry(reading, dictionaryIndex) {
    return {
        type: 'term',
        isPrimary: false,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 1,
        frequencyOrder: 0,
        dictionaryIndex,
        dictionaryAlias: '',
        sourceTermExactMatchCount: 0,
        matchPrimaryReading: false,
        maxOriginalTextLength: 0,
        headwords: [createHeadword(reading)],
        definitions: [],
        pronunciations: [],
        frequencies: [],
    };
}

describe('Translator reading normalizer registry', () => {
    const addTermHeadwords = getAddTermHeadwordsMethod();
    const addSecondaryRelatedDictionaryEntries = getAddSecondaryRelatedDictionaryEntriesMethod();
    const groupDictionaryEntriesByHeadword = getGroupDictionaryEntriesByHeadwordMethod();

    test('preparation registers only bundled normalizer functions', () => {
        const translator = createPreparedTranslator();
        const normalizers = /** @type {Map<string, (reading: string) => string>} */ (Reflect.get(translator, '_readingNormalizers'));
        const bundledNormalizers = getAllLanguageReadingNormalizers();

        expect(normalizers).toBeInstanceOf(Map);
        expect([...normalizers]).toStrictEqual(bundledNormalizers.map(({iso, readingNormalizer}) => [iso, readingNormalizer]));
        expect(normalizers.get('zh')).toBe(normalizePinyin);
        for (const language of unknownLanguageKeys) {
            expect(normalizers.has(language)).toBe(false);
        }
    });

    test.each(unknownLanguageKeys)('%s does not normalize or merge headwords', (language) => {
        const translator = createPreparedTranslator();
        const headwords = /** @type {Map<string, import('dictionary').TermHeadword>} */ (new Map());
        const indexMap = addTermHeadwords(translator, language, headwords, [
            createHeadword('Rì wén'),
            createHeadword('rìwén'),
        ]);

        expect(indexMap).toStrictEqual([0, 1]);
        expect([...headwords.values()].map(({reading}) => reading)).toStrictEqual(['Rì wén', 'rìwén']);
    });

    test.each(unknownLanguageKeys)('%s keeps dictionary grouping keyed by the original reading', (language) => {
        const translator = createPreparedTranslator();
        const grouped = groupDictionaryEntriesByHeadword(translator, language, [
            createDictionaryEntry('Rì wén', 0),
            createDictionaryEntry('rìwén', 1),
        ]);

        expect(grouped).toHaveLength(2);
        expect(grouped.map(({headwords}) => headwords.map(({reading}) => reading))).toStrictEqual([['Rì wén'], ['rìwén']]);
    });

    test.each(unknownLanguageKeys)('%s does not match unrelated secondary readings', async (language) => {
        const translator = createPreparedTranslator();
        const groupedEntry = createDictionaryEntry('Rì wén', 0);
        const secondaryEntry = createDictionaryEntry('rìwén', 1);
        const group = {dictionaryEntries: [groupedEntry], ids: new Set()};
        const ungrouped = new Map([[1, secondaryEntry]]);

        await addSecondaryRelatedDictionaryEntries(translator, language, [group], ungrouped);

        expect(group.dictionaryEntries).toHaveLength(1);
        expect(group.ids.size).toBe(0);
        expect(ungrouped.has(1)).toBe(true);
    });

    test('Chinese pinyin normalization still merges equivalent readings in both paths', async () => {
        const translator = createPreparedTranslator();
        const headwords = /** @type {Map<string, import('dictionary').TermHeadword>} */ (new Map());
        const indexMap = addTermHeadwords(translator, 'zh', headwords, [
            createHeadword('Rì wén', [{originalText: 'a', transformedText: 'a', deinflectedText: 'a', matchType: 'exact', matchSource: 'term', isPrimary: true}]),
            createHeadword('rìwén', [{originalText: 'b', transformedText: 'b', deinflectedText: 'b', matchType: 'exact', matchSource: 'term', isPrimary: false}]),
        ]);

        expect(indexMap).toStrictEqual([0, 0]);
        expect([...headwords.values()]).toHaveLength(1);
        expect([...headwords.values()][0].reading).toBe('Rì wén');
        expect([...headwords.values()][0].sources.map(({originalText}) => originalText)).toStrictEqual(['a', 'b']);

        const grouped = groupDictionaryEntriesByHeadword(translator, 'zh', [
            createDictionaryEntry('Rì wén', 0),
            createDictionaryEntry('rìwén', 1),
        ]);
        expect(grouped).toHaveLength(1);
        expect(grouped[0].headwords).toHaveLength(1);
        expect(grouped[0].headwords[0].reading).toBe('Rì wén');

        const groupedEntry = createDictionaryEntry('Rì wén', 0);
        const secondaryEntry = createDictionaryEntry('rìwén', 1);
        const group = {dictionaryEntries: [groupedEntry], ids: new Set()};
        const ungrouped = new Map([[1, secondaryEntry]]);
        await addSecondaryRelatedDictionaryEntries(translator, 'zh', [group], ungrouped);
        expect(group.dictionaryEntries).toStrictEqual([groupedEntry, secondaryEntry]);
        expect(group.ids.has(1)).toBe(true);
        expect(ungrouped.has(1)).toBe(false);
    });
});
