/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, describe, expect, test, vi} from 'vitest';
import {openSyncImportIndexWriter, SyncImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-writer.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {safePerformance} from '../ext/js/core/safe-performance.js';

/**
 * @param {{shortWrite?: number, invalidProgress?: number, flushError?: Error, closeError?: Error, truncateError?: Error, writeError?: Error}} [options]
 * @returns {{access: import('../ext/js/dictionary/term-record-import-index-writer.js').SyncAccessHandle, calls: {writes: Array<{at: number, bytes: Uint8Array}>, flushes: number, closes: number}, bytes: Uint8Array}}
 */
function memoryFile(options = {}) {
    let bytes = new Uint8Array(0);
    const calls = {writes: /** @type {Array<{at: number, bytes: Uint8Array}>} */ ([]), flushes: 0, closes: 0};
    const access = {
        /**
         * @param {Uint8Array} view
         * @param {{at?: number}} [position]
         * @returns {number}
         */
        write(view, position = {}) {
            const {at = 0} = position;
            if (options.writeError) { throw options.writeError; }
            if (typeof options.invalidProgress === 'number') { return options.invalidProgress; }
            const length = Math.min(view.byteLength, options.shortWrite ?? view.byteLength);
            calls.writes.push({at, bytes: view.slice(0, length)});
            const expanded = new Uint8Array(Math.max(bytes.byteLength, at + length));
            expanded.set(bytes);
            expanded.set(view.subarray(0, length), at);
            bytes = expanded;
            return length;
        },
        /** @param {number} size */
        truncate(size) {
            if (options.truncateError) { throw options.truncateError; }
            const resized = new Uint8Array(size);
            resized.set(bytes.subarray(0, size));
            bytes = resized;
        },
        flush() {
            ++calls.flushes;
            if (options.flushError) { throw options.flushError; }
        },
        close() {
            ++calls.closes;
            if (options.closeError) { throw options.closeError; }
        },
    };
    return {access, calls, get bytes() { return bytes; }};
}

/**
 * @param {ReturnType<typeof memoryFile>} file
 * @returns {Promise<SyncImportIndexWriter>}
 */
async function writerFor(file) {
    const writer = await openSyncImportIndexWriter({async createSyncAccessHandle() { return file.access; }});
    if (writer === null) { throw new Error('Expected synchronous writer'); }
    return writer;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('fresh import index writer', () => {
    test('honors partial positional writes, queued seek, header rewrite and truncate', async () => {
        const file = memoryFile({shortWrite: 2});
        const writer = await writerFor(file);
        const body = new Uint8Array([1, 2, 3, 4, 5, 6]);
        await Promise.all([writer.write(body), writer.seek(0), writer.write(new Uint8Array([9, 8])), writer.truncate(5)]);
        await writer.close();
        expect([...file.bytes]).toEqual([9, 8, 3, 4, 5]);
        expect(file.calls.writes.map((x) => x.at)).toEqual([0, 2, 4, 0]);
        expect([...body]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(file.calls.flushes).toBe(1);
        expect(file.calls.closes).toBe(1);
    });

    test.each([0, -1, 0.5, Number.NaN, Infinity, 10])('latches invalid write progress %s without replay', async (invalidProgress) => {
        const file = memoryFile({invalidProgress});
        const writer = await writerFor(file);
        const failure = await writer.write(new Uint8Array([1])).then(() => null, (error) => error);
        expect(failure).toBeInstanceOf(Error);
        await expect(writer.write(new Uint8Array([2]))).rejects.toBe(failure);
        await expect(writer.close()).rejects.toBe(failure);
        await expect(writer.close()).rejects.toBe(failure);
        expect(file.calls.closes).toBe(1);
        expect(file.calls.flushes).toBe(0);
    });

    test('checks offsets and total overflow before the first write', async () => {
        const file = memoryFile();
        const writer = await writerFor(file);
        await expect(writer.seek(-1)).rejects.toBeInstanceOf(RangeError);
        await expect(writer.truncate(Number.NaN)).rejects.toBeInstanceOf(RangeError);
        await writer.seek(Number.MAX_SAFE_INTEGER);
        await expect(writer.writeChunks([new Uint8Array([1]), new Uint8Array([2])])).rejects.toBeInstanceOf(RangeError);
        expect(file.calls.writes).toHaveLength(0);
        await expect(writer.abort()).rejects.toBeInstanceOf(RangeError);
        expect(file.calls.closes).toBe(1);
    });

    test('copies exact bytes across several bounded blocks and yields', async () => {
        let clock = 0;
        vi.spyOn(safePerformance, 'now').mockImplementation(() => {
            clock += 7;
            return clock;
        });
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const file = memoryFile();
        const writer = await writerFor(file);
        const expected = Uint8Array.from({length: 9 * 1024 * 1024 + 31}, (_, i) => (i ^ (i >>> 9)) & 255);
        const chunks = [new Uint8Array(0), expected.subarray(0, 1024 * 1024 + 7), expected.subarray(1024 * 1024 + 7)];
        const pending = writer.writeChunks(chunks);
        chunks.length = 0;
        await pending;
        await writer.close();
        expect(Buffer.compare(file.bytes, expected)).toBe(0);
        expect(file.calls.writes.every((x) => x.bytes.length <= 512 * 1024)).toBe(true);
        expect(timer).toHaveBeenCalled();
    });

    test('bounds a single large view and preserves its bytes', async () => {
        const file = memoryFile();
        const writer = await writerFor(file);
        const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(123);
        await writer.write(bytes);
        await writer.close();
        expect(Buffer.compare(file.bytes, bytes)).toBe(0);
        expect(file.calls.writes.map((x) => x.bytes.length)).toEqual([...new Array(8).fill(512 * 1024), 17]);
    });

    test('keeps flush and close failures sticky and closes exactly once', async () => {
        const flushError = new Error('flush witness');
        const closeError = new Error('close witness');
        const file = memoryFile({flushError, closeError});
        const writer = await writerFor(file);
        const failure = await writer.close().then(() => null, (error) => error);
        expect(failure).toMatchObject({errors: [flushError, closeError]});
        await expect(writer.close()).rejects.toBe(failure);
        await expect(writer.abort()).rejects.toBe(failure);
        expect(file.calls.closes).toBe(1);
    });

    test('abort joins queued bytes without flushing or claiming durable close', async () => {
        const file = memoryFile();
        const writer = await writerFor(file);
        const pending = writer.write(new Uint8Array([1, 2]));
        await writer.abort();
        await pending;
        await writer.abort();
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'});
        expect(file.calls.flushes).toBe(0);
        expect(file.calls.closes).toBe(1);
    });

    test('returns unsupported only before acquisition and preserves storage errors', async () => {
        expect(await openSyncImportIndexWriter({})).toBeNull();
        const unsupported = new Error('unsupported');
        unsupported.name = 'NotSupportedError';
        expect(await openSyncImportIndexWriter({async createSyncAccessHandle() { throw unsupported; }})).toBeNull();
        const denied = new Error('permission witness');
        await expect(openSyncImportIndexWriter({async createSyncAccessHandle() { throw denied; }})).rejects.toBe(denied);
        const file = memoryFile({truncateError: unsupported});
        await expect(writerFor(file)).rejects.toBe(unsupported);
        expect(file.calls.closes).toBe(1);
    });

    test('selects synchronous access only for a fresh active-import sidecar', async () => {
        const file = memoryFile();
        const createSyncAccessHandle = vi.fn(async () => file.access);
        const createWritable = vi.fn(async () => ({}));
        const fileHandle = {createSyncAccessHandle, createWritable};
        const store = new TermRecordOpfsStore();
        const state = /** @type {Parameters<TermRecordOpfsStore['_createLookupIndexWritable']>[0]} */ (/** @type {unknown} */ ({lookupIndexFileHandle: fileHandle, initialFileLength: 0}));
        Reflect.set(store, '_importSessionActive', true);
        const writer = await store._createLookupIndexWritable(state);
        expect(writer).toBeInstanceOf(SyncImportIndexWriter);
        await writer.close();
        state.initialFileLength = 4;
        await store._createLookupIndexWritable(state);
        state.initialFileLength = 0;
        Reflect.set(store, '_importSessionActive', false);
        await store._createLookupIndexWritable(state);
        expect(createSyncAccessHandle).toHaveBeenCalledTimes(1);
        expect(createWritable).toHaveBeenCalledTimes(2);
    });

    test('a synchronous flush failure closes the owned sidecar and fails finalization', async () => {
        const failure = new Error('sync index flush witness');
        const file = memoryFile({flushError: failure});
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_importSessionActive', true);
        Reflect.set(store, '_recordsDirectoryHandle', {async getFileHandle() {
            return {async createSyncAccessHandle() { return file.access; }};
        }});
        const state = /** @type {Parameters<TermRecordOpfsStore['_flushLookupIndexFile']>[0]} */ (/** @type {unknown} */ ({
            fileName: 'fresh.mbtr',
            fileLength: 45,
            initialFileLength: 0,
            generationId: new Uint8Array(16),
            pendingLookupIndexChunks: [new Uint8Array([1, 2, 3])],
            pendingLookupIndexBytes: 3,
            pendingLookupIndexRecordCount: 1,
            lookupIndexWritable: null,
            lookupIndexFileHandle: null,
            lookupIndexWriteError: null,
            lookupIndexWritePromise: null,
            lookupIndexQueuedBytes: 0,
            lookupIndexMaxQueuedBytes: 0,
            lookupIndexChunkCount: 0,
            lookupIndexRecordCount: 0,
        }));
        await expect(store._flushLookupIndexFile(state)).rejects.toBe(failure);
        expect(state.lookupIndexWritable).toBeNull();
        expect(state.lookupIndexFileHandle).toBeNull();
        expect(file.calls.closes).toBe(1);
        expect(Reflect.get(store, '_importSessionActive')).toBe(true);
    });

    test('store propagates sync acquisition errors without opening an asynchronous writer', async () => {
        const failure = new Error('sync index lock witness');
        const createWritable = vi.fn();
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_importSessionActive', true);
        const state = /** @type {Parameters<TermRecordOpfsStore['_createLookupIndexWritable']>[0]} */ (/** @type {unknown} */ ({
            initialFileLength: 0,
            lookupIndexFileHandle: {
                async createSyncAccessHandle() { throw failure; }, createWritable,
            },
        }));
        await expect(store._createLookupIndexWritable(state)).rejects.toBe(failure);
        expect(createWritable).not.toHaveBeenCalled();
    });

    test('rollback joins an acquired synchronous writer before releasing its sidecar', async () => {
        const file = memoryFile();
        const writer = await writerFor(file);
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_importSessionActive', true);
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise(/** @param {(value?: void|PromiseLike<void>) => void} resolve */ (resolve) => { release = resolve; });
        const pending = gate.then(async () => { await writer.write(new Uint8Array([7, 8, 9])); });
        const state = /** @type {Parameters<TermRecordOpfsStore['_flushLookupIndexFile']>[0]} */ (/** @type {unknown} */ ({
            pendingWriteBytes: 0,
            pendingWriteChunks: [],
            queuedWriteBytes: 0,
            queuedWriteChunks: [],
            queuedWritePromise: null,
            queuedWriteError: null,
            writable: null,
            pendingLookupIndexChunks: [],
            pendingLookupIndexBytes: 0,
            pendingLookupIndexRecordCount: 0,
            lookupIndexWritable: writer,
            lookupIndexFileHandle: {},
            lookupIndexWritePromise: pending,
            lookupIndexWriteError: null,
            lookupIndexQueuedBytes: 3,
            lookupIndexChunkCount: 0,
            lookupIndexRecordCount: 0,
        }));
        Reflect.get(store, '_shardStateByFileName').set('fresh.mbtr', state);
        let complete = false;
        const rollback = store._abandonImportWritesForRollback().then(() => { complete = true; });
        await Promise.resolve();
        expect(complete).toBe(false);
        expect(file.calls.closes).toBe(0);
        release();
        await rollback;
        expect([...file.bytes]).toEqual([7, 8, 9]);
        expect(state.lookupIndexWritable).toBeNull();
        expect(state.lookupIndexFileHandle).toBeNull();
        expect(state.lookupIndexWritePromise).toBeNull();
        expect(file.calls.closes).toBe(1);
        expect(file.calls.flushes).toBe(0);
    });
});
