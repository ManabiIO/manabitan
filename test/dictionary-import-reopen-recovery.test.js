/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {deferPromise} from '../ext/js/core/utilities.js'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {encodeRawTermContentBinary, RAW_TERM_CONTENT_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js'
import {deleteOpfsDatabaseFiles, getSqlite3, openOpfsDatabase} from '../ext/js/dictionary/sqlite-wasm.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

vi.mock('../ext/js/dictionary/sqlite-wasm.js', async (original) => ({
    ...(await original()),
    getSqlite3: vi.fn(),
    openOpfsDatabase: vi.fn(),
    deleteOpfsDatabaseFiles: vi.fn(),
}))
vi.mock('../ext/js/dictionary/zstd-term-content.js', async (original) => ({
    ...(await original()),
    initializeTermContentZstd: vi.fn(async () => {}),
}))

/**
 * @typedef {object} RecoveryTestOpfs
 * @property {FileSystemDirectoryHandle} root
 * @property {() => Promise<void>} dispose
 * @property {{beforeRemove: ((name: string) => void)|null, beforeWrite: ((name: string) => void|Promise<void>)|null, beforeTruncate: ((name: string) => void)|null}} hooks
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
 * @param {string} [contentDictName='raw']
 * @returns {Promise<void>}
 */
async function appendTerm(database, dictionary, contentDictName = 'raw') {
    const encoder = new TextEncoder()
    const glossary = [`${dictionary} definition`]
    const bytes = contentDictName === RAW_TERM_CONTENT_DICT_NAME ?
        encodeRawTermContentBinary('', '', '', encoder.encode(JSON.stringify(glossary)), encoder) :
        encoder.encode(JSON.stringify({rules: '', definitionTags: '', termTags: '', glossary}))
    const [span] = await database._termContentStore.appendBatch([bytes])
    await database._termRecordStore.appendBatch([{
        dictionary,
        expression: dictionary,
        reading: dictionary,
        expressionReverse: null,
        readingReverse: null,
        entryContentOffset: span.offset,
        entryContentLength: span.length,
        entryContentDictName: contentDictName,
        score: 0,
        sequence: 1,
    }])
}

/**
 * @param {string} [contentDictName='raw']
 * @returns {Promise<{database: DictionaryDatabase, opfs: RecoveryTestOpfs, bytes: Uint8Array, persistedContent: Uint8Array}>}
 */
async function fixture(contentDictName = 'raw') {
    const adapterUrl = new URL('fixtures/import-journal-snapshot/node-opfs-adapter.mjs', import.meta.url)
    // eslint-disable-next-line no-unsanitized/method -- Fixed repository fixture URL; no external input.
    const {createNodeOpfs} = /** @type {{createNodeOpfs: (options: {terminalWriteErrors: boolean}) => Promise<RecoveryTestOpfs>}} */ (await import(adapterUrl.href))
    const opfs = await createNodeOpfs({terminalWriteErrors: true})
    cleanup.push(opfs.dispose)
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => opfs.root}})
    vi.stubGlobal('self', {constructor: {name: 'DedicatedWorkerGlobalScope'}})
    const filename = `/dictionary-import-reopen-${++serial}`
    let sqliteGeneration = 0
    vi.mocked(getSqlite3).mockResolvedValue(sqlite3)
    vi.mocked(openOpfsDatabase).mockImplementation(async () => {
        const connection = new sqlite3.oo1.DB(`${filename}-${sqliteGeneration}.sqlite3`, 'c')
        connections.push(connection)
        return connection
    })
    // SQLite's OPFS VFS is unavailable in Node. Model its file replacement by
    // opening a fresh real SQLite file after the actual purge coordinator runs.
    vi.mocked(deleteOpfsDatabaseFiles).mockImplementation(async () => {
        ++sqliteGeneration
        return true
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
    await appendTerm(database, 'Survivor', contentDictName)
    await database._termRecordStore.endImportSession()
    await database._termContentStore.ensureLoadedForRead()
    database._requireDb().exec("UPDATE dictionaries SET summaryJson = json_set(summaryJson, '$.counts.terms.total', 1) WHERE title = 'Survivor'")
    const contentHandle = await opfs.root.getFileHandle('manabitan-term-content.bin')
    const persistedContent = new Uint8Array(await (await contentHandle.getFile()).arrayBuffer())
    return {database, opfs, bytes, persistedContent}
}

test.each([
    {newWorker: false, blockedRetry: false},
    {newWorker: true, blockedRetry: false},
    {newWorker: false, blockedRetry: true},
    {newWorker: true, blockedRetry: true},
])('failed orphan cleanup cannot attach deleted terms to a new import; new worker=$newWorker, blocked retry=$blockedRetry', async ({newWorker, blockedRetry}) => {
    // Packed-artifact imports can use raw-v2 while ordinary source ZIPs use
    // raw JSON. Distinct codec shard names must not bypass retired ownership.
    const {database, opfs} = await fixture(RAW_TERM_CONTENT_DICT_NAME)
    await database.bulkAdd('dictionaries', [{title: 'Keeper', version: 3, importSuccess: true, revision: '1', sequenced: false, importDate: 1, prefixWildcardsSupported: true, styles: ''}], 0, 1)
    await database._termRecordStore.beginImportSession()
    await appendTerm(database, 'Keeper')
    await database._termRecordStore.endImportSession()
    await database._termContentStore.ensureLoadedForRead()
    database._requireDb().exec("UPDATE dictionaries SET summaryJson = json_set(summaryJson, '$.counts.terms.total', 1) WHERE title = 'Keeper'")
    const shard = database._termRecordStore._getShardFileName('Survivor', RAW_TERM_CONTENT_DICT_NAME)
    const failCleanup = (/** @type {string} */ name) => {
        if (name === shard || name === `${shard}.mbti`) { throw new DOMException('Temporarily locked', 'NoModificationAllowedError') }
    }
    opfs.hooks.beforeRemove = failCleanup
    opfs.hooks.beforeTruncate = failCleanup
    await database.deleteDictionary('Survivor', 1000, () => {})
    await database.close()

    const recovered = newWorker ? new DictionaryDatabase() : database
    await recovered.prepare()
    expect(await recovered.getDictionaryInfo()).toMatchObject([{title: 'Keeper'}])

    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0})
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Survivor', revision: '2', format: 3})))
    await writer.add('term_bank_1.json', new TextReader(JSON.stringify([['Fresh', 'Fresh', '', '', 0, ['Fresh definition'], 1, '']])))
    const archive = new Uint8Array(await writer.close()).buffer
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    const details = /** @type {import('dictionary-importer').ImportDetails} */ ({zipUseWebWorkers: false, termContentStorageMode: 'raw-bytes'})
    const publishJournal = vi.spyOn(recovered._importJournal, 'write')
    if (blockedRetry) {
        const blocked = await importer.importDictionary(recovered, archive, details)
        expect(blocked.result).toBeNull()
        expect(blocked.errors.length).toBeGreaterThan(0)
        // Retirement must finish before another journal can claim these files.
        expect(publishJournal).not.toHaveBeenCalled()
        expect(await recovered._importJournal.read()).toBeNull()
        expect(recovered.isPrepared()).toBe(true)
        expect(await recovered.getDictionaryInfo()).toMatchObject([{title: 'Keeper'}])
        expect(await recovered.findTermsBulk(['Keeper'], new Set(['Keeper']), 'exact')).toMatchObject([{dictionary: 'Keeper', definitions: ['Keeper definition']}])
    }
    opfs.hooks.beforeRemove = null
    opfs.hooks.beforeTruncate = null
    const result = await importer.importDictionary(recovered, archive, details)
    expect(result.errors).toEqual([])
    expect(result.result).toMatchObject({title: 'Survivor', importSuccess: true, counts: {terms: {total: 1}}})
    expect(publishJournal).toHaveBeenCalledOnce()
    expect(publishJournal.mock.calls[0][0].recordCheckpoint.shards.some(({fileName}) => fileName === shard || fileName === `${shard}.mbti`)).toBe(false)
    expect(await recovered.findTermsBulk(['Survivor'], new Set(['Survivor']), 'exact')).toEqual([])
    expect(await recovered.findTermsBulk(['Fresh'], new Set(['Survivor']), 'exact')).toMatchObject([{dictionary: 'Survivor', definitions: ['Fresh definition']}])
    expect(await recovered.findTermsBulk(['Keeper'], new Set(['Keeper']), 'exact')).toMatchObject([{dictionary: 'Keeper', definitions: ['Keeper definition']}])
    await recovered.close()
    const reopened = new DictionaryDatabase()
    await reopened.prepare()
    expect(await reopened.findTermsBulk(['Survivor'], new Set(['Survivor']), 'exact')).toEqual([])
    expect(await reopened.findTermsBulk(['Fresh'], new Set(['Survivor']), 'exact')).toMatchObject([{dictionary: 'Survivor', definitions: ['Fresh definition']}])
    expect(await reopened.findTermsBulk(['Keeper'], new Set(['Keeper']), 'exact')).toMatchObject([{dictionary: 'Keeper', definitions: ['Keeper definition']}])
})

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

