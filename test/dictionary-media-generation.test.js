/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {afterEach, beforeAll, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {deferPromise} from '../ext/js/core/utilities.js'
import {log} from '../ext/js/core/log.js'

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3
/** @type {import('@sqlite.org/sqlite-wasm').Database[]} */
const connections = []
beforeAll(async () => { sqlite3 = await sqlite3InitModule() })
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const connection of connections.splice(0)) { connection.close() }
})

/** @returns {Promise<DictionaryDatabase>} */
async function fixture() {
    const connection = new sqlite3.oo1.DB(':memory:')
    connections.push(connection)
    const database = new DictionaryDatabase()
    database._db = connection
    database._sqlite3 = sqlite3
    await database._initializeSchema()
    return database
}

/**
 * @param {DictionaryDatabase} database
 * @param {string} dictionary
 * @param {number} value
 * @returns {Promise<void>}
 */
async function install(database, dictionary, value) {
    const bytes = new Uint8Array([value, value, value, value])
    const [span] = await database._termContentStore.appendBatch([bytes])
    await database.bulkAdd('dictionaries', [{title: dictionary, version: 3, importSuccess: true, revision: '1', sequenced: false, importDate: 1, prefixWildcardsSupported: true, styles: ''}], 0, 1)
    await database.bulkAddExternalMediaRows([{
        dictionary,
        path: 'image.png',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        content: new ArrayBuffer(0),
        contentOffset: span.offset,
        contentLength: span.length,
    }])
}

/**
 * @param {DictionaryDatabase} database
 * @returns {{entered: import('core').DeferredPromiseDetails<void>, resume: import('core').DeferredPromiseDetails<void>}}
 */
function pauseNextRead(database) {
    const entered = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const resume = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise())
    const read = database._termContentStore.readSlice.bind(database._termContentStore)
    vi.spyOn(database._termContentStore, 'readSlice').mockImplementationOnce(async (...args) => {
        entered.resolve()
        await resume.promise
        return await read(...args)
    })
    return {entered, resume}
}

test.each(['New', 'Old'])('a media request cannot borrow bytes after replacing Old with %s', async (replacement) => {
    const database = await fixture()
    await install(database, 'Old', 1)
    const gate = pauseNextRead(database)
    const request = database.getMedia([{dictionary: 'Old', path: 'image.png'}])
    const outcome = request.then((value) => ({value}), (error) => ({error}))
    await gate.entered.promise
    await database.deleteDictionary('Old', 1000, () => {})
    await install(database, replacement, 2)
    gate.resume.resolve()
    expect(await outcome).toMatchObject({error: {message: expect.stringContaining('lookup state changed')}})
    const media = await database.getMedia([{dictionary: replacement, path: 'image.png'}])
    expect([...new Uint8Array(media[0].content)]).toEqual([2, 2, 2, 2])
})

test('a direct media drawing port cannot publish bytes borrowed from a subsequent dictionary', async () => {
    const database = await fixture()
    await install(database, 'Old', 1)
    const gate = pauseNextRead(database)
    const postMessage = vi.fn()
    const close = vi.fn()
    const decodedBytes = /** @type {number[][]} */ ([])
    vi.stubGlobal('navigator', {serviceWorker: {}})
    vi.stubGlobal('ImageDecoder', class {
        /** @param {{data: ArrayBuffer}} options */
        constructor({data}) { decodedBytes.push([...new Uint8Array(data)]) }
        close = close
        async decode() { return {image: {close}} }
    })
    const report = vi.spyOn(log, 'error').mockImplementation(() => {})
    const draw = vi.spyOn(database, 'drawMedia')
    const port = /** @type {MessagePort} */ (/** @type {unknown} */ ({postMessage, onmessage: null}))
    const replies = /** @type {Map<string, import('core').DeferredPromiseDetails<unknown>>} */ (new Map())
    vi.stubGlobal('self', {addEventListener: vi.fn(), postMessage: (/** @type {{id: string, error?: unknown}} */ message) => { replies.get(message.id)?.resolve(message) }})
    const {OffscreenDictionaryWorkerHandler} = await import('../ext/js/background/offscreen-dictionary-worker.js')
    const worker = new OffscreenDictionaryWorkerHandler()
    Reflect.set(worker, '_dictionaryDatabase', database)
    Reflect.set(worker, '_databaseReady', true)
    Reflect.set(worker, '_translator', {clearDatabaseCaches: vi.fn()})
    /**
     * Exercise the actual queue rather than calling the deletion handler
     * directly: connected drawing ports run outside that exclusive queue.
     * @param {string} action
     * @param {Record<string, unknown>} params
     * @param {MessagePort[]} ports
     * @returns {Promise<void>}
     */
    const send = async (action, params, ports) => {
        const reply = deferPromise()
        replies.set(action, reply)
        worker._onMessage(/** @type {Parameters<typeof worker._onMessage>[0]} */ (/** @type {unknown} */ ({data: {id: action, action, params}, ports})))
        expect(await reply.promise).not.toHaveProperty('error')
    }
    await send('connectToDatabaseWorker', {}, [port])
    const requests = [{dictionary: 'Old', path: 'image.png', canvasIndex: 4, canvasWidth: 1, canvasHeight: 1, generation: 3}]
    const event = /** @type {MessageEvent} */ ({data: {action: 'drawMedia', params: {requests}}})
    if (port.onmessage === null) { throw new Error('Missing connected media handler') }
    port.onmessage.call(port, event)
    await gate.entered.promise
    await send('deleteDictionaryOffscreen', {dictionaryTitle: 'Old'}, [])
    await install(database, 'New', 2)
    gate.resume.resolve()
    await draw.mock.results[0].value.catch(() => {})
    expect(decodedBytes).toEqual([])
    expect(postMessage).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    port.onmessage.call(port, /** @type {MessageEvent} */ ({data: {
        action: 'drawMedia', params: {requests: [{...requests[0], dictionary: 'New', generation: 4}]},
    }}))
    await draw.mock.results[1].value
    expect(postMessage).toHaveBeenCalledOnce()
    expect(decodedBytes).toEqual([[2, 2, 2, 2]])
    expect(postMessage.mock.calls[0][0].params.generation).toBe(4)
    expect(report).toHaveBeenCalledOnce()
})


test('overlapping media reads without a mutation keep their exact requested bytes', async () => {
    const database = await fixture()
    await install(database, 'First', 1)
    await install(database, 'Second', 2)
    const gate = pauseNextRead(database)
    const first = database.getMedia([{dictionary: 'First', path: 'image.png'}])
    await gate.entered.promise
    const second = await database.getMedia([{dictionary: 'Second', path: 'image.png'}])
    gate.resume.resolve()
    expect([...new Uint8Array((await first)[0].content)]).toEqual([1, 1, 1, 1])
    expect([...new Uint8Array(second[0].content)]).toEqual([2, 2, 2, 2])
})
