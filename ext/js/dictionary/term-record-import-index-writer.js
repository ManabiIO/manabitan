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

const MAX_WRITE_BYTES = 512 * 1024;
const WRITE_TIME_BUDGET_MS = 6;

/**
 * @typedef {object} SyncAccessHandle
 * @property {(buffer: Uint8Array, options?: {at?: number}) => number} write
 * @property {(size: number) => void} truncate
 * @property {() => void} flush
 * @property {() => void} close
 */

/**
 * Acquires only the fresh sidecar owned by the active import. The opener's
 * Unsupported acquisition permits the established asynchronous writer fallback.
 * Once acquired, every failure belongs to this writer and must fail import.
 * @param {{createSyncAccessHandle?: () => Promise<SyncAccessHandle>}} fileHandle
 * @returns {Promise<SyncImportIndexWriter|null>}
 */
export async function openSyncImportIndexWriter(fileHandle) {
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
    return new SyncImportIndexWriter(access);
}

/** Ordered, bounded writes to an unpublished generation-bound index sidecar. */
export class SyncImportIndexWriter {
    /** @param {SyncAccessHandle} access */
    constructor(access) {
        /** @type {SyncAccessHandle} */
        this._access = access;
        /** @type {number} */
        this._position = 0;
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
        this._workStartedAt = safePerformance.now();
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

    /** @param {Uint8Array[]} chunks */
    async writeChunks(chunks) {
        if (!Array.isArray(chunks)) { throw new TypeError('Import index chunks must be an array'); }
        const ownedChunks = [...chunks];
        let total = 0;
        for (const chunk of ownedChunks) {
            if (!(chunk instanceof Uint8Array)) { throw new TypeError('Import index chunk requires Uint8Array'); }
            total += chunk.byteLength;
            if (!Number.isSafeInteger(total)) { throw new RangeError('Import index chunk length overflow'); }
        }
        await this._enqueue(async () => {
            this._validateWriteLength(total);
            if (ownedChunks.length === 1) {
                await this._writeBytes(ownedChunks[0]);
                return;
            }
            if (total === 0) { return; }
            const scratch = new Uint8Array(Math.min(MAX_WRITE_BYTES, total));
            let sourceIndex = 0;
            let sourceOffset = 0;
            for (let completed = 0; completed < total;) {
                const length = Math.min(scratch.byteLength, total - completed);
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
                completed += length;
                if (completed < total) { await this._yieldIfNeeded(); }
            }
        });
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
            if (offset < bytes.byteLength) { await this._yieldIfNeeded(); }
        }
    }

    /** @returns {Promise<void>} */
    async _yieldIfNeeded() {
        if (safePerformance.now() - this._workStartedAt < WRITE_TIME_BUDGET_MS) { return; }
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        this._workStartedAt = safePerformance.now();
    }
}
