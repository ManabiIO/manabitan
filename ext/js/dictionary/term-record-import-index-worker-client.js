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

import {toError} from '../core/to-error.js';

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * @typedef {{id: number, name?: string, message?: string, stack?: string, errors?: SerializedIndexError[]}} SerializedIndexError
 */

/**
 * Preserve repeated failures and aggregate children across the worker boundary.
 * References also permit cyclic AggregateError values without recursive copies.
 * @param {unknown} value
 * @param {Map<Error, number>} ids
 * @param {Set<Error>} [seen]
 * @returns {SerializedIndexError}
 */
export function serializeImportIndexWorkerError(value, ids, seen = new Set()) {
    const error = toError(value);
    let id = ids.get(error);
    if (typeof id === 'undefined') {
        id = ids.size + 1;
        ids.set(error, id);
    }
    if (seen.has(error)) { return {id}; }
    seen.add(error);
    const result = {
        id,
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
    return error instanceof AggregateError ?
        {...result, errors: error.errors.map((child) => serializeImportIndexWorkerError(child, ids, seen))} :
        result;
}

/**
 * @param {unknown} value
 * @param {Map<number, Error>} errors
 * @returns {Error}
 * @throws {TypeError} If the worker error is malformed.
 */
function deserializeImportIndexWorkerError(value, errors) {
    if (typeof value !== 'object' || value === null) { throw new TypeError('Invalid import index worker error'); }
    const data = /** @type {SerializedIndexError} */ (value);
    if (!Number.isSafeInteger(data.id) || data.id <= 0) { throw new TypeError('Invalid import index worker error'); }
    const previous = errors.get(data.id);
    if (typeof previous !== 'undefined') { return previous; }
    if (
        typeof data.name !== 'string' || typeof data.message !== 'string' ||
        (typeof data.errors !== 'undefined' && !Array.isArray(data.errors))
    ) {
        throw new TypeError('Invalid import index worker error');
    }
    let error;
    if (Array.isArray(data.errors)) {
        error = new AggregateError([], data.message);
    } else if (data.name === 'RangeError') {
        error = new RangeError(data.message);
    } else if (data.name === 'TypeError') {
        error = new TypeError(data.message);
    } else {
        error = new Error(data.message);
    }
    error.name = data.name;
    if (typeof data.stack === 'string') { error.stack = data.stack; }
    errors.set(data.id, error);
    if (error instanceof AggregateError && Array.isArray(data.errors)) {
        error.errors = data.errors.map((child) => deserializeImportIndexWorkerError(child, errors));
    }
    return error;
}

/**
 * Startup has no file handle or bytes, so a worker unavailable before readiness
 * can safely retain the established local synchronous/asynchronous opener.
 * @returns {Promise<ImportIndexWorkerClient|null>}
 */
export async function createImportIndexWorkerClient() {
    if (typeof Worker !== 'function') { return null; }
    let client;
    try {
        const worker = new Worker(new URL('term-record-import-index-worker.js', import.meta.url), {type: 'module'});
        client = new ImportIndexWorkerClient(worker);
        await client.ready;
        return client;
    } catch (_) {
        await client?.dispose();
        return null;
    }
}

/** One import session owns this worker and every fresh sidecar opened in it. */
export class ImportIndexWorkerClient {
    /** @param {Worker|import('./compression-index-worker-transport.js').CompressionIndexWorkerTransport} worker */
    constructor(worker) {
        /** @type {Worker|import('./compression-index-worker-transport.js').CompressionIndexWorkerTransport} */
        this._worker = worker;
        /** @type {number} */
        this._nextRequestId = 1;
        /** @type {number} */
        this._nextWriterId = 1;
        /** @type {Error|null} */
        this._failure = null;
        /** @type {Promise<void>|null} */
        this._disposePromise = null;
        /** @type {Map<number, Error>} */
        this._errors = new Map();
        /** @type {Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void, timeout: ReturnType<typeof setTimeout>}>} */
        this._pending = new Map();
        /** @type {() => void} */
        this._resolveReady = () => {};
        /** @type {(error: Error) => void} */
        this._rejectReady = () => {};
        /** @type {Promise<void>} */
        this.ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        void this.ready.catch(() => {});
        /** @type {ReturnType<typeof setTimeout>} */
        this._readyTimeout = setTimeout(() => {
            this._fail(new Error('Import index worker startup timed out'));
        }, READY_TIMEOUT_MS);
        worker.addEventListener('message', (event) => { this._onMessage(/** @type {MessageEvent<unknown>} */ (event)); });
        worker.addEventListener('error', (event) => {
            this._fail(new Error(/** @type {ErrorEvent} */ (event).message || 'Import index worker failed'));
        });
        worker.addEventListener('messageerror', () => {
            this._fail(new Error('Import index worker returned an invalid message'));
        });
    }

    /**
     * Once this request is sent, an ambiguous failure cannot retry acquisition
     * locally: the worker may already have truncated the unpublished file.
     * @param {FileSystemFileHandle} fileHandle
     * @returns {Promise<WorkerImportIndexWriter|null>}
     */
    async open(fileHandle) {
        await this.ready;
        const writerId = this._nextWriterId++;
        const status = await this.request(writerId, 'open', {fileHandle});
        if (status === 'unsupported') { return null; }
        if (status !== 'opened') {
            const error = new Error('Import index worker returned invalid acquisition status');
            this._fail(error);
            throw error;
        }
        return new WorkerImportIndexWriter(this, writerId);
    }

    /**
     * @param {number} writerId
     * @param {string} action
     * @param {Record<string, unknown>} [params]
     * @param {Transferable[]} [transfer]
     * @returns {Promise<unknown>}
     */
    request(writerId, action, params = {}, transfer = []) {
        if (this._failure !== null) { return Promise.reject(this._failure); }
        const id = this._nextRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._fail(new Error(`Import index worker request timed out: ${action}`));
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(id, {resolve, reject, timeout});
            try {
                this._worker.postMessage({id, writerId, action, ...params}, transfer);
            } catch (error) {
                this._fail(toError(error));
            }
        });
    }

    /**
     * Called only after store finalization/rollback has joined all writers.
     * Transport failure still reaches checkpoint restoration; termination is
     * never used as proof that a mutated file was successfully published.
     * @returns {Promise<void>}
     */
    dispose() {
        this._disposePromise ??= this._dispose();
        return this._disposePromise;
    }

    /**
     * @returns {Promise<void>}
     * @throws {Error} If a borrowed session cannot acknowledge clean retirement.
     */
    async _dispose() {
        if (this._failure !== null) { return; }
        const worker = this._worker;
        if ('release' in worker) {
            try {
                const status = await this.request(0, 'dispose-session');
                if (status !== 'disposed') { throw new Error('Shared import index worker returned invalid disposal status'); }
                this._fail(new Error('Import index worker closed'), false);
                worker.release();
            } catch (error) {
                const failure = toError(error);
                this._fail(failure);
                throw failure;
            }
        } else {
            this._fail(new Error('Import index worker closed'));
        }
    }

    /** @param {MessageEvent<unknown>} event */
    _onMessage(event) {
        if (this._failure !== null) { return; }
        const data = /** @type {{type?: unknown, id?: unknown, result?: unknown, error?: unknown}} */ (event.data);
        if (typeof data !== 'object' || data === null) {
            this._fail(new Error('Import index worker returned an invalid message'));
            return;
        }
        if (data.type === 'ready') {
            clearTimeout(this._readyTimeout);
            this._resolveReady();
            return;
        }
        const pending = typeof data.id === 'number' ? this._pending.get(data.id) : void 0;
        if (typeof pending === 'undefined') {
            this._fail(new Error('Import index worker returned an unknown response'));
            return;
        }
        this._pending.delete(/** @type {number} */ (data.id));
        clearTimeout(pending.timeout);
        if (typeof data.error !== 'undefined') {
            try {
                pending.reject(deserializeImportIndexWorkerError(data.error, this._errors));
            } catch (error) {
                const failure = toError(error);
                pending.reject(failure);
                this._fail(failure);
            }
        } else {
            pending.resolve(data.result);
        }
    }

    /**
     * @param {Error} error
     * @param {boolean} [terminate=true]
     */
    _fail(error, terminate = true) {
        if (this._failure !== null) { return; }
        this._failure = error;
        clearTimeout(this._readyTimeout);
        this._rejectReady(error);
        if (terminate) { this._worker.terminate(); }
        for (const {reject, timeout} of this._pending.values()) {
            clearTimeout(timeout);
            reject(error);
        }
        this._pending.clear();
    }
}

