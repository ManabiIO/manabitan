/* SPDX-License-Identifier: GPL-3.0-or-later */

import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {afterEach, describe, expect, test, vi} from 'vitest';
import * as compression from '../ext/js/dictionary/zstd-term-content.js';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {ImportIndexWorkerClient} from '../ext/js/dictionary/term-record-import-index-worker-client.js';

/** @typedef {import('../ext/js/dictionary/term-record-import-index-worker-client.js').ImportIndexWorkerClient} Client */
/** @typedef {import('../ext/js/dictionary/term-record-import-index-worker-client.js').WorkerImportIndexWriter} Writer */
/** @typedef {import('./util/shared-index-test-worker.js').WorkerOptions} WorkerOptions */
/** @type {SharedWorkerThread[]} */
const workers = [];
/** @type {ReturnType<typeof fixture>[]} */
const files = [];
/** @type {compression.TermContentCompressionPool[]} */
const pools = [];
/** @type {Client[]} */
const clients = [];
/** @type {Writer[]} */
const writers = [];

class SharedWorkerThread extends EventTarget {
    /**
     * @param {URL} [entry]
     * @param {WorkerOptions} [options]
     */
    constructor(entry, options = {}) {
        super();
        if (typeof entry !== 'undefined' && !entry.href.endsWith('/zstd-term-content-compression-worker.js')) {
            throw new Error('Unexpected dedicated-worker startup');
        }
        this.thread = new ThreadWorker(new URL('util/shared-index-test-worker.js', import.meta.url), {workerData: {options}});
        const threadId = this.thread.threadId;
        this.terminated = false;
        this.terminateCount = 0;
        this.connections = 0;
        this._nextControl = 1;
        /** @type {Map<number, () => void>} */
        this._controls = new Map();
        /** @type {() => void} */
        let resolveReady = () => {};
        /** @type {(error: Error) => void} */
        let rejectReady = () => {};
        /** @type {Promise<void>} */
        this.ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        void this.ready.catch(() => {});
        this.thread.on('message', (/** @type {Record<string, unknown>} */ data) => {
            if (data.type === 'ready') { resolveReady(); }
            if (typeof data.testControlAck === 'number') {
                this._controls.get(data.testControlAck)?.();
                this._controls.delete(data.testControlAck);
                return;
            }
            this.dispatchEvent(new MessageEvent('message', {data}));
        });
        this.thread.on('error', (error) => {
            rejectReady(error);
            this.fail(error.message);
        });
        this.exited = new Promise((resolve) => {
            this.thread.once('exit', (code) => {
                // Node closes this thread's tracked native descriptors on exit.
                // Release the test's exclusive-lock model only after observing it.
                for (const file of files) {
                    if (Atomics.load(file.counters, 9) === threadId) { Atomics.store(file.counters, 8, 0); }
                }
                if (!this.terminated) { this.fail(`Shared worker exited: ${code}`); }
                resolve(code);
            });
        });
        workers.push(this);
    }

    /**
     * @param {Record<string, unknown>} value
     * @param {Transferable[]} [transfer]
     */
    postMessage(value, transfer = []) {
        if (value.type === 'connect-import-index') { ++this.connections; }
        this.thread.postMessage(value, /** @type {import('node:worker_threads').TransferListItem[]} */ (/** @type {unknown} */ (transfer)));
    }

    terminate() {
        if (this.terminated) { return; }
        this.terminated = true;
        ++this.terminateCount;
        void this.thread.terminate();
    }

    /** @param {string} message */
    fail(message) { this.dispatchEvent(Object.assign(new Event('error'), {message})); }

    /** @returns {Promise<void>} */
    async closeIndexPorts() {
        const controlId = this._nextControl++;
        /** @type {Promise<void>} */
        const completion = new Promise((resolve) => {
            this._controls.set(controlId, () => { resolve(); });
        });
        this.thread.postMessage({testControl: 'close-ports', controlId});
        await completion;
    }
}

