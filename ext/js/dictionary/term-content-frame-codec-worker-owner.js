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

/** @typedef {{id: number, action: 'decode'|'compress', bytes: Uint8Array, codecId: string|null, dictionary?: Uint8Array, envelope?: 'mbc2'|'none', expectedDecodedLength?: number, maxOutputSize?: number, wrap?: boolean, level?: number}} TermContentFrameCodecRequest */

export class TermContentFrameCodecError extends Error {
    /**
     * @param {string} message
     * @param {'invalid-input'|'invalid-output'|'unavailable'} kind
     */
    constructor(message, kind = 'unavailable') {
        super(message);
        /**
         *
         */
        this.name = 'TermContentFrameCodecError';
        /** @type {'invalid-input'|'invalid-output'|'unavailable'} */
        this.kind = kind;
    }
}

/**
 * Owns one independent codec context. Foreground cancellation terminates the
 * context synchronously; input bytes remain owned by the caller.
 */
export class TermContentFrameCodecWorkerOwner {
    /**
     * @param {{createWorker?: () => Worker, initializationTimeoutMs?: number, operationTimeoutMs?: number}} [options]
     */
    constructor({
        createWorker = () => new Worker(new URL('term-content-frame-codec-worker.js', import.meta.url), {type: 'module'}),
        initializationTimeoutMs = 30000,
        operationTimeoutMs = 30000,
    } = {}) {
        if (!Number.isSafeInteger(initializationTimeoutMs) || initializationTimeoutMs <= 0 ||
        !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0 || typeof createWorker !== 'function') {
            throw new TypeError('Invalid term-content codec worker owner options');
        }
        /**
         *
         */
        this._createWorker = createWorker;
        /**
         *
         */
        this._initializationTimeoutMs = initializationTimeoutMs;
        /**
         *
         */
        this._operationTimeoutMs = operationTimeoutMs;
        /** @type {Worker|null} */
        this._worker = null;
        /** @type {Promise<Worker>|null} */
        this._readyPromise = null;
        /** @type {((error: Error) => void)|null} */
        this._readyReject = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._initializationTimer = null;
        /** @type {number} */
        this._nextId = 1;
        /** @type {{id: number, resolve: (bytes: Uint8Array) => void, reject: (error: Error) => void, signal: AbortSignal|null, onAbort: (() => void)|null, timeout: ReturnType<typeof setTimeout>|null}|null} */
        this._active = null;
        /**
         *
         */
        this._closed = false;
        /** @type {((event: MessageEvent) => void)|null} */
        this._onMessage = null;
        /** @type {((event: ErrorEvent) => void)|null} */
        this._onError = null;
        /** @type {((event: MessageEvent) => void)|null} */
        this._onMessageError = null;
    }

    /**
     * @param {TermContentFrameCodecRequest} request
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<Uint8Array>}
     */
    async run(request, {signal} = {}) {
        this._validateRequest(request);
        if (this._closed) { throw new Error('Term-content codec worker owner is closed'); }
        if (signal?.aborted) { throw createAbortError(); }
        if (this._active !== null) { throw new Error('Term-content codec worker already has an active operation'); }
        const id = this._nextId++;
        const ownedBytes = new Uint8Array(request.bytes.byteLength);
        ownedBytes.set(request.bytes);
        /** @type {TermContentFrameCodecRequest} */
        const message = {...request, id, bytes: ownedBytes};
        /** @type {ArrayBuffer[]} */
        const transfer = [ownedBytes.buffer];
        if (request.dictionary instanceof Uint8Array) {
            message.dictionary = new Uint8Array(request.dictionary.byteLength);
            message.dictionary.set(request.dictionary);
            transfer.push(message.dictionary.buffer);
        }
        return await new Promise((resolve, reject) => {
            /** @type {{id: number, resolve: (bytes: Uint8Array) => void, reject: (error: Error) => void, signal: AbortSignal|null, onAbort: (() => void)|null, timeout: ReturnType<typeof setTimeout>|null}} */
            const active = {
                id,
                resolve,
                reject,
                signal: signal ?? null,
                onAbort: null,
                timeout: setTimeout(() => this._terminate(new TermContentFrameCodecError('Term-content codec operation timed out')), this._operationTimeoutMs),
            };
            const onAbort = signal ?
                () => {
                    if (this._active === active) { this._terminate(createAbortError()); }
                } :
                null;
            active.onAbort = onAbort;
            // Reserve synchronously before worker initialization, so concurrent
            // cold-start callers cannot both pass the one-operation gate.
            this._active = active;
            if (signal && onAbort) {
                signal.addEventListener('abort', onAbort, {once: true});
                if (signal.aborted) {
                    onAbort();
                    return;
                }
            }
            void this._ensureWorker(signal ?? null).then((worker) => {
                if (this._active !== active) { return; }
                if (this._closed) {
                    this._terminate(new Error('Term-content codec worker owner is closed'));
                    return;
                }
                if (signal?.aborted) {
                    this._terminate(createAbortError());
                    return;
                }
                try {
                    worker.postMessage(message, transfer);
                } catch {
                    this._terminate(new TermContentFrameCodecError('Term-content codec request could not be posted'));
                }
            }).catch((error) => {
                if (this._active !== active) { return; }
                this._terminate(error instanceof Error ? error : new Error('Term-content codec worker could not start'));
            });
        });
    }

