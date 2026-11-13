/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {getSqlite3, openOpfsDatabase} from '../ext/js/dictionary/sqlite-wasm.js'

vi.mock('../ext/js/dictionary/sqlite-wasm.js', async (original) => ({
    ...(await original()),
    getSqlite3: vi.fn(),
    openOpfsDatabase: vi.fn(),
}))
vi.mock('../ext/js/dictionary/zstd-term-content.js', async (original) => ({
    ...(await original()),
    initializeTermContentZstd: vi.fn(async () => {}),
}))

/**
 * @typedef {object} RecoveryTestOpfs
 * @property {FileSystemDirectoryHandle} root
 * @property {() => Promise<void>} dispose
 * @property {{beforeRemove: ((name: string) => void)|null}} hooks
 */
/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
/** @type {Array<() => Promise<void>>} */
const cleanup = []
let serial = 0
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const connection of connections.splice(0)) { connection.close() }
    for (const dispose of cleanup.splice(0)) { await dispose() }
})

/**
 * Persist a real term container and content payload without loading a compressor.
 * @param {DictionaryDatabase} database
 * @param {string} dictionary
 * @returns {Promise<void>}
 */
async function appendTerm(database, dictionary) {
    const bytes = new TextEncoder().encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary: [`${dictionary} definition`]}))
    const [span] = await database._termContentStore.appendBatch([bytes])
    await database._termRecordStore.appendBatch([{
        dictionary,
        expression: dictionary,
        reading: dictionary,
        expressionReverse: null,
        readingReverse: null,
        entryContentOffset: span.offset,
        entryContentLength: span.length,
        entryContentDictName: 'raw',
        score: 0,
        sequence: 1,
    }])
}

async function fixture() {
    const adapterUrl = new URL('fixtures/import-journal-snapshot/node-opfs-adapter.mjs', import.meta.url)
    // eslint-disable-next-line no-unsanitized/method -- Fixed repository fixture URL; no external input.
    const {createNodeOpfs} = /** @type {{createNodeOpfs: () => Promise<RecoveryTestOpfs>}} */ (await import(adapterUrl.href))
    const opfs = await createNodeOpfs()
    cleanup.push(opfs.dispose)
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => opfs.root}})
    vi.stubGlobal('self', {constructor: {name: 'DedicatedWorkerGlobalScope'}})
    const filename = `/dictionary-import-reopen-${++serial}.sqlite3`
    vi.mocked(getSqlite3).mockResolvedValue(sqlite3)
    vi.mocked(openOpfsDatabase).mockImplementation(async () => {
        const connection = new sqlite3.oo1.DB(filename, 'c')
        connections.push(connection)
        return connection
    })
    const database = new DictionaryDatabase()
    await database.prepare()
    const bytes = new Uint8Array([4, 5, 6])
    const [span] = await database._termContentStore.appendBatch([bytes])
    await database._termContentStore.ensureLoadedForRead()
    await database.bulkAdd('dictionaries', [{title: 'Survivor', version: 3, importSuccess: true, revision: '1', sequenced: false, importDate: 1, prefixWildcardsSupported: true, styles: ''}], 0, 1)
    await database.bulkAddExternalMediaRows([{
        dictionary: 'Survivor',
        path: 'image.png',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        content: new ArrayBuffer(0),
        contentOffset: span.offset,
        contentLength: span.length,
    }])
    await database._termRecordStore.beginImportSession()
    await appendTerm(database, 'Survivor')
    await database._termRecordStore.endImportSession()
    await database._termContentStore.ensureLoadedForRead()
    database._requireDb().exec("UPDATE dictionaries SET summaryJson = json_set(summaryJson, '$.counts.terms.total', 1) WHERE title = 'Survivor'")
    const contentHandle = await opfs.root.getFileHandle('manabitan-term-content.bin')
    const persistedContent = new Uint8Array(await (await contentHandle.getFile()).arrayBuffer())
    return {database, opfs, bytes, persistedContent}
}