/**
 * @param {import('./util/shared-index-test-worker.js').FileOptions} [options]
 * @returns {{directory: string, filePath: string, handle: FileSystemFileHandle, counters: Int32Array}}
 */
function fixture(options = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'manabitan-shared-index-'));
    const filePath = path.join(directory, 'index.mbti');
    writeFileSync(filePath, new Uint8Array());
    const counters = new Int32Array(new SharedArrayBuffer(10 * 4));
    const handle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({path: filePath, counters: counters.buffer, options}));
    Object.defineProperties(handle, {
        getFile: {value: async () => ({size: statSync(filePath).size})},
        createWritable: {value: async () => {
            if (Atomics.load(counters, 8) !== 0) { throw new Error('Shared sidecar is still locked'); }
            return {async truncate(/** @type {number} */ size) { truncateSync(filePath, size); }, async close() {}};
        }},
    });
    const file = {directory, filePath, handle, counters};
    files.push(file);
    return file;
}

/**
 * @param {WorkerOptions} [options]
 * @returns {Promise<{worker: SharedWorkerThread, pool: compression.TermContentCompressionPool}>}
 */
async function poolFixture(options = {}) {
    const worker = new SharedWorkerThread(void 0, options);
    await worker.ready;
    const pool = new compression.TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ ([worker])));
    pools.push(pool);
    return {worker, pool};
}

/**
 * @param {compression.TermContentCompressionPool} pool
 * @returns {Promise<Client>}
 */
async function connect(pool) {
    const client = await pool.createImportIndexClient();
    if (client === null) { throw new Error('Missing shared import client'); }
    clients.push(client);
    return client;
}

/**
 * @param {Client} client
 * @param {ReturnType<typeof fixture>} file
 * @returns {Promise<Writer>}
 */
async function open(client, file) {
    const writer = await client.open(file.handle);
    if (writer === null) { throw new Error('Missing shared index writer'); }
    writers.push(writer);
    return writer;
}

/** @param {ReturnType<typeof fixture>} file */
function release(file) {
    Atomics.store(file.counters, 5, 1);
    Atomics.notify(file.counters, 5);
}

/**
 * @param {compression.TermContentCompressionPool} pool
 * @param {ReturnType<typeof fixture>} file
 * @param {Uint8Array} bytes
 * @returns {{store: TermRecordOpfsStore, state: ReturnType<TermRecordOpfsStore['_createShardState']>, removeEntry: import('vitest').Mock}}
 */
function storeFixture(pool, file, bytes) {
    vi.spyOn(compression, 'createImportIndexClientFromReadyCompressionPool').mockImplementation(async () => await connect(pool));
    const store = new TermRecordOpfsStore();
    store.setRawTermBankSourceBytes(171_617_523);
    const name = store._getShardSegmentFileName('Shared worker test', 'raw', 0);
    const state = store._createShardState(name, file.handle, 0);
    state.pendingLookupIndexChunks = [bytes];
    state.pendingLookupIndexBytes = bytes.byteLength;
    state.pendingLookupIndexRecordCount = 1;
    state.fileLength = 45;
    const removeEntry = vi.fn(async () => {
        if (Atomics.load(file.counters, 8) !== 0) { throw new Error('Cannot restore locked shared sidecar'); }
        unlinkSync(file.filePath);
    });
    Reflect.set(store, '_importSessionActive', true);
    Reflect.set(store, '_recordsDirectoryHandle', {
        async getFileHandle() { return file.handle; },
        async *entries() {
            if (existsSync(file.filePath)) { yield [`${state.fileName}.mbti`, {kind: 'file'}]; }
        },
        removeEntry,
    });
    Reflect.get(store, '_shardStateByFileName').set(name, state);
    vi.spyOn(store, '_prepare').mockResolvedValue();
    return {store, state, removeEntry};
}