/** Ordered proxy; only writeOwnedChunks consumes its input buffers. */
export class WorkerImportIndexWriter {
    /**
     * @param {ImportIndexWorkerClient} client
     * @param {number} writerId
     */
    constructor(client, writerId) {
        /** @type {ImportIndexWorkerClient} */
        this._client = client;
        /** @type {number} */
        this._writerId = writerId;
        /** @type {Promise<void>} */
        this._queue = Promise.resolve();
        /** @type {Error|null} */
        this._failure = null;
        /** @type {boolean} */
        this._closing = false;
        /** @type {boolean} */
        this._aborted = false;
        /** @type {Promise<void>|null} */
        this._closePromise = null;
    }

    /** @param {number} offset */
    async seek(offset) {
        this._validatePosition(offset);
        await this._enqueue('seek', {offset});
    }

    /** @param {number} size */
    async truncate(size) {
        this._validatePosition(size);
        await this._enqueue('truncate', {size});
    }

    /** @param {Uint8Array} bytes */
    async write(bytes) {
        if (!(bytes instanceof Uint8Array)) { throw new TypeError('Import index write requires Uint8Array'); }
        await this.writeOwnedChunks([Uint8Array.from(bytes)]);
    }

    /** @param {Uint8Array[]} chunks */
    async writeChunks(chunks) {
        if (!Array.isArray(chunks)) { throw new TypeError('Import index chunks must be an array'); }
        const copies = chunks.map((chunk) => {
            if (!(chunk instanceof Uint8Array)) { throw new TypeError('Import index chunk requires Uint8Array'); }
            return Uint8Array.from(chunk);
        });
        await this.writeOwnedChunks(copies);
    }