test.each([false, true])('explicit purge recovers failed rollback storage; new worker=%s', async (newWorker) => {
    const {database, opfs} = await fixture()
    const sessionId = await database.startBulkImport()
    for (let index = 1; index <= 3; ++index) {
        const handle = await opfs.root.getFileHandle(`manabitan-term-content^${index}.bin`, {create: true})
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array([index, index, index]))
        await writable.close()
    }
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (name === 'manabitan-term-content^2.bin') { throw new DOMException('Temporarily locked', 'NoModificationAllowedError') }
    }
    await expect(database.abortBulkImport(sessionId)).rejects.toThrow()
    opfs.hooks.beforeRemove = null

    const result = await database.purge().then((value) => ({value}), (error) => ({error}))
    const recovered = newWorker ? new DictionaryDatabase() : database
    if (!recovered.isPrepared()) { await expect(recovered.prepare()).resolves.toBeUndefined() }
    expect(result).toEqual({value: true})
    expect(await recovered.getDictionaryInfo()).toEqual([])
    expect(await recovered._importJournal.read()).toBeNull()
    const nextSession = await recovered.startBulkImport()
    const bytes = new Uint8Array([7, 8, 9])
    const [span] = await recovered._termContentStore.appendBatch([bytes])
    expect(span).toEqual({offset: 0, length: 3})
    await recovered.finishBulkImport(null, null, nextSession)
    expect(await recovered._termContentStore.readSlice(0, 3)).toEqual(bytes)
})

