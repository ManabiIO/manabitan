/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

/**
 * Keep real term storage/index lookups and database cache behavior; replace only
 * database setup and glossary presentation, which are unrelated to cache keys.
 * @param {Array<{dictionary: string, expression: string}>} entries
 * @returns {Promise<DictionaryDatabase>}
 */
async function fixture(entries) {
    const store = new TermRecordOpfsStore()
    await store.appendBatch(entries.map((row) => ({
        ...row,
        reading: '',
        expressionReverse: null,
        readingReverse: null,
        entryContentOffset: 0,
        entryContentLength: 0,
        entryContentDictName: 'raw',
        score: 0,
        sequence: null,
    })))
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', {})
    Reflect.set(database, '_termRecordStore', store)
    Reflect.set(database, '_ensureDirectTermIndexesLoaded', vi.fn(async () => {}))
    Reflect.set(database, '_fetchTermRowsByIds', (/** @type {Iterable<number>} */ ids) => store.getByIdsAsync(ids))
    Reflect.set(database, '_createTerm', (matchSource, matchType, row, index) => ({dictionary: row.dictionary, term: row.expression, matchSource, matchType, index}))
    return database
}

describe('dictionary cache key identities', () => {
    test('positive postings cannot leak from one delimiter-containing name to two enabled dictionaries', async () => {
        const database = await fixture([
            {dictionary: 'A\u001fB', expression: 'needle'},
            {dictionary: 'A', expression: 'needle'},
            {dictionary: 'B', expression: 'needle'},
        ])
        const first = await database.findTermsBulk(['needle'], new Set(['A\u001fB']), 'exact')
        expect(first.map(({dictionary}) => dictionary)).toEqual(['A\u001fB'])
        for (const names of [['A', 'B'], ['B', 'A']]) {
            const result = await database.findTermsBulk(['needle'], new Set(names), 'exact')
            expect(result.map(({dictionary}) => dictionary)).toEqual(names)
        }
    })

    test.each(/** @type {const} */ (['exact', 'prefix', 'suffix']))('negative %s cache cannot hide hits in another dictionary set', async (matchType) => {
        const database = await fixture([
            {dictionary: 'A\u001fB', expression: 'other'},
            {dictionary: 'A', expression: 'needle'},
            {dictionary: 'B', expression: 'needle'},
        ])
        expect(await database.findTermsBulk(['needle'], new Set(['A\u001fB']), matchType)).toEqual([])
        const result = await database.findTermsBulk(['needle'], new Set(['A', 'B']), matchType)
        expect(result.map(({dictionary}) => dictionary)).toEqual(['A', 'B'])
    })

    test('presence cache keeps dictionary/term field boundaries distinct', async () => {
        const database = await fixture([{dictionary: 'A', expression: 'other'}, {dictionary: 'A\u001fB', expression: 'needle'}])
        expect(await database.findTermsBulk(['B\u001fneedle'], new Set(['A']), 'exact')).toEqual([])
        expect(await database.findTermsBulk(['needle'], new Set(['A\u001fB']), 'exact')).toMatchObject([{dictionary: 'A\u001fB', term: 'needle'}])
    })

    test('positive cache keeps dictionary/term record-separator boundaries distinct', async () => {
        const database = await fixture([{dictionary: 'A\u001eB', expression: 'needle'}, {dictionary: 'A', expression: 'B\u001eneedle'}])
        expect(await database.findTermsBulk(['needle'], new Set(['A\u001eB']), 'exact')).toMatchObject([{dictionary: 'A\u001eB', term: 'needle'}])
        expect(await database.findTermsBulk(['B\u001eneedle'], new Set(['A']), 'exact')).toMatchObject([{dictionary: 'A', term: 'B\u001eneedle'}])
    })
})
