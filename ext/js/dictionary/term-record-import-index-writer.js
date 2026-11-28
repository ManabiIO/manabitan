/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {safePerformance} from '../core/safe-performance.js';
import {toError} from '../core/to-error.js';
import {prepareImportIndexChunkParts} from './term-record-import-index-chunk.js';

const MAX_WRITE_BYTES = 512 * 1024;
const MAX_UNFLUSHED_BYTES = 16 * 1024 * 1024;
const WRITE_TIME_BUDGET_MS = 6;

/**
 * @typedef {object} SyncAccessHandle
 * @property {(buffer: Uint8Array, options?: {at?: number}) => number} write
 * @property {(size: number) => void} truncate
 * @property {() => void} flush
 * @property {() => void} close
 */

/**
 * Acquires and truncates the fresh sidecar owned by the active import. The opener's
 * Unsupported acquisition permits the established asynchronous writer fallback.
 * Once acquired, every failure belongs to this writer and must fail import.
 * @param {{createSyncAccessHandle?: () => Promise<SyncAccessHandle>}} fileHandle
 * @param {boolean} [periodicFlush=false] Only the dedicated I/O worker opts in.
 * @returns {Promise<SyncImportIndexWriter|null>}
 */
export async function openSyncImportIndexWriter(fileHandle, periodicFlush = false) {
    if (typeof fileHandle.createSyncAccessHandle !== 'function') {
        return null;
    }
    let access;
    try { access = await fileHandle.createSyncAccessHandle(); } catch (error) {
        if (error instanceof Error && error.name === 'NotSupportedError') { return null; }
        throw error;
    }
    try {
        access.truncate(0);
    } catch (error) {
        try { access.close(); } catch (closeError) {
            throw new AggregateError([error, closeError], 'Failed to initialize synchronous import index writer');
        }
        throw error;
    }
    return new SyncImportIndexWriter(access, periodicFlush);
}

/** Ordered, bounded writes to an unpublished generation-bound index sidecar. */
export class SyncImportIndexWriter {
    /**
     * @param {SyncAccessHandle} access
     * @param {boolean} [periodicFlush=false]
     */
    constructor(access, periodicFlush = false) {
        /** @type {SyncAccessHandle} */
        this._access = access;
        /** @type {number} */
        this._position = 0;
        /** @type {number} */
        this._unflushedBytes = 0;
        /** @type {boolean} */
        this._periodicFlush = periodicFlush;
        /** @type {boolean} */
        this._closing = false;
        /** @type {boolean} */
        this._aborted = false;
        /** @type {Error|null} */
        this._failure = null;
        /** @type {Promise<void>} */
        this._queue = Promise.resolve();
        /** @type {Promise<void>|null} */
        this._closePromise = null;
        /** @type {number} */
        this._workStartedAt = 0;
        /** @type {number} */
        this._workElapsedMs = 0;
        /** @type {MessageChannel|null} */
        this._yieldChannel = null;
        /** @type {(() => void)|null} */
        this._pendingYield = null;
    }

    /** @param {number} offset */
    async seek(offset) {
        this._validatePosition(offset);
        await this._enqueue(() => { this._position = offset; });
    }

    /** @param {number} size */
    async truncate(size) {
        this._validatePosition(size);
        await this._enqueue(() => {
            this._access.truncate(size);
            this._position = Math.min(this._position, size);
        });
    }

    /** @param {Uint8Array} bytes */
    async write(bytes) {
        if (!(bytes instanceof Uint8Array)) { throw new TypeError('Import index write requires Uint8Array'); }
        await this._enqueue(() => this._writeBytes(bytes));
    }

    /**
     * The caller retains the immutable chunk bytes until the write settles.
     * @param {Uint8Array[]} chunks
     */
    async writeChunks(chunks) {
        if (!Array.isArray(chunks)) { throw new TypeError('Import index chunks must be an array'); }
        const ownedChunks = [...chunks];
        let total = 0;
        for (const chunk of ownedChunks) {
            if (!(chunk instanceof Uint8Array)) { throw new TypeError('Import index chunk requires Uint8Array'); }
            total += chunk.byteLength;
            if (!Number.isSafeInteger(total)) { throw new RangeError('Import index chunk length overflow'); }
        }
        await this._enqueue(() => this._writeChunkBytes(ownedChunks, total));
    }

