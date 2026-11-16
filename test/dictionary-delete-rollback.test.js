/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {log} from '../ext/js/core/log.js'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
let serial = 0

beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const connection of connections.splice(0)) { connection.close() }
})

/**
 * Use real SQLite commits, rollback-on-close, and reopening. Only OPFS record
 * cleanup and the worker's connection-opening boundary are substituted.
 * @param {number} failedCommit
 * @param {boolean} rollbackFails
 * @param {boolean} [hasSibling=true]
 * @returns {Promise<{database: DictionaryDatabase, connection: import('@sqlite.org/sqlite-wasm').Database, worker: import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler, prepare: import('vitest').MockInstance, close: import('vitest').MockInstance, finalize: import('vitest').MockInstance, deleteRecords: import('vitest').MockInstance, resetContent: import('vitest').MockInstance, warn: import('vitest').MockInstance}>}
 */
async function fixture(failedCommit, rollbackFails, hasSibling = true) {
    const filename = `/dictionary-delete-rollback-${++serial}.sqlite3`
    const connection = new sqlite3.oo1.DB(filename, 'c')
    connections.push(connection)
    connection.exec('CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT UNIQUE, version INTEGER, summaryJson TEXT)')
    for (const table of ['kanji', 'kanjiMeta', 'termMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts', 'termGlossaryTokens', 'termGlossarySearchTerms', 'dictionaryGlossarySearchIndex', 'termEntryContent']) {
        connection.exec(`CREATE TABLE ${table}(dictionary TEXT)`)
        connection.exec({sql: `INSERT INTO ${table} VALUES (?)`, bind: ['Fixture']})
        if (hasSibling) { connection.exec({sql: `INSERT INTO ${table} VALUES (?)`, bind: ['Sibling']}) }
    }
    for (const title of hasSibling ? ['Fixture', 'Sibling'] : ['Fixture']) {
        connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES (?, 3, ?)', bind: [title, JSON.stringify({title, version: 3, importSuccess: true})]})
    }
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', connection)
    const records = Reflect.get(database, '_termRecordStore')
    const content = Reflect.get(database, '_termContentStore')
    vi.spyOn(records, 'ensureDictionariesLoaded').mockResolvedValue()
    vi.spyOn(records, 'getDictionaryRecordCount').mockReturnValue(1)
    const deleteRecords = vi.spyOn(records, 'deleteByDictionary').mockResolvedValue(1)
    const resetContent = vi.spyOn(content, 'reset').mockResolvedValue()
    vi.spyOn(database, '_pruneOrphanTermEntryContent').mockImplementation(() => {
        database._requireDb().exec('DELETE FROM termEntryContent WHERE dictionary NOT IN (SELECT title FROM dictionaries)')
    })
    // A cached SQLite statement must also be retired with the failed connection.
    const statement = database._getCachedStatement('SELECT 1')
    const finalize = vi.spyOn(statement, 'finalize')
    const close = vi.spyOn(connection, 'close')
    const exec = connection.exec.bind(connection)
    let commitCount = 0
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0])
        if (sql === 'COMMIT' && ++commitCount === failedCommit) { throw new Error('commit failed') }
        if (sql === 'ROLLBACK' && rollbackFails) { throw new Error('rollback failed') }
        return exec(...args)
    })
    const prepare = vi.spyOn(database, 'prepare').mockImplementation(async () => {
        const reopened = new sqlite3.oo1.DB(filename, 'w')
        connections.push(reopened)
        Reflect.set(database, '_db', reopened)
    })
    vi.stubGlobal('self', {addEventListener: vi.fn()})
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js')
    const worker = new OffscreenDictionaryWorkerHandler()
    Reflect.set(worker, '_dictionaryDatabase', database)
    Reflect.set(worker, '_databaseReady', true)
    Reflect.set(worker, '_translator', {prepare: vi.fn(), clearDatabaseCaches: vi.fn()})
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    return {database, connection, worker, prepare, close, finalize, deleteRecords, resetContent, warn}
}

test('failed deletion rollback retires the connection and the next worker request restores committed metadata', async () => {
    const {database, worker, prepare, close, finalize, deleteRecords, resetContent} = await fixture(1, true)

    await expect(worker._invokeAction('deleteDictionaryOffscreen', {dictionaryTitle: 'Fixture'}, [])).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [expect.objectContaining({message: 'commit failed'}), expect.objectContaining({message: 'rollback failed'})],
    })

    expect(database.isPrepared()).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledOnce()
    expect(deleteRecords).not.toHaveBeenCalled()
    expect(resetContent).not.toHaveBeenCalled()
    await expect(worker._invokeAction('getDictionaryInfoOffscreen', {}, [])).resolves.toEqual([
        expect.objectContaining({title: 'Fixture'}),
        expect.objectContaining({title: 'Sibling'}),
    ])
    expect(prepare).toHaveBeenCalledOnce()
    // The subsequent mutation uses a fresh transaction and succeeds normally.
    await expect(worker._invokeAction('deleteDictionaryOffscreen', {dictionaryTitle: 'Fixture'}, [])).resolves.toBeUndefined()
    expect(deleteRecords).toHaveBeenCalledOnce()
})

test.each([false, true])('cleanup rollback failure preserves committed deletion and a usable next connection; sibling=%s', async (hasSibling) => {
    const {database, worker, prepare, close, finalize, deleteRecords, resetContent, warn} = await fixture(2, true, hasSibling)

    await expect(worker._invokeAction('deleteDictionaryOffscreen', {dictionaryTitle: 'Fixture'}, [])).resolves.toBeUndefined()

    expect(database.isPrepared()).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledOnce()
    expect(deleteRecords).toHaveBeenCalledExactlyOnceWith('Fixture')
    expect(resetContent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        name: 'AggregateError',
        errors: [expect.objectContaining({message: 'commit failed'}), expect.objectContaining({message: 'rollback failed'})],
    }))
    await expect(worker._invokeAction('getDictionaryInfoOffscreen', {}, [])).resolves.toEqual(hasSibling ? [expect.objectContaining({title: 'Sibling'})] : [])
    expect(prepare).toHaveBeenCalledOnce()
    // Cleanup did not commit, so it must not reset bytes still referenced by
    // the last committed content metadata, including any healthy sibling.
    expect(database._requireDb().selectValues('SELECT dictionary FROM termEntryContent ORDER BY dictionary')).toEqual(hasSibling ? ['Fixture', 'Sibling'] : ['Fixture'])
})

test('a successful deletion rollback retains the original error and prepared connection', async () => {
    const {database, connection, worker, prepare, close, deleteRecords, resetContent} = await fixture(1, false)

    await expect(worker._invokeAction('deleteDictionaryOffscreen', {dictionaryTitle: 'Fixture'}, [])).rejects.toThrow('commit failed')

    expect(database.isPrepared()).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(deleteRecords).not.toHaveBeenCalled()
    expect(resetContent).not.toHaveBeenCalled()
    expect(connection.selectValues('SELECT title FROM dictionaries ORDER BY title')).toEqual(['Fixture', 'Sibling'])
})
