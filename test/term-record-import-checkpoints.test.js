/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {afterEach, describe, expect, test, vi} from 'vitest'
import {safePerformance} from '../ext/js/core/safe-performance.js'
import {openSyncImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-writer.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const CHECKPOINT_BYTES = 16 * 1024 * 1024

/**
 * @param {{capacity?: number, shortWrite?: number, failFlushAt?: number, closeError?: Error}} [options]
 * @returns {{access: import('../ext/js/dictionary/term-record-import-index-writer.js').SyncAccessHandle, calls: {writes: Array<{at: number, length: number}>, flushes: Array<{writtenBytes: number, fileLength: number}>, closes: number}, flushError: Error, bytes: Uint8Array|null}}
 */
function createFile({capacity = 0, shortWrite = 512 * 1024, failFlushAt = 0, closeError} = {}) {
    const bytes = capacity === 0 ? null : new Uint8Array(capacity)
    const flushError = new Error('checkpoint flush failed')
    const calls = {
        writes: /** @type {Array<{at: number, length: number}>} */ ([]),
        flushes: /** @type {Array<{writtenBytes: number, fileLength: number}>} */ ([]),
        closes: 0,
    }
    let fileLength = 0
    let writtenBytes = 0
    let clock = 0
    vi.spyOn(safePerformance, 'now').mockImplementation(() => clock)
    const access = {
        /** @param {number} size */
        truncate(size) {
            fileLength = size
        },
        /**
         * @param {Uint8Array} view
         * @param {{at?: number}} [options]
         * @returns {number}
         */
        write(view, {at = 0} = {}) {
            const length = Math.min(view.length, shortWrite)
            bytes?.set(view.subarray(0, length), at)
            calls.writes.push({at, length})
            fileLength = Math.max(fileLength, at + length)
            writtenBytes += length
            return length
        },
        flush() {
            ++clock
            calls.flushes.push({writtenBytes, fileLength})
            if (calls.flushes.length === failFlushAt) { throw flushError }
        },
        close() {
            ++calls.closes
            if (typeof closeError !== 'undefined') { throw closeError }
        },
    }
    return {access, calls, flushError, get bytes() { return bytes?.subarray(0, fileLength) ?? null }}
}

/**
 * @param {ReturnType<typeof createFile>} file
 * @returns {Promise<import('../ext/js/dictionary/term-record-import-index-writer.js').SyncImportIndexWriter>}
 */
async function openWriter(file) {
    const writer = await openSyncImportIndexWriter({async createSyncAccessHandle() { return file.access }})
    if (writer === null) { throw new Error('Expected synchronous writer') }
    return writer
}

/**
 * @param {ReturnType<typeof createFile>} file
 * @returns {{store: TermRecordOpfsStore, state: ReturnType<TermRecordOpfsStore['_createShardState']>, createWritable: ReturnType<typeof vi.fn>}}
 */
function createStore(file) {
    const createWritable = vi.fn()
    const handle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
        async createSyncAccessHandle() { return file.access },
        createWritable,
    }))
    const store = new TermRecordOpfsStore()
    Reflect.set(store, '_importSessionActive', true)
    Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return handle }})
    const state = store._createShardState('fresh.mbtr', handle, 0)
    state.fileLength = 45
    state.pendingLookupIndexChunks = [new Uint8Array(CHECKPOINT_BYTES + 1)]
    state.pendingLookupIndexBytes = CHECKPOINT_BYTES + 1
    state.pendingLookupIndexRecordCount = 1
    Reflect.get(store, '_shardStateByFileName').set('fresh.mbtr', state)
    return {store, state, createWritable}
}

afterEach(() => { vi.restoreAllMocks() })

