/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []

beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    vi.restoreAllMocks()
    for (const connection of connections.splice(0)) { connection.close() }
})

/**
 * Exercise real schema DDL and transactions. Only OPFS checkpoints, sessions,
 * and journal persistence are replaced because this suite runs in Node.
 * @param {boolean} [enableIndexes=false]
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, contentRollback: import('vitest').MockInstance, recordRollback: import('vitest').MockInstance, journalClear: import('vitest').MockInstance}>}
 */
async function createDatabase(enableIndexes = false) {
    const connection = new sqlite3.oo1.DB(':memory:')
    connections.push(connection)
    const database = new DictionaryDatabase()
    Reflect.set(database, '_sqlite3', sqlite3)
    Reflect.set(database, '_db', connection)
    if (enableIndexes) { Reflect.set(database, '_enableSqliteSecondaryIndexes', true) }
    await database._initializeSchema()
    vi.spyOn(database._termContentStore, 'createImportCheckpoint').mockResolvedValue({segments: []})
    vi.spyOn(database._termRecordStore, 'createImportCheckpoint').mockResolvedValue({shards: []})
    vi.spyOn(database._termContentStore, 'beginImportSession').mockResolvedValue()
    vi.spyOn(database._termRecordStore, 'beginImportSession').mockResolvedValue()
    const contentRollback = vi.spyOn(database._termContentStore, 'rollbackImportSession').mockResolvedValue()
    const recordRollback = vi.spyOn(database._termRecordStore, 'rollbackImportSession').mockResolvedValue()
    vi.spyOn(database._importJournal, 'write').mockResolvedValue()
    const journalClear = vi.spyOn(database._importJournal, 'clear').mockResolvedValue()
    return {database, connection, contentRollback, recordRollback, journalClear}
}

/**
 * @param {import('@sqlite.org/sqlite-wasm').Database} connection
 * @returns {unknown[]}
 */
function secondaryIndexes(connection) {
    return connection.selectValues("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
}

/**
 * @param {import('vitest').MockInstance<import('@sqlite.org/sqlite-wasm').Database['exec']>} exec
 * @returns {string[]}
 */
function droppedIndexes(exec) {
    return exec.mock.calls.map((args) => /** @type {unknown} */ (args[0]))
        .filter((sql) => typeof sql === 'string' && sql.startsWith('DROP INDEX'))
        .map((sql) => /** @type {string} */ (sql))
}

test('a partial enabled-index drop failure restores indexes and permits a new import', async () => {
    const {database, connection, contentRollback, recordRollback, journalClear} = await createDatabase(true)
    const currentIndexes = secondaryIndexes(connection)
    const execute = connection.exec.bind(connection)
    /** @type {unknown[]} */
    let indexesAtFailure = []
    let shouldFail = true
    const exec = vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        if (shouldFail && String(args[0]) === 'DROP INDEX IF EXISTS idx_term_entry_content_hash') {
            shouldFail = false
            indexesAtFailure = secondaryIndexes(connection)
            throw new Error('injected index drop failure')
        }
        return execute(...args)
    })
    await expect(database.startBulkImport()).rejects.toThrow('injected index drop failure')
    expect(indexesAtFailure).not.toContain('idx_dictionaries_title')
    expect(indexesAtFailure).not.toContain('idx_dictionaries_version')
    expect(indexesAtFailure).toContain('idx_term_entry_content_hash')
    expect(secondaryIndexes(connection)).toEqual(currentIndexes)
    expect(contentRollback).toHaveBeenCalledOnce()
    expect(recordRollback).toHaveBeenCalledOnce()
    expect(journalClear).toHaveBeenCalledOnce()
    expect(database._bulkImportState).toBe('idle')
    expect(database._bulkImportJournalRecord).toBeNull()
    expect(database._bulkImportTransactionOpen).toBe(false)
    exec.mockClear()
    const session = await database.startBulkImport()
    expect(droppedIndexes(exec)).toHaveLength(23)
    expect(secondaryIndexes(connection)).toEqual([])
    connection.exec("INSERT INTO dictionaries(title, version, summaryJson) VALUES ('Retry', 3, '{}')")
    expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1)
    await database.abortBulkImport(session)
    expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(0)
    expect(secondaryIndexes(connection)).toEqual(currentIndexes)
})

test('default imports retain setup rollback and retry after a transaction-start failure', async () => {
    const {database, connection, contentRollback, recordRollback, journalClear} = await createDatabase()
    const execute = connection.exec.bind(connection)
    let shouldFail = true
    const exec = vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        if (shouldFail && String(args[0]) === 'BEGIN IMMEDIATE') {
            shouldFail = false
            throw new Error('injected transaction start failure')
        }
        return execute(...args)
    })
    await expect(database.startBulkImport()).rejects.toThrow('injected transaction start failure')
    expect(contentRollback).toHaveBeenCalledOnce()
    expect(recordRollback).toHaveBeenCalledOnce()
    expect(journalClear).toHaveBeenCalledOnce()
    expect(database._bulkImportState).toBe('idle')
    expect(database._bulkImportJournalRecord).toBeNull()
    expect(database._bulkImportTransactionOpen).toBe(false)
    const session = await database.startBulkImport()
    connection.exec("INSERT INTO dictionaries(title, version, summaryJson) VALUES ('Retry', 3, '{}')")
    expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(1)
    await database.abortBulkImport(session)
    expect(connection.selectValue('SELECT COUNT(*) FROM dictionaries')).toBe(0)
    expect(droppedIndexes(exec)).toEqual([])
    expect(database._bulkImportState).toBe('idle')
})
