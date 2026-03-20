/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

/* eslint-disable no-underscore-dangle */

import {fileURLToPath} from 'node:url';
import path from 'path';
import {afterAll, bench, describe} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {TextSourceGenerator} from '../ext/js/dom/text-source-generator.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {setupDomTest} from '../test/fixtures/dom-test.js';
import {createTranslatorContext} from '../test/fixtures/translator-test.js';
import {setupStubs} from '../test/utilities/database.js';

setupStubs();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dictionaryName = 'Test Dictionary 2';
const {translator} = await createTranslatorContext(path.join(dirname, '..', 'test', 'data/dictionaries/valid-dictionary1'), dictionaryName);
const {window, teardown} = await setupDomTest();

afterAll(async () => {
    await teardown(global);
});

const article = window.document.createElement('article');
for (const [index, term] of ['打ち込む', '画像', '番号', '好き', '自重'].entries()) {
    const element = window.document.createElement('span');
    element.dataset.term = `${index + 1}`;
    element.textContent = term;
    article.appendChild(element);
}
window.document.body.replaceChildren(article);

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
backend._translatorProfileOptionsCache = /** @type {WeakMap<import('settings').ProfileOptions, object>} */ (new WeakMap());

/** @type {import('settings').ProfileOptions} */
const profileOptions = {
    general: {
        mainDictionary: dictionaryName,
        sortFrequencyDictionary: null,
        sortFrequencyDictionaryOrder: 'descending',
        language: 'ja',
    },
    scanning: {
        alphanumeric: false,
    },
    translation: {
        searchResolution: 'letter',
        textReplacements: {
            searchOriginal: true,
            groups: [[
                {pattern: '\\(([^)]*)(?:\\))', ignoreCase: false, replacement: '$1'},
            ]],
        },
    },
    dictionaries: [{
        name: dictionaryName,
        enabled: true,
        alias: dictionaryName,
        allowSecondarySearches: false,
        partsOfSpeechFilter: true,
        useDeinflections: true,
    }],
};

const searchContext = {
    optionsContext: {url: 'https://example.com/article'},
    detail: {documentTitle: 'Hover Lookup Bench'},
};
const benchOptions = {
    time: 75,
    iterations: 15,
    warmupTime: 25,
    warmupIterations: 5,
};

/**
 * @param {import('settings').ProfileOptions} options
 * @returns {Map<string, import('translation').FindTermDictionary>}
 */
function createLegacyEnabledDictionaryMap(options) {
    const enabledDictionaryMap = new Map();
    for (const dictionary of options.dictionaries) {
        if (!dictionary.enabled) { continue; }
        const {name, alias, allowSecondarySearches, partsOfSpeechFilter, useDeinflections} = dictionary;
        enabledDictionaryMap.set(name, {
            index: enabledDictionaryMap.size,
            alias,
            allowSecondarySearches,
            partsOfSpeechFilter,
            useDeinflections,
        });
    }
    return enabledDictionaryMap;
}

/**
 * @param {import('settings').TranslationTextReplacementOptions} textReplacementsOptions
 * @returns {(?(import('translation').FindTermsTextReplacement[]))[]}
 */