    /**
     * The store transfers only fresh complete index chunks produced by its
     * private encoder. Parser views and ordinary caller buffers never enter
     * this method. Its promise settles after the worker stops using the bytes.
     * @param {Uint8Array[]} chunks
     */
    async writeOwnedChunks(chunks) {
        if (!Array.isArray(chunks)) { throw new TypeError('Import index chunks must be an array'); }
        const owned = [...chunks];
        /** @type {Set<ArrayBuffer>} */
        const buffers = new Set();
        let length = 0;
        for (const chunk of owned) {
            if (
                !(chunk instanceof Uint8Array) || !(chunk.buffer instanceof ArrayBuffer) ||
                chunk.byteOffset !== 0 || chunk.byteLength !== chunk.buffer.byteLength ||
                buffers.has(chunk.buffer)
            ) {
                throw new TypeError('Import index transfer requires independently owned complete buffers');
            }
            buffers.add(chunk.buffer);
            length += chunk.byteLength;
            if (!Number.isSafeInteger(length)) { throw new RangeError('Import index chunk length overflow'); }
        }
        await this._enqueue('writeChunks', {chunks: owned}, [...buffers]);
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
        // Messages already admitted above precede this one on the same port.
        // Send abort before joining acknowledgements so the worker can suppress
        // later periodic flushes while its existing queue drains.
        const closing = this._client.request(this._writerId, abort ? 'abort' : 'close');
        void closing.catch(() => {});
        this._closePromise = (async () => {
            await this._queue;
            try {
                await closing;
                if (this._failure !== null) { throw this._failure; }
            } catch (error) {
                const failure = toError(error);
                const previous = this._failure;
                const additionalFailure = previous !== null && previous !== failure && !(failure instanceof AggregateError && failure.errors.includes(previous));
                this._failure = additionalFailure ?
                    new AggregateError([previous, failure], 'Failed to finalize import index writer') :
                    failure;
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
     * @param {string} action
     * @param {Record<string, unknown>} params
     * @param {Transferable[]} [transfer]
     * @returns {Promise<void>}
     */
    _enqueue(action, params, transfer = []) {
        if (this._failure !== null) { return Promise.reject(this._failure); }
        if (this._closing) { return Promise.reject(new Error('Import index writer is closed')); }
        const promise = this._client.request(this._writerId, action, params, transfer)
            .then(() => {}, (error) => {
                this._failure = toError(error);
                throw this._failure;
            });
        // The remote writer orders execution. Track every acknowledgement for
        // local close/abort without retaining transferred bytes until a later
        // local turn, or delaying abort behind the operation it must join.
        void promise.catch(() => {});
        this._queue = this._queue.then(() => promise).catch(() => {});
        return promise;
    }
}
