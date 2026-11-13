/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
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
 * Use the actual importer, worker, schema and source stores. Substitute only
 * the persistent journal and connection-opening boundary for Node's missing OPFS.
 * @param {'create'|'cleanup'} phase
 * @param {boolean} [rollbackFails=true]
 * @returns {Promise<{database: DictionaryDatabase, worker: import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler, prepare: import('vitest').MockInstance, close: import('vitest').MockInstance, faults: {commit: boolean, rollback: boolean}, originalSummary: string}>}
 */
async function fixture(phase, rollbackFails = true) {
    const filename = `/import-summary-rollback-${++serial}.sqlite3`
    const connection = new sqlite3.oo1.DB(filename, 'c')
    connections.push(connection)
    const database = new DictionaryDatabase()
    database._db = connection
    database._sqlite3 = sqlite3
    await database._initializeSchema()
    Reflect.set(database, '_importJournal', {clear: async () => {}, write: async () => {}})
    const [span] = await database._termContentStore.appendBatch([
        new TextEncoder().encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: ['domestic cat']})),
    ])
    await database._termRecordStore.appendBatch([{
        dictionary: 'Healthy',
        expression: 'healthy-term',
        reading: 'healthy-term',
        expressionReverse: 'mret-yhtlaeh',
        readingReverse: 'mret-yhtlaeh',
        entryContentOffset: span.offset,
        entryContentLength: span.length,
        entryContentDictName: 'raw',
        score: 0,
        sequence: 1,
    }])
    database._termRecordStore.ensureDictionaryIndexes(['Healthy'])
    const originalSummary = JSON.stringify({title: 'Healthy', version: 3, importSuccess: true, counts: {terms: {total: 1}}})
    connection.exec({sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES (?, 3, ?)', bind: ['Healthy', originalSummary]})
    const close = vi.spyOn(connection, 'close')
    const exec = connection.exec.bind(connection)
    const faults = {commit: false, rollback: false}
    let commitCount = 0
    vi.spyOn(connection, 'exec').mockImplementation((...args) => {
        const sql = /** @type {unknown} */ (args[0])
        if (sql === 'COMMIT' && ++commitCount === (phase === 'create' ? 1 : 2)) {
            faults.commit = true
            throw new Error(`summary ${phase} commit failed`)
        }
        if (sql === 'ROLLBACK' && faults.commit && rollbackFails && !faults.rollback) {
            faults.rollback = true
            throw new Error(`summary ${phase} rollback failed`)
        }
        return exec(...args)
    })
    const prepare = vi.spyOn(database, 'prepare').mockImplementation(async () => {
        const reopened = new sqlite3.oo1.DB(filename, 'w')
        connections.push(reopened)
        database._db = reopened
        await database._initializeSchema()
        database._refreshTermRecordStorageNameMappings()
        // Keep production startup removal of any durably retained placeholder.
        await database._cleanupIncompleteImports()
        database._refreshTermRecordStorageNameMappings()
    })
    vi.stubGlobal('self', {addEventListener: vi.fn()})
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js')
    const worker = new OffscreenDictionaryWorkerHandler()
    Reflect.set(worker, '_dictionaryDatabase', database)
    Reflect.set(worker, '_databaseReady', true)
    Reflect.set(worker, '_translator', {prepare: vi.fn(), clearDatabaseCaches: vi.fn()})
    return {database, worker, prepare, close, faults, originalSummary}
}

/**
 * @param {import('../ext/js/background/offscreen-dictionary-worker.js').OffscreenDictionaryWorkerHandler} worker
 * @param {boolean} malformed
 * @returns {Promise<Array<{type: string, result?: unknown, error?: unknown}>>}
 */
async function runImport(worker, malformed) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Faulty', revision: '1', format: 3})))
    if (malformed) { await writer.add('term_bank_1.json', new TextReader('not valid JSON')) }
    const archive = new Uint8Array(await writer.close()).buffer
    const operationId = `${Date.now()}:summary-${++serial}`
    worker._admitImportOperation(operationId)
    /** @type {Array<{type: string, result?: unknown, error?: unknown}>} */
    const messages = []
    const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({
        postMessage: (/** @type {{type: string, result?: unknown, error?: unknown}} */ message) => { messages.push(message) },
        close: vi.fn(),
    }))
    await worker._importDictionaryOffscreen(
        /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false, disableTermBankWasmFastPath: true, skipImageMetadata: true}),
        archive,
        port,
        operationId,
    )
    return messages
}

test.each(['create', 'cleanup'])('failed summary %s rollback cannot poison the retained import worker', async (phaseValue) => {
    const phase = /** @type {'create'|'cleanup'} */ (phaseValue)
    const {database, worker, prepare, close, faults, originalSummary} = await fixture(phase)

    const messages = await runImport(worker, phase === 'cleanup')

    expect(faults).toEqual({commit: true, rollback: true})
    expect(messages.find(({type}) => type !== 'progress')).toMatchObject(phase === 'create' ? {type: 'error'} : {type: 'complete', result: {result: null}})
    expect.soft(database.isPrepared()).toBe(false)
    expect.soft(close).toHaveBeenCalledOnce()
    await expect.soft(worker._invokeAction('getDictionaryInfoOffscreen', {}, [])).resolves.toEqual([
        expect.objectContaining({title: 'Healthy', importSuccess: true}),
    ])
    expect.soft(prepare).toHaveBeenCalledOnce()
    expect(database._requireDb().selectValue("SELECT summaryJson FROM dictionaries WHERE title = 'Healthy'")).toBe(originalSummary)
    await expect.soft(database.findTermsByGlossary('cat', new Set(['Healthy']))).resolves.toEqual([
        expect.objectContaining({term: 'healthy-term'}),
    ])
    expect((await runImport(worker, false)).find(({type}) => type !== 'progress')).toMatchObject({
        type: 'complete',
        result: {result: {title: 'Faulty', importSuccess: true}, errors: []},
    })
})

test('successful summary creation rollback keeps the connection usable for another real import', async () => {
    const {database, worker, prepare, close, faults} = await fixture('create', false)

    const messages = await runImport(worker, false)

    expect(faults).toEqual({commit: true, rollback: false})
    expect(messages.find(({type}) => type === 'error')).toMatchObject({error: {message: 'summary create commit failed'}})
    expect(database.isPrepared()).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect((await runImport(worker, false)).find(({type}) => type === 'complete')).toMatchObject({
        result: {result: {title: 'Faulty', importSuccess: true}, errors: []},
    })
})
