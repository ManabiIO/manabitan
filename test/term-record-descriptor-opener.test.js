/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'
import {encodePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js'

/**
 * @typedef {object} TestOpfs
 * @property {FileSystemDirectoryHandle} root
 * @property {() => Promise<void>} dispose
 * @property {Array<{type: string, name: string, offset?: number, length?: number}>} operations
 * @property {{beforeCreateWritable: ((name: string) => void|Promise<void>)|null, beforeSeek: ((name: string, offset: number) => void|Promise<void>)|null, beforeWrite: ((name: string) => void|Promise<void>)|null, beforeClose: ((name: string) => void|Promise<void>)|null}} hooks
 */

/** @type {Array<() => Promise<void>>} */
const cleanup = []
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const dispose of cleanup.splice(0)) { await dispose() }
})

function gate() {
    /** @type {() => void} */
    let release = () => {}
    /** @type {Promise<void>} */
    const promise = new Promise((resolve) => { release = resolve })
    return {promise, release}
}

/** @param {boolean} [active=true] */
async function fixture(active = true) {
    const adapterUrl = new URL('fixtures/import-journal-snapshot/node-opfs-adapter.mjs', import.meta.url)
    // eslint-disable-next-line no-unsanitized/method -- Fixed repository fixture URL; no external input.
    const {createNodeOpfs} = /** @type {{createNodeOpfs: (options: {terminalWriteErrors: boolean}) => Promise<TestOpfs>}} */ (await import(adapterUrl.href))
    const opfs = await createNodeOpfs({terminalWriteErrors: true})
    cleanup.push(opfs.dispose)
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => opfs.root}})
    const store = new TermRecordOpfsStore()
    await store.prepare()
    const checkpoint = await store.createImportCheckpoint()
    if (active) { await store.beginImportSession() }
    const fileName = store._getShardFileName('JMdict', 'raw')
    const directory = await opfs.root.getDirectoryHandle('manabitan-term-records')
    return {store, opfs, checkpoint, fileName, directory}
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {string} [expression='one']
 */
