/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint-disable @stylistic/semi */

import {describe, expect, test, vi} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

function gate() {
    /** @type {() => void} */
    let release = () => {}
    /** @type {Promise<void>} */
    const promise = new Promise((resolve) => { release = resolve })
    return {promise, release}
}

async function fixture() {
    const store = new TermRecordOpfsStore()
    await store.beginImportSession()
    const fileName = store._getShardSegmentFileName('JMdict', 'raw', 0)
    const state = store._createShardState(
        fileName,
        /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({})),
        0,
    )
    Reflect.get(store, '_shardStateByFileName').set(fileName, state)
    Reflect.get(store, '_importSessionDictionaryNames').add('JMdict')
    const health = vi.spyOn(store, '_setDictionaryHealth').mockImplementation(() => {})
    const retire = vi.spyOn(store, '_retireImportIndexWorker').mockResolvedValue()
    return {store, state, health, retire}
}

describe('term-record import finalization ownership', () => {
    test('seals the lookup index while descriptor preparation is pending and joins every stage', async () => {
        const {store, health, retire} = await fixture()
        const flushGate = gate()
        const drainGate = gate()
        const closeGate = gate()
        const indexGate = gate()
        const flush = vi.spyOn(store, '_flushPendingWritesForShard').mockImplementation(async () => await flushGate.promise)
        const drain = vi.spyOn(store, '_awaitQueuedWritesForShard').mockImplementation(async () => await drainGate.promise)
        const close = vi.spyOn(store, '_closeShardWritable').mockImplementation(async () => await closeGate.promise)
        const index = vi.spyOn(store, '_flushLookupIndexFile').mockImplementation(async () => await indexGate.promise)
        let settled = false
        const finalization = store.endImportSession().finally(() => { settled = true })

        await vi.waitFor(() => {
            expect(flush).toHaveBeenCalledOnce()
            expect(index).toHaveBeenCalledOnce()
        })
        expect(drain).not.toHaveBeenCalled()
        indexGate.release()
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(retire).not.toHaveBeenCalled()
        expect(health).not.toHaveBeenCalled()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)

        flushGate.release()
        await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
        expect(close).not.toHaveBeenCalled()
        expect(retire).not.toHaveBeenCalled()
        drainGate.release()
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
        expect(settled).toBe(false)
        expect(retire).not.toHaveBeenCalled()
        closeGate.release()
        await finalization
        expect(retire).toHaveBeenCalledOnce()
        expect(health).toHaveBeenCalledExactlyOnceWith('JMdict', 'available')
        expect(Reflect.get(store, '_importSessionActive')).toBe(false)
    })

    test.each(['flush', 'drain', 'close'])('owns the index chain after descriptor %s fails', async (stage) => {
        const {store, health, retire} = await fixture()
        const failure = new Error(`descriptor ${stage} failed`)
        const indexGate = gate()
        const flush = vi.spyOn(store, '_flushPendingWritesForShard').mockImplementation(async () => {
            if (stage === 'flush') { throw failure }
        })
        const drain = vi.spyOn(store, '_awaitQueuedWritesForShard').mockImplementation(async () => {
            if (stage === 'drain') { throw failure }
        })
        const close = vi.spyOn(store, '_closeShardWritable').mockImplementation(async () => {
            if (stage === 'close') { throw failure }
        })
        const index = vi.spyOn(store, '_flushLookupIndexFile').mockImplementation(async () => await indexGate.promise)
        let settled = false
        const finalization = store.endImportSession().then(
            () => { settled = true; return null },
            (error) => { settled = true; return error },
        )

        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
        expect(flush).toHaveBeenCalledOnce()
        expect(drain).toHaveBeenCalledOnce()
        expect(index).toHaveBeenCalledOnce()
        expect(settled).toBe(false)
        expect(retire).not.toHaveBeenCalled()
        indexGate.release()
        expect(await finalization).toBe(failure)
        expect(retire).toHaveBeenCalledOnce()
        expect(health).not.toHaveBeenCalled()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)
        expect(store.getLastEndImportSessionMetrics()).toBeNull()
    })

    test('owns descriptor preparation after index sealing fails', async () => {
        const {store, health, retire} = await fixture()
        const failure = new Error('index sealing failed')
        const flushGate = gate()
        const flush = vi.spyOn(store, '_flushPendingWritesForShard').mockImplementation(async () => await flushGate.promise)
        const drain = vi.spyOn(store, '_awaitQueuedWritesForShard').mockResolvedValue()
        const close = vi.spyOn(store, '_closeShardWritable').mockResolvedValue()
        const index = vi.spyOn(store, '_flushLookupIndexFile').mockRejectedValue(failure)
        let settled = false
        const finalization = store.endImportSession().then(
            () => { settled = true; return null },
            (error) => { settled = true; return error },
        )

        await vi.waitFor(() => expect(index).toHaveBeenCalledOnce())
        expect(flush).toHaveBeenCalledOnce()
        expect(drain).not.toHaveBeenCalled()
        expect(close).not.toHaveBeenCalled()
        expect(settled).toBe(false)
        expect(retire).not.toHaveBeenCalled()
        flushGate.release()
        expect(await finalization).toBe(failure)
        expect(drain).toHaveBeenCalledOnce()
        expect(close).toHaveBeenCalledOnce()
        expect(retire).toHaveBeenCalledOnce()
        expect(health).not.toHaveBeenCalled()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)
    })

    test('retains independent failures from descriptor preparation, drain, close, and index sealing', async () => {
        const {store, retire} = await fixture()
        const flushFailure = new Error('descriptor preparation failed')
        const drainFailure = new Error('descriptor drain failed')
        const closeFailure = new Error('descriptor close failed')
        const indexFailure = new Error('index sealing failed')
        vi.spyOn(store, '_flushPendingWritesForShard').mockRejectedValue(flushFailure)
        vi.spyOn(store, '_awaitQueuedWritesForShard').mockRejectedValue(drainFailure)
        vi.spyOn(store, '_closeShardWritable').mockRejectedValue(closeFailure)
        vi.spyOn(store, '_flushLookupIndexFile').mockRejectedValue(indexFailure)

        await expect(store.endImportSession()).rejects.toMatchObject({
            errors: [
                {errors: [flushFailure, drainFailure, closeFailure]},
                indexFailure,
            ],
        })
        expect(retire).toHaveBeenCalledOnce()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)
    })

    test('reports a sticky descriptor write failure once after both flush and drain observe it', async () => {
        const {store, retire} = await fixture()
        const failure = new Error('queued descriptor write failed')
        vi.spyOn(store, '_flushPendingWritesForShard').mockRejectedValue(failure)
        vi.spyOn(store, '_awaitQueuedWritesForShard').mockRejectedValue(failure)
        const close = vi.spyOn(store, '_closeShardWritable').mockResolvedValue()
        vi.spyOn(store, '_flushLookupIndexFile').mockResolvedValue()

        await expect(store.endImportSession()).rejects.toBe(failure)
        expect(close).toHaveBeenCalledOnce()
        expect(retire).toHaveBeenCalledOnce()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)
    })

    test('does not invoke an Error cause accessor while collecting independent close failures', async () => {
        const {store, state, retire} = await fixture()
        const failure = new Error('queued descriptor write failed')
        const causeGetter = vi.fn(() => { throw new Error('unexpected cause getter') })
        Object.defineProperty(failure, 'cause', {get: causeGetter})
        state.queuedWriteError = failure
        vi.spyOn(store, '_flushPendingWritesForShard').mockRejectedValue(failure)
        vi.spyOn(store, '_awaitQueuedWritesForShard').mockRejectedValue(failure)
        vi.spyOn(store, '_closeShardWritable').mockRejectedValue('independent close failure')
        vi.spyOn(store, '_flushLookupIndexFile').mockResolvedValue()

        await expect(store.endImportSession()).rejects.toMatchObject({
            errors: [failure, {message: 'independent close failure'}],
        })
        expect(causeGetter).not.toHaveBeenCalled()
        expect(retire).toHaveBeenCalledOnce()
    })

    test('writes the final logical descriptor length before its independent file-open completes', async () => {
        const {store, state, retire} = await fixture()
        const openGate = gate()
        const descriptorBytes = new Uint8Array(45)
        const descriptorWrite = vi.fn(async () => {})
        const descriptorClose = vi.fn(async () => {})
        state.fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
            async createWritable() {
                await openGate.promise
                return {seek: async () => {}, write: descriptorWrite, close: descriptorClose}
            },
        }))
        state.fileLength = descriptorBytes.length
        state.pendingWriteBytes = descriptorBytes.length
        state.pendingWriteChunks = [descriptorBytes]
        state.lookupIndexChunkCount = 1
        state.lookupIndexRecordCount = 2
        /** @type {Uint8Array|null} */
        let header = null
        const indexClose = vi.fn(async () => {})
        state.lookupIndexWritable = /** @type {FileSystemWritableFileStream} */ (/** @type {unknown} */ ({
            async seek() {},
            /** @param {Uint8Array} bytes */
            async write(bytes) { header = Uint8Array.from(bytes) },
            close: indexClose,
        }))
        Reflect.set(store, '_recordsDirectoryHandle', {})

        const finalization = store.endImportSession()
        await vi.waitFor(() => expect(indexClose).toHaveBeenCalledOnce())
        expect(descriptorWrite).not.toHaveBeenCalled()
        expect(descriptorClose).not.toHaveBeenCalled()
        expect(retire).not.toHaveBeenCalled()
        if (header === null) { throw new Error('Missing final lookup-index header') }
        const observedHeader = /** @type {Uint8Array} */ (header)
        const view = new DataView(observedHeader.buffer, observedHeader.byteOffset, observedHeader.byteLength)
        expect(new TextDecoder().decode(observedHeader.subarray(0, 8))).toBe('MBTIDX11')
        expect(view.getUint32(8, true)).toBe(descriptorBytes.length)
        expect(view.getUint32(12, true)).toBe(0)
        expect(view.getUint32(16, true)).toBe(1)
        expect(view.getUint32(20, true)).toBe(2)
        expect(observedHeader.subarray(24)).toEqual(state.generationId)
        openGate.release()
        await finalization
        expect(descriptorWrite).toHaveBeenCalledExactlyOnceWith(descriptorBytes)
        expect(descriptorClose).toHaveBeenCalledOnce()
        expect(retire).toHaveBeenCalledOnce()
    })
})
/* eslint-enable @stylistic/semi */