    /**
     * Hashing belongs to the same ordered operation as the writes, so an older
     * failure remains authoritative and active work counts toward yielding.
     * @param {import('./term-record-import-index-chunk.js').ImportIndexChunk[]} chunks
     * @returns {Promise<(Uint8Array|null)[]>} Completed headers in logical chunk order.
     */
    async writeIndexChunks(chunks) {
        if (!Array.isArray(chunks)) { throw new TypeError('Import index chunks must be an array'); }
        const owned = [...chunks];
        /** @type {(Uint8Array|null)[]} */
        const headers = [];
        await this._enqueue(async () => {
            const parts = prepareImportIndexChunkParts(owned);
            let total = 0;
            for (const part of parts) {
                total += part.byteLength;
                if (!Number.isSafeInteger(total)) { throw new RangeError('Import index chunk length overflow'); }
            }
            await this._writeChunkBytes(parts, total);
            for (const chunk of owned) {
                headers.push(chunk instanceof Uint8Array ? null : Uint8Array.from(chunk.header));
            }
        });
        return headers;
    }

    /**
     * @param {Uint8Array[]} ownedChunks
     * @param {number} total
     * @returns {Promise<void>}
     */
    async _writeChunkBytes(ownedChunks, total) {
        this._validateWriteLength(total);
        if (ownedChunks.length === 1) {
            await this._writeBytes(ownedChunks[0]);
            return;
        }
        if (total === 0) { return; }
        /** @type {Uint8Array|null} */
        let scratch = null;
        let sourceIndex = 0;
        let sourceOffset = 0;
        for (let completed = 0; completed < total;) {
            const length = Math.min(MAX_WRITE_BYTES, total - completed);
            while (ownedChunks[sourceIndex].byteLength === sourceOffset) {
                ++sourceIndex;
                sourceOffset = 0;
            }
            const first = ownedChunks[sourceIndex];
            if (first.byteLength - sourceOffset >= length) {
                // The queued chunks own these bytes until the batch finishes.
                // Keep each OPFS request the same size as a coalesced write.
                await this._writeBytes(first.subarray(sourceOffset, sourceOffset + length));
                sourceOffset += length;
            } else {
                scratch ??= new Uint8Array(Math.min(MAX_WRITE_BYTES, total));
                let filled = 0;
                while (filled < length) {
                    const source = ownedChunks[sourceIndex];
                    const count = Math.min(source.byteLength - sourceOffset, length - filled);
                    scratch.set(source.subarray(sourceOffset, sourceOffset + count), filled);
                    sourceOffset += count;
                    filled += count;
                    if (sourceOffset === source.byteLength) {
                        ++sourceIndex;
                        sourceOffset = 0;
                    }
                }
                await this._writeBytes(scratch.subarray(0, length));
            }
            completed += length;
            if (completed < total) { await this._yieldIfNeeded(); }
        }
    }

    /** @returns {Promise<void>} */
    async close() {
        await this._finish(false);
        if (this._aborted) {
            const error = new Error('Import index writer was aborted');
            error.name = 'AbortError';
            throw error;
        }
    }

    /** @returns {Promise<void>} */
    async abort() {
        await this._finish(true);
    }

    /**
     * @param {boolean} abort
     * @returns {Promise<void>}
     */
    _finish(abort) {
        if (this._closePromise !== null) { return this._closePromise; }
        this._closing = true;
        this._aborted = abort;
        this._closePromise = (async () => {
            await this._queue;
            this._closeYieldChannel();
            const errors = this._failure === null ? [] : [this._failure];
            if (!abort && errors.length === 0) {
                try {
                    this._access.flush();
                } catch (error) {
                    errors.push(toError(error));
                }
            }
            try {
                this._access.close();
            } catch (error) {
                errors.push(toError(error));
            }
            if (errors.length > 0) {
                this._failure = errors.length === 1 ?
                    errors[0] :
                    new AggregateError(errors, 'Failed to finalize import index writer');
                throw this._failure;
            }
        })();
        return this._closePromise;
    }