async function appendTerm(store, expression = 'one') {
    await store.appendBatch([{
        dictionary: 'JMdict', expression, reading: expression,
        expressionReverse: null, readingReverse: null,
        entryContentOffset: expression === 'one' ? 17 : 43,
        entryContentLength: 5, entryContentDictName: 'raw', score: 12, sequence: 23,
    }])
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {string} fileName
 */
function getState(store, fileName) {
    const state = store._shardStateByFileName.get(fileName)
    if (typeof state === 'undefined') { throw new Error('Missing test shard') }
    return state
}

describe('queued immutable term-record descriptor initialization', () => {
    test('owns the opener before invocation, continues appends, and commits one exact header at finalization', async () => {
        const {store, opfs, fileName, directory} = await fixture()
        const opened = gate()
        const resume = gate()
        opfs.hooks.beforeCreateWritable = async (name) => {
            if (name !== fileName) { return }
            expect(getState(store, fileName).queuedWritePromise).toBeInstanceOf(Promise)
            opened.release()
            await resume.promise
        }
        await appendTerm(store)
        await opened.promise
        const state = getState(store, fileName)
        expect(state.writable).toBeNull()
        expect(state.pendingWriteBytes).toBe(0)
        expect(store._hasPendingShardWrites()).toBe(true)
        await appendTerm(store, 'two')
        const health = vi.spyOn(store, '_setDictionaryHealth')
        const drain = vi.spyOn(store, '_awaitQueuedWritesForShard')
        let settled = false
        const completion = store.endImportSession().finally(() => { settled = true })
        try {
            await vi.waitFor(() => expect(drain).toHaveBeenCalled())
            expect(settled).toBe(false)
            expect(health).not.toHaveBeenCalledWith('JMdict', 'available')
            expect((await (await directory.getFileHandle(fileName)).getFile()).size).toBe(0)
        } finally {
            resume.release()
        }
        await completion
        const operations = opfs.operations.filter(({name}) => name === fileName)
        expect(operations.map(({type}) => type)).toEqual(['create', 'writable', 'seek', 'write', 'close'])
        expect(operations.find(({type}) => type === 'seek')).toMatchObject({offset: 0})
        expect(operations.find(({type}) => type === 'write')).toMatchObject({length: 26})
        const bytes = new Uint8Array(await (await (await directory.getFileHandle(fileName)).getFile()).arrayBuffer())
        expect(bytes).toEqual(new Uint8Array([...new TextEncoder().encode('MBTRD16X'), ...state.generationId, 0, 0]))
        expect(store.getLastEndImportSessionMetrics()).toMatchObject({writeCallCount: 1, totalWriteBytes: 26})
        const reopened = new TermRecordOpfsStore()
        await reopened.prepare()
        await reopened.ensureDictionariesLoaded(['JMdict'])
        const ids = [...reopened.findTermIds('JMdict', 'one', 'expression'), ...reopened.findTermIds('JMdict', 'two', 'expression')]
        expect([...(await reopened.getByIdsAsync(ids)).values()]).toMatchObject([
            {expression: 'one', entryContentOffset: 17, entryContentLength: 5, score: 12, sequence: 23},
            {expression: 'two', entryContentOffset: 43, entryContentLength: 5, score: 12, sequence: 23},
        ])
    })

    test.each(['abort', 'reset', 'delete', 'close'])('%s joins an opener before retiring its descriptor', async (operation) => {
        const {store, opfs, checkpoint, fileName, directory} = await fixture()
        const opened = gate()
        const resume = gate()
        opfs.hooks.beforeCreateWritable = async (name) => {
            if (name !== fileName) { return }
            opened.release()
            await resume.promise
        }
        await appendTerm(store)
        await opened.promise
        let settled = false
        const completion = (async () => {
            switch (operation) {
                case 'abort': await store.rollbackImportSession(checkpoint); break
                case 'reset': await store.reset(); break
                case 'delete': await store._deleteShardByDictionary('JMdict'); break
                default: await store._closeAllWritables(); break
            }
        })().finally(() => { settled = true })
        try {
            for (let i = 0; i < 8; ++i) { await Promise.resolve() }
            expect(settled).toBe(false)
            expect(opfs.operations.filter(({name, type}) => name === fileName && ['close', 'abort', 'remove'].includes(type))).toEqual([])
        } finally {
            resume.release()
        }
        await completion
        const operations = opfs.operations.filter(({name}) => name === fileName)
        expect(operations.filter(({type}) => type === 'writable')).toHaveLength(1)
        const retired = operations.findIndex(({type}) => type === 'close' || type === 'abort')
        expect(retired).toBeGreaterThan(operations.findIndex(({type}) => type === 'write'))
        if (operation === 'close') {
            expect((await (await directory.getFileHandle(fileName)).getFile()).size).toBe(26)
        } else {
            await expect(directory.getFileHandle(fileName)).rejects.toHaveProperty('name', 'NotFoundError')
        }
    })

    test('public deletion still rejects an active import without losing its opener', async () => {
        const {store, opfs, checkpoint, fileName} = await fixture()
        const opened = gate()
        const resume = gate()
        opfs.hooks.beforeCreateWritable = async (name) => {
            if (name !== fileName) { return }
            opened.release()
            await resume.promise
        }
        await appendTerm(store)
        await opened.promise
        try {
            await expect(store.deleteByDictionary('JMdict')).rejects.toThrow('active import session')
            expect(getState(store, fileName).queuedWritePromise).toBeInstanceOf(Promise)
            expect(opfs.operations.some(({type}) => type === 'remove')).toBe(false)
        } finally {
            resume.release()
        }
        await store.rollbackImportSession(checkpoint)
    })

    test.each([
        {stage: 'open', hook: 'beforeCreateWritable', raw: false},
        {stage: 'seek', hook: 'beforeSeek', raw: false},
        {stage: 'write', hook: 'beforeWrite', raw: false},
        {stage: 'non-Error write', hook: 'beforeWrite', raw: true},
    ])('keeps $stage failure sticky and owns the stream through rollback', async ({stage, hook, raw}) => {
        const {store, opfs, checkpoint, fileName, directory} = await fixture()
        const entered = gate()
        const resume = gate()
        const message = `descriptor ${stage} failure`
        const failure = raw ? message : new Error(message)
        Reflect.set(opfs.hooks, hook, async (/** @type {string} */ name) => {
            if (name !== fileName) { return }
            entered.release()
            await resume.promise
            throw failure
        })
        await appendTerm(store)
        await entered.promise
        const drain = vi.spyOn(store, '_awaitQueuedWritesForShard')
        const completion = store.endImportSession().then(() => null, (error) => error)
        await vi.waitFor(() => expect(drain).toHaveBeenCalled())
        resume.release()
        const result = await completion
        expect(result).toBe(failure)
        const stickyFailure = getState(store, fileName).queuedWriteError
        if (raw) {
            expect(stickyFailure).toBeInstanceOf(Error)
            expect(stickyFailure).toHaveProperty('message', message)
        } else {
            expect(stickyFailure).toBe(failure)
        }
        await expect(appendTerm(store, 'two')).rejects.toBe(stickyFailure)
        await store.rollbackImportSession(checkpoint)
        const operations = opfs.operations.filter(({name}) => name === fileName)
        if (stage !== 'open') { expect(operations.some(({type}) => type === 'abort')).toBe(true) }
        await expect(directory.getFileHandle(fileName)).rejects.toHaveProperty('name', 'NotFoundError')
        Reflect.set(opfs.hooks, hook, null)
        await store.beginImportSession()
        await appendTerm(store)
        await store.endImportSession()
        expect((await (await directory.getFileHandle(fileName)).getFile()).size).toBe(26)
    })

    test('a close failure still blocks final publication and permits rollback', async () => {
        const {store, opfs, checkpoint, fileName} = await fixture()
        const failure = new Error('descriptor close failed')
        opfs.hooks.beforeClose = (name) => {
            if (name === fileName) { throw failure }
        }
        await appendTerm(store)
        const health = vi.spyOn(store, '_setDictionaryHealth')
        await expect(store.endImportSession()).rejects.toBe(failure)
        expect(health).not.toHaveBeenCalledWith('JMdict', 'available')
        expect(store._importSessionActive).toBe(true)
        opfs.hooks.beforeClose = null
        await expect(store.rollbackImportSession(checkpoint)).resolves.toBeUndefined()
    })

    test.each([false, true])('keeps the captured opener offset while a later suffix is admitted; recoverable retry=%s', async (retry) => {
        const {store, opfs, fileName, directory} = await fixture()
        const state = await store._getOrCreateShardState('JMdict', 'raw')
        if (state === null) { throw new Error('Missing test shard') }
        const opened = gate()
        const resume = gate()
        let opens = 0
        opfs.hooks.beforeCreateWritable = async (name) => {
            if (name !== fileName || ++opens !== 1) { return }
            opened.release()
            await resume.promise
        }
        let writes = 0
        opfs.hooks.beforeWrite = (name) => {
            if (name === fileName && ++writes === 1 && retry) { throw new Error('closing writable stream') }
        }
        state.fileLength = 3
        store._queueWriteChunksForShard(state, [new Uint8Array([1, 2, 3])])
        await opened.promise
        state.fileLength += 2
        state.pendingWriteChunks = [new Uint8Array([4, 5])]
        state.pendingWriteBytes = 2
        resume.release()
        await store._awaitQueuedWritesForShard(state)
        await store._flushPendingWritesForShard(state)
        await store._awaitQueuedWritesForShard(state)
        await store._closeShardWritable(state)
        const bytes = new Uint8Array(await (await (await directory.getFileHandle(fileName)).getFile()).arrayBuffer())
        expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
        expect(opfs.operations.filter(({name, type}) => name === fileName && type === 'seek').map(({offset}) => offset)).toEqual(retry ? [0, 0] : [0])
    })

    test('retains awaited initialization for generic appends outside an import', async () => {
        const {store, opfs, fileName} = await fixture(false)
        const opened = gate()
        const resume = gate()
        opfs.hooks.beforeCreateWritable = async (name) => {
            if (name !== fileName) { return }
            opened.release()
            await resume.promise
        }
        let settled = false
        const append = appendTerm(store).finally(() => { settled = true })
        await opened.promise
        expect(settled).toBe(false)
        expect(getState(store, fileName).queuedWritePromise).toBeNull()
        resume.release()
        await append
        await store.endImportSession()
        expect(opfs.operations.filter(({name, type}) => name === fileName && type === 'writable')).toHaveLength(1)
    })

    test('retains the generic flush path when the header would fill the existing queue budget', async () => {
        const {store, opfs, fileName} = await fixture()
        store._queuedWriteBudgetBytes = 26
        await appendTerm(store)
        const state = getState(store, fileName)
        expect(state.pendingWriteBytes).toBe(26)
        expect(state.queuedWritePromise).toBeNull()
        expect(opfs.operations.some(({type}) => type === 'writable')).toBe(false)
        await store.endImportSession()
        expect(opfs.operations.filter(({name, type}) => name === fileName && type === 'writable')).toHaveLength(1)
    })

    test('does not queue a descriptor before authoritative field validation succeeds', async () => {
        const {store, opfs, checkpoint} = await fixture()
        const state = await store._getOrCreateShardState('JMdict', 'raw')
        if (state === null) { throw new Error('Missing test shard') }
        const lookup = encodePersistedTermLookupIndex([{expressionBytes: new TextEncoder().encode('one'), readingBytes: null, sequence: 23}])
        await expect(store._appendEncodedChunk(state, 1, 1, 'raw', 0, lookup, new Uint8Array())).rejects.toThrow('Invalid authoritative term-record fields')
        expect(state.queuedWritePromise).toBeNull()
        expect(state.pendingWriteBytes).toBe(26)
        expect(opfs.operations.some(({type}) => type === 'writable')).toBe(false)
        await store.rollbackImportSession(checkpoint)
    })

    test('pending-state detection includes an opener before a writable exists', () => {
        const store = new TermRecordOpfsStore()
        const state = store._createShardState('queued-header.mbtr', /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({})), 0)
        const pending = gate()
        state.queuedWritePromise = pending.promise
        store._shardStateByFileName.set(state.fileName, state)
        expect(store._hasPendingShardWrites()).toBe(true)
        pending.release()
    })
})
