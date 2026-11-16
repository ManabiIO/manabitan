/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect} from 'vitest';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';
import {DisplayGenerator} from '../ext/js/display/display-generator.js';
import {Translator} from '../ext/js/language/translator.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/templates-display.html');

/**
 * @param {string} dictionary
 * @param {string} reading
 * @param {number} id
 * @returns {import('dictionary-database').TermEntry}
 */
function entry(dictionary, reading, id) {
    return {
        index: 0,
        matchType: 'exact',
        matchSource: 'term',
        term: '生',
        reading,
        definitionTags: [],
        termTags: [],
        rules: [],
        definitions: [`${dictionary}: ${reading}`],
        score: 0,
        dictionary,
        id,
        sequence: id,
    };
}

/** @returns {import('translation').FindTermsOptions} */
function findOptions() {
    return {
        matchType: 'exact',
        deinflect: false,
        primaryReading: '',
        mainDictionary: 'Dictionary A',
        sortFrequencyDictionary: 'Frequency',
        sortFrequencyDictionaryOrder: 'ascending',
        removeNonJapaneseCharacters: false,
        textReplacements: [null],
        excludeDictionaryDefinitions: null,
        searchResolution: 'word',
        language: 'ja',
        useAllFrequencyDictionaries: false,
        enabledDictionaryMap: new Map(['Dictionary A', 'Dictionary B', 'Frequency'].map((name, index) => [name, {
            index, alias: name.replace('Dictionary ', ''), allowSecondarySearches: true, partsOfSpeechFilter: false, useDeinflections: true,
        }])),
    };
}

test.for([false, true])('definitions retain their dictionary label and metadata with frequency sorting %s', async (frequencySorting, {window}) => {
    const dictionaries = /** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ ([
        {title: 'Dictionary A', revision: 'A-1', author: 'Author A'},
        {title: 'Dictionary B', revision: 'B-2', author: 'Author B'},
        {title: 'Frequency', frequencyMode: 'rank'},
    ]));
    const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
        findTermsBulk: async (/** @type {string[]} */ terms) => (terms.includes('生') ? [entry('Dictionary A', 'せい', 1), entry('Dictionary A', 'なま', 2), entry('Dictionary B', 'せい', 3)] : []),
        getDictionaryInfo: async () => dictionaries,
        findTermMetaBulk: async () => [
            {index: 0, dictionary: 'Frequency', mode: 'freq', data: {reading: 'せい', frequency: 10}},
            {index: 0, dictionary: 'Frequency', mode: 'freq', data: {reading: 'なま', frequency: 20}},
        ],
        findTagMetaBulk: async () => [],
    }));
    const translator = new Translator(database);
    translator.prepare();
    const options = findOptions();
    if (!frequencySorting) { options.sortFrequencyDictionary = null; }
    const {dictionaryEntries} = await translator.findTerms('term', '生', options);
    const labels = frequencySorting ? ['A', 'B', 'A'] : ['A', 'A', 'B'];
    expect(dictionaryEntries).toHaveLength(1);
    expect(dictionaryEntries[0].definitions.map(({dictionary}) => dictionary)).toEqual(labels.map((label) => `Dictionary ${label}`));

    const manager = new DisplayContentManager(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({})));
    const generator = new DisplayGenerator(manager, null);
    generator._templates.load(window.document);
    const node = generator.createTermEntry(dictionaryEntries[0], dictionaries);
    const tags = /** @type {HTMLElement[]} */ ([...node.querySelectorAll('.definition-tag-list [data-category="dictionary"]')]);

    expect(tags.map((tag) => tag.querySelector('.tag-label-content')?.textContent)).toEqual(labels);
    expect(tags.map((tag) => tag.getAttribute('title'))).toEqual(labels.map((label) => (label === 'A' ?
        'Dictionary A\nrev.A-1\nAuthor: Author A' :
        'Dictionary B\nrev.B-2\nAuthor: Author B')));
    expect(tags.map((tag) => tag.dataset.redundant)).toEqual(frequencySorting ? [void 0, void 0, void 0] : [void 0, 'true', void 0]);
});
