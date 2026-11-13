/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {log} from '../ext/js/core/log.js'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js'

/**
 * @typedef {object} ResetTestOpfs
 * @property {FileSystemDirectoryHandle} root
 * @property {() => Promise<void>} dispose
 * @property {{beforeRemove: ((name: string) => void)|null, beforeTruncate: ((name: string) => void)|null}} hooks
 */

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
/** @type {Array<() => Promise<void>>} */
const cleanup = []
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const connection of connections.splice(0)) { connection.close() }
    for (const dispose of cleanup.splice(0)) { await dispose() }
})

/**
 * @param {number} index
 * @returns {string}
 */
function segmentName(index) {
    return index === 0 ? 'manabitan-term-content.bin' : `manabitan-term-content^${index}.bin`
}

async function fixture() {
    // Reuse the subprocess tests' filesystem adapter with an explicit typed
    // boundary; production deletion and storage implementations remain real.
    const adapterUrl = new URL('fixtures/import-journal-snapshot/node-opfs-adapter.mjs', import.meta.url)
    // eslint-disable-next-line no-unsanitized/method -- Fixed repository fixture URL; no external input.
    const {createNodeOpfs} = /** @type {{createNodeOpfs: (options: {terminalWriteErrors: boolean}) => Promise<ResetTestOpfs>}} */ (await import(adapterUrl.href))
    const opfs = await createNodeOpfs({terminalWriteErrors: true})
    cleanup.push(opfs.dispose)
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => opfs.root}})
    // Small legal segments model a previously installed multi-segment dictionary.
    // The actual storage parser, SQLite deletion and commit-on-close I/O run here.
    for (let index = 0; index < 4; ++index) {
        const handle = await opfs.root.getFileHandle(segmentName(index), {create: true})
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array([index + 1, index + 1, index + 1]))
        await writable.close()
    }
    const connection = new sqlite3.oo1.DB(':memory:')
    connections.push(connection)
    const database = new DictionaryDatabase()
    database._db = connection
    database._sqlite3 = sqlite3
    await database._termContentStore.prepare()
    await database._initializeSchema()
    await database.bulkAdd('dictionaries', [{title: 'Last', version: 3, importSuccess: true, revision: '1', sequenced: false, importDate: 1, prefixWildcardsSupported: true, styles: ''}], 0, 1)
    return {database, opfs}
}

test.each([
    {retainedIndexes: []},
    {retainedIndexes: [1]},
    {retainedIndexes: [2]},
    {retainedIndexes: [3]},
    {retainedIndexes: [2, 3]},
    {retainedIndexes: [0, 1, 2, 3]},
])('deleting the last dictionary remains reopenable with retained segments $retainedIndexes', async ({retainedIndexes}) => {
    const {database, opfs} = await fixture()
    const retainedNames = new Set(retainedIndexes.map(segmentName))
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (retainedNames.has(name)) { throw new DOMException('File is locked', 'NoModificationAllowedError') }
    }
    await expect(database.deleteDictionary('Last', 1000, () => {})).resolves.toBeUndefined()
    expect(await database.getDictionaryInfo()).toEqual([])

    // Warm append and a fresh worker must agree on the same content addresses.
    const bytes = new Uint8Array([9, 8, 7])
    const [span] = await database._termContentStore.appendBatch([bytes])
    expect(span).toEqual({offset: 0, length: 3})
    expect(await database._termContentStore.readSlice(span.offset, span.length)).toEqual(bytes)
    const reopened = new TermContentOpfsStore()
    await expect(reopened.prepare()).resolves.toBeUndefined()
    expect(await reopened.readSlice(span.offset, span.length)).toEqual(bytes)
    await expect(reopened.createImportCheckpoint()).resolves.toHaveProperty('segments')
})

test('failed truncation during committed deletion retains a contiguous prefix for reopening and cleanup retry', async () => {
    const {database, opfs} = await fixture()
    const retainedName = segmentName(2)
    opfs.hooks.beforeRemove = (/** @type {string} */ name) => {
        if (name === retainedName) { throw new DOMException('File is locked', 'NoModificationAllowedError') }
    }
    opfs.hooks.beforeTruncate = (/** @type {string} */ name) => {
        if (name === retainedName) { throw new DOMException('Storage is temporarily unavailable', 'UnknownError') }
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    await expect(database.deleteDictionary('Last', 1000, () => {})).resolves.toBeUndefined()
    expect(await database.getDictionaryInfo()).toEqual([])
    expect(warn).toHaveBeenCalledOnce()

    opfs.hooks.beforeRemove = null
    opfs.hooks.beforeTruncate = null
    const reopened = new TermContentOpfsStore()
    await expect(reopened.prepare()).resolves.toBeUndefined()
    await expect(reopened.reset()).resolves.toBeUndefined()
    const bytes = new Uint8Array([6, 5, 4])
    const [span] = await reopened.appendBatch([bytes])
    expect(span).toEqual({offset: 0, length: 3})
    expect(await reopened.readSlice(span.offset, span.length)).toEqual(bytes)
})