describe('import index durability checkpoints', () => {
    test.each([0, CHECKPOINT_BYTES - 1, CHECKPOINT_BYTES, CHECKPOINT_BYTES + 1])('flushes %s written bytes before close when due and still flushes at close', async (length) => {
        const file = createFile()
        const writer = await openWriter(file)
        await writer.write(new Uint8Array(length))
        const checkpoints = length >= CHECKPOINT_BYTES ? 1 : 0
        expect(file.calls.flushes).toHaveLength(checkpoints)
        expect(file.calls.closes).toBe(0)
        await writer.close()
        expect(file.calls.flushes).toHaveLength(checkpoints + 1)
        expect(file.calls.closes).toBe(1)
        expect(writer.getFlushMetrics()).toEqual({
            checkpointCount: checkpoints,
            checkpointBytes: checkpoints * CHECKPOINT_BYTES,
            checkpointMs: checkpoints,
            finalFlushMs: 1,
        })
    })

    test('preserves exact ordered bytes across short writes, chunk joins, header patches and truncation', async () => {
        const expected = Uint8Array.from({length: 2 * CHECKPOINT_BYTES + 77}, (_, i) => (i ^ (i >>> 8)) & 255)
        const input = new Uint8Array(expected)
        const file = createFile({capacity: expected.length, shortWrite: 64 * 1024})
        const writer = await openWriter(file)
        await writer.writeChunks([input.subarray(0, 123), new Uint8Array(0), input.subarray(123, CHECKPOINT_BYTES + 17), input.subarray(CHECKPOINT_BYTES + 17)])
        expect(file.calls.flushes.map(({writtenBytes}) => writtenBytes)).toEqual([CHECKPOINT_BYTES, 2 * CHECKPOINT_BYTES])
        await writer.seek(0)
        await writer.write(Uint8Array.of(9, 8, 7))
        await writer.truncate(expected.length - 11)
        await writer.close()
        expect(Buffer.compare(input, expected)).toBe(0)
        expected.set([9, 8, 7])
        expect(Buffer.compare(/** @type {Uint8Array} */ (file.bytes), expected.subarray(0, -11))).toBe(0)
        expect(file.calls.flushes).toHaveLength(3)
        expect(file.calls.flushes[2]).toEqual({writtenBytes: input.length + 3, fileLength: input.length - 11})
        expect(file.calls.writes.every(({length}) => length <= 512 * 1024)).toBe(true)
    })

    test('counts actual rewritten bytes instead of the current seek position', async () => {
        const file = createFile({shortWrite: 128 * 1024})
        const writer = await openWriter(file)
        await writer.write(new Uint8Array(CHECKPOINT_BYTES - 128 * 1024))
        await writer.seek(0)
        await writer.write(new Uint8Array(128 * 1024))
        expect(file.calls.flushes).toEqual([{writtenBytes: CHECKPOINT_BYTES, fileLength: CHECKPOINT_BYTES - 128 * 1024}])
        await writer.close()
        expect(file.calls.flushes).toHaveLength(2)
    })

    test('aborting a queued write suppresses new checkpoints and the final durability flush', async () => {
        const file = createFile()
        const writer = await openWriter(file)
        await writer.write(new Uint8Array(CHECKPOINT_BYTES))
        const queued = writer.write(new Uint8Array(CHECKPOINT_BYTES + 1))
        await writer.abort()
        await queued
        expect(file.calls.flushes).toHaveLength(1)
        expect(file.calls.closes).toBe(1)
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'})
        expect(writer.getFlushMetrics().finalFlushMs).toBe(0)
    })

    test('a checkpoint failure stops later bytes and remains sticky through mutation and close', async () => {
        const file = createFile({failFlushAt: 1})
        const writer = await openWriter(file)
        await expect(writer.write(new Uint8Array(CHECKPOINT_BYTES + 512 * 1024))).rejects.toBe(file.flushError)
        expect(file.calls.writes.reduce((sum, {length}) => sum + length, 0)).toBe(CHECKPOINT_BYTES)
        await expect(writer.write(Uint8Array.of(1))).rejects.toBe(file.flushError)
        await expect(writer.seek(0)).rejects.toBe(file.flushError)
        await expect(writer.truncate(0)).rejects.toBe(file.flushError)
        await expect(writer.close()).rejects.toBe(file.flushError)
        await expect(writer.abort()).rejects.toBe(file.flushError)
        expect(file.calls.flushes).toHaveLength(1)
        expect(file.calls.closes).toBe(1)
    })

    test('final flush failure still rejects after successful checkpoints', async () => {
        const file = createFile({failFlushAt: 2})
        const writer = await openWriter(file)
        await writer.write(new Uint8Array(CHECKPOINT_BYTES + 1))
        await expect(writer.close()).rejects.toBe(file.flushError)
        await expect(writer.close()).rejects.toBe(file.flushError)
        expect(file.calls.flushes).toHaveLength(2)
        expect(file.calls.closes).toBe(1)
    })

    test('aggregates checkpoint and close failures without retrying either operation', async () => {
        const closeError = new Error('close failed')
        const file = createFile({failFlushAt: 1, closeError})
        const writer = await openWriter(file)
        await expect(writer.write(new Uint8Array(CHECKPOINT_BYTES))).rejects.toBe(file.flushError)
        const failure = await writer.close().then(() => null, (error) => error)
        expect(failure).toMatchObject({errors: [file.flushError, closeError]})
        await expect(writer.close()).rejects.toBe(failure)
        expect(file.calls.flushes).toHaveLength(1)
        expect(file.calls.closes).toBe(1)
    })

    test('exposes checkpoint work and final flush separately in storage finalization metrics', async () => {
        const file = createFile()
        const {store, createWritable} = createStore(file)
        await store.endImportSession()
        expect(store.getLastEndImportSessionMetrics()).toMatchObject({
            lookupIndexCheckpointCount: 1,
            lookupIndexCheckpointBytes: CHECKPOINT_BYTES + 40,
            lookupIndexCheckpointMs: 1,
            lookupIndexFinalFlushMs: 1,
            lookupIndexWriteBytes: CHECKPOINT_BYTES + 1,
        })
        expect(file.calls.flushes).toHaveLength(2)
        expect(createWritable).not.toHaveBeenCalled()
        expect(Reflect.get(store, '_importSessionActive')).toBe(false)
    })

    test('a checkpoint failure fails import without switching to the asynchronous writer', async () => {
        const file = createFile({failFlushAt: 1})
        const {store, state, createWritable} = createStore(file)
        await expect(store.endImportSession()).rejects.toBeInstanceOf(AggregateError)
        expect(state.lookupIndexWriteError).toBe(file.flushError)
        expect(state.lookupIndexWritable).toBeNull()
        expect(file.calls.closes).toBe(1)
        expect(createWritable).not.toHaveBeenCalled()
        expect(Reflect.get(store, '_importSessionActive')).toBe(true)
        expect(store.getLastEndImportSessionMetrics()).toBeNull()
    })
})