test('explicit purge discovers cold OPFS files after a journal failure prevented store preparation', async () => {
    const {database, opfs} = await fixture()
    const survivorShard = database._termRecordStore._getShardFileName('Survivor', 'raw')
    await database.close()
    for (const [name, bytes] of [
        ['manabitan-term-content^2.bin', 'orphan'],
        ['manabitan-dictionary-import-journal.json', '{'],
    ]) {
        const handle = await opfs.root.getFileHandle(name, {create: true})
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
    }
    const recovered = new DictionaryDatabase()
    await expect(recovered.prepare()).rejects.toThrow('invalid dictionary import journal')
    expect(recovered._termContentStore._fileHandle).toBeNull()
    await expect(recovered.purge()).resolves.toBe(true)
    expect(await recovered.getDictionaryInfo()).toEqual([])
    const directory = await opfs.root.getDirectoryHandle('manabitan-term-records')
    await expect(directory.getFileHandle(survivorShard)).rejects.toHaveProperty('name', 'NotFoundError')
    const reopened = new DictionaryDatabase()
    await expect(reopened.prepare()).resolves.toBeUndefined()
    expect(await reopened.getDictionaryInfo()).toEqual([])
})

test.each(['content', 'records'])('explicit purge discards failed live %s writes and opens a clean store', async (target) => {
    const {database, opfs} = await fixture()
    await database.startBulkImport()
    let failedWrites = 0
    opfs.hooks.beforeWrite = (/** @type {string} */ name) => {
        if (target === 'content' ? name === 'manabitan-term-content.bin' : name.endsWith('.mbti')) {
            ++failedWrites
            throw new DOMException('Disk is full', 'QuotaExceededError')
        }
    }
    if (target === 'content') {
        await expect((async () => {
            await database._termContentStore.appendBatch([new Uint8Array([1, 2, 3])])
            await database._termContentStore.flushImportWrites()
        })()).rejects.toThrow()
    } else {
        await appendTerm(database, 'Interrupted')
        await expect(database._termRecordStore.endImportSession()).rejects.toThrow()
    }
    expect(failedWrites).toBeGreaterThan(0)
    opfs.hooks.beforeWrite = null
    await expect(database.purge()).resolves.toBe(true)
    expect(await database.getDictionaryInfo()).toEqual([])
    const nextSession = await database.startBulkImport()
    const bytes = new Uint8Array([3, 2, 1])
    const [span] = await database._termContentStore.appendBatch([bytes])
    expect(span).toEqual({offset: 0, length: 3})
    await database.finishBulkImport(null, null, nextSession)
    expect(await database._termContentStore.readSlice(0, 3)).toEqual(bytes)
})

test('purge joins an in-flight content writer before deleting its files', async () => {
    const {database, opfs} = await fixture()
    const entered = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const resume = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const content = database._termContentStore
    content.setQueueImportWritesEnabled(true)
    await database.startBulkImport()
    opfs.hooks.beforeWrite = async (/** @type {string} */ name) => {
        if (name !== 'manabitan-term-content.bin') { return }
        entered.resolve()
        await resume.promise
    }
    const contentRemovals = /** @type {string[]} */ ([])
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (name.startsWith('manabitan-term-content')) { contentRemovals.push(name) }
    }
    await content.appendBatch([new Uint8Array([1, 2, 3])])
    await content.queuePendingImportWrites()
    await entered.promise
    const reset = vi.spyOn(content, 'reset')
    let settled = false
    const purge = database.purge().finally(() => { settled = true })
    try {
        await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce())
        expect(settled).toBe(false)
        expect(contentRemovals).toEqual([])
    } finally {
        resume.resolve()
    }
    await expect(purge).resolves.toBe(true)
    expect(contentRemovals).toContain('manabitan-term-content.bin')
    const handle = await opfs.root.getFileHandle('manabitan-term-content.bin')
    expect((await handle.getFile()).size).toBe(0)
    expect(await database.getDictionaryInfo()).toEqual([])
})
