/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFileSync} from 'node:fs';
import {expect, vi} from 'vitest';
import {JsonSchema} from '../ext/js/data/json-schema.js';
import {PronunciationGenerator} from '../ext/js/display/pronunciation-generator.js';
import {getKanaMorae} from '../ext/js/language/ja/japanese.js';
import {createDomTest} from './fixtures/dom-test.js';
import {fetch} from './mocks/common.js';
import {getTemplateRenderResults} from './utilities/anki.js';

vi.stubGlobal('fetch', fetch);
const test = createDomTest();
const schema = new JsonSchema(/** @type {import('ext/json-schema').Schema} */ (JSON.parse(readFileSync(new URL('../ext/data/schemas/dictionary-term-meta-bank-v3-schema.json', import.meta.url), 'utf8'))));
const template = readFileSync(new URL('../ext/data/templates/default-anki-field-templates.handlebars', import.meta.url), 'utf8');

for (const position of [3, 10000]) {
    test('accepted oversized pitch renders a bounded JJ graph: ' + position, ({window}) => {
        expect(() => schema.validate([['あ', 'pitch', {reading: 'あ', pitches: [{position}]}]])).not.toThrow();
        const generator = new PronunciationGenerator(window.document);
        const graph = generator.createPronunciationGraphJJ(['あ'], position);
        expect([...graph.querySelectorAll('circle')].map((node) => node.getAttribute('cy'))).toEqual(['30', '5']);
        expect(graph.querySelectorAll('path')).toHaveLength(1);
        expect(graph.getAttribute('viewBox')).toBe('0 0 67 75');
    });
}

/** @type {Array<{position: number|string, levels: string[]}>} */
const pitchCases = [
    {position: 0, levels: ['30', '5', '5', '5']},
    {position: 1, levels: ['5', '30', '30', '30']},
    {position: 2, levels: ['30', '5', '30', '30']},
    {position: 3, levels: ['30', '5', '5', '30']},
    {position: 4, levels: ['30', '5', '5', '5']},
    {position: 'LHH', levels: ['30', '5', '5', '5']},
    {position: 'LHHL', levels: ['30', '5', '5', '30']},
    {position: 'HLLH', levels: ['5', '30', '30', '5']},
];
for (const {position, levels} of pitchCases) {
    test('preserves ordinary pitch and explicit suffix levels: ' + position, ({window}) => {
        const graph = new PronunciationGenerator(window.document).createPronunciationGraphJJ(['あ', 'い', 'う'], position);
        expect([...graph.querySelectorAll('circle')].map((node) => node.getAttribute('cy'))).toEqual(levels);
        expect(graph.querySelectorAll('path')).toHaveLength(3);
    });
}

/** @type {Array<{reading: string, labels: string[]}>} */
const labelCases = [
    {reading: '𛀁', labels: ['𛀁']},
    {reading: '𠮷', labels: ['𠮷']},
    {reading: 'きゃ', labels: ['き', 'ゃ']},
    {reading: '𛀁ゃ', labels: ['𛀁', 'ゃ']},
    {reading: 'ティェ', labels: ['テ', 'ィェ']},
];
for (const {reading, labels} of labelCases) {
    test('preserves code points and the complete mora label: ' + reading, ({window}) => {
        const morae = getKanaMorae(reading);
        expect(morae).toEqual([reading]);
        const graph = new PronunciationGenerator(window.document).createPronunciationGraphJJ(morae, 0);
        expect([...graph.querySelectorAll('text')].map((node) => node.textContent)).toEqual(labels);
        expect(graph.textContent).toBe(reading);
    });
}

/**
 * @param {string} reading
 * @param {number|string} position
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function entry(reading, position) {
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 0,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: 'Pitch fixture',
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: true,
        maxOriginalTextLength: reading.length,
        headwords: [{index: 0, headwordIndex: 0, term: reading, reading, sources: [{originalText: reading, transformedText: reading, deinflectedText: reading, matchType: 'exact', matchSource: 'term', isPrimary: true}], tags: [], wordClasses: []}],
        definitions: [{index: 0, headwordIndices: [0], dictionary: 'Pitch fixture', dictionaryIndex: 0, dictionaryAlias: 'Pitch fixture', id: 1, score: 0, frequencyOrder: 0, sequences: [-1], isPrimary: true, tags: [], entries: ['healthy definition']}],
        pronunciations: [{index: 0, headwordIndex: 0, dictionary: 'Pitch fixture', dictionaryIndex: 0, dictionaryAlias: 'Pitch fixture', pronunciations: [{type: 'pitch-accent', positions: position, nasalPositions: [], devoicePositions: [], tags: []}]}],
        frequencies: [],
    };
}

test('shipped Anki marker keeps its SVG when a dictionary pitch exceeds its reading', async ({window}) => {
    void window;
    const [fields] = await getTemplateRenderResults([entry('あ', 3)], 'split', template, expect);
    expect(fields['pitch-accent-graphs-jj']).toContain('<svg');
    expect(fields['pitch-accent-graphs-jj']).not.toContain('render-error');
    expect(fields['glossary-plain-no-dictionary']).toContain('healthy definition');
});
