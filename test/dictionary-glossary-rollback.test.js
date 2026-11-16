/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
let serial = 0
const indexTables = ['dictionaryGlossarySearchIndex', 'termGlossarySearchTerms', 'termGlossaryTokens']

beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const connection of connections.splice(0)) { connection.close() }
})

/**
 * Exercise real SQLite persistence, source records/content, glossary indexing,
 * and the worker's reopen decision. Only OPFS discovery and opening are replaced.
 * @param {boolean} rollbackFails
 * @returns {Promise<{database: DictionaryDatabase, worker: import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler, connection: import('@sqlite.org/sqlite-wasm').Database, prepare: import('vitest').MockInstance, close: import('vitest').MockInstance, finalize: import('vitest').MockInstance, originalIndex: Record<string, unknown>[][], sourceBytes: Uint8Array, span: {offset: number, length: number}, commitError: Error, rollbackError: Error}>}
 */
async function fixture(rollbackFails) {
    const filename = `/glossary-rollback-${++serial}.sqlite3`
    const connection = new sqlite3.oo1.DB(filename, 'c')
    connections.push(connection)
    connection.exec(`
        CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT UNIQUE, version INTEGER, summaryJson TEXT);
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);
        CREATE TABLE dictionaryGlossarySearchIndex(dictionary TEXT PRIMARY KEY, version INTEGER, termCount INTEGER, completedAt INTEGER);
        CREATE TABLE termGlossarySearchTerms(dictionary TEXT, termId INTEGER, score REAL, PRIMARY KEY(dictionary, termId));
        CREATE TABLE termGlossaryTokens(dictionary TEXT, token TEXT, termId INTEGER, PRIMARY KEY(dictionary, token, termId));
    `)
    const database = new DictionaryDatabase()
    database._db = connection
    const sourceBytes = new TextEncoder().encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: ['domestic cat']}))
    const [span] = await database._termContentStore.appendBatch([sourceBytes])
    for (const dictionary of ['Healthy', 'Faulty']) {
        const term = `${dictionary.toLowerCase()}-term`
        database._registerTermRecordStorageName(dictionary, dictionary)
        await database._termRecordStore.appendBatch([{
            dictionary,
            expression: term,
            reading: term,
            expressionReverse: [...term].reverse().join(''),
            readingReverse: [...term].reverse().join(''),
            entryContentOffset: span.offset,
            entryContentLength: span.length,
            entryContentDictName: 'raw',
            score: 0,
            sequence: 1,
        }])
        connection.exec({
            sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES (?, 3, ?)',
            bind: [dictionary, JSON.stringify({title: dictionary, version: 3, importSuccess: true})],
        })
    }
    database._termRecordStore.ensureDictionaryIndexes(['Healthy', 'Faulty'])
    vi.spyOn(database, '_ensureDirectTermIndexesLoaded').mockResolvedValue()
    await database.ensureGlossarySearchIndex(new Set(['Healthy']))
    const originalIndex = indexTables.map((table) => connection.selectObjects(`SELECT * FROM ${table} WHERE dictionary = 'Healthy'`))

    const statement = database._getCachedStatement('SELECT 1')
    const finalize = vi.spyOn(statement, 'finalize')
    const close = vi.spyOn(connection, 'close')
    const exec = connection.exec.bind(connection)
    const commitError = new Error('glossary commit failed')
    const rollbackError = new Error('glossary rollback failed')
    let commitFailed = false
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0])
        if (sql === 'COMMIT' && !commitFailed) {
            commitFailed = true
            throw commitError
        }
        if (sql === 'ROLLBACK' && rollbackFails) { throw rollbackError }
        return exec(...args)
    })
    const prepare = vi.spyOn(database, 'prepare').mockImplementation(async () => {
        const reopened = new sqlite3.oo1.DB(filename, 'w')
        connections.push(reopened)
        database._db = reopened
    })
    vi.stubGlobal('self', {addEventListener: vi.fn()})
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js')
    const worker = new OffscreenDictionaryWorkerHandler()
    Reflect.set(worker, '_dictionaryDatabase', database)
    Reflect.set(worker, '_databaseReady', true)
    Reflect.set(worker, '_translator', {prepare: vi.fn(), clearDatabaseCaches: vi.fn()})
    return {database, worker, connection, prepare, close, finalize, originalIndex, sourceBytes, span, commitError, rollbackError}
}

test('failed glossary rollback retires the connection and the next worker request reopens committed storage', async () => {
    const {database, worker, prepare, close, finalize, originalIndex, sourceBytes, span} = await fixture(true)

    await expect(database.findTermsByGlossary('cat', new Set(['Faulty']))).rejects.toBeInstanceOf(Error)

    expect(database.isPrepared()).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledOnce()
    await expect(worker._invokeAction('getDictionaryInfoOffscreen', {}, [])).resolves.toEqual([
        expect.objectContaining({title: 'Healthy'}),
        expect.objectContaining({title: 'Faulty'}),
    ])
    expect(prepare).toHaveBeenCalledOnce()
    const reopened = database._requireDb()
    expect(indexTables.map((table) => reopened.selectObjects(`SELECT * FROM ${table} WHERE dictionary = 'Healthy'`))).toEqual(originalIndex)
    for (const table of indexTables) {
        expect(reopened.selectValues(`SELECT dictionary FROM ${table} WHERE dictionary = 'Faulty'`)).toEqual([])
    }
    expect(await database._termContentStore.readSlice(span.offset, span.length)).toEqual(sourceBytes)
    expect(database._termRecordStore.getDictionaryRecordCount('Faulty')).toBe(1)
    expect(database._termRecordStore.getDictionaryHealth('Faulty').status).toBe('available')
    expect((await database.findTermsByGlossary('cat', new Set(['Healthy', 'Faulty']))).map(({term}) => term).sort()).toEqual(['faulty-term', 'healthy-term'])
    expect(reopened.selectValue("SELECT termCount FROM dictionaryGlossarySearchIndex WHERE dictionary = 'Faulty'")).toBe(1)
})

test('successful glossary rollback preserves the original error and permits retry on the same connection', async () => {
    const {database, connection, prepare, close, finalize, originalIndex, commitError} = await fixture(false)

    await expect(database.findTermsByGlossary('cat', new Set(['Faulty']))).rejects.toBe(commitError)

    expect(database.isPrepared()).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(indexTables.map((table) => connection.selectObjects(`SELECT * FROM ${table} WHERE dictionary = 'Healthy'`))).toEqual(originalIndex)
    expect((await database.findTermsByGlossary('cat', new Set(['Faulty']))).map(({term}) => term)).toEqual(['faulty-term'])
})

test('the failed index build retains both transaction failures while releasing its connection', async () => {
    const {database, commitError, rollbackError} = await fixture(true)

    await expect(database._ensureGlossarySearchIndexForDictionary('Faulty')).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [commitError, rollbackError],
    })
    expect(database.isPrepared()).toBe(false)
})
