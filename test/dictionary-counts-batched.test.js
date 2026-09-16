/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {Awaited<ReturnType<typeof sqlite3InitModule>>} */
let sqlite3
/** @type {Array<() => void>} */
const cleanups = []
const tables = ['kanji', 'kanjiMeta', 'termMeta', 'tagMeta', 'media']
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) { cleanup() }
    vi.restoreAllMocks()
})

function fixture() {
    const connection = new sqlite3.oo1.DB(':memory:')
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', connection)
    connection.exec('CREATE TABLE dictionaries(title TEXT, summaryJson TEXT)')
    const names = ['JMdict', 'Jitendex', "A' quoted", '', '日本語', 'orphan']
    for (const [i, title] of names.entries()) {
        if (title === '' || title === 'orphan') { continue }
        connection.exec({sql: 'INSERT INTO dictionaries VALUES(?, ?)', bind: [title, JSON.stringify({counts: {terms: {total: 100 + i}}})]})
    }
    for (const [t, table] of tables.entries()) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT NOT NULL)`)
        const statement = connection.prepare(`INSERT INTO ${table} VALUES(?)`)
        try {
            for (const [i, title] of names.entries()) {
                for (let j = 0; j < (i + 1) * (t + 1); ++j) { statement.bind([title]).stepReset() }
            }
        } finally { statement.finalize() }
    }
    const ensureDictionariesLoaded = vi.fn(async () => {})
    Reflect.set(database, '_termRecordStore', {ensureDictionariesLoaded})
    Reflect.set(database, '_getDirectDictionaryRecordCount', (name) => (name === 'legacy' ? 7 : 0))
    cleanups.push(() => connection.close())
    /**
     * @param {string[]} requested
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    const check = async (requested, getTotal) => {
        const actual = await database.getDictionaryCounts(requested, getTotal)
        expect(actual.counts).toHaveLength(requested.length)
        for (const [i, name] of requested.entries()) {
            for (const table of tables) {
                expect(actual.counts[i][table]).toBe(connection.selectValue(`SELECT COUNT(*) FROM ${table} WHERE dictionary = ?`, [name]))
            }
        }
        if (getTotal) {
            for (const table of tables) { expect(actual.total?.[table]).toBe(connection.selectValue(`SELECT COUNT(*) FROM ${table}`)) }
        } else { expect(actual.total).toBeNull() }
        return actual
    }
    return {connection, database, ensureDictionariesLoaded, check}
}

describe('batched dictionary side-table counts', () => {
    test.each([false, true])('matches direct counts for missing, repeated and quoted names; total=%s', async (getTotal) => {
        const {check} = fixture()
        for (const names of [[], ['JMdict'], ['JMdict', 'JMdict'], ['Jitendex', 'JMdict'], ['JMdict', 'missing', 'JMdict'], ["A' quoted", '', '日本語'], ['orphan', 'missing']]) {
            await check(names, getTotal)
        }
    })

    test('uses one conditional-count query per table while retaining duplicate result slots', async () => {
        const {database, connection} = fixture()
        const scalar = vi.spyOn(connection, 'selectValue')
        const rows = vi.spyOn(connection, 'selectObjects')
        const result = await database.getDictionaryCounts(['JMdict', 'Jitendex', 'JMdict'], true)
        expect(result.counts[0]).toEqual(result.counts[2])
        expect(scalar).not.toHaveBeenCalled()
        expect(rows).toHaveBeenCalledTimes(6)
        expect(result.total?.termMeta).toBe(63)
        expect(result.total?.terms).toBe(407)
    })

    test('retains the scalar count path for one unique requested dictionary', async () => {
        const {database, connection} = fixture()
        const rows = vi.spyOn(connection, 'selectObjects')
        const scalar = vi.spyOn(connection, 'selectValue')
        await database.getDictionaryCounts(['JMdict'], true)
        expect(rows).toHaveBeenCalledTimes(1)
        expect(scalar).toHaveBeenCalledTimes(10)
    })

    test('retains indexed equality queries when secondary indexes are enabled', async () => {
        const {database, connection, check} = fixture()
        Reflect.set(database, '_enableSqliteSecondaryIndexes', true)
        for (const table of tables) { connection.exec(`CREATE INDEX idx_${table}_dictionary ON ${table}(dictionary)`) }
        const rows = vi.spyOn(connection, 'selectObjects')
        const scalar = vi.spyOn(connection, 'selectValue')
        await database.getDictionaryCounts(['JMdict', 'Jitendex'], true)
        expect(rows).toHaveBeenCalledTimes(1)
        expect(scalar).toHaveBeenCalledTimes(15)
        await check(['JMdict', 'Jitendex'], true)
    })

    test('counts totals once across batches and binds names rather than interpolating SQL', async () => {
        const {database, connection, check} = fixture()
        const names = ['JMdict', 'Jitendex', "A' quoted", ...Array.from({length: 80}, (_, i) => `missing-${i}`)]
        const rows = vi.spyOn(connection, 'selectObjects')
        await database.getDictionaryCounts(names, true)
        expect(rows).toHaveBeenCalledTimes(16)
        const queries = rows.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('FILTER'))
        expect(queries).toHaveLength(15)
        expect(queries.filter(([sql]) => typeof sql === 'string' && sql.includes(' AS total'))).toHaveLength(5)
        for (const [sql, bindings] of queries) {
            if (typeof sql !== 'string') { throw new TypeError('Expected SQL text') }
            expect(sql).not.toContain('quoted')
            expect(Array.isArray(bindings)).toBe(true)
            expect(/** @type {unknown[]} */ (bindings)).toHaveLength(sql.match(/\?\d+/g)?.length ?? 0)
            expect(/** @type {unknown[]} */ (bindings).length).toBeLessThanOrEqual(32)
        }
        await check(names, true)
    })

    test('does not reuse stale counts after inserts, updates or deletes', async () => {
        const {check, connection} = fixture()
        await check(['JMdict', 'Jitendex'], true)
        for (const table of tables) {
            connection.exec(`INSERT INTO ${table} VALUES('JMdict')`)
            connection.exec(`UPDATE ${table} SET dictionary='Moved' WHERE dictionary='Jitendex'`)
        }
        await check(['JMdict', 'Jitendex', 'Moved'], true)
        for (const table of tables) { connection.exec(`DELETE FROM ${table} WHERE dictionary='JMdict'`) }
        await check(['JMdict', 'Moved'], true)
    })

    test('keeps totals for rows without an installed dictionary summary and legacy fallback', async () => {
        const {check, connection, ensureDictionariesLoaded} = fixture()
        connection.exec({sql: 'INSERT INTO dictionaries VALUES(?, ?)', bind: ['legacy', '{invalid']})
        const result = await check(['JMdict', 'legacy', 'orphan'], true)
        expect(result.counts[1].terms).toBe(7)
        expect(result.counts[2].terms).toBe(0)
        expect(result.total?.terms).toBe(414)
        expect(ensureDictionariesLoaded).toHaveBeenCalledOnce()
    })

    test('bounds each query and supports more names than the legacy SQLite bind budget', async () => {
        const {check} = fixture()
        // Each query binds at most 32 requested names.
        const result = await check(['JMdict', ...Array.from({length: 1200}, (_, i) => `missing-${i}`)], false)
        expect(result.counts[0].terms).toBe(100)
    })
})