function createLegacyTextReplacements(textReplacementsOptions) {
    /** @type {(?(import('translation').FindTermsTextReplacement[]))[]} */
    const textReplacements = [];
    for (const group of textReplacementsOptions.groups) {
        /** @type {import('translation').FindTermsTextReplacement[]} */
        const textReplacementsEntries = [];
        for (const {pattern, ignoreCase, replacement} of group) {
            let patternRegExp;
            try {
                patternRegExp = ignoreCase ?
                    new RegExp(pattern.replace(/['’]/g, "['’]"), 'gi') :
                    new RegExp(pattern, 'g');
            } catch (e) {
                continue;
            }
            textReplacementsEntries.push({pattern: patternRegExp, replacement});
        }
        if (textReplacementsEntries.length > 0) {
            textReplacements.push(textReplacementsEntries);
        }
    }
    if (textReplacements.length === 0 || textReplacementsOptions.searchOriginal) {
        textReplacements.unshift(null);
    }
    return textReplacements;
}

/**
 * @param {import('api').FindTermsDetails} details
 * @param {import('settings').ProfileOptions} options
 * @returns {import('translation').FindTermsOptions}
 */
function createLegacyFindTermsOptions(details, options) {
    let {matchType, deinflect, primaryReading} = details;
    if (typeof matchType !== 'string') { matchType = /** @type {import('translation').FindTermsMatchType} */ ('exact'); }
    if (typeof deinflect !== 'boolean') { deinflect = true; }
    if (typeof primaryReading !== 'string') { primaryReading = ''; }
    const enabledDictionaryMap = createLegacyEnabledDictionaryMap(options);
    const {
        general: {mainDictionary, sortFrequencyDictionary, sortFrequencyDictionaryOrder, language},
        scanning: {alphanumeric},
        translation: {
            textReplacements: textReplacementsOptions,
            searchResolution,
        },
    } = options;
    return {
        matchType,
        deinflect,
        primaryReading,
        mainDictionary,
        sortFrequencyDictionary,
        sortFrequencyDictionaryOrder,
        removeNonJapaneseCharacters: !alphanumeric,
        searchResolution,
        textReplacements: createLegacyTextReplacements(textReplacementsOptions),
        enabledDictionaryMap,
        excludeDictionaryDefinitions: null,
        language,
    };
}

const api = /** @type {import('../ext/js/comm/api.js').API} */ ({
    async termsFind(text, details) {
        const findTermsOptions = backend._getTranslatorFindTermsOptions('split', details, profileOptions);
        return await translator.findTerms('split', text, findTermsOptions);
    },
    async kanjiFind(text) {
        const findKanjiOptions = backend._getTranslatorFindKanjiOptions(profileOptions);
        return await translator.findKanji(text, findKanjiOptions);
    },
    async isTextLookupWorthy() {
        return true;
    },
});

const textScanner = new TextScanner({
    api,
    node: window,
    getSearchContext: () => searchContext,
    searchTerms: true,
    searchKanji: true,
    textSourceGenerator: new TextSourceGenerator(),
});
textScanner.language = 'ja';
textScanner.setOptions({
    inputs: [],
    deepContentScan: false,
    normalizeCssZoom: true,
    selectText: false,
    delay: 0,
    scanLength: 12,
    layoutAwareScan: false,
    preventMiddleMouseOnPage: false,
    preventMiddleMouseOnTextHover: false,
    preventBackForwardOnPage: false,
    preventBackForwardOnTextHover: false,
    sentenceParsingOptions: {
        scanExtent: 24,
        terminationCharacterMode: 'newlines',
        terminationCharacters: [],
    },
    scanWithoutMousemove: true,
    scanResolution: 'character',
});

const ranges = [...window.document.querySelectorAll('[data-term]')].map((element) => {
    const node = /** @type {Text} */ (element.firstChild);
    const range = window.document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 0);
    return range;
});
const terms = [...window.document.querySelectorAll('[data-term]')].map((element) => element.textContent ?? '');

describe('Hover lookup runtime', () => {
    bench('Legacy Backend._getTranslatorFindTermsOptions', () => {
        createLegacyFindTermsOptions({}, profileOptions);
    }, benchOptions);

    bench('Cached Backend._getTranslatorFindTermsOptions', () => {
        backend._getTranslatorFindTermsOptions('split', {}, profileOptions);
    }, benchOptions);

    bench('Legacy translator lookup pipeline', async () => {
        for (const term of terms) {
            await translator.findTerms('split', term, createLegacyFindTermsOptions({}, profileOptions));
        }
    }, benchOptions);

    bench('Cached translator lookup pipeline', async () => {
        for (const term of terms) {
            await translator.findTerms('split', term, backend._getTranslatorFindTermsOptions('split', {}, profileOptions));
        }
    }, benchOptions);

    bench('TextScanner.search + translator lookup', async () => {
        for (const range of ranges) {
            textScanner.clearSelection();
            await textScanner.search(TextSourceRange.createLazy(range.cloneRange()), null, false);
        }
    }, benchOptions);
});

/* eslint-enable no-underscore-dangle */
