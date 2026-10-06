/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import {exactReaderEntries, readerEntriesWithSurface} from '../ext/js/app/reader-lookup-bridge.js';

/** @type {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} */
const request = {protocol: 1, term: '見る', reading: 'みる', surface: '見られなかった', sentence: '見られなかった。', offset: 0};

/** @returns {import('dictionary').TermDictionaryEntry} */
function createEntry() {
    const dictionary = {dictionary: 'fixture', dictionaryIndex: 0, dictionaryAlias: 'fixture'};
    return {
        type: 'term',
        isPrimary: true,
        matchPrimaryReading: false,
        score: 10,
        frequencyOrder: 1,
        dictionaryIndex: 0,
        dictionaryAlias: 'unrelated',
        sourceTermExactMatchCount: 2,
        maxOriginalTextLength: 2,
        textProcessorRuleChainCandidates: [['unrelated']],
        inflectionRuleChainCandidates: [{source: 'dictionary', inflectionRules: [{name: 'unrelated'}]}],
        headwords: ['観る', '見る'].map(/**
                                     * @param {string} term
                                     * @param {number} index
                                     * @returns {import('dictionary').TermHeadword}
                                     */ (term, index) => ({
                index,
                headwordIndex: index,
                term,
                reading: 'みる',
                tags: [],
                wordClasses: [],
                sources: [{isPrimary: true, originalText: '見る', transformedText: '見る', deinflectedText: '見る', matchType: 'exact', matchSource: 'term'}],
            }),
        ),
        definitions: [
            {...dictionary, index: 0, headwordIndices: [0], id: 10, sequences: [10], dictionaryAlias: 'wrong', score: 10, frequencyOrder: 1, entries: ['unrelated'], tags: [], isPrimary: true},
            {...dictionary, index: 1, headwordIndices: [1, 0], id: 20, sequences: [20], dictionaryIndex: 2, dictionaryAlias: 'right', score: 5, frequencyOrder: 3, entries: ['shared definition'], tags: [], isPrimary: true},
        ],
        frequencies: [10, 100].map((frequency, index) => ({
            ...dictionary, index, headwordIndex: index, frequency, hasReading: true, frequencyMode: null, displayValue: null, displayValueParsed: false,
        })),
        pronunciations: [1, 2].map(/**
                                    * @param {number} positions
                                    * @param {number} index
                                    * @returns {import('dictionary').TermPronunciation}
                                    */ (positions, index) => ({
                ...dictionary,
                index,
                headwordIndex: index,
                pronunciations: [{type: 'pitch-accent', positions, nasalPositions: [], devoicePositions: [], tags: []}],
            }),
        ),
    };
}

describe('Reader exact-entry projection', () => {
    test('keeps the exact headword and remaps every dependent index', () => {
        const input = createEntry();
        const before = structuredClone(input);
        const [result] = exactReaderEntries([input], request);
        expect(result.headwords).toHaveLength(1);
        expect(result.headwords[0].term).toBe('見る');
        expect(result.headwords[0].index).toBe(1);
        expect(result.headwords[0].headwordIndex).toBe(0);
        expect(result.definitions).toHaveLength(1);
        expect(result.definitions[0].headwordIndices).toStrictEqual([0]);
        expect(result.definitions[0].id).toBe(20);
        expect(result.definitions[0].index).toBe(1);
        expect(result.definitions[0].sequences).toStrictEqual([20]);
        expect(result.definitions[0].entries).toStrictEqual(['shared definition']);
        expect(result.frequencies).toHaveLength(1);
        expect(result.frequencies[0].headwordIndex).toBe(0);
        expect(result.frequencies[0].frequency).toBe(100);
        expect(result.pronunciations).toHaveLength(1);
        expect(result.pronunciations[0].pronunciations).toStrictEqual(input.pronunciations[1].pronunciations);
        expect(result.pronunciations[0].headwordIndex).toBe(0);
        expect(result.dictionaryAlias).toBe('right');
        expect(result.score).toBe(5);
        expect(result.inflectionRuleChainCandidates).toStrictEqual([]);
        expect(result.textProcessorRuleChainCandidates).toStrictEqual([]);
        expect(input).toStrictEqual(before);
    });

    test('keeps the real inflected mining span rather than the lemma length', () => {
        const [result] = readerEntriesWithSurface(exactReaderEntries([createEntry()], request), request);
        expect(result.maxOriginalTextLength).toBe(request.surface.length);
        expect(result.headwords[0].sources[0].originalText).toBe(request.surface);
    });

    test('does not inherit unrelated meaning when no definitions attach to the matched word', () => {
        const entry = createEntry();
        entry.definitions = entry.definitions.slice(0, 1);
        expect(exactReaderEntries([entry], request)).toStrictEqual([]);
    });

    test('excludes different readings and does not guess malformed relationships', () => {
        expect(exactReaderEntries([createEntry()], {...request, reading: 'けん'})).toStrictEqual([]);
        const entry = createEntry();
        entry.headwords[1].headwordIndex = 99;
        expect(exactReaderEntries([entry], request)).toStrictEqual([]);
    });

    test('preserves original headword ordering independently of the remapped relationship index', () => {
        const entry = createEntry();
        entry.headwords[1].index = 99;
        const [result] = exactReaderEntries([entry], request);
        expect(result.headwords[0].index).toBe(99);
        expect(result.headwords[0].headwordIndex).toBe(0);
        expect(result.definitions[0].headwordIndices).toStrictEqual([0]);
    });
});