afterEach(async () => {
    vi.useRealTimers();
    for (const file of files) { release(file); }
    await Promise.allSettled(writers.splice(0).map((writer) => writer.abort()));
    await Promise.allSettled(clients.splice(0).map((client) => client.dispose()));
    for (const pool of pools.splice(0)) { pool.close(); }
    for (const worker of workers) { worker.terminate(); }
    await Promise.all(workers.splice(0).map((worker) => worker.exited));
    for (const file of files.splice(0)) { rmSync(file.directory, {recursive: true, force: true}); }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('shared compression-worker index lifetime', () => {
    test('does not create or wait for a compression pool when none is ready', async () => {
        const construct = vi.fn(() => { throw new Error('Unexpected worker startup'); });
        vi.stubGlobal('Worker', construct);
        expect(await compression.createImportIndexClientFromReadyCompressionPool()).toBeNull();
        expect(construct).not.toHaveBeenCalled();
    });

    test('pool death during client-module loading cannot send a port or resurrect a lease', async () => {
        const {pool, worker} = await poolFixture();
        const connecting = pool.createImportIndexClient();
        pool.close();
        expect(await connecting).toBeNull();
        await worker.exited;
        expect(worker.connections).toBe(0);
        expect(worker.terminateCount).toBe(1);
        expect(Reflect.get(pool, '_indexClients').size).toBe(0);
        expect(pool.failed).toBe(true);
        expect(await pool.createImportIndexClient()).toBeNull();
        expect(worker.connections).toBe(0);
    });

    test('isolates writer IDs on simultaneous ports and reuses the worker after successful disposal', async () => {
        const {pool, worker} = await poolFixture();
        const firstClient = await connect(pool);
        const secondClient = await connect(pool);
        const first = fixture({shortWrite: 2});
        const second = fixture({shortWrite: 3});
        const firstWriter = await open(firstClient, first);
        const secondWriter = await open(secondClient, second);
        expect(Reflect.get(firstWriter, '_writerId')).toBe(1);
        expect(Reflect.get(secondWriter, '_writerId')).toBe(1);
        await firstWriter.writeOwnedChunks([Uint8Array.of(1, 2, 3, 4)]);
        await secondWriter.writeOwnedChunks([Uint8Array.of(8, 9)]);
        await firstWriter.close();
        await firstClient.dispose();
        expect(worker.terminateCount).toBe(0);
        await secondWriter.writeOwnedChunks([Uint8Array.of(10, 11)]);
        await secondWriter.close();
        await secondClient.dispose();
        expect([...readFileSync(first.filePath)]).toEqual([1, 2, 3, 4]);
        expect([...readFileSync(second.filePath)]).toEqual([8, 9, 10, 11]);
        expect(Atomics.load(first.counters, 3)).toBe(1);
        expect(Atomics.load(second.counters, 3)).toBe(1);
        expect(Reflect.get(pool, '_indexClients').size).toBe(0);
        const thirdClient = await connect(pool);
        const third = fixture();
        const thirdWriter = await open(thirdClient, third);
        expect(Reflect.get(thirdWriter, '_writerId')).toBe(1);
        await thirdWriter.write(Uint8Array.of(31));
        await thirdWriter.close();
        await thirdClient.dispose();
        const compressed = await pool.compress([Uint8Array.of(41), Uint8Array.of(42)], null);
        expect(compressed.map((value) => [...value])).toEqual([[41], [42]]);
        expect(worker.connections).toBe(3);
        expect(worker.terminateCount).toBe(0);
        expect(pool.failed).toBe(false);
    });

    test('pool death poisons an idle I/O lease and still permits checkpoint restoration', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture();
        const {store, state, removeEntry} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        await store._flushPendingLookupIndexChunks(state);
        const writer = state.lookupIndexWritable;
        if (writer === null) { throw new Error('Missing live sidecar writer'); }
        const client = clients[0];
        expect(Reflect.get(client, '_pending').size).toBe(0);
        expect(Atomics.load(file.counters, 8)).toBe(1);
        pool.close();
        await worker.exited;
        await expect(writer.write(Uint8Array.of(4))).rejects.toThrow('compression pool closed');
        await expect(writer.close()).rejects.toThrow('compression pool closed');
        await store.rollbackImportSession({shards: []});
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
        expect(state.lookupIndexWritable).toBeNull();
        expect(Reflect.get(store, '_importIndexWorkerPromise')).toBeNull();
        expect(Reflect.get(pool, '_indexClients').size).toBe(0);
        expect(worker.terminateCount).toBe(1);
    });

    test('lost port transport terminates its owner and releases a live sidecar lock before restoration', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture();
        const {store, state, removeEntry} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        await store._flushPendingLookupIndexChunks(state);
        const writer = state.lookupIndexWritable;
        if (writer === null) { throw new Error('Missing live sidecar writer'); }
        await worker.closeIndexPorts();
        expect(Atomics.load(file.counters, 8)).toBe(1);
        vi.useFakeTimers();
        const failure = writer.write(Uint8Array.of(5)).catch((error) => error);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await failure).toMatchObject({message: 'Import index worker request timed out: writeChunks'});
        vi.useRealTimers();
        await worker.exited;
        expect(pool.failed).toBe(true);
        expect(worker.terminateCount).toBe(1);
        expect(Atomics.load(file.counters, 8)).toBe(0);
        await store.rollbackImportSession({shards: []});
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
    });

    test('does not retry failed acquisition through a local handle', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture({acquireError: true});
        const local = vi.fn(async () => { throw new Error('Local acquisition must not run'); });
        Object.defineProperty(file.handle, 'createSyncAccessHandle', {value: local});
        const {store, state} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        await expect(store._flushPendingLookupIndexChunks(state)).rejects.toThrow('Shared acquisition witness');
        expect(local).not.toHaveBeenCalled();
        expect(Atomics.load(file.counters, 0)).toBe(0);
        await worker.exited;
        await store.rollbackImportSession({shards: []});
        expect(worker.terminateCount).toBe(1);
        expect(pool.failed).toBe(true);
    });

    test('failed truncate and failed close retire an acquired handle absent from the writer map', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture({truncateError: true, closeError: true});
        const {store, state, removeEntry} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        const failure = await store._flushPendingLookupIndexChunks(state).catch((error) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors.map((/** @type {Error} */ error) => error.message)).toEqual(['Shared truncate witness', 'Shared close witness']);
        await worker.exited;
        expect(Atomics.load(file.counters, 0)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(Atomics.load(file.counters, 8)).toBe(0);
        expect(worker.terminateCount).toBe(1);
        expect(pool.failed).toBe(true);
        await store.rollbackImportSession({shards: []});
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
    });

    test('ambiguous acquisition failure cannot reopen a truncated file locally', async () => {
        const {pool, worker} = await poolFixture({dropReplyAction: 'open'});
        const client = await connect(pool);
        const file = fixture();
        const local = vi.fn(async () => { throw new Error('Local acquisition must not run'); });
        Object.defineProperty(file.handle, 'createSyncAccessHandle', {value: local});
        const {store, state} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        vi.spyOn(compression, 'createImportIndexClientFromReadyCompressionPool').mockResolvedValue(client);
        vi.useFakeTimers();
        const failure = store._flushPendingLookupIndexChunks(state).catch((error) => error);
        await vi.waitFor(() => { expect(Atomics.load(file.counters, 0)).toBe(1); });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await failure).toMatchObject({message: 'Import index worker request timed out: open'});
        vi.useRealTimers();
        await worker.exited;
        expect(local).not.toHaveBeenCalled();
        expect(worker.terminateCount).toBe(1);
        await store.rollbackImportSession({shards: []});
        expect(existsSync(file.filePath)).toBe(false);
    });

    test('abort joins a blocked admitted write without flushing or retiring the compression worker', async () => {
        const {pool, worker} = await poolFixture();
        const client = await connect(pool);
        const file = fixture({blockWriteAt: 1});
        const writer = await open(client, file);
        const bytes = new Uint8Array(1024 * 1024).fill(71);
        const writing = writer.writeOwnedChunks([bytes]);
        await expect.poll(() => Atomics.load(file.counters, 4)).toBe(1);
        expect(bytes.byteLength).toBe(0);
        let aborted = false;
        const aborting = writer.abort().then(() => { aborted = true; });
        await Promise.resolve();
        expect(aborted).toBe(false);
        expect(Atomics.load(file.counters, 3)).toBe(0);
        release(file);
        await Promise.all([writing, aborting]);
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'});
        expect(Atomics.load(file.counters, 2)).toBe(0);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(readFileSync(file.filePath)).toEqual(Buffer.alloc(1024 * 1024, 71));
        await client.dispose();
        expect(worker.terminateCount).toBe(0);
        expect(pool.failed).toBe(false);
    });

    test('refuses premature disposal and releases every owned lock through pool failure', async () => {
        const {pool, worker} = await poolFixture();
        const client = await connect(pool);
        const file = fixture();
        await open(client, file);
        expect(Reflect.get(client, '_pending').size).toBe(0);
        await expect(client.dispose()).rejects.toThrow('Cannot dispose an active import index session');
        await worker.exited;
        expect(pool.failed).toBe(true);
        expect(Atomics.load(file.counters, 8)).toBe(0);
        expect(worker.terminateCount).toBe(1);
    });

    test('final flush failure prevents SQLite publication and restores the unpublished sidecar', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture({flushErrorAt: 1});
        const {store, state, removeEntry} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        const database = new DictionaryDatabase();
        const exec = vi.fn();
        const clear = vi.fn();
        Reflect.set(database, '_db', {exec, close: vi.fn()});
        Reflect.set(database, '_bulkImportState', 'active');
        Reflect.set(database, '_bulkImportTransactionOpen', true);
        Reflect.set(database, '_bulkImportJournalRecord', {
            version: 1, sessionId: 'shared-final-flush', contentCheckpoint: {segments: []}, recordCheckpoint: {shards: []}, createdAt: 0,
        });
        Reflect.set(database, '_importJournal', {clear});
        Reflect.set(database, '_termContentStore', {
            async endImportSession() {},
            getLastEndImportSessionMetrics() { return null; },
            async rollbackImportSession() {},
        });
        Reflect.set(database, '_termRecordStore', store);
        Reflect.set(database, '_applyRuntimePragmas', vi.fn());
        await expect(database.finishBulkImport()).rejects.toThrow('Shared final flush witness');
        expect(exec).not.toHaveBeenCalledWith('COMMIT');
        expect(exec).toHaveBeenCalledWith('ROLLBACK');
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(clear).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
        expect(state.lookupIndexWritable).toBeNull();
        expect(Atomics.load(file.counters, 2)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(worker.terminateCount).toBe(1);
        expect(pool.failed).toBe(true);
    });

    test('failed final close cannot preserve a worker holding an unregistered sidecar lock', async () => {
        const {pool, worker} = await poolFixture();
        const file = fixture({closeError: true});
        const {store, state, removeEntry} = storeFixture(pool, file, new Uint8Array(2 * 1024 * 1024));
        const health = vi.spyOn(store, '_setDictionaryHealth');
        await expect(store.endImportSession()).rejects.toThrow('Shared close witness');
        await worker.exited;
        expect(Reflect.get(store, '_importSessionActive')).toBe(true);
        expect(store.getLastEndImportSessionMetrics()).toBeNull();
        expect(health).not.toHaveBeenCalled();
        expect(state.lookupIndexWritable).toBeNull();
        expect(Atomics.load(file.counters, 2)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(Atomics.load(file.counters, 8)).toBe(0);
        expect(worker.terminateCount).toBe(1);
        await store.rollbackImportSession({shards: []});
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
    });

    test('throwing owner cleanup still rejects every admitted request and preserves all causes', async () => {
        const channel = new MessageChannel();
        const ownerFailure = new Error('Owner cleanup witness');
        const releaseFailure = new Error('Lease release witness');
        const fail = vi.fn(() => { throw ownerFailure; });
        const releaseOwner = vi.fn(() => { throw releaseFailure; });
        const client = new ImportIndexWorkerClient(channel.port1, {fail, release: releaseOwner});
        clients.push(client);
        try {
            channel.port2.postMessage({type: 'ready'});
            await client.ready;
            const first = client.request(1, 'seek', {offset: 0}).catch((error) => error);
            const second = client.request(2, 'seek', {offset: 0}).catch((error) => error);
            channel.port1.dispatchEvent(new Event('messageerror'));
            const failure = await first;
            expect(failure).toBeInstanceOf(AggregateError);
            if (!(failure instanceof AggregateError)) { throw new Error('Missing aggregate transport failure'); }
            expect(failure.errors).toContain(ownerFailure);
            expect(failure.errors).toContain(releaseFailure);
            expect(await second).toBe(failure);
            expect(Reflect.get(client, '_pending').size).toBe(0);
            expect(fail).toHaveBeenCalledOnce();
            expect(releaseOwner).toHaveBeenCalledOnce();
            client.failFromOwner(new Error('Late failure'));
            await expect(client.request(3, 'seek')).rejects.toBe(failure);
            expect(fail).toHaveBeenCalledOnce();
            expect(releaseOwner).toHaveBeenCalledOnce();
        } finally { channel.port2.close(); }
    });

    test('compression fallback invalidates an idle I/O lease before a replacement pool is reused', async () => {
        class FailingCompressionWorker extends SharedWorkerThread {
            /** @param {URL} entry */
            constructor(entry) { super(entry, {compressionErrorAt: 2}); }
        }
        vi.stubGlobal('Worker', FailingCompressionWorker);
        await compression.compressWrappedTermContentZstdBatch([Uint8Array.of(1), Uint8Array.of(2)], null);
        expect(workers).toHaveLength(4);
        const client = await compression.createImportIndexClientFromReadyCompressionPool();
        if (client === null) { throw new Error('Missing existing-pool lease'); }
        clients.push(client);
        const file = fixture();
        const writer = await open(client, file);
        await writer.write(Uint8Array.of(3));
        expect(Reflect.get(client, '_pending').size).toBe(0);
        await expect(compression.compressWrappedTermContentZstdBatch([Uint8Array.of(4), Uint8Array.of(5)], null)).rejects.toThrow('Shared compression witness');
        await Promise.all(workers.map((worker) => worker.exited));
        expect(workers.map((worker) => worker.terminateCount)).toEqual([1, 1, 1, 1]);
        await expect(writer.close()).rejects.toThrow('compression pool closed');
        vi.stubGlobal('Worker', SharedWorkerThread);
        const result = await compression.compressWrappedTermContentZstdBatch([Uint8Array.of(6), Uint8Array.of(7)], null);
        expect(result.chunks.map((value) => [...value])).toEqual([[6], [7]]);
        expect(workers).toHaveLength(8);
        const replacement = await compression.createImportIndexClientFromReadyCompressionPool();
        if (replacement === null) { throw new Error('Missing replacement pool lease'); }
        clients.push(replacement);
        // A stale failed lease cannot retire any replacement worker.
        await client.dispose();
        expect(workers.slice(4).map((worker) => worker.terminateCount)).toEqual([0, 0, 0, 0]);
        await replacement.dispose();
    });
});
