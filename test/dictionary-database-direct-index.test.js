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

    test('suffix lookup marks a complete reversed-key match as exact', async () => {
        const database = createDatabase({expressionReverse: new Map([['るべ食', [7]]])});

        const results = await database.findTermsBulk(['食べる'], new Set(['Test']), 'suffix');

        expect(results).toEqual([
            {id: 7, matchSource: 'term', matchType: 'exact', itemIndex: 0},
        ]);
    });
});
