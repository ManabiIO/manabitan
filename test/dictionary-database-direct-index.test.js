/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {Translator} from '../ext/js/language/translator.js';

const partialMatchTypes = /** @type {const} */ (['prefix', 'suffix']);

/**
 * @param {{expression?: Map<string, number[]>, reading?: Map<string, number[]>, expressionReverse?: Map<string, number[]>, readingReverse?: Map<string, number[]>} } [index={}]
 * @returns {DictionaryDatabase}
 */
function createDatabase(index = {}) {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', {});
    const completeIndex = {
        expression: new Map(),
        reading: new Map(),
        expressionReverse: new Map(),
        readingReverse: new Map(),
        ...index,
    };
    Reflect.set(database, '_ensureDirectTermIndexesLoaded', vi.fn(async () => {}));
    Reflect.set(database, '_ensureDirectTermIndex', vi.fn().mockReturnValue(completeIndex));
    Reflect.set(database, '_getDictionaryNames', vi.fn().mockReturnValue(['Test']));
    Reflect.set(database, '_fetchTermRowsByIds', vi.fn(async (ids) => new Map([...ids].map((id) => [id, {id}]))));
    Reflect.set(database, '_createTerm', vi.fn((matchSource, matchType, row, itemIndex) => ({
        id: row.id,
        matchSource,
        matchType,
        itemIndex,
    })));
    Reflect.set(database, '_termRecordStore', {ensureDictionaryReverseIndex: vi.fn()});
    return database;
}

