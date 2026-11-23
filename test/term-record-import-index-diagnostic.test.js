/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import {getIndexIoDiagnosticReceipt, resetIndexIoDiagnostic} from '../ext/js/dictionary/term-record-import-index-diagnostic.js'
import {SyncImportIndexWriter, openSyncImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-writer.js'
import {WorkerImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-worker-client.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const mode = vi.hoisted(() => ({arm: /** @type {'A'|'B'|'C'} */ ('A')}))
vi.mock('../ext/js/dictionary/term-record-import-index-diagnostic-arm.js', () => ({
    get INDEX_IO_DIAGNOSTIC_ARM() { return mode.arm },
}))

/** @type {ControlledWorker[]} */
const workers = []
/** @type {TermRecordOpfsStore[]} */
const stores = []

// These witnesses control only startup and acknowledgement. Real-thread byte,
// flush, abort and error transport witnesses remain in the production suites.
class ControlledWorker extends EventTarget {
    constructor() {
        super()
        /** @type {Array<{id: number, action: string}>} */
        this.requests = []
        this.terminated = false
        workers.push(this)
    }

    /** @param {{id: number, action: string}} request */
    postMessage(request) {
        this.requests.push(request)
        queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', {data: {
                id: request.id,
                result: request.action === 'open' ? 'opened' : void 0,
            }}))
        })
    }

    ready() { this.dispatchEvent(new MessageEvent('message', {data: {type: 'ready'}})) }
    fail() { this.dispatchEvent(Object.assign(new Event('error'), {message: 'Startup witness'})) }
    terminate() { this.terminated = true }
}

/**
 * @param {'A'|'B'|'C'} arm
 * @returns {Promise<TermRecordOpfsStore>}
 */
async function begin(arm) {
    mode.arm = arm
    vi.stubGlobal('Worker', ControlledWorker)
    const store = new TermRecordOpfsStore()
    stores.push(store)
    store.setRawTermBankSourceBytes(171_617_523)
    await store.beginImportSession()
    return store
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {number} queuedBytes
 * @returns {{state: ReturnType<TermRecordOpfsStore['_createShardState']>, access: import('../ext/js/dictionary/term-record-import-index-writer.js').SyncAccessHandle, acquire: import('vitest').Mock}}
 */
function sidecar(store, queuedBytes) {
    const access = {
        /**
         * @param {Uint8Array} bytes
         * @returns {number}
         */
        write(bytes) { return bytes.byteLength },
        truncate: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
    }
    const acquire = vi.fn(async () => access)
    const file = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({createSyncAccessHandle: acquire}))
    const state = store._createShardState('diagnostic.mbtr', file, 0)
    state.lookupIndexFileHandle = file
    state.lookupIndexQueuedBytes = queuedBytes
    return {state, access, acquire}
}

