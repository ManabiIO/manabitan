/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {createImportIndexWorkerClient, WorkerImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-worker-client.js';
import {SyncImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-writer.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {createImportIndexChunkFixture} from './util/import-index-chunk-fixture.js';

/** @type {NodeWorker[]} */
const workers = [];
/** @type {ReturnType<typeof fixture>[]} */
const files = [];

class NodeWorker extends EventTarget {
    /** @param {URL} entry */
    constructor(entry) {
        super();
        this.thread = new ThreadWorker(new URL('util/import-index-test-worker.js', import.meta.url), {workerData: {entry: entry.href}});
        this.terminated = false;
        this.thread.on('message', (data) => { this.dispatchEvent(new MessageEvent('message', {data})); });
        this.thread.on('error', (error) => { this.fail(error.message); });
        this.exited = new Promise((resolve) => {
            this.thread.once('exit', (code) => {
                if (!this.terminated) { this.fail(`Import index worker exited: ${code}`); }
                resolve(code);
            });
        });
        workers.push(this);
    }

    /**
     * @param {unknown} data
     * @param {import('node:worker_threads').TransferListItem[]} transfer
     */
    postMessage(data, transfer) { this.thread.postMessage(data, transfer); }

    terminate() {
        this.terminated = true;
        void this.thread.terminate();
    }

    /** @param {string} message */
    fail(message) { this.dispatchEvent(Object.assign(new Event('error'), {message})); }
}

/**
 * @param {import('./util/import-index-test-worker.js').FileOptions} [options]
 * @returns {{directory: string, filePath: string, handle: FileSystemFileHandle, counters: Int32Array}}
 */
function fixture(options = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'manabitan-index-worker-'));
    const filePath = path.join(directory, 'index.mbti');
    writeFileSync(filePath, new Uint8Array());
    const counters = new Int32Array(new SharedArrayBuffer(8 * 4));
    const handle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({path: filePath, counters: counters.buffer, options}));
    const file = {directory, filePath, handle, counters};
    files.push(file);
    return file;
}

/**
 * @param {ReturnType<typeof fixture>} file
 * @returns {Promise<{client: NonNullable<Awaited<ReturnType<typeof createImportIndexWorkerClient>>>, writer: NonNullable<Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof createImportIndexWorkerClient>>>['open']>>>}>}
 */
async function openWorker(file) {
    vi.stubGlobal('Worker', NodeWorker);
    const client = await createImportIndexWorkerClient();
    if (client === null) { throw new Error('Production worker failed to start'); }
    const writer = await client.open(file.handle);
    if (writer === null) { throw new Error('Production worker failed to acquire file'); }
    return {client, writer};
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function patternedBytes(length) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; ++i) { bytes[i] = (i * 17 + (i >>> 9)) & 255; }
    return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * @param {ReturnType<typeof fixture>} file
 * @param {Uint8Array} bytes
 * @returns {{store: TermRecordOpfsStore, state: ReturnType<TermRecordOpfsStore['_createShardState']>}}
 */
function storeWithPendingIndex(file, bytes) {
    vi.stubGlobal('Worker', NodeWorker);
    const store = new TermRecordOpfsStore();
    store.setRawTermBankSourceBytes(1024 * 1024 * 1024);
    const name = store._getShardSegmentFileName('Worker test', 'raw', 0);
    const state = store._createShardState(name, file.handle, 0);
    state.pendingLookupIndexChunks = [bytes];
    state.pendingLookupIndexBytes = bytes.byteLength;
    state.pendingLookupIndexRecordCount = 1;
    state.fileLength = 45;
    Reflect.set(store, '_importSessionActive', true);
    Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() { return file.handle; }});
    Reflect.get(store, '_shardStateByFileName').set(name, state);
    return {store, state};
}

/**
 * Native file-handle methods are not enumerable data in a worker message.
 * @param {ReturnType<typeof fixture>} file
 * @returns {{flush: import('vitest').Mock, close: import('vitest').Mock}}
 */
function localFallback(file) {
    const access = {
        write: vi.fn((/** @type {Uint8Array} */ bytes) => bytes.byteLength),
        truncate: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
    };
    Object.defineProperty(file.handle, 'createSyncAccessHandle', {value: async () => access});
    return access;
}