    /** Terminates active codec work and releases the worker's WASM context. */
    close() {
        if (this._closed) { return; }
        this._closed = true;
        this._terminate(new Error('Term-content codec worker owner was closed'));
    }

    /**
     * @param {TermContentFrameCodecRequest} request
     * @throws {TypeError} If the request is outside supported bounds.
     */
    _validateRequest(request) {
        if (!request || typeof request !== 'object' ||
        (request.action !== 'decode' && request.action !== 'compress') ||
        !(request.bytes instanceof Uint8Array) || request.bytes.byteLength === 0 || request.bytes.byteLength > 16 * 1024 * 1024 ||
        (request.codecId !== null && (typeof request.codecId !== 'string' || request.codecId.length === 0 || request.codecId.length > 128))) {
            throw new TypeError('Invalid term-content codec request');
        }
        if (request.codecId !== null && (!(request.dictionary instanceof Uint8Array) || request.dictionary.byteLength === 0 || request.dictionary.byteLength > 128 * 1024)) {
            throw new TypeError('Custom term-content codec request requires a bounded dictionary');
        }
        if (request.codecId === null && typeof request.dictionary !== 'undefined') {
            throw new TypeError('Vanilla term-content codec request cannot include a dictionary');
        }
        if (request.action === 'decode' &&
        ((request.envelope !== 'mbc2' && request.envelope !== 'none') ||
        typeof request.expectedDecodedLength !== 'number' || !Number.isSafeInteger(request.expectedDecodedLength) || request.expectedDecodedLength <= 0 || request.expectedDecodedLength > 128 * 1024 * 1024 ||
        typeof request.maxOutputSize !== 'number' || !Number.isSafeInteger(request.maxOutputSize) || request.maxOutputSize < request.expectedDecodedLength || request.maxOutputSize > 128 * 1024 * 1024)) {
            throw new TypeError('Invalid term-content frame decode bounds');
        }
        if (request.action === 'compress' && typeof request.wrap !== 'boolean') {
            throw new TypeError('Invalid term-content frame compression request');
        }
    }