    /**
     * @param {number} value
     * @throws {RangeError} If the position is not a nonnegative safe integer.
     */
    _validatePosition(value) {
        if (!Number.isSafeInteger(value) || value < 0) { throw new RangeError('Invalid import index position'); }
    }

    /**
     * @param {number} length
     * @throws {RangeError} If the final position would overflow.
     */
    _validateWriteLength(length) {
        if (length > Number.MAX_SAFE_INTEGER - this._position) { throw new RangeError('Import index position overflow'); }
    }

    /**
     * @param {() => void|Promise<void>} operation
     * @returns {Promise<void>}
     */
    _enqueue(operation) {
        if (this._failure !== null) { return Promise.reject(this._failure); }
        if (this._closing) { return Promise.reject(new Error('Import index writer is closed')); }
        const promise = this._queue.then(async () => {
            if (this._failure !== null) { throw this._failure; }
            try {
                // Charge only active writer work. Parser/compressor pauses and
                // waits for the queue must not force a timer after a tiny write.
                // Keep the accumulated budget across operations so a chain of
                // short writes still yields instead of starving other tasks.
                this._workStartedAt = safePerformance.now();
                await operation();
                await this._yieldIfNeeded();
            } catch (error) {
                this._failure = toError(error);
                throw this._failure;
            }
        });
        this._queue = promise.catch(() => {});
        return promise;
    }

    /** @param {Uint8Array} bytes */
    async _writeBytes(bytes) {
        this._validateWriteLength(bytes.byteLength);
        for (let offset = 0; offset < bytes.byteLength;) {
            const view = bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_WRITE_BYTES));
            const written = this._access.write(view, {at: this._position});
            if (!Number.isSafeInteger(written) || written <= 0 || written > view.byteLength) {
                throw new Error('Invalid import index write progress');
            }
            offset += written;
            this._position += written;
            this._unflushedBytes += written;
            if (this._periodicFlush && !this._aborted && this._unflushedBytes >= MAX_UNFLUSHED_BYTES) {
                // Persist bounded batches while parser workers can still make progress.
                // Successful close must also flush the final index header and tail.
                this._access.flush();
                this._unflushedBytes = 0;
            }
            if (offset < bytes.byteLength) { await this._yieldIfNeeded(); }
        }
    }

    /** @returns {Promise<void>} */
    async _yieldIfNeeded() {
        const now = safePerformance.now();
        this._workElapsedMs += now - this._workStartedAt;
        this._workStartedAt = now;
        if (this._workElapsedMs < WRITE_TIME_BUDGET_MS) { return; }
        await this._yieldToNextTask();
        this._workElapsedMs = 0;
        this._workStartedAt = safePerformance.now();
    }

    /** @returns {Promise<void>} */
    _yieldToNextTask() {
        if (typeof MessageChannel !== 'function') {
            return new Promise((resolve) => { setTimeout(resolve, 0); });
        }
        if (this._yieldChannel === null) {
            try {
                this._yieldChannel = new MessageChannel();
                this._yieldChannel.port1.onmessage = () => {
                    const resolve = this._pendingYield;
                    this._pendingYield = null;
                    resolve?.();
                };
            } catch {
                this._yieldChannel = null;
                return new Promise((resolve) => { setTimeout(resolve, 0); });
            }
        }
        return new Promise((resolve) => {
            this._pendingYield = resolve;
            try {
                this._yieldChannel?.port2.postMessage(0);
            } catch {
                this._pendingYield = null;
                this._closeYieldChannel();
                setTimeout(resolve, 0);
            }
        });
    }

    /** Closes the per-writer task-yield channel after queued writes settle. */
    _closeYieldChannel() {
        if (this._yieldChannel === null) { return; }
        this._yieldChannel.port1.onmessage = null;
        this._yieldChannel.port1.close();
        this._yieldChannel.port2.close();
        this._yieldChannel = null;
    }
}
