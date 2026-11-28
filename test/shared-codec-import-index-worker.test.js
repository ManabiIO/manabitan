/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker as ThreadWorker} from 'node:worker_threads';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {CompressionIndexWorkerTransport} from '../ext/js/dictionary/compression-index-worker-transport.js';
import {ImportIndexWorkerClient} from '../ext/js/dictionary/term-record-import-index-worker-client.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js';

/** @type {CodecWorker[]} */
const workers = [];
/** @type {TermContentCompressionPool[]} */
const pools = [];
/** @type {ReturnType<typeof fixture>[]} */
const files = [];

class CodecWorker extends EventTarget {
    constructor() {
        super();
        this.thread = new ThreadWorker(new URL('util/compression-index-test-worker.js', import.meta.url), {
            workerData: {entry: new URL('../ext/js/dictionary/zstd-term-content-compression-worker.js', import.meta.url).href},
        });
        this.terminated = false;
        this.bindings = 0;
        this.ready = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            this.thread.on('message', (data) => {
                if (data.type === 'ready') { resolve(); }
                if (data.type === 'initialization-error') { reject(new Error(data.error)); }
                this.dispatchEvent(new MessageEvent('message', {data}));
            });
            this.thread.on('error', (error) => {
                reject(error);
                this.fail(error.message);
            });
        }));
        void this.ready.catch(() => {});
        this.exited = new Promise((resolve) => {
            this.thread.once('exit', (code) => {
                if (!this.terminated) { this.fail(`Compression index worker exited: ${code}`); }
                resolve(code);
            });
        });
        workers.push(this);
    }

    /**
     * @param {unknown} data
     * @param {import('node:worker_threads').TransferListItem[]} transfer
     */
    postMessage(data, transfer) {
        if (Reflect.get(/** @type {object} */ (data), 'type') === 'bind-import-index') { ++this.bindings; }
        this.thread.postMessage(data, transfer);
    }

    terminate() {
        this.terminated = true;
        void this.thread.terminate();
    }

    /** @param {string} message */
    fail(message) { this.dispatchEvent(Object.assign(new Event('error'), {message})); }
}

/** @returns {Promise<TermContentCompressionPool>} */
async function readyPool() {
    const lanes = [new CodecWorker(), new CodecWorker()];
    await Promise.all(lanes.map((worker) => worker.ready));
    const pool = new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (lanes)));
    pools.push(pool);
    return pool;
}

/**
 * @param {TermContentCompressionPool} pool
 * @returns {Promise<ImportIndexWorkerClient>}
 */
async function borrow(pool) {
    const transport = pool.createImportIndexTransport(CompressionIndexWorkerTransport);
    if (transport === null) { throw new Error('Expected a ready codec lane'); }
    const client = new ImportIndexWorkerClient(transport);
    await client.ready;
    return client;
}

/**
 * @param {import('./util/import-index-test-file-handle.js').FileOptions} [options]
 * @returns {{directory: string, filePath: string, handle: FileSystemFileHandle, counters: Int32Array}}
 */
function fixture(options = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'manabitan-codec-index-worker-'));
    const filePath = path.join(directory, 'index.mbti');
    writeFileSync(filePath, new Uint8Array());
    const counters = new Int32Array(new SharedArrayBuffer(8 * 4));
    const handle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({path: filePath, counters: counters.buffer, options}));
    const file = {directory, filePath, handle, counters};
    files.push(file);
    return file;
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
 * @param {ImportIndexWorkerClient} client
 * @returns {{store: TermRecordOpfsStore, state: ReturnType<TermRecordOpfsStore['_createShardState']>}}
 */
function storeWithPendingIndex(file, client) {
    const store = new TermRecordOpfsStore();
    store.setRawTermBankSourceBytes(171_617_523);
    const name = store._getShardSegmentFileName('Borrowed codec test', 'raw', 0);
    const state = store._createShardState(name, file.handle, 0);
    state.pendingLookupIndexChunks = [patternedBytes(2 * 1024 * 1024)];
    state.pendingLookupIndexBytes = state.pendingLookupIndexChunks[0].byteLength;
    state.pendingLookupIndexRecordCount = 1;
    state.fileLength = 45;
    Reflect.set(store, '_importSessionActive', true);
    // Inject an acquired production client so the fixture can use two real
    // codec lanes without initializing a separate global four-worker pool.
    Reflect.set(store, '_importIndexWorkerPromise', Promise.resolve(client));
    Reflect.get(store, '_shardStateByFileName').set(name, state);
    return {store, state};
}

afterEach(async () => {
    for (const file of files) {
        Atomics.store(file.counters, 5, 1);
        Atomics.notify(file.counters, 5);
    }
    for (const pool of pools.splice(0)) { pool.close(); }
    for (const worker of workers) { worker.terminate(); }
    await Promise.all(workers.splice(0).map((worker) => worker.exited));
    for (const file of files.splice(0)) { rmSync(file.directory, {recursive: true, force: true}); }
    vi.restoreAllMocks();
});