    /**
     * @param {AbortSignal|null} signal
     * @returns {Promise<Worker>}
     */
    _ensureWorker(signal) {
        if (this._readyPromise !== null) { return this._readyPromise; }
        if (this._closed || signal?.aborted) { return Promise.reject(createAbortError()); }
        let worker;
        try {
            worker = this._createWorker();
        } catch (error) {
            return Promise.reject(new TermContentFrameCodecError('Term-content codec worker could not start'));
        }
        this._worker = worker;
        /** @type {(worker: Worker) => void} */
        let resolveReady = () => {};
        /** @type {(error: Error) => void} */
        let rejectReady = () => {};
        /** @type {Promise<Worker>} */
        const readyPromise = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        this._readyPromise = readyPromise;
        this._readyReject = rejectReady;
        this._initializationTimer = setTimeout(
            () => this._terminate(new TermContentFrameCodecError('Term-content codec worker initialization timed out')),
            this._initializationTimeoutMs,
        );
        this._onMessage = (event) => {
            const eventData = /** @type {unknown} */ (event.data);
            const data = /** @type {{type?: unknown, id?: unknown, bytes?: unknown, error?: unknown, errorKind?: unknown}} */ (eventData);
            if (data?.type === 'ready') {
                if (this._initializationTimer !== null) { clearTimeout(this._initializationTimer); }
                this._initializationTimer = null;
                this._readyReject = null;
                resolveReady(worker);
                return;
            }
            if (data?.type === 'initialization-error') {
                if (this._initializationTimer !== null) { clearTimeout(this._initializationTimer); }
                this._initializationTimer = null;
                this._terminate(new TermContentFrameCodecError(typeof data.error === 'string' ? data.error : 'Term-content codec initialization failed'));
                return;
            }
            const active = this._active;
            if (active === null || data?.id !== active.id) { return; }
            this._settleActive(active, data);
        };
        this._onError = () => {
            this._terminate(new TermContentFrameCodecError('Term-content codec worker crashed'));
        };
        this._onMessageError = () => {
            this._terminate(new TermContentFrameCodecError('Term-content codec worker response could not be decoded'));
        };
        worker.addEventListener('message', this._onMessage);
        worker.addEventListener('error', this._onError);
        worker.addEventListener('messageerror', this._onMessageError);
        if (signal !== null) {
            const cancel = () => this._terminate(createAbortError());
            signal.addEventListener('abort', cancel, {once: true});
            void readyPromise.finally(() => signal.removeEventListener('abort', cancel)).catch(() => {});
            if (signal.aborted) { cancel(); }
        }
        return readyPromise;
    }

    /**
     * @param {{id: number, resolve: (bytes: Uint8Array) => void, reject: (error: Error) => void, signal: AbortSignal|null, onAbort: (() => void)|null, timeout: ReturnType<typeof setTimeout>|null}} active
     * @param {{bytes?: unknown, error?: unknown, errorKind?: unknown}} data
     */
    _settleActive(active, data) {
        if (this._active !== active) { return; }
        this._active = null;
        if (this._initializationTimer !== null) { clearTimeout(this._initializationTimer); }
        this._initializationTimer = null;
        if (active.timeout !== null) { clearTimeout(active.timeout); }
        if (active.signal && active.onAbort) { active.signal.removeEventListener('abort', active.onAbort); }
        if (typeof data.error === 'string') {
            const kind = data.errorKind === 'invalid-input' || data.errorKind === 'invalid-output' ? data.errorKind : 'unavailable';
            active.reject(new TermContentFrameCodecError(data.error, kind));
            return;
        }
        if (!(data.bytes instanceof ArrayBuffer)) {
            active.reject(new TermContentFrameCodecError('Term-content codec worker returned invalid bytes', 'invalid-output'));
            return;
        }
        active.resolve(new Uint8Array(data.bytes));
    }

    /** @param {Error} error */
    _terminate(error) {
        const active = this._active;
        this._active = null;
        if (this._initializationTimer !== null) { clearTimeout(this._initializationTimer); }
        this._initializationTimer = null;
        if (active !== null) {
            if (active.timeout !== null) { clearTimeout(active.timeout); }
            if (active.signal && active.onAbort) { active.signal.removeEventListener('abort', active.onAbort); }
            active.reject(error);
        }
        if (this._readyReject !== null) {
            const reject = this._readyReject;
            this._readyReject = null;
            reject(error);
        }
        const worker = this._worker;
        this._worker = null;
        this._readyPromise = null;
        if (worker !== null) {
            if (this._onMessage) { worker.removeEventListener('message', this._onMessage); }
            if (this._onError) { worker.removeEventListener('error', this._onError); }
            if (this._onMessageError) { worker.removeEventListener('messageerror', this._onMessageError); }
            this._onMessage = null;
            this._onError = null;
            this._onMessageError = null;
            try { worker.terminate(); } catch (_) { /* Termination must not strand the pending operation. */ }
        }
    }
}

/** @returns {Error} */
function createAbortError() {
    const error = new Error('Term-content codec work was preempted');
    error.name = 'AbortError';
    return error;
}
