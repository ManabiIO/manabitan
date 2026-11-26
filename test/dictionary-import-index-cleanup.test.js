/*
 * Copyright (C) 2026 Manabitan authors
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

/* eslint-disable @stylistic/semi */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import sqlite3InitModule from '../ext/lib/sqlite/index.mjs'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {Array<{database: DictionaryDatabase, sql: import('@sqlite.org/sqlite-wasm').Database}>} */
const fixtures = []

beforeAll(async () => {
    const initialize = /** @type {(options: {wasmBinary: Uint8Array}) => Promise<import('@sqlite.org/sqlite-wasm').Sqlite3Static>} */ (sqlite3InitModule)
    sqlite3 = await initialize({wasmBinary: await readFile(new URL('../ext/lib/sqlite/sqlite3.wasm', import.meta.url))})
})

afterEach(() => {
    vi.restoreAllMocks()
    for (const {database, sql} of fixtures.splice(0)) {
        database._clearCachedStatements()
        sql.close()
    }
})

/**
 * Keep real SQLite schema, prepared inserts and transactions. OPFS checkpoints
 * and virtual-table storage are outside this index-lifecycle regression.
 * @param {boolean} [enabled]
 * @returns {Promise<{database: DictionaryDatabase, sql: import('@sqlite.org/sqlite-wasm').Database}>}
 */
async function createFixture(enabled = false) {
    const sql = new sqlite3.oo1.DB(':memory:', 'c')
    const database = new DictionaryDatabase()
    fixtures.push({database, sql})
    Reflect.set(database, '_db', sql)
    Reflect.set(database, '_enableSqliteSecondaryIndexes', enabled)
    vi.spyOn(database, '_ensureTermsVirtualTable').mockResolvedValue()
    const content = database._termContentStore
    const records = database._termRecordStore
    vi.spyOn(content, 'createImportCheckpoint').mockResolvedValue({segments: []})
    vi.spyOn(records, 'createImportCheckpoint').mockResolvedValue({shards: []})
    for (const store of [content, records]) {
        vi.spyOn(store, 'beginImportSession').mockResolvedValue()
        vi.spyOn(store, 'endImportSession').mockResolvedValue()
        vi.spyOn(store, 'rollbackImportSession').mockResolvedValue()
        vi.spyOn(store, 'getLastEndImportSessionMetrics').mockReturnValue(null)
    }
    vi.spyOn(database._importJournal, 'write').mockResolvedValue()
    vi.spyOn(database._importJournal, 'clear').mockResolvedValue()
    await database._initializeSchema()
    return {database, sql}
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} sql
 * @returns {import('@sqlite.org/sqlite-wasm').SqlValue[]}
 */
function secondaryIndexes(sql) {
    return sql.selectValues("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
}

/**
 * @param {DictionaryDatabase} database
 * @param {string} dictionary
 * @param {string} name
 */
async function addTag(database, dictionary, name) {
    await database.bulkAdd('tagMeta', [{dictionary, name, category: '', order: 0, notes: '', score: 0}], 0, 1)
}

describe('dictionary import secondary-index cleanup', () => {
    test('schema startup removes existing and legacy indexes once before repeated default imports', async () => {
        const {database, sql} = await createFixture(true)
        sql.exec("INSERT INTO termMeta(dictionary, expression, mode, dataJson) VALUES ('Installed frequency', '猫', 'freq', '7')")
        sql.exec('CREATE INDEX idx_term_meta_expression ON termMeta(expression)')
        sql.exec('CREATE INDEX idx_kanji_character ON kanji(character)')
        expect(secondaryIndexes(sql)).toHaveLength(10)

        Reflect.set(database, '_enableSqliteSecondaryIndexes', false)
        await database._initializeSchema()
        expect(secondaryIndexes(sql)).toEqual([])
        const exec = vi.spyOn(sql, 'exec')
        for (const title of ['JMdict', 'Jitendex', 'VNDB']) {
            const session = await database.startBulkImport()
            await addTag(database, title, 'published')
            await database.finishBulkImport(null, null, session)
        }

        const drops = exec.mock.calls.filter(([value]) => typeof value === 'string' && value.startsWith('DROP INDEX'))
        expect(drops).toEqual([])
        expect(database._createDropIndexesSql()).toHaveLength(23)
        expect(secondaryIndexes(sql)).toEqual([])
        expect(sql.selectValues('SELECT dictionary FROM tagMeta ORDER BY id')).toEqual(['JMdict', 'Jitendex', 'VNDB'])
        expect(sql.selectObjects('SELECT dictionary, expression, dataJson FROM termMeta')).toEqual([
            {dictionary: 'Installed frequency', expression: '猫', dataJson: '7'},
        ])
    })

    test('abort and retry preserve default schema cleanup and SQLite rollback', async () => {
        const {database, sql} = await createFixture()
        const exec = vi.spyOn(sql, 'exec')
        const cancelled = await database.startBulkImport()
        await addTag(database, 'Jitendex', 'cancelled')
        await database.abortBulkImport(cancelled)
        expect(sql.selectValue('SELECT count(*) FROM tagMeta')).toBe(0)

        const retry = await database.startBulkImport()
        expect(retry).not.toBe(cancelled)
        await addTag(database, 'Jitendex', 'retry')
        await database.finishBulkImport(null, null, retry)

        expect(sql.selectValues('SELECT name FROM tagMeta')).toEqual(['retry'])
        expect(secondaryIndexes(sql)).toEqual([])
        expect(exec.mock.calls.some(([value]) => typeof value === 'string' && value.startsWith('DROP INDEX'))).toBe(false)
    })

    test.each(['abort', 'finish'])('enabled indexes still drop before writes and rebuild after %s', async (finish) => {
        const {database, sql} = await createFixture(true)
        const initial = secondaryIndexes(sql)
        expect(initial).toHaveLength(8)
        const exec = vi.spyOn(sql, 'exec')
        const session = await database.startBulkImport()
        expect(secondaryIndexes(sql)).toEqual([])
        await addTag(database, 'Jitendex', finish)
        if (finish === 'abort') {
            await database.abortBulkImport(session)
        } else {
            await database.finishBulkImport(null, null, session)
        }

        expect(secondaryIndexes(sql)).toEqual(initial)
        expect(sql.selectValues('SELECT name FROM tagMeta')).toEqual(finish === 'abort' ? [] : ['finish'])
        const drops = exec.mock.calls.filter(([value]) => typeof value === 'string' && value.startsWith('DROP INDEX'))
        expect(drops).toHaveLength(23)
    })
})