describe('production codec worker with borrowed index ownership', {timeout: 10_000}, () => {
    test('transfers a private port, preserves file bytes, and keeps the real codec usable across clean rebind', async () => {
        const pool = await readyPool();
        const samples = [patternedBytes(32 * 1024), new TextEncoder().encode('辞書の意味を圧縮する。'.repeat(2048))];
        const compressSamples = () => pool.compress(samples.map((bytes) => Uint8Array.from(bytes)), 'jmdict');
        const expectedCompression = await compressSamples();
        const client = await borrow(pool);
        expect(workers.map(({bindings}) => bindings)).toEqual([0, 1]);
        expect(pool.createImportIndexTransport(CompressionIndexWorkerTransport)).toBeNull();
        const file = fixture({shortWrite: 200_003});
        const writer = await client.open(file.handle);
        if (writer === null) { throw new Error('Expected an index writer on the codec lane'); }
        const expected = patternedBytes(2 * 1024 * 1024 + 31);
        const first = expected.slice(0, 128 * 1024 + 7);
        const second = expected.slice(first.byteLength);
        const writing = writer.writeOwnedChunks([first, second]);
        expect(first.byteLength).toBe(0);
        expect(second.byteLength).toBe(0);
        const [, compressedWhileWriting] = await Promise.all([writing, compressSamples()]);
        expect(compressedWhileWriting).toEqual(expectedCompression);
        const patch = Uint8Array.of(9, 8, 7, 6);
        await writer.seek(0);
        await writer.write(patch);
        await writer.truncate(expected.byteLength - 13);
        await writer.close();
        expected.set(patch);
        expect(digest(readFileSync(file.filePath))).toBe(digest(expected.subarray(0, expected.byteLength - 13)));
        expect(Atomics.load(file.counters, 2)).toBe(1);
        expect(Atomics.load(file.counters, 3)).toBe(1);
        expect(Atomics.load(file.counters, 7)).toBeLessThanOrEqual(512 * 1024);
        await client.dispose();
        expect(pool.failed).toBe(false);
        expect(workers.every(({terminated}) => !terminated)).toBe(true);
        expect(await compressSamples()).toEqual(expectedCompression);
        const nextClient = await borrow(pool);
        const nextWriter = await nextClient.open(file.handle);
        if (nextWriter === null) { throw new Error('Expected the released codec lane to accept a new session'); }
        await nextWriter.write(Uint8Array.of(4, 2));
        await nextWriter.close();
        await nextClient.dispose();
        expect([...readFileSync(file.filePath)]).toEqual([4, 2]);
        expect(Atomics.load(file.counters, 0)).toBe(2);
        expect(Atomics.load(file.counters, 3)).toBe(2);
        expect(workers.map(({bindings}) => bindings)).toEqual([0, 2]);
        expect(workers).toHaveLength(2);
        expect(await compressSamples()).toEqual(expectedCompression);
    });

    test.each([
        {name: 'native worker crash', options: {crashWriteAt: 2}, expectedWrites: 2},
        {name: 'failed final flush and close', options: {flushErrorAt: 1, closeError: true}, expectedWrites: 6},
    ])('revokes the complete codec pool and restores the checkpoint after $name', async ({options, expectedWrites}) => {
        const pool = await readyPool();
        const client = await borrow(pool);
        const file = fixture(options);
        const {store, state} = storeWithPendingIndex(file, client);
        const removeEntry = vi.fn(async () => {
            expect(pool.failed).toBe(true);
            expect(workers.every(({terminated}) => terminated)).toBe(true);
            rmSync(file.filePath);
        });
        Reflect.set(store, '_recordsDirectoryHandle', {
            async getFileHandle() { return file.handle; },
            async *entries() { yield [`${state.fileName}.mbti`, {kind: 'file'}]; },
            removeEntry,
        });
        vi.spyOn(store, '_prepare').mockResolvedValue();
        await expect(store.endImportSession()).rejects.toThrow();
        expect(pool.failed).toBe(true);
        expect(workers.every(({terminated}) => terminated)).toBe(true);
        expect(store.getLastEndImportSessionMetrics()).toBeNull();
        expect(Atomics.load(file.counters, 0)).toBe(1);
        expect(Atomics.load(file.counters, 1)).toBe(expectedWrites);
        await expect(client.open(file.handle)).rejects.toThrow();
        await store.rollbackImportSession({shards: []});
        expect(removeEntry).toHaveBeenCalledOnce();
        expect(existsSync(file.filePath)).toBe(false);
        expect(state.lookupIndexWritable).toBeNull();
        expect(state.lookupIndexQueuedBytes).toBe(0);
        expect(Reflect.get(store, '_importIndexWorkerPromise')).toBeNull();
    });
});