afterEach(async () => {
    for (const worker of workers) { worker.ready() }
    for (const store of stores.splice(0)) { await store._abandonImportWritesForRollback() }
    workers.length = 0
    mode.arm = 'A'
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('isolated index I/O diagnostic lifecycle', () => {
    test.each(/** @type {const} */ (['A', 'B', 'C']))('%s retains the intended source gate and readiness boundary', async (arm) => {
        const store = await begin(arm)
        expect(workers).toHaveLength(arm === 'C' ? 1 : 0)
        const {state, acquire} = sidecar(store, 2 * 1024 * 1024)
        const opening = store._createLookupIndexWritable(state)
        if (arm !== 'A') {
            expect(workers).toHaveLength(1)
            expect(workers[0].requests).toHaveLength(0)
            expect(acquire).not.toHaveBeenCalled()
            workers[0].ready()
        }
        const writer = await opening
        expect(writer).toBeInstanceOf(arm === 'A' ? SyncImportIndexWriter : WorkerImportIndexWriter)
        expect(acquire).toHaveBeenCalledTimes(arm === 'A' ? 1 : 0)
        await writer.close()
        await store.endImportSession()
        expect(store.getLastEndImportSessionMetrics()?.lookupIndexWorkerFileCount).toBe(arm === 'A' ? 0 : 1)
        if (arm !== 'A') { expect(workers[0].terminated).toBe(true) }
        expect(getIndexIoDiagnosticReceipt()).toMatchObject({schemaVersion: 1, arm, purpose: 'mechanistic-diagnostic-only'})
    })

    test.each(/** @type {const} */ (['B', 'C']))('%s keeps tiny sidecars local even when readiness was prewarmed', async (arm) => {
        const store = await begin(arm)
        const {state, acquire} = sidecar(store, 2 * 1024 * 1024 - 1)
        const writer = await store._createLookupIndexWritable(state)
        expect(writer).toBeInstanceOf(SyncImportIndexWriter)
        expect(acquire).toHaveBeenCalledOnce()
        expect(workers).toHaveLength(arm === 'C' ? 1 : 0)
        if (arm === 'C') { expect(workers[0].requests).toHaveLength(0) }
        await writer.close()
        if (arm === 'C') { workers[0].ready() }
        await store.endImportSession()
    })

    test('C retains safe local fallback after startup fails before any file is sent', async () => {
        const store = await begin('C')
        workers[0].fail()
        const {state, access, acquire} = sidecar(store, 2 * 1024 * 1024)
        const writer = await store._createLookupIndexWritable(state)
        expect(writer).toBeInstanceOf(SyncImportIndexWriter)
        expect(acquire).toHaveBeenCalledOnce()
        expect(workers[0].requests).toHaveLength(0)
        await writer.write(new Uint8Array(17 * 1024 * 1024))
        expect(access.flush).not.toHaveBeenCalled()
        await writer.close()
        await store.endImportSession()
        expect(access.flush).toHaveBeenCalledOnce()
        expect(workers[0].terminated).toBe(true)
        expect(getIndexIoDiagnosticReceipt().events).toEqual(expect.arrayContaining([
            expect.objectContaining({type: 'worker-startup', status: 'failed'}),
            expect.objectContaining({type: 'writer-flush', reason: 'final', success: true}),
        ]))
    })

    test.each(['end', 'rollback', 'reset'])('C joins late startup on %s with zero sidecars', async (ending) => {
        const store = await begin('C')
        let completed = false
        const finishing = (ending === 'end' ?
store.endImportSession() :
            (ending === 'reset' ? store.reset() : store._abandonImportWritesForRollback()))
            .then(() => { completed = true })
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        expect(completed).toBe(false)
        expect(workers[0].requests).toHaveLength(0)
        expect(workers[0].terminated).toBe(false)
        workers[0].ready()
        await finishing
        expect(workers[0].terminated).toBe(true)
        expect(Reflect.get(store, '_importIndexWorkerPromise')).toBeNull()
        expect(Reflect.get(store, '_diagnosticIndexWorkerAdmitted')).toBe(false)
        expect(getIndexIoDiagnosticReceipt().events).toEqual(expect.arrayContaining([
            expect.objectContaining({type: 'worker-retire'}),
        ]))
    })

    test('flush receipts count actual short writes, final header rewrites and a failed flush', async () => {
        resetIndexIoDiagnostic()
        const flushError = new Error('Flush witness')
        let writtenBytes = 0
        let flushes = 0
        const writer = await openSyncImportIndexWriter({async createSyncAccessHandle() {
            return {
                write(bytes) {
                    const written = Math.min(bytes.byteLength, 173_021)
                    writtenBytes += written
                    return written
                },
                truncate() {},
                flush() { if (++flushes === 2) { throw flushError } },
                close() {},
            }
        }}, true, {writerId: 'test-writer', fileName: 'witness.mbti'})
        if (writer === null) { throw new Error('Writer unavailable') }
        const length = 18 * 1024 * 1024
        await writer.write(new Uint8Array(length))
        await writer.seek(0)
        await writer.write(new Uint8Array(40))
        await expect(writer.close()).rejects.toBe(flushError)
        const events = getIndexIoDiagnosticReceipt().events
        const receipts = events.filter(({type}) => type === 'writer-flush')
        expect(receipts).toHaveLength(2)
        expect(receipts[0]).toMatchObject({reason: 'periodic', success: true, periodicFlush: true})
        expect(receipts[0].writtenBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024)
        expect(receipts[0].writtenBytes).toBeLessThan(16 * 1024 * 1024 + 173_021)
        expect(receipts[1]).toMatchObject({
            reason: 'final',
            success: false,
            position: 40,
            fileLength: length,
            writtenBytes,
            unflushedBytes: writtenBytes - Number(receipts[0].writtenBytes),
        })
        expect(events.at(-1)).toMatchObject({type: 'writer-close', success: true, aborted: false, writtenBytes})
        for (const event of events) { expect(event.endMs).toBeGreaterThanOrEqual(event.startMs) }
    })
})
