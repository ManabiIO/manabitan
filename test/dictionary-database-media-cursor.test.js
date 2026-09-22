/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import sqlite3InitModule from '../ext/lib/sqlite/index.mjs'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const handles = []
beforeAll(async () => {
    const initialize = /** @type {(options: {wasmBinary: Uint8Array}) => Promise<import('@sqlite.org/sqlite-wasm').Sqlite3Static>} */ (sqlite3InitModule)
    sqlite3 = await initialize({wasmBinary: await readFile(new URL('../ext/lib/sqlite/sqlite3.wasm', import.meta.url))})
})
afterEach(() => {
    for (const handle of handles.splice(0)) { handle.close() }
})

/** @returns {{database: DictionaryDatabase, sql: import('@sqlite.org/sqlite-wasm').Database}} */
function fixture() {
    const sql = new sqlite3.oo1.DB(':memory:', 'c')
    handles.push(sql)
    sql.exec(`CREATE TABLE media (
        dictionary TEXT, path TEXT, mediaType TEXT, width INTEGER, height INTEGER,
        content BLOB, contentOffset INTEGER, contentLength INTEGER,
        contentCompressionMethod INTEGER, contentUncompressedLength INTEGER
    )`)
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', sql)
    return {database, sql}
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} sql
 * @param {string} dictionary
 * @param {string} path
 * @param {number} byte
 * @param {boolean} [external]
 */
function insert(sql, dictionary, path, byte, external = false) {
    sql.exec({
        sql: 'INSERT INTO media VALUES (?, ?, ?, 1, 1, ?, ?, ?, 0, 1)',
        bind: [dictionary, path, 'image/png', external ? new Uint8Array() : new Uint8Array([byte]), byte, external ? 1 : 0],
    })
}

/**
 * @param {import('dictionary-database').Media[]} rows
 * @returns {Array<{index: number, dictionary: string, path: string, bytes: number[]}>}
 */
function summarize(rows) {
    return rows.map(({index, dictionary, path, content}) => ({index, dictionary, path, bytes: [...new Uint8Array(content)]}))
}

describe('media query cursor ownership with real SQLite', () => {
    test.each([false, true])('overlapping equal-shaped queries retain their own rows (external=%s)', async (external) => {
        const {database, sql} = fixture()
        for (const [dictionary, start] of /** @type {[string, number][]} */ ([['A', 1], ['B', 3]])) {
            insert(sql, dictionary, 'one.png', start, external)
            insert(sql, dictionary, 'two.png', start + 1, external)
        }
        Reflect.set(database, '_termContentStore', {readSlice: vi.fn(async (/** @type {number} */ offset) => new Uint8Array([offset]))})
        const requests = ['A', 'B'].map((dictionary) => ['one.png', 'two.png'].map((path) => ({dictionary, path})))
        const [a, b] = await Promise.all(requests.map((items) => database.getMedia(items)))
        expect(summarize(a)).toEqual([
            {index: 0, dictionary: 'A', path: 'one.png', bytes: [1]},
            {index: 1, dictionary: 'A', path: 'two.png', bytes: [2]},
        ])
        expect(summarize(b)).toEqual([
            {index: 0, dictionary: 'B', path: 'one.png', bytes: [3]},
            {index: 1, dictionary: 'B', path: 'two.png', bytes: [4]},
        ])
    })

    test('simultaneous identical requests each return every row exactly once', async () => {
        const {database, sql} = fixture()
        insert(sql, 'A', 'one.png', 1)
        insert(sql, 'A', 'two.png', 2)
        const request = ['one.png', 'two.png', 'one.png'].map((path) => ({dictionary: 'A', path}))
        const results = await Promise.all(Array.from({length: 4}, async () => summarize(await database.getMedia(request))))
        const expected = [
            {index: 0, dictionary: 'A', path: 'one.png', bytes: [1]},
            {index: 2, dictionary: 'A', path: 'one.png', bytes: [1]},
            {index: 1, dictionary: 'A', path: 'two.png', bytes: [2]},
        ]
        for (const result of results) { expect(result).toEqual(expected) }
    })

    test('cache eviction during an external read does not finalize the active cursor', async () => {
        const {database, sql} = fixture()
        Reflect.set(database, '_statementCacheMaxEntries', 1)
        insert(sql, 'A', 'one.png', 1, true)
        insert(sql, 'A', 'two.png', 2, true)
        Reflect.set(database, '_termContentStore', {
            readSlice: vi.fn(async (/** @type {number} */ offset) => {
                const statement = Reflect.get(database, '_getCachedStatement').call(database, `SELECT ${offset}`)
                statement.step()
                return new Uint8Array([offset])
            }),
        })
        const result = await database.getMedia(['one.png', 'two.png'].map((path) => ({dictionary: 'A', path})))
        expect(summarize(result).map(({bytes}) => bytes)).toEqual([[1], [2]])
    })

    test('multi-chunk concurrent requests retain duplicate associations and missing-item behavior', async () => {
        const {database, sql} = fixture()
        const requests = ['A', 'B'].map((dictionary) => {
            const items = Array.from({length: 257}, (_, i) => {
                const path = `image-${i}.png`
                insert(sql, dictionary, path, i % 256)
                return {dictionary, path}
            })
            items.push(items[0], {dictionary, path: 'missing.png'})
            return items
        })
        const results = await Promise.all(requests.map((items) => database.getMedia(items)))
        for (let i = 0; i < results.length; ++i) {
            const result = results[i]
            expect(result).toHaveLength(258)
            expect(new Set(result.map(({index}) => index)).size).toBe(258)
            for (const row of result) {
                expect(row.dictionary).toBe(requests[i][row.index].dictionary)
                expect(row.path).toBe(requests[i][row.index].path)
                expect([...new Uint8Array(row.content)]).toEqual([row.index === 257 ? 0 : row.index % 256])
            }
        }
    })

    test('deserialization failure releases the cursor and later calls can retry', async () => {
        const {database, sql} = fixture()
        insert(sql, 'A', 'one.png', 1)
        insert(sql, 'A', 'two.png', 2)
        const deserialize = Reflect.get(database, '_deserializeMediaRow')
        Reflect.set(database, '_deserializeMediaRow', vi.fn().mockRejectedValueOnce(new Error('conversion failed')))
        const items = ['one.png', 'two.png'].map((path) => ({dictionary: 'A', path}))
        await expect(database.getMedia(items)).rejects.toThrow('conversion failed')
        // No active read cursor should obstruct a table change after rejection.
        expect(() => sql.exec('DROP TABLE media')).not.toThrow()
        Reflect.set(database, '_deserializeMediaRow', deserialize)
    })
})

