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

import {describe, expect, test, vi} from 'vitest';
import {Translator} from '../ext/js/language/translator.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {findJapaneseSearch} from '../ext/js/search/japanese-search.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();
/** @type {import('translator').DictionaryAvailability[]} */
const degraded = [{dictionary: 'Damaged', generationId: 'generation-1', status: 'repairPending', reason: 'index missing'}];
/** @type {import('dictionary').TermDictionaryEntry} */
const healthyEntry = /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({type: 'term', definitions: [{dictionary: 'Healthy'}], frequencies: [], pronunciations: []}));
const optionsContext = {depth: 0, url: 'https://example.test/'};
/** @type {import('text-scanner').InputInfo} */
const inputInfo = {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null};

/**
 * @param {object} database
 * @param {import('dictionary').TermDictionaryEntry[]} [entries]
 * @returns {Translator}
 */
function createTranslator(database, entries = []) {
    const translator = new Translator(/** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)));
    Reflect.set(translator, '_findTermsInternal', vi.fn().mockResolvedValue({dictionaryEntries: entries, originalTextLength: entries.length > 0 ? 2 : 0}));
    Reflect.set(translator, '_addTermMeta', vi.fn().mockResolvedValue(void 0));
    Reflect.set(translator, '_expandTagGroupsAndGroup', vi.fn().mockResolvedValue(void 0));
    Reflect.set(translator, '_flagRedundantDefinitionTags', vi.fn());
    Reflect.set(translator, '_addUserFacingInflections', (_language, values) => values);
    return translator;
}

/** @returns {import('translation').FindTermsOptions} */
function findOptions() {
    return /** @type {import('translation').FindTermsOptions} */ (/** @type {unknown} */ ({
        enabledDictionaryMap: new Map([['Healthy', {}], ['Damaged', {}]]),
        excludeDictionaryDefinitions: null,
        sortFrequencyDictionary: null,
        language: 'ja',
        primaryReading: '',
        useAllFrequencyDictionaries: false,
    }));
}

/** @returns {import('translation').FindTermsOptions} */
function lookupOptions() {
    return {
        ...findOptions(),
        matchType: 'exact',
        deinflect: false,
        mainDictionary: 'Healthy',
        sortFrequencyDictionaryOrder: 'descending',
        removeNonJapaneseCharacters: false,
        textReplacements: [null],
        searchResolution: 'word',
        enabledDictionaryMap: new Map(['Healthy', 'Damaged'].map((name, index) => [name, {
            index, alias: name, allowSecondarySearches: true, partsOfSpeechFilter: false, useDeinflections: true,
        }])),
    };
}

/**
 * @param {string} dictionary
 * @param {number} id
 * @returns {import('dictionary-database').TermEntry}
 */
function databaseEntry(dictionary, id) {
    return {
        index: 0,
        matchType: 'exact',
        matchSource: 'term',
        term: '日本',
        reading: 'にほん',
        definitionTags: [],
        termTags: [],
        rules: [],
        definitions: ['Japan'],
        score: 1,
        dictionary,
        id,
        sequence: 7,
    };
}

/**
 * @param {object} database
 * @returns {Translator}
 */
function createLookupTranslator(database) {
    const translator = new Translator(/** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ (database)));
    translator.prepare();
    Reflect.set(translator, '_addTermMeta', vi.fn().mockResolvedValue(void 0));
    Reflect.set(translator, '_expandTagGroupsAndGroup', vi.fn().mockResolvedValue(void 0));
    return translator;
}

/**
 * @param {import('text-scanner').ScannerApi['termsFind']} termsFind
 * @param {Window} window
 * @returns {TextScanner}
 */
function createScanner(termsFind, window) {
    const scanner = new TextScanner({
        api: {termsFind, kanjiFind: vi.fn().mockResolvedValue([]), isTextLookupWorthy: vi.fn().mockResolvedValue(false)},
        browser: 'chrome',
        node: window,
        getSearchContext: () => ({optionsContext, detail: {documentTitle: 'test'}}),
        searchTerms: true,
        searchKanji: true,
        textSourceGenerator: /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({extractSentence: () => ({text: 'sentence', offset: 0})})),
    });
    scanner.setOptions({scanLength: 20});
    Reflect.set(scanner, '_getSiteTheme', () => 'light');
    return scanner;
}

/**
 * @param {Document} document
 * @returns {TextSourceRange}
 */
function createSource(document) {
    const node = document.createTextNode('𠮷山は日本');
    document.body.appendChild(node);
    const range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    return TextSourceRange.create(range);
}

describe('Translator request-owned dictionary availability', () => {
    test.each([false, true])('preserves healthy siblings and includes availability on an %s partial hit', async (partial) => {
        const getDictionaryAvailability = vi.fn().mockReturnValue(degraded);
        const translator = createTranslator({getDictionaryAvailability}, partial ? [healthyEntry] : []);
        const result = await translator.findTerms('split', '日本', findOptions());
        expect(result.dictionaryEntries).toEqual(partial ? [healthyEntry] : []);
        expect(result.dictionaryAvailability).toEqual(degraded);
        expect([...getDictionaryAvailability.mock.calls[0][0]]).toEqual(['Healthy', 'Damaged']);
    });

    test('availability is sampled after metadata, not before the lookup', async () => {
        let metadataComplete = false;
        const getDictionaryAvailability = vi.fn(() => {
            expect(metadataComplete).toBe(true);
            return degraded;
        });
        const translator = createTranslator({getDictionaryAvailability});
        Reflect.set(translator, '_addTermMeta', async () => { metadataComplete = true; });
        expect((await translator.findTerms('split', '日本', findOptions())).dictionaryAvailability).toEqual(degraded);
    });

    test('healthy responses and legacy database mocks omit the optional field', async () => {
        for (const database of [{}, {getDictionaryAvailability: () => []}]) {
            const result = await createTranslator(database).findTerms('split', '日本', findOptions());
            expect(result).toEqual({dictionaryEntries: [], originalTextLength: 0});
        }
    });

    test('a later healthy response does not inherit a prior degraded response', async () => {
        const getDictionaryAvailability = vi.fn().mockReturnValueOnce(degraded).mockReturnValueOnce([]);
        const translator = createTranslator({getDictionaryAvailability});
        const first = await translator.findTerms('split', '日本', findOptions());
        const second = await translator.findTerms('split', '日本', findOptions());
        expect(first.dictionaryAvailability).toEqual(degraded);
        expect(second).not.toHaveProperty('dictionaryAvailability');
    });

    test.each([false, true])('repair completing during delayed content leaves the %s partial response incomplete, but not the next response', async (partial) => {
        /** @type {PromiseWithResolvers<import('dictionary-database').TermEntry[]>} */
        const content = Promise.withResolvers();
        let repairing = true;
        const findTermsBulk = vi.fn(async (
            /** @type {string[]} */ terms,
            /** @type {import('translation').TermEnabledDictionaryMap} */ _dictionaries,
            /** @type {import('dictionary').TermSourceMatchType} */ _matchType,
            /** @type {import('translator').DictionaryAvailability[]} */ observed,
        ) => {
            if (terms.length === 0) { return []; }
            if (repairing) {
                observed.push(...degraded);
                return content.promise;
            }
            return [databaseEntry('Healthy', 1), databaseEntry('Damaged', 2)];
        });
        const getDictionaryAvailability = vi.fn(() => (repairing ? degraded : []));
        const translator = createLookupTranslator({findTermsBulk, getDictionaryAvailability});
        const first = translator.findTerms('simple', '日本', lookupOptions());
        await vi.waitFor(() => { expect(findTermsBulk).toHaveBeenCalledTimes(1); });
        repairing = false;
        content.resolve(partial ? [databaseEntry('Healthy', 1)] : []);
        const result = await first;
        expect(getDictionaryAvailability.mock.results[0].value).toEqual([]);
        expect(result.dictionaryEntries).toHaveLength(partial ? 1 : 0);
        expect(result.dictionaryAvailability).toEqual(degraded);
        const fresh = await translator.findTerms('simple', '日本', lookupOptions());
        expect(fresh.dictionaryEntries).toHaveLength(2);
        expect(fresh).not.toHaveProperty('dictionaryAvailability');
        expect(findTermsBulk.mock.calls[0][3]).not.toBe(findTermsBulk.mock.calls[2][3]);
    });

    test('deduplicates observations and final health by dictionary and generation without losing observed exclusions', async () => {
        const nextGeneration = {...degraded[0], generationId: 'generation-2', status: /** @type {const} */ ('reimportRequired')};
        const translator = createTranslator({getDictionaryAvailability: () => [degraded[0], nextGeneration]});
        Reflect.set(translator, '_findTermsInternal', async (
            /** @type {string} */ _text,
            /** @type {import('translation').FindTermsOptions} */ _options,
            /** @type {object} */ _tags,
            /** @type {string} */ _reading,
            /** @type {import('translator').DictionaryAvailability[]} */ observed,
        ) => {
            observed.push(degraded[0], degraded[0]);
            return {dictionaryEntries: [], originalTextLength: 0};
        });
        expect((await translator.findTerms('split', '日本', findOptions())).dictionaryAvailability).toEqual([degraded[0], nextGeneration]);
    });

    test.each(/** @type {const} */ (['repairing', 'temporarilyUnavailable', 'reimportRequired']))('current %s health takes precedence over an earlier repair observation', async (status) => {
        const current = {...degraded[0], status, reason: 'new health evidence'};
        const translator = createTranslator({getDictionaryAvailability: () => [current]});
        Reflect.set(translator, '_findTermsInternal', async (
            /** @type {string} */ _text,
            /** @type {import('translation').FindTermsOptions} */ _options,
            /** @type {object} */ _tags,
            /** @type {string} */ _reading,
            /** @type {import('translator').DictionaryAvailability[]} */ observed,
        ) => {
            observed.push(...degraded);
            return {dictionaryEntries: [], originalTextLength: 0};
        });
        expect((await translator.findTerms('split', '日本', findOptions())).dictionaryAvailability).toEqual([current]);
    });

    test.each(['sequence', 'secondary'])('merge %s lookups share the request-local observation array', async (source) => {
        /** @type {import('translator').DictionaryAvailability[][]} */
        const observations = [];
        const findTermsBulk = vi.fn(async (
            /** @type {string[]} */ terms,
            /** @type {import('translation').TermEnabledDictionaryMap} */ _dictionaries,
            /** @type {import('dictionary').TermSourceMatchType} */ _matchType,
            /** @type {import('translator').DictionaryAvailability[]} */ observed,
        ) => {
            observations.push(observed);
            return terms.length > 0 ? [databaseEntry('Healthy', 1)] : [];
        });
        const findTermsBySequenceBulk = vi.fn(async (/** @type {import('translator').SequenceQuery[]} */ _items, /** @type {import('translator').DictionaryAvailability[]} */ observed) => {
            observations.push(observed);
            if (source === 'sequence') { observed.push(...degraded); }
            return [];
        });
        const findTermsExactBulk = vi.fn(async (
            /** @type {import('dictionary-database').TermExactRequest[]} */ _terms,
            /** @type {import('translation').TermEnabledDictionaryMap} */ _dictionaries,
            /** @type {import('translator').DictionaryAvailability[]} */ observed,
        ) => {
            observations.push(observed);
            if (source === 'secondary') { observed.push(...degraded); }
            return [];
        });
        const translator = createLookupTranslator({findTermsBulk, findTermsBySequenceBulk, findTermsExactBulk, getDictionaryAvailability: () => []});
        const result = await translator.findTerms('merge', '日本', lookupOptions());
        expect(findTermsBySequenceBulk).toHaveBeenCalledTimes(1);
        expect(findTermsExactBulk).toHaveBeenCalledTimes(1);
        expect(result.dictionaryAvailability).toEqual(degraded);
        expect(result.dictionaryEntries).toHaveLength(1);
        expect(observations.every((observed) => observed === observations[0])).toBe(true);
    });
});

describe('incomplete Japanese searches', () => {
    test.each([false, true])('returns an incomplete %s partial hit without alternate or prefix lookup', async (partial) => {
        const result = {dictionaryEntries: partial ? [healthyEntry] : [], originalTextLength: partial ? 1 : 0, dictionaryAvailability: degraded};
        const lookup = vi.fn().mockResolvedValue(result);
        const prefixLookup = vi.fn().mockResolvedValue({dictionaryEntries: [healthyEntry]});
        const found = await findJapaneseSearch('tabe', lookup, () => {}, prefixLookup);
        expect(found.result).toBe(result);
        expect(found.matchedQuery).toBe('tabe');
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(prefixLookup).not.toHaveBeenCalled();
    });

    test('returns an incomplete prefix miss without discarding its availability', async () => {
        const result = {dictionaryEntries: [], dictionaryAvailability: degraded};
        const found = await findJapaneseSearch('日本', async () => ({dictionaryEntries: []}), () => {}, async () => result);
        expect(found.result).toBe(result);
        expect(found.matchType).toBe('prefix');
    });

    test('still checks staleness before publishing an incomplete response', async () => {
        const gate = Promise.withResolvers();
        const abort = new AbortController();
        const pending = findJapaneseSearch('日本', () => gate.promise, () => abort.signal.throwIfAborted());
        abort.abort(new Error('stale search'));
        gate.resolve({dictionaryEntries: [], dictionaryAvailability: degraded});
        await expect(pending).rejects.toThrow('stale search');
    });
});

describe('scanner incomplete results', () => {
    domTest('status-only searches skip shortening and kanji fallback and bound source to one code point', async ({window}) => {
        const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability: degraded});
        const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
        const source = createSource(window.document);
        const result = await scanner._findDictionaryEntries(source, true, true, optionsContext);
        expect(termsFind).toHaveBeenCalledTimes(1);
        expect(Reflect.get(scanner, '_api').kanjiFind).not.toHaveBeenCalled();
        expect(result).toEqual({type: 'terms', dictionaryEntries: [], dictionaryAvailability: degraded, sentence: {text: 'sentence', offset: 0}});
        expect(source.text()).toBe('𠮷');
        expect(source.range.endOffset).toBe(2);
    });

    domTest('partial results retain healthy entries and their matched source span', async ({window}) => {
        const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [healthyEntry], originalTextLength: 2, dictionaryAvailability: degraded});
        const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
        const source = createSource(window.document);
        const result = await scanner._findDictionaryEntries(source, true, true, optionsContext);
        expect(result?.dictionaryEntries).toEqual([healthyEntry]);
        expect(result?.dictionaryAvailability).toBe(degraded);
        expect(source.text()).toBe('𠮷山');
    });

    domTest('an incomplete shortened lookup is preserved after a healthy full-query miss', async ({window}) => {
        const termsFind = vi.fn().mockResolvedValueOnce({dictionaryEntries: [], originalTextLength: 0}).mockResolvedValueOnce({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability: degraded});
        const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
        const result = await scanner._findDictionaryEntries(createSource(window.document), true, true, optionsContext);
        expect(termsFind).toHaveBeenCalledTimes(2);
        expect(result?.dictionaryAvailability).toBe(degraded);
        expect(Reflect.get(scanner, '_api').kanjiFind).not.toHaveBeenCalled();
    });

    for (const partial of [false, true]) {
        domTest(`incomplete ${partial} partial hits publish status and permit same-position recovery`, async ({window}) => {
            const termsFind = vi.fn().mockResolvedValueOnce({dictionaryEntries: partial ? [healthyEntry] : [], originalTextLength: 2, dictionaryAvailability: degraded}).mockResolvedValue({dictionaryEntries: [healthyEntry], originalTextLength: 2});
            const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
            const source = createSource(window.document);
            const success = vi.fn();
            const empty = vi.fn();
            const error = vi.fn();
            scanner.on('searchSuccess', success);
            scanner.on('searchEmpty', empty);
            scanner.on('searchError', error);
            expect(await scanner._search(source, true, true, inputInfo)).toBe(true);
            expect(success.mock.calls[0][0].dictionaryAvailability).toBe(degraded);
            expect(await scanner._search(source.clone(), true, true, inputInfo)).toBe(true);
            expect(success.mock.calls[1][0]).not.toHaveProperty('dictionaryAvailability');
            expect(await scanner._search(source.clone(), true, true, inputInfo)).toBeNull();
            expect(termsFind).toHaveBeenCalledTimes(2);
            expect(empty).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();
        });
    }

    domTest('ordinary healthy misses remain empty and can use shortened fallback', async ({window}) => {
        const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0});
        const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
        expect(await scanner._findTermDictionaryEntries(createSource(window.document), optionsContext)).toBeNull();
        expect(termsFind).toHaveBeenCalledTimes(2);
    });

    domTest('incomplete selection replaces the prior source and clears current input on dismissal', async ({window}) => {
        vi.useFakeTimers();
        try {
            const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: -1, dictionaryAvailability: degraded});
            const scanner = createScanner(termsFind, /** @type {Window} */ (/** @type {unknown} */ (window)));
            scanner.setOptions({selectText: true});
            Reflect.set(scanner, '_userHasNotSelectedAnythingManually', true);
            const prior = createSource(window.document);
            prior.setEndOffset(2, false, false);
            scanner.setCurrentTextSource(prior);
            const source = createSource(window.document);
            expect(await scanner._search(source, true, true, inputInfo)).toBe(true);
            expect(scanner.getCurrentTextSource()).toBe(source);
            expect(window.getSelection()?.toString()).toBe('𠮷');
            expect(Reflect.get(scanner, '_inputInfoCurrent')).toBe(inputInfo);
            expect(await scanner._search(source.clone(), true, true, inputInfo)).toBe(true);
            scanner.clearSelection();
            expect(scanner.getCurrentTextSource()).toBeNull();
            expect(Reflect.get(scanner, '_inputInfoCurrent')).toBeNull();
            expect(Reflect.get(scanner, '_textSourceCurrentIncomplete')).toBe(false);
            expect(window.getSelection()?.rangeCount).toBe(0);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });
});