describe('DictionaryDatabase direct term indexes', () => {
    test('normalizes dictionary iterables without quadratic duplicate scans', () => {
        const database = new DictionaryDatabase();
        const iterable = {
            *[Symbol.iterator]() {
                yield 'JMdict';
                yield '';
                yield 'Jitendex';
                yield 'JMdict';
            },
        };

        expect(database._getUniqueDictionaryNames(iterable)).toEqual(['JMdict', 'Jitendex']);
        expect(database._getUniqueDictionaryNames(new Set(['JMdict', '', 'Jitendex'])))
            .toEqual(['JMdict', 'Jitendex']);
    });

    test('keeps positive exact cache keys sensitive to dictionary order', () => {
        const database = new DictionaryDatabase();
        const createKey = Reflect.get(database, '_createTermExactMatchCacheKey').bind(database);

        expect(createKey(['JMdict', 'Jitendex'], '食べる'))
            .not.toBe(createKey(['Jitendex', 'JMdict'], '食べる'));
    });

    test('exact lookup preserves every duplicate input association without duplicating index IDs', async () => {
        const database = createDatabase({expression: new Map([['食べる', [7, 7]]])});

        const results = await database.findTermsBulk(['食べる', '食べる'], new Set(['Test']), 'exact');

        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 1},
        ]);
    });

    test('exact lookup resolves expression and reading postings with one store probe', async () => {
        const database = createDatabase({});
        const findTermIdMatches = vi.fn().mockReturnValue({expression: [7], reading: [8]});
        Reflect.set(database, '_termRecordStore', {findTermIdMatches});

        const results = await database.findTermsBulk(['食べる'], new Set(['Test']), 'exact');

        expect(findTermIdMatches).toHaveBeenCalledOnce();
        expect(findTermIdMatches).toHaveBeenCalledWith('Test', '食べる');
        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
            {id: 8, matchSource: 'reading', matchType: 'exact', itemIndex: 0},
        ]);
    });

    test('queries immutable term-record storage while preserving the logical dictionary title', async () => {
        const database = createDatabase({});
        const findTermIdMatches = vi.fn().mockReturnValue({expression: [7], reading: []});
        Reflect.set(database, '_termRecordStore', {findTermIdMatches});
        Reflect.get(database, '_registerTermRecordStorageName').call(
            database,
            'JMdict [2026-02-26]',
            'JMdict [update-staging token123]',
        );
        Reflect.set(database, '_getDictionaryNames', vi.fn().mockReturnValue(['JMdict [2026-02-26]']));

        const results = await database.findTermsBulk(
            ['食べる'],
            new Set(['JMdict [2026-02-26]']),
            'exact',
        );

        expect(findTermIdMatches).toHaveBeenCalledWith('JMdict [update-staging token123]', '食べる');
        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
        ]);
    });

    test('exact lookup probes all enabled dictionaries through one shared-query call', async () => {
        const database = createDatabase({});
        Reflect.set(database, '_getDictionaryNames', vi.fn().mockReturnValue(['JMdict', 'Jitendex']));
        const findTermIdMatchesForDictionaries = vi.fn().mockReturnValue([
            {expression: [7], reading: []},
            {expression: [], reading: [8]},
        ]);
        Reflect.set(database, '_termRecordStore', {findTermIdMatchesForDictionaries});

        const results = await database.findTermsBulk(['食べる'], new Set(['JMdict', 'Jitendex']), 'exact');

        expect(findTermIdMatchesForDictionaries).toHaveBeenCalledOnce();
        expect(findTermIdMatchesForDictionaries).toHaveBeenCalledWith(['JMdict', 'Jitendex'], '食べる');
        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
            {id: 8, matchSource: 'reading', matchType: 'exact', itemIndex: 0},
        ]);
    });

    test('reuses bounded positive exact postings across repeated lookups', async () => {
        const database = createDatabase({});
        const findTermIdMatchesForDictionaries = vi.fn().mockReturnValue([
            {expression: [7], reading: [8]},
        ]);
        Reflect.set(database, '_termRecordStore', {findTermIdMatchesForDictionaries});

        const first = await database.findTermsBulk(['食べる'], new Set(['Test']), 'exact');
        const second = await database.findTermsBulk(['食べる'], new Set(['Test']), 'exact');

        expect(second).toEqual(first);
        expect(findTermIdMatchesForDictionaries).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_termExactMatchCache').size).toBe(1);

        Reflect.get(database, '_clearDirectTermIndexCaches').call(database);
        await database.findTermsBulk(['食べる'], new Set(['Test']), 'exact');
        expect(findTermIdMatchesForDictionaries).toHaveBeenCalledTimes(2);
    });

    test('does not cache an empty exact result while dictionary storage is temporarily unavailable', async () => {
        const database = createDatabase({});
        let available = false;
        const findTermIdMatchesForDictionaries = vi.fn(() => [{expression: [7], reading: []}]);
        Reflect.set(database, '_termRecordStore', {
            isDictionaryAvailable: vi.fn(() => available),
            findTermIdMatchesForDictionaries,
        });

        await expect(database.findTermsBulk(['食べる'], new Set(['Test']), 'exact')).resolves.toEqual([]);
        expect(findTermIdMatchesForDictionaries).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_termExactPresenceCache').size).toBe(0);

        available = true;
        await expect(database.findTermsBulk(['食べる'], new Set(['Test']), 'exact')).resolves.toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
        ]);
        expect(findTermIdMatchesForDictionaries).toHaveBeenCalledOnce();
    });

    test('retries loading after a previously loaded dictionary becomes temporarily unavailable', async () => {
        const database = new DictionaryDatabase();
        Reflect.set(database, '_db', {});
        const ensureDictionariesLoaded = vi.fn(async () => {});
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded,
            isDictionaryAvailable: vi.fn(() => true),
            hasPersistentTermLookupIndex: vi.fn(() => true),
        });
        Reflect.get(database, '_directTermIndexLoadedDictionaryNames').add('Test');
        const directIndex = /** @type {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}} */ ({
            expression: new Map(),
            reading: new Map(),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        });
        Reflect.get(database, '_directTermIndexByDictionary').set('Test', directIndex);

        database._onTermRecordDictionaryHealthChanged(
            'Test',
            'temporarilyUnavailable',
            'injected transient read failure',
        );

        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Test')).toBe(false);
        expect(Reflect.get(database, '_directTermIndexByDictionary').has('Test')).toBe(false);
        await database._ensureDirectTermIndexesLoaded(['Test']);
        expect(ensureDictionariesLoaded).toHaveBeenCalledOnce();
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Test')).toBe(true);
    });

    test('suffix lookup marks a complete reversed-key match as exact', async () => {
        const database = createDatabase({expressionReverse: new Map([['るべ食', [7]]])});

        const results = await database.findTermsBulk(['食べる'], new Set(['Test']), 'suffix');

        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
        ]);
    });

    test.each(partialMatchTypes)('%s lookup preserves overlapping and repeated query associations', async (matchType) => {
        const reverse = matchType === 'suffix';
        const expression = 'helpful';
        const shortQuery = reverse ? 'ful' : 'help';
        const key = reverse ? [...expression].reverse().join('') : expression;
        const database = createDatabase({[reverse ? 'expressionReverse' : 'expression']: new Map([[key, [7, 7]]])});
        const terms = [shortQuery, expression, shortQuery];
        const expected = [];
        for (let itemIndex = 0; itemIndex < terms.length; ++itemIndex) {
            const single = await database.findTermsBulk([terms[itemIndex]], new Set(['Test']), matchType);
            expected.push(...single.map((result) => ({...result, itemIndex})));
        }

        vi.mocked(database._fetchTermRowsByIds).mockClear();
        const results = await database.findTermsBulk(terms, new Set(['Test']), matchType);

        expect([...results].sort((a, b) => Reflect.get(a, 'itemIndex') - Reflect.get(b, 'itemIndex'))).toEqual(expected);
        expect(results).toHaveLength(3);
        expect(results).toContainEqual({id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 1});
        expect(Reflect.get(database, '_fetchTermRowsByIds')).toHaveBeenCalledOnce();
    });

    test.each(partialMatchTypes)('%s lookup does not let an earlier reading match hide a later expression match', async (matchType) => {
        const reverse = matchType === 'suffix';
        const transform = (/** @type {string} */ value) => (reverse ? [...value].reverse().join('') : value);
        const database = createDatabase({
            [reverse ? 'expressionReverse' : 'expression']: new Map([[transform('猫'), [7, 7]]]),
            [reverse ? 'readingReverse' : 'reading']: new Map([[transform('ねこ'), [7, 7]]]),
        });

        const results = await database.findTermsBulk(['ねこ', '猫'], new Set(['Test']), matchType);

        expect(results).toEqual([
            {id: 7, matchSource: 'reading', matchType: 'exact', itemIndex: 0},
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 1},
        ]);
        expect(Reflect.get(database, '_fetchTermRowsByIds')).toHaveBeenCalledOnce();
    });

    test.each(partialMatchTypes)('%s lookup shares persistent probes and record reads without dropping associations', async (matchType) => {
        const database = createDatabase();
        const shortQuery = matchType === 'suffix' ? 'ful' : 'help';
        const find = vi.fn((/** @type {string[]} */ dictionaryNames, /** @type {string} */ query) => [{
            expression: [{id: 7, exact: query === 'helpful'}, {id: 7, exact: query === 'helpful'}],
            reading: [{id: 7, exact: false}],
        }]);
        Reflect.set(database, '_termRecordStore', {findTermPrefixIdMatchesForDictionaries: find});

        const results = await database.findTermsBulk([shortQuery, 'helpful', shortQuery], new Set(['Test']), matchType);

        expect(results).toHaveLength(3);
        expect(results).toContainEqual({id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 1});
        expect(results.map((result) => Reflect.get(result, 'itemIndex')).sort((a, b) => a - b)).toEqual([0, 1, 2]);
        expect(find).toHaveBeenCalledTimes(2);
        expect(find).toHaveBeenNthCalledWith(1, ['Test'], shortQuery, matchType === 'suffix');
        expect(find).toHaveBeenNthCalledWith(2, ['Test'], 'helpful', matchType === 'suffix');
        expect(Reflect.get(database, '_fetchTermRowsByIds')).toHaveBeenCalledOnce();
    });

    test('prefix lookup retains a valid deinflection when the first overlapping query fails POS filtering', async () => {
        const database = createDatabase({expression: new Map([['help', [7]]])});
        Reflect.set(database, '_createTerm', DictionaryDatabase.prototype._createTerm.bind(database));
        Reflect.set(database, '_fetchTermRowsByIds', vi.fn(async () => new Map([[7, {
            id: 7,
            expression: 'help',
            reading: '',
            dictionary: 'Test',
            definitionTags: '',
            termTags: '',
            rules: 'v',
            glossary: ['assist'],
            score: 0,
            sequence: -1,
        }]])));
        const translator = new Translator(database);
        translator.prepare();
        const transformer = Reflect.get(translator, '_multiLanguageTransformer');
        const nounConditions = transformer.getConditionFlagsFromPartsOfSpeech('en', ['n']);
        const verbConditions = transformer.getConditionFlagsFromPartsOfSpeech('en', ['v']);
        expect(nounConditions).not.toBe(0);
        expect(verbConditions).not.toBe(0);
        const createDeinflection = Reflect.get(translator, '_createDeinflection').bind(translator);
        const deinflections = [
            createDeinflection('helped', 'helped', 'hel', nounConditions, [], []),
            createDeinflection('helped', 'helped', 'help', verbConditions, [], []),
        ];
        const dictionaries = new Map([['Test', {
            index: 0, alias: 'Test', allowSecondarySearches: false, partsOfSpeechFilter: true, useDeinflections: true,
        }]]);

        await Reflect.get(translator, '_addEntriesToDeinflections').call(translator, 'en', deinflections, dictionaries, 'prefix');

        expect(deinflections[0].databaseEntries).toEqual([]);
        expect(deinflections[1].databaseEntries).toMatchObject([{id: 7, term: 'help', matchType: 'exact', index: 1}]);
    });
});
