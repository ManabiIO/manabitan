/* SPDX-License-Identifier: GPL-3.0-or-later */

import {createHash} from 'node:crypto';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {safePerformance} from '../ext/js/core/safe-performance.js';
import {openSyncImportIndexWriter} from '../ext/js/dictionary/term-record-import-index-writer.js';

const FLUSH_INTERVAL_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;

/**
 * A fixed-capacity file keeps large-prefix tests independent of resize/copy
 * costs. Flush receipts record the successful bytes since the previous flush,
 * including positional rewrites, rather than inferring them from file size.
 * @param {number} capacity
 * @param {{shortWrite?: number, flushFailureAt?: number, flushError?: Error, closeError?: Error}} [options]
 * @returns {{access: import('../ext/js/dictionary/term-record-import-index-writer.js').SyncAccessHandle, writes: Array<{at: number, length: number, requestLength: number}>, flushes: Array<{bytes: number, writtenBytes: number, size: number, header: Uint8Array}>, truncates: number[], closes: number, bytes: Uint8Array, writtenBytes: number}}
 */
function createFile(capacity, options = {}) {
    const storage = new Uint8Array(capacity);
    let size = 0;
    let unflushedBytes = 0;
    let writtenBytes = 0;
    let closes = 0;
    /** @type {Array<{bytes: number, writtenBytes: number, size: number, header: Uint8Array}>} */
    const flushes = [];
    /** @type {Array<{at: number, length: number, requestLength: number}>} */
    const writes = [];
    /** @type {number[]} */
    const truncates = [];
    const access = {
        /**
         * @param {Uint8Array} view
         * @param {{at?: number}} [position]
         * @returns {number}
         */
        write(view, {at = 0} = {}) {
            const length = Math.min(view.byteLength, options.shortWrite ?? view.byteLength);
            if (at > storage.byteLength - length) { throw new Error('Test file capacity exceeded'); }
            storage.set(view.subarray(0, length), at);
            size = Math.max(size, at + length);
            unflushedBytes += length;
            writtenBytes += length;
            writes.push({at, length, requestLength: view.byteLength});
            return length;
        },
        /** @param {number} length */
        truncate(length) {
            if (length > storage.byteLength) { throw new Error('Test file capacity exceeded'); }
            storage.fill(0, Math.min(size, length), Math.max(size, length));
            size = length;
            truncates.push(length);
        },
        flush() {
            flushes.push({bytes: unflushedBytes, writtenBytes, size, header: storage.slice(0, Math.min(32, size))});
            if (options.flushFailureAt === flushes.length) {
                throw options.flushError ?? new Error('Injected flush failure');
            }
            unflushedBytes = 0;
        },
        close() {
            ++closes;
            if (typeof options.closeError !== 'undefined') { throw options.closeError; }
        },
    };
    return {
        access,
        writes,
        flushes,
        truncates,
        get closes() { return closes; },
        get bytes() { return storage.subarray(0, size); },
        get writtenBytes() { return writtenBytes; },
    };
}

/**
 * @param {ReturnType<typeof createFile>} file
 * @returns {Promise<NonNullable<Awaited<ReturnType<typeof openSyncImportIndexWriter>>>>}
 */