test.each([false, true])('an interrupted import rollback can recover through real prepare; new worker=%s', async (newWorker) => {
    const {database, opfs, bytes} = await fixture()
    const sessionId = await database.startBulkImport()
    await appendTerm(database, 'Interrupted')
    await database._termRecordStore.endImportSession()
    // Model committed append segments from the interrupted import without
    // allocating hundreds of MiB. Their filenames and durable I/O are real.
    for (let index = 1; index <= 3; ++index) {
        const handle = await opfs.root.getFileHandle(`manabitan-term-content^${index}.bin`, {create: true})
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array([index, index, index]))
        await writable.close()
    }
    const interruptedShard = database._termRecordStore._getShardFileName('Interrupted', 'raw')
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (name === 'manabitan-term-content^2.bin' || name === interruptedShard) {
            throw new DOMException('Temporarily locked', 'NoModificationAllowedError')
        }
    }
    await expect(database.abortBulkImport(sessionId)).rejects.toThrow()
    expect(database.isPrepared()).toBe(false)
    expect(await database._importJournal.read()).toHaveProperty('sessionId', sessionId)
    const recordDirectory = await opfs.root.getDirectoryHandle('manabitan-term-records')
    await expect(recordDirectory.getFileHandle(interruptedShard)).resolves.toBeDefined()

    opfs.hooks.beforeRemove = null
    const recovered = newWorker ? new DictionaryDatabase() : database
    await expect(recovered.prepare()).resolves.toBeUndefined()
    expect(await recovered.getDictionaryInfo()).toMatchObject([{title: 'Survivor'}])
    const [media] = await recovered.getMedia([{dictionary: 'Survivor', path: 'image.png'}])
    expect(new Uint8Array(media.content)).toEqual(bytes)
    expect(await recovered.findTermsBulk(['Survivor'], new Set(['Survivor']), 'exact')).toMatchObject([{dictionary: 'Survivor', definitions: ['Survivor definition']}])
    expect(recovered._termRecordStore.getDictionaryRecordCount('Interrupted')).toBe(0)
    await expect(recordDirectory.getFileHandle(interruptedShard)).rejects.toHaveProperty('name', 'NotFoundError')
    expect(await recovered._importJournal.read()).toBeNull()
    // A later import also acquires and releases ownership normally.
    const nextSession = await recovered.startBulkImport()
    await expect(recovered.abortBulkImport(nextSession)).resolves.toBeUndefined()
})

test('startup recovery preserves a published import when journal deletion previously failed', async () => {
    const {database, opfs} = await fixture()
    const sessionId = await database.startBulkImport()
    const bytes = new Uint8Array([9, 8, 7])
    const [span] = await database._termContentStore.appendBatch([bytes])
    await database.bulkAddExternalMediaRows([{
        dictionary: 'Survivor',
        path: 'published.png',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        content: new ArrayBuffer(0),
        contentOffset: span.offset,
        contentLength: span.length,
    }])
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (name === 'manabitan-dictionary-import-journal.json') { throw new DOMException('Temporarily locked', 'NoModificationAllowedError') }
    }
    await expect(database.finishBulkImport(null, null, sessionId)).resolves.toHaveProperty('published', true)
    await database.close()
    opfs.hooks.beforeRemove = null

    const recovered = new DictionaryDatabase()
    const contentRollback = vi.spyOn(recovered._termContentStore, 'rollbackImportSession')
    const recordRollback = vi.spyOn(recovered._termRecordStore, 'rollbackImportSession')
    await recovered.prepare()
    expect(contentRollback).not.toHaveBeenCalled()
    expect(recordRollback).not.toHaveBeenCalled()
    const [media] = await recovered.getMedia([{dictionary: 'Survivor', path: 'published.png'}])
    expect(new Uint8Array(media.content)).toEqual(bytes)
    expect(await recovered._importJournal.read()).toBeNull()
})

test('malformed journal bytes prevent startup without changing committed content', async () => {
    const {database, opfs, persistedContent} = await fixture()
    await database.close()
    const handle = await opfs.root.getFileHandle('manabitan-dictionary-import-journal.json', {create: true})
    const writable = await handle.createWritable()
    await writable.write('{')
    await writable.close()
    const recovered = new DictionaryDatabase()
    await expect(recovered.prepare()).rejects.toThrow('invalid dictionary import journal')
    expect(recovered.isPrepared()).toBe(false)
    const contentHandle = await opfs.root.getFileHandle('manabitan-term-content.bin')
    expect(new Uint8Array(await (await contentHandle.getFile()).arrayBuffer())).toEqual(persistedContent)
    expect(await (await handle.getFile()).text()).toBe('{')
})

test('a journal without its SQLite publication table stays fail closed', async () => {
    const {database, opfs, persistedContent} = await fixture()
    const contentCheckpoint = await database._termContentStore.createImportCheckpoint()
    const recordCheckpoint = await database._termRecordStore.createImportCheckpoint()
    await database._importJournal.write({version: 1, sessionId: 'unowned', createdAt: 1, contentCheckpoint, recordCheckpoint})
    database._requireDb().exec('DROP TABLE dictionaryImportPublications')
    await database.close()

    const recovered = new DictionaryDatabase()
    const contentRollback = vi.spyOn(recovered._termContentStore, 'rollbackImportSession')
    const recordRollback = vi.spyOn(recovered._termRecordStore, 'rollbackImportSession')
    await expect(recovered.prepare()).rejects.toThrow('dictionaryImportPublications')
    expect(recovered.isPrepared()).toBe(false)
    expect(contentRollback).not.toHaveBeenCalled()
    expect(recordRollback).not.toHaveBeenCalled()
    expect(await recovered._importJournal.read()).toHaveProperty('sessionId', 'unowned')
    const contentHandle = await opfs.root.getFileHandle('manabitan-term-content.bin')
    expect(new Uint8Array(await (await contentHandle.getFile()).arrayBuffer())).toEqual(persistedContent)
})