describe('exact dictionary and media request identity', () => {
    test.each(['unit\u001fseparator', '\u001elead\u001ftrail\u001f', '12:長い名前😀', 'quote"\\name'])('media returns the full exact dictionary and path %j', async (value) => {
        const {database, sql} = fixture()
        insert(sql, value, 'same.png', 7)
        insert(sql, 'Dictionary', value, 8)
        const result = await database.getMedia([
            {dictionary: value, path: 'same.png'},
            {dictionary: 'Dictionary', path: value},
            {dictionary: value, path: 'same.png'},
        ])
        expect(summarize(result).sort((a, b) => a.index - b.index)).toEqual([
            {index: 0, dictionary: value, path: 'same.png', bytes: [7]},
            {index: 1, dictionary: 'Dictionary', path: value, bytes: [8]},
            {index: 2, dictionary: value, path: 'same.png', bytes: [7]},
        ])
    })

    test('separator collisions do not merge media requests or their duplicate associations', async () => {
        const {database, sql} = fixture()
        insert(sql, 'A', 'B\u001fone.png', 1)
        insert(sql, 'A\u001fB', 'one.png', 2)
        // Previously the split query selected this unrelated partial name.
        insert(sql, 'A', 'B', 3)
        const result = await database.getMedia([
            {dictionary: 'A', path: 'B\u001fone.png'},
            {dictionary: 'A\u001fB', path: 'one.png'},
            {dictionary: 'A', path: 'B\u001fone.png'},
        ])
        expect(summarize(result).sort((a, b) => a.index - b.index)).toEqual([
            {index: 0, dictionary: 'A', path: 'B\u001fone.png', bytes: [1]},
            {index: 1, dictionary: 'A\u001fB', path: 'one.png', bytes: [2]},
            {index: 2, dictionary: 'A', path: 'B\u001fone.png', bytes: [1]},
        ])
    })

    test('tag queries retain separator characters across batching and missing entries', async () => {
        const {database, sql} = fixture()
        sql.exec('CREATE TABLE tagMeta (dictionary TEXT, name TEXT, category TEXT, ord INTEGER, notes TEXT, score INTEGER)')
        const items = Array.from({length: 260}, (_, i) => ({dictionary: `D${i}\u001fpart`, query: `tag\u001f${i}`}))
        items.push({dictionary: 'D0', query: 'part\u001ftag\u001f0'}, items[0], {dictionary: 'missing', query: 'absent'})
        for (const [i, item] of items.slice(0, 261).entries()) {
            sql.exec({sql: 'INSERT INTO tagMeta VALUES (?, ?, ?, ?, ?, ?)', bind: [item.dictionary, item.query, 'test', i, `notes-${i}`, i]})
        }
        const result = await database.findTagMetaBulk(items)
        expect(result).toHaveLength(items.length)
        for (let i = 0; i < 262; ++i) {
            expect(result[i]).toMatchObject({dictionary: items[i].dictionary, name: items[i].query, score: i === 261 ? 0 : i})
        }
        expect(result[262]).toBeUndefined()
    })
})