async function writerFor(file) {
    const writer = await openSyncImportIndexWriter({async createSyncAccessHandle() { return file.access; }}, true);
    if (writer === null) { throw new Error('Expected synchronous writer'); }
    return writer;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('bounded persistence of import index bytes', () => {
    test('retains close-only persistence unless a dedicated worker opts in', async () => {
        const file = createFile(2 * FLUSH_INTERVAL_BYTES);
        const writer = await openSyncImportIndexWriter({async createSyncAccessHandle() { return file.access; }});
        if (writer === null) { throw new Error('Expected synchronous writer'); }
        await writer.write(new Uint8Array(2 * FLUSH_INTERVAL_BYTES));
        expect(file.flushes).toHaveLength(0);
        await writer.close();
        expect(file.flushes).toHaveLength(1);
        expect(file.closes).toBe(1);
    });

    test('flushes large fragmented short writes before close and preserves final header bytes', async () => {
        const body = new Uint8Array(2 * FLUSH_INTERVAL_BYTES + 31);
        for (let i = 0; i < body.length; ++i) { body[i] = (i ^ (i >>> 8)) & 255; }
        const originalDigest = digest(body);
        const file = createFile(body.byteLength, {shortWrite: 173_021});
        const writer = await writerFor(file);
        const chunks = [
            body.subarray(0, 3),
            new Uint8Array(0),
            body.subarray(3, FLUSH_INTERVAL_BYTES - 17),
            body.subarray(FLUSH_INTERVAL_BYTES - 17, FLUSH_INTERVAL_BYTES + 29),
            body.subarray(FLUSH_INTERVAL_BYTES + 29),
            new Uint8Array(0),
        ];
        const writing = writer.writeChunks(chunks);
        chunks.length = 0;
        await writing;

        expect(file.flushes.length).toBeGreaterThanOrEqual(2);
        expect(file.flushes.every(({bytes}) => bytes >= FLUSH_INTERVAL_BYTES && bytes <= FLUSH_INTERVAL_BYTES + MAX_WRITE_BYTES)).toBe(true);
        expect(file.writes.every(({requestLength}) => requestLength <= MAX_WRITE_BYTES)).toBe(true);
        expect(digest(file.bytes)).toBe(originalDigest);
        expect(digest(body)).toBe(originalDigest);

        const header = new Uint8Array(23).fill(239);
        await writer.seek(0);
        await writer.write(header);
        await writer.truncate(body.byteLength - 13);
        const periodicFlushCount = file.flushes.length;
        await writer.close();
        await writer.close();

        const expected = body.slice(0, body.byteLength - 13);
        expected.set(header);
        expect(digest(file.bytes)).toBe(digest(expected));
        expect(digest(body)).toBe(originalDigest);
        expect(file.flushes).toHaveLength(periodicFlushCount + 1);
        expect(file.flushes.at(-1)?.header.subarray(0, header.length)).toEqual(header);
        expect(file.flushes.at(-1)?.size).toBe(expected.byteLength);
        expect(file.closes).toBe(1);
    });

    test('counts successful positional overwrites across calls and still flushes at final close', async () => {
        const file = createFile(MAX_WRITE_BYTES, {shortWrite: 131_071});
        const writer = await writerFor(file);
        const bytes = new Uint8Array(MAX_WRITE_BYTES).fill(57);
        for (let written = 0; written < FLUSH_INTERVAL_BYTES; written += bytes.byteLength) {
            await writer.seek(0);
            await writer.write(bytes);
        }
        expect(file.bytes.byteLength).toBe(bytes.byteLength);
        expect(file.writtenBytes).toBe(FLUSH_INTERVAL_BYTES);
        expect(file.flushes).toHaveLength(1);
        expect(file.flushes[0].bytes).toBe(FLUSH_INTERVAL_BYTES);
        await writer.close();
        expect(file.flushes).toHaveLength(2);
        expect(file.flushes[1].bytes).toBe(0);
        expect(digest(file.bytes)).toBe(digest(bytes));
    });

    test.each([false, true])('latches a periodic flush failure, drains queued operations, and closes once (close failure: %s)', async (failClose) => {
        const flushError = new Error('Periodic persistence failed');
        const closeError = new Error('Closing failed after periodic persistence');
        const file = createFile(FLUSH_INTERVAL_BYTES + MAX_WRITE_BYTES, {
            shortWrite: 173_021,
            flushFailureAt: 1,
            flushError,
            ...(failClose ? {closeError} : {}),
        });
        const writer = await writerFor(file);
        const body = new Uint8Array(FLUSH_INTERVAL_BYTES + MAX_WRITE_BYTES).fill(93);
        const originalDigest = digest(body);
        const results = await Promise.allSettled([
            writer.write(body),
            writer.seek(0),
            writer.write(new Uint8Array([8, 9])),
            writer.truncate(2),
        ]);
        expect(results).toEqual(new Array(4).fill({status: 'rejected', reason: flushError}));
        expect(file.flushes).toHaveLength(1);
        expect(file.writtenBytes).toBeGreaterThanOrEqual(FLUSH_INTERVAL_BYTES);
        expect(file.writtenBytes).toBeLessThan(body.byteLength);
        expect(file.truncates).toEqual([0]);
        expect(digest(file.bytes)).toBe(digest(body.subarray(0, file.bytes.byteLength)));
        expect(digest(body)).toBe(originalDigest);
        await expect(writer.write(new Uint8Array([1]))).rejects.toBe(flushError);
        const failure = await writer.close().then(() => null, (error) => error);
        if (failClose) {
            expect(failure).toBeInstanceOf(AggregateError);
            expect(failure.errors).toEqual([flushError, closeError]);
        } else {
            expect(failure).toBe(flushError);
        }
        await expect(writer.close()).rejects.toBe(failure);
        await expect(writer.abort()).rejects.toBe(failure);
        expect(file.flushes).toHaveLength(1);
        expect(file.closes).toBe(1);
    });

    test('does not let an earlier periodic flush hide a failed final header flush', async () => {
        const flushError = new Error('Final header persistence failed');
        const file = createFile(FLUSH_INTERVAL_BYTES, {flushFailureAt: 2, flushError});
        const writer = await writerFor(file);
        await writer.write(new Uint8Array(FLUSH_INTERVAL_BYTES).fill(37));
        expect(file.flushes).toHaveLength(1);
        const header = Uint8Array.of(7, 8, 9);
        await writer.seek(0);
        await writer.write(header);
        await expect(writer.close()).rejects.toBe(flushError);
        await expect(writer.close()).rejects.toBe(flushError);
        expect(file.flushes).toHaveLength(2);
        expect(file.flushes[1].header.subarray(0, header.length)).toEqual(header);
        expect(file.closes).toBe(1);
    });

    test.each([false, true])('abort drains a paused large write without further flushing (earlier flush: %s)', async (flushBeforeAbort) => {
        vi.useFakeTimers();
        let clock = 0;
        vi.spyOn(safePerformance, 'now').mockImplementation(() => clock);
        const body = new Uint8Array(FLUSH_INTERVAL_BYTES + 17).fill(119);
        const file = createFile(body.byteLength + (flushBeforeAbort ? FLUSH_INTERVAL_BYTES : 0));
        const writer = await writerFor(file);
        if (flushBeforeAbort) {
            await writer.write(body.subarray(0, FLUSH_INTERVAL_BYTES));
            expect(file.flushes).toHaveLength(1);
        }
        const previousFlushCount = file.flushes.length;
        const originalDigest = digest(body);
        /** @type {() => void} */
        let firstWrite = () => {};
        const reachedWrite = new Promise(/** @param {(value?: void|PromiseLike<void>) => void} resolve */ (resolve) => { firstWrite = resolve; });
        const write = file.access.write;
        file.access.write = (view, position) => {
            const written = write(view, position);
            clock += 7;
            firstWrite();
            return written;
        };
        const writing = writer.write(body);
        await reachedWrite;
        const aborting = writer.abort();
        await expect(writer.write(new Uint8Array([1]))).rejects.toThrow('closed');
        await vi.runAllTimersAsync();
        await Promise.all([writing, aborting]);
        await writer.abort();
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'});

        expect(file.flushes).toHaveLength(previousFlushCount);
        expect(file.closes).toBe(1);
        expect(digest(file.bytes.subarray(file.bytes.byteLength - body.byteLength))).toBe(originalDigest);
        expect(digest(body)).toBe(originalDigest);
    });
});
