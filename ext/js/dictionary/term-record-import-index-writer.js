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
import {nextIndexIoDiagnosticId, recordIndexIoDiagnostic} from './term-record-import-index-diagnostic.js';

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
 * @param {{writerId: string, fileName: string}} [diagnostic]
 * @returns {Promise<SyncImportIndexWriter|null>}
 */
export async function openSyncImportIndexWriter(fileHandle, periodicFlush = false, diagnostic) {
    diagnostic ??= {writerId: `local-${nextIndexIoDiagnosticId()}`, fileName: ''};
    const startedAt = safePerformance.now();
    let status = 'error';
    try {
        if (typeof fileHandle.createSyncAccessHandle !== 'function') {
            status = 'unsupported';
            return null;
        }
        let access;
        try { access = await fileHandle.createSyncAccessHandle(); } catch (error) {
            if (error instanceof Error && error.name === 'NotSupportedError') {
                status = 'unsupported';
                return null;
            }
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
        status = 'opened';
        return new SyncImportIndexWriter(access, periodicFlush, diagnostic);
    } finally {
        recordIndexIoDiagnostic('writer-open', {...diagnostic, periodicFlush, status}, startedAt);
    }
}

/** Ordered, bounded writes to an unpublished generation-bound index sidecar. */
export class SyncImportIndexWriter {
    /**
     * @param {SyncAccessHandle} access
     * @param {boolean} [periodicFlush=false]
     * @param {{writerId: string, fileName: string}} [diagnostic]
     */
    constructor(access, periodicFlush = false, diagnostic) {
        /** @type {SyncAccessHandle} */
        this._access = access;
        /** @type {number} */
        this._position = 0;
        /** @type {number} */
        this._unflushedBytes = 0;
        /** @type {{writerId: string, fileName: string}} */
        this._diagnostic = diagnostic ?? {writerId: `local-${nextIndexIoDiagnosticId()}`, fileName: ''};
        /** @type {number} */
        this._writtenBytes = 0;
        /** @type {number} */
        this._fileLength = 0;
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
            this._fileLength = size;
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
        await this._enqueue(async () => {
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
                    this._flush('final');
                } catch (error) {
                    errors.push(toError(error));
                }
            }
            const closeStartedAt = safePerformance.now();
            let closed = false;
            try {
                this._access.close();
                closed = true;
            } catch (error) {
                errors.push(toError(error));
            } finally {
                recordIndexIoDiagnostic('writer-close', {
                    ...this._diagnostic,
                    aborted: abort,
                    success: closed,
                    position: this._position,
                    fileLength: this._fileLength,
                    writtenBytes: this._writtenBytes,
                }, closeStartedAt);
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
            this._unflushedBytes += written;
            this._writtenBytes += written;
            this._fileLength = Math.max(this._fileLength, this._position);
            if (this._periodicFlush && !this._aborted && this._unflushedBytes >= MAX_UNFLUSHED_BYTES) {
                // Persist bounded batches while parser workers can still make progress.
                // Successful close must also flush the final index header and tail.
                this._flush('periodic');
                this._unflushedBytes = 0;
            }
            if (offset < bytes.byteLength) { await this._yieldIfNeeded(); }
        }
    }

    /** @param {'periodic'|'final'} reason */
    _flush(reason) {
        const startedAt = safePerformance.now();
        let success = false;
        try {
            this._access.flush();
            success = true;
        } finally {
            recordIndexIoDiagnostic('writer-flush', {
                ...this._diagnostic,
                reason,
                success,
                periodicFlush: this._periodicFlush,
                position: this._position,
                fileLength: this._fileLength,
                writtenBytes: this._writtenBytes,
                unflushedBytes: this._unflushedBytes,
            }, startedAt);
        }
    }

    /** @returns {Promise<void>} */
    async _yieldIfNeeded() {
        if (safePerformance.now() - this._workStartedAt < WRITE_TIME_BUDGET_MS) { return; }
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        this._workStartedAt = safePerformance.now();
    }
}
