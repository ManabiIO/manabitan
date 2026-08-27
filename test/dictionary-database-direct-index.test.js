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

/**
 * @param {{expression?: Map<string, number[]>, reading?: Map<string, number[]>, expressionReverse?: Map<string, number[]>, readingReverse?: Map<string, number[]>}} index
 * @returns {DictionaryDatabase}
 */
function createDatabase(index) {
    const database = new DictionaryDatabase();
    Reflect.set(database, '_db', {});
    const completeIndex = {
        expression: new Map(),
        reading: new Map(),
        expressionReverse: new Map(),
        readingReverse: new Map(),
        ...index,
    };
    Reflect.set(database, '_ensureDirectTermIndexesLoaded', vi.fn().mockResolvedValue());
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
        const ensureDictionariesLoaded = vi.fn().mockResolvedValue(undefined);
        Reflect.set(database, '_termRecordStore', {
            ensureDictionariesLoaded,
            isDictionaryAvailable: vi.fn(() => true),
            hasPersistentTermLookupIndex: vi.fn(() => true),
        });
        Reflect.get(database, '_directTermIndexLoadedDictionaryNames').add('Test');
        Reflect.get(database, '_directTermIndexByDictionary').set('Test', {});

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
});
