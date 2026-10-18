/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {stringReverse} from '../ext/js/core/utilities.js';

const fixture = /** @type {{expression: string, reading: string}[]} */ (JSON.parse(readFileSync(new URL('data/manabitan-lookup-regressions/suffix-match-classification.json', import.meta.url), 'utf8')));

/** @returns {DictionaryDatabase} */
function createDatabase() {
    const database = new DictionaryDatabase();
    const index = {
        expression: new Map(),
        reading: new Map(),
        expressionReverse: new Map(),
        readingReverse: new Map(),
        pair: new Map(),
        sequence: new Map(),
    };
    const rows = new Map();
    for (let i = 0; i < fixture.length; ++i) {
        const {expression, reading} = fixture[i];
        const id = i + 1;
        index.expression.set(expression, [id]);
        index.reading.set(reading, [id]);
        index.expressionReverse.set(stringReverse(expression), [id]);
        index.readingReverse.set(stringReverse(reading), [id]);
        rows.set(id, {id, expression, reading, dictionary: 'suffix-fixture', glossary: [], score: 0, sequence: -1});
    }
    // Only persistence/content loading is replaced; exercise the public lookup,
    // sorted prefix search, query reversal, and result classification unchanged.
    Reflect.set(database, '_db', {});
    Reflect.set(database, '_termRecordStore', {
        ensureDictionariesLoaded: async () => {},
        getDictionaryIndex: () => index,
        ensureDictionaryReverseIndex: () => {},
    });
    Reflect.set(database, '_fetchTermRowsByIds', async (/** @type {Iterable<number>} */ ids) => (
        new Map([...ids].map((id) => [id, rows.get(id)]))
    ));
    return database;
}

describe('DictionaryDatabase suffix result classification', () => {
    test.each([
        {query: '日本', exact: '日本', suffix: '大日本', source: 'term'},
        {query: 'にほん', exact: '日本', suffix: '大日本', source: 'reading'},
        {query: '𠮷山', exact: '𠮷山', suffix: '大𠮷山', source: 'term'},
    ])('distinguishes exact and extended suffix hits for $query', async ({query, exact, suffix, source}) => {
        const results = await createDatabase().findTermsBulk([query], new Set(['suffix-fixture']), 'suffix');
        expect(results.map(({term, matchType, matchSource, index}) => ({term, matchType, matchSource, index}))).toEqual([
            {term: exact, matchType: 'exact', matchSource: source, index: 0},
            {term: suffix, matchType: 'suffix', matchSource: source, index: 0},
        ]);
    });

    test('retains exact classification for palindromic suffix keys', async () => {
        const results = await createDatabase().findTermsBulk(['人人'], new Set(['suffix-fixture']), 'suffix');
        expect(results.map(({term, matchType}) => ({term, matchType}))).toEqual([{term: '人人', matchType: 'exact'}]);
    });

    test('retains exact and extended prefix classification', async () => {
        const results = await createDatabase().findTermsBulk(['日'], new Set(['suffix-fixture']), 'prefix');
        expect(results.map(({term, matchType}) => ({term, matchType}))).toEqual([{term: '日本', matchType: 'prefix'}]);
        const exact = await createDatabase().findTermsBulk(['日本'], new Set(['suffix-fixture']), 'prefix');
        expect(exact.map(({term, matchType}) => ({term, matchType}))).toEqual([{term: '日本', matchType: 'exact'}]);
    });
});