/** @param {ReturnType<typeof fixture>} file */
function release(file) {
    Atomics.store(file.counters, 5, 1);
    Atomics.notify(file.counters, 5);
}

afterEach(async () => {
    for (const file of files) { release(file); }
    for (const worker of workers) { worker.terminate(); }
    await Promise.all(workers.splice(0).map((worker) => worker.exited));
    for (const file of files.splice(0)) { rmSync(file.directory, {recursive: true, force: true}); }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('production import index worker', () => {
    test('writes exact owned envelope parts through short writes without changing logical chunk counts', async () => {
        const file = fixture({shortWrite: 200_003});
        const prepared = await createImportIndexChunkFixture(30000);
        const chunk = prepared.adopt();
        if (chunk instanceof Uint8Array) { throw new Error('Expected owned envelope parts'); }
        const chunks = Array.from({length: 4}, () => structuredClone(chunk));
        const {store, state} = storeWithPendingIndex(file, new Uint8Array());
        state.pendingLookupIndexChunks = chunks;
        state.pendingLookupIndexBytes = chunks.reduce((sum, item) => sum + item.byteLength, 0);
        state.pendingLookupIndexRecordCount = prepared.chunk.rowCount * chunks.length;
        await store._flushPendingLookupIndexChunks(state, true);
        expect(state.lookupIndexChunkCount).toBe(4);
        expect(state.lookupIndexRecordCount).toBe(120000);
        expect(state.lookupIndexQueuedBytes).toBe(0);
        await store.endImportSession();
        const stored = readFileSync(file.filePath);
        const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
        expect(view.getUint32(16, true)).toBe(4);
        expect(view.getUint32(20, true)).toBe(120000);
        expect(digest(stored.subarray(40))).toBe(digest(Buffer.concat(Array.from({length: 4}, () => prepared.expected))));
        expect(chunks.every((item) => item.header.byteLength === 0 && item.payload.byteLength === 0 && item.recordFields.byteLength === 0)).toBe(true);
        expect(Atomics.load(file.counters, 7)).toBeLessThanOrEqual(512 * 1024);
        expect(workers).toHaveLength(1);
    });

    test('keeps every envelope byte charged through a blocked periodic flush and rollback', async () => {
        const file = fixture({blockFlushAt: 1});
        const prepared = await createImportIndexChunkFixture(30000);
        const chunk = prepared.adopt();
        if (chunk instanceof Uint8Array) { throw new Error('Expected owned envelope parts'); }
        const chunks = Array.from({length: 32}, () => structuredClone(chunk));
        const {store, state} = storeWithPendingIndex(file, new Uint8Array());
        const byteLength = chunks.reduce((sum, item) => sum + item.byteLength, 0);
        expect(byteLength).toBeGreaterThan(16 * 1024 * 1024);
        state.pendingLookupIndexChunks = chunks;
        state.pendingLookupIndexBytes = byteLength;
        state.pendingLookupIndexRecordCount = prepared.chunk.rowCount * chunks.length;
        Reflect.set(store, '_queuedWriteBudgetBytes', 8 * 1024 * 1024);
        let acknowledged = false;
        const writing = store._flushPendingLookupIndexChunks(state, false).then(() => { acknowledged = true; });
        await expect.poll(() => Atomics.load(file.counters, 4)).toBe(2);
        expect(state.lookupIndexQueuedBytes).toBe(byteLength);
        expect(acknowledged).toBe(false);
        let abandoned = false;
        const rollback = store._abandonImportWritesForRollback().then(() => { abandoned = true; });
        await Promise.resolve();
        expect(abandoned).toBe(false);
        release(file);
        await Promise.all([writing, rollback]);
        expect(state.lookupIndexQueuedBytes).toBe(0);
        expect(state.lookupIndexWritable).toBeNull();
        expect(Atomics.load(file.counters, 2)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(digest(readFileSync(file.filePath).subarray(40))).toBe(digest(Buffer.concat(Array.from({length: 32}, () => prepared.expected))));
    });

    test('an earlier write failure remains authoritative before deferred envelope preparation', async () => {
        const file = fixture({writeErrorAt: 2});
        const {client, writer} = await openWorker(file);
        const prepared = await createImportIndexChunkFixture();
        const first = writer.writeOwnedChunks([patternedBytes(1024 * 1024)]);
        const second = writer.writeOwnedIndexChunks([prepared.adopt()]);
        const failures = await Promise.all([first.catch((error) => error), second.catch((error) => error)]);
        expect(failures[0]).toMatchObject({message: 'Worker write witness'});
        expect(failures[1]).toBe(failures[0]);
        await expect(writer.close()).rejects.toBe(failures[0]);
        expect(Atomics.load(file.counters, 1)).toBe(2);
        expect(Atomics.load(file.counters, 2)).toBe(0);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        client.dispose();
    });

    test('preserves positional byte parity across owned transfer, short writes and periodic/final flush', async () => {
        const file = fixture({shortWrite: 200_003});
        const {client, writer} = await openWorker(file);
        const expected = patternedBytes(18 * 1024 * 1024 + 31);
        const first = expected.slice(0, 1024 * 1024 + 7);
        const second = expected.slice(first.byteLength);
        const writing = writer.writeOwnedChunks([first, second]);
        expect(first.byteLength).toBe(0);
        expect(second.byteLength).toBe(0);
        const header = new Uint8Array([9, 8, 7, 6]);
        await Promise.all([writing, writer.seek(0), writer.write(header), writer.truncate(expected.byteLength - 13)]);
        await writer.close();
        expected.set(header);
        expect(digest(readFileSync(file.filePath))).toBe(digest(expected.subarray(0, expected.byteLength - 13)));
        expect([...header]).toEqual([9, 8, 7, 6]);
        expect(Atomics.load(file.counters, 2)).toBe(2);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(Atomics.load(file.counters, 7)).toBeLessThanOrEqual(512 * 1024);
        client.dispose();
    });

    test('joins an admitted large write on abort and suppresses periodic/final flush', async () => {
        const file = fixture({blockWriteAt: 1});
        const {client, writer} = await openWorker(file);
        const bytes = patternedBytes(18 * 1024 * 1024);
        const expected = digest(bytes);
        const writing = writer.writeOwnedChunks([bytes]);
        await expect.poll(() => Atomics.load(file.counters, 4)).toBe(1);
        let aborted = false;
        const aborting = writer.abort().then(() => { aborted = true; });
        await new Promise((resolve) => { setTimeout(resolve, 15); });
        expect(aborted).toBe(false);
        expect(Atomics.load(file.counters, 3)).toBe(0);
        release(file);
        await Promise.all([writing, aborting]);
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'});
        expect(digest(readFileSync(file.filePath))).toBe(expected);
        expect(Atomics.load(file.counters, 2)).toBe(0);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        client.dispose();
    });

    test('retains sticky write failure identity and both close causes across the production boundary', async () => {
        const file = fixture({writeErrorAt: 2, closeError: true});
        const {client, writer} = await openWorker(file);
        const writing = writer.writeOwnedChunks([patternedBytes(1024 * 1024)]);
        const failure = await writing.catch((error) => error);
        expect(failure).toMatchObject({message: 'Worker write witness'});
        await expect(writer.write(new Uint8Array([1]))).rejects.toBe(failure);
        const closed = await writer.close().catch((error) => error);
        expect(closed).toBeInstanceOf(AggregateError);
        expect(closed.errors[0]).toBe(failure);
        expect(closed.errors[1]).toMatchObject({message: 'Worker close witness'});
        await expect(writer.close()).rejects.toBe(closed);
        expect(Atomics.load(file.counters, 1)).toBe(2);
        expect(Atomics.load(file.counters, 2)).toBe(0);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        client.dispose();
    });

    test('retains positional overflow validation and its error type before writing bytes', async () => {
        const file = fixture();
        const {client, writer} = await openWorker(file);
        await writer.seek(Number.MAX_SAFE_INTEGER);
        const failure = await writer.writeOwnedChunks([new Uint8Array([1])]).catch((error) => error);
        expect(failure).toBeInstanceOf(RangeError);
        expect(Atomics.load(file.counters, 1)).toBe(0);
        await expect(writer.abort()).rejects.toBe(failure);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        client.dispose();
    });

    test('keeps queue bytes charged and rollback pending while worker disk flush is blocked', async () => {
        const file = fixture({blockFlushAt: 1});
        const bytes = patternedBytes(18 * 1024 * 1024);
        const length = bytes.byteLength;
        const expected = digest(bytes);
        const {store, state} = storeWithPendingIndex(file, bytes);
        Reflect.set(store, '_queuedWriteBudgetBytes', 8 * 1024 * 1024);
        let finished = false;
        const writing = store._flushPendingLookupIndexChunks(state, false).then(() => { finished = true; });
        await expect.poll(() => Atomics.load(file.counters, 4)).toBe(2);
        // The test's own event loop runs while the synchronous worker flush is
        // blocked. Neither ownership nor the existing byte budget is released.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        expect(bytes.byteLength).toBe(0);
        expect(state.lookupIndexQueuedBytes).toBe(length);
        expect(finished).toBe(false);
        let abandoned = false;
        const rollback = store._abandonImportWritesForRollback().then(() => { abandoned = true; });
        await Promise.resolve();
        expect(abandoned).toBe(false);
        expect(Atomics.load(file.counters, 3)).toBe(0);
        release(file);
        await Promise.all([writing, rollback]);
        expect(state.lookupIndexQueuedBytes).toBe(0);
        expect(state.lookupIndexWritable).toBeNull();
        expect(Atomics.load(file.counters, 2)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        const stored = readFileSync(file.filePath);
        expect([...stored.subarray(0, 40)]).toEqual([...new Uint8Array(40)]);
        expect(digest(stored.subarray(40))).toBe(expected);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(true);
    });

    test('publishes final headers only after acknowledged writes and uses one worker for the session', async () => {
        const file = fixture();
        const {store, state} = storeWithPendingIndex(file, patternedBytes(2 * 1024 * 1024));
        await store._flushPendingLookupIndexChunks(state, false);
        await state.lookupIndexWritePromise;
        const other = fixture();
        const otherName = store._getShardSegmentFileName('Worker test', 'raw', 1);
        const otherState = store._createShardState(otherName, other.handle, 0);
        otherState.lookupIndexFileHandle = other.handle;
        otherState.lookupIndexWritable = await store._createLookupIndexWritable(otherState);
        Reflect.get(store, '_shardStateByFileName').set(otherName, otherState);
        await store.endImportSession();
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(true);
        const stored = readFileSync(file.filePath);
        expect(stored.subarray(0, 8).toString()).toBe('MBTIDX11');
        expect(new DataView(stored.buffer, stored.byteOffset).getUint32(16, true)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(Atomics.load(other.counters, 3)).toBe(1);
        expect(store.getLastEndImportSessionMetrics()).toMatchObject({lookupIndexWorkerFileCount: 2, lookupIndexWriteBytes: 2 * 1024 * 1024});
        expect(Reflect.get(store, '_importIndexWorkerPromise')).toBeNull();
    });

    test('failed final durability acknowledgement keeps the import unpublished and closes the worker', async () => {
        const file = fixture({flushErrorAt: 1});
        const {store, state} = storeWithPendingIndex(file, patternedBytes(2 * 1024 * 1024));
        await expect(store.endImportSession()).rejects.toMatchObject({message: 'Worker flush witness'});
        expect(Reflect.get(store, '_importSessionActive')).toBe(true);
        expect(store.getLastEndImportSessionMetrics()).toBeNull();
        expect(state.lookupIndexWritable).toBeNull();
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(workers[0].terminated).toBe(true);
    });

    test('worker crash preserves the journal and quarantines SQLite when checkpoint restoration fails', async () => {
        const file = fixture({crashWriteAt: 2});
        const {store, state} = storeWithPendingIndex(file, patternedBytes(2 * 1024 * 1024));
        const restoreFailure = new Error('Sidecar lock still prevents restoration');
        const removeEntry = vi.fn(async () => { throw restoreFailure; });
        Reflect.set(store, '_recordsDirectoryHandle', {
            async getFileHandle() { return file.handle; },
            async *entries() { yield [`${state.fileName}.mbti`, {kind: 'file'}]; },
            removeEntry,
        });
        vi.spyOn(store, '_prepare').mockResolvedValue();
        const failure = await store._flushPendingLookupIndexChunks(state).catch((error) => error);
        expect(failure).toMatchObject({message: 'Import index worker exited: 7'});
        expect(state.lookupIndexQueuedBytes).toBe(0);
        expect(Atomics.load(file.counters, 0)).toBe(1);
        expect(Atomics.load(file.counters, 1)).toBe(2);
        expect(Atomics.load(file.counters, 3)).toBe(0);
        await expect(store._flushPendingLookupIndexChunks(state)).rejects.toBe(failure);
        const database = new DictionaryDatabase();
        const close = vi.fn();
        const exec = vi.fn();
        const clear = vi.fn();
        Reflect.set(database, '_db', {exec, close});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1, sessionId: 'worker-crash', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear});
        Reflect.set(database, '_termContentStore', {
            async endImportSession() {},
            getLastEndImportSessionMetrics() { return null; },
            async rollbackImportSession() {},
        });
        Reflect.set(database, '_termRecordStore', store);
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());
        await expect(database.finishBulkImport()).rejects.toThrow('Dictionary import finalization and cleanup failed');
        expect(exec).not.toHaveBeenCalledWith('COMMIT');
        expect(close).toHaveBeenCalledOnce();
        expect(clear).not.toHaveBeenCalled();
        expect(Reflect.get(database, '_db')).toBeNull();
        expect(Reflect.get(database, '_bulkImportJournalRecord')).not.toBeNull();
        expect(Reflect.get(database, '_importJournalRecoveryPending')).toBe(true);
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(state.lookupIndexWritable).toBeNull();
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(true);
    });

    test('retains the local default for tiny sidecars and unavailable worker startup', async () => {
        const workerConstructor = vi.fn(() => { throw new Error('Worker unavailable'); });
        vi.stubGlobal('Worker', workerConstructor);
        const store = new TermRecordOpfsStore();
        store.setRawTermBankSourceBytes(1024 * 1024 * 1024);
        const access = {write: vi.fn((bytes) => bytes.byteLength), truncate: vi.fn(), flush: vi.fn(), close: vi.fn()};
        const file = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({async createSyncAccessHandle() { return access; }}));
        const state = store._createShardState('tiny.mbtr', file, 0);
        state.lookupIndexFileHandle = file;
        Reflect.set(store, '_importSessionActive', true);
        let writer = await store._createLookupIndexWritable(state);
        expect(writer).toBeInstanceOf(SyncImportIndexWriter);
        expect(workerConstructor).not.toHaveBeenCalled();
        await writer.close();
        state.lookupIndexQueuedBytes = 2 * 1024 * 1024;
        writer = await store._createLookupIndexWritable(state);
        expect(writer).toBeInstanceOf(SyncImportIndexWriter);
        expect(workerConstructor).toHaveBeenCalledTimes(1);
        await writer.write(new Uint8Array(18 * 1024 * 1024));
        expect(access.flush).toHaveBeenCalledTimes(1);
        await writer.close();
        expect(access.flush).toHaveBeenCalledTimes(2);
        await store._retireImportIndexWorker();
    });

    test.each([
        {sourceBytes: 1024 ** 3 - 1, queuedBytes: 2 * 1024 ** 2, remote: false},
        {sourceBytes: 1024 ** 3, queuedBytes: 2 * 1024 ** 2 - 1, remote: false},
        {sourceBytes: 1024 ** 3, queuedBytes: 2 * 1024 ** 2, remote: true},
        {sourceBytes: 1024 ** 3 + 1, queuedBytes: 2 * 1024 ** 2, remote: true},
    ])('requires both source and queued-byte thresholds: $sourceBytes / $queuedBytes', async ({sourceBytes, queuedBytes, remote}) => {
        vi.stubGlobal('Worker', NodeWorker);
        const file = fixture();
        const local = localFallback(file);
        const store = new TermRecordOpfsStore();
        store.setRawTermBankSourceBytes(sourceBytes);
        await store.beginImportSession();
        const state = store._createShardState('eligible.mbtr', file.handle, 0);
        state.lookupIndexFileHandle = file.handle;
        state.lookupIndexQueuedBytes = queuedBytes;
        const writer = await store._createLookupIndexWritable(state);
        expect(writer).toBeInstanceOf(remote ? WorkerImportIndexWriter : SyncImportIndexWriter);
        if (!remote) {
            await writer.write(new Uint8Array(18 * 1024 * 1024));
            expect(local.flush).not.toHaveBeenCalled();
        }
        await writer.close();
        await store.endImportSession();
        expect(workers).toHaveLength(remote ? 1 : 0);
        expect(store.getLastEndImportSessionMetrics()?.lookupIndexWorkerFileCount).toBe(remote ? 1 : 0);
        expect(local.flush).toHaveBeenCalledTimes(remote ? 0 : 1);
    });

    test.each([void 0, null, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1073741824'])(
        'declines unavailable or invalid source hints without worker startup: %s',
        async (sourceBytes) => {
            const workerConstructor = vi.fn();
            vi.stubGlobal('Worker', workerConstructor);
            const file = fixture();
            localFallback(file);
            const store = new TermRecordOpfsStore();
            store.setRawTermBankSourceBytes(/** @type {number|null} */ (sourceBytes));
            await store.beginImportSession();
            const state = store._createShardState('invalid-hint.mbtr', file.handle, 0);
            state.lookupIndexFileHandle = file.handle;
            state.lookupIndexQueuedBytes = 2 * 1024 * 1024;
            const writer = await store._createLookupIndexWritable(state);
            expect(writer).toBeInstanceOf(SyncImportIndexWriter);
            expect(workerConstructor).not.toHaveBeenCalled();
            await writer.close();
            await store.endImportSession();
        },
    );

    test.each(['finish', 'failed finish', 'rollback', 'reset'])('clears worker eligibility after %s', async (ending) => {
        const file = fixture(ending === 'failed finish' ? {flushErrorAt: 1} : {});
        const {store, state} = storeWithPendingIndex(file, patternedBytes(2 * 1024 * 1024));
        await store._flushPendingLookupIndexChunks(state);
        expect(state.lookupIndexWritable).toBeInstanceOf(WorkerImportIndexWriter);
        switch (ending) {
            case 'finish': await store.endImportSession(); break;
            case 'failed finish':
                await expect(store.endImportSession()).rejects.toThrow('Worker flush witness');
                expect(Reflect.get(store, '_rawTermBankSourceBytes')).toBeNull();
                await store._abandonImportWritesForRollback();
                break;
            case 'rollback': await store._abandonImportWritesForRollback(); break;
            case 'reset': await store.reset(); break;
        }
        await store.beginImportSession();
        const next = fixture();
        localFallback(next);
        const nextState = store._createShardState('next-session.mbtr', next.handle, 0);
        nextState.lookupIndexFileHandle = next.handle;
        nextState.lookupIndexQueuedBytes = 2 * 1024 * 1024;
        const nextWriter = await store._createLookupIndexWritable(nextState);
        expect(nextWriter).toBeInstanceOf(SyncImportIndexWriter);
        expect(workers).toHaveLength(1);
        await nextWriter.close();
        await store.endImportSession();
    });

    test('routes and resets the source hint independently of record-write coalescing options', async () => {
        const database = new DictionaryDatabase();
        const store = /** @type {TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
        const baselineCoalescing = Reflect.get(store, '_writeCoalesceTargetBytes');
        database.setImportOptimizationFlags({rawTermBankSourceBytes: 1024 ** 3});
        expect(Reflect.get(store, '_rawTermBankSourceBytes')).toBe(1024 ** 3);
        expect(Reflect.get(store, '_writeCoalesceTargetBytes')).toBe(baselineCoalescing);
        database.setImportOptimizationFlags({expectedTermRecordImportBytes: 2 * 1024 ** 3, rawTermBankSourceBytes: 1024 ** 3});
        const largeCoalescing = Reflect.get(store, '_writeCoalesceTargetBytes');
        expect(largeCoalescing).toBe(64 * 1024 * 1024);
        database.setImportOptimizationFlags({expectedTermRecordImportBytes: 2 * 1024 ** 3});
        expect(Reflect.get(store, '_rawTermBankSourceBytes')).toBeNull();
        expect(Reflect.get(store, '_writeCoalesceTargetBytes')).toBe(largeCoalescing);
        database.setImportOptimizationFlags();
        expect(Reflect.get(store, '_rawTermBankSourceBytes')).toBeNull();
        expect(Reflect.get(store, '_writeCoalesceTargetBytes')).toBe(baselineCoalescing);
    });
});
