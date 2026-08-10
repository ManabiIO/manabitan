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

import {ExtensionError} from '../core/extension-error.js';
import {reportDiagnostics} from '../core/diagnostics-reporter.js';
import {getDictionaryRuntimeActionPolicy} from './dictionary-runtime-action-policy.js';

const timeoutByClass = Object.freeze({
    'interactive': 30_000,
    'standard': 30_000,
    'maintenance': 300_000,
    'streamed-import': null,
});

export class DictionaryWorkerTransportError extends Error {
    /**
     * @param {string} message
     * @param {{cause?: unknown, retryable?: boolean}} [options]
     */
    constructor(message, options) {
        super(message, options);
        /** @type {string} */
        this.name = 'DictionaryWorkerTransportError';
        /** @type {boolean} */
        this.retryable = options?.retryable ?? true;
    }
}

export class DictionaryWorkerClient {
    /**
     * @param {string} workerPath
     * @param {{context?: string, onFatalError?: ((error: Error) => void)|null}} [options]
     */
    constructor(workerPath, options = {}) {
        /** @type {string} */
        this._workerPath = workerPath;
        /** @type {string} */
        this._context = options.context ?? 'Dictionary worker';
        /** @type {((error: Error) => void)|null} */
        this._onFatalError = options.onFatalError ?? null;
        /** @type {Worker} */
        this._worker = /** @type {Worker} */ (/** @type {unknown} */ (null));
        /** @type {Map<number, {action: string, resolve: (value: unknown) => void, reject: (reason?: unknown) => void}>} */
        this._responseHandlers = new Map();
        /** @type {Set<number>} */
        this._oneWayRequestIds = new Set();
        /** @type {number} */
        this._requestId = 0;
        /** @type {number} */
        this._generation = 0;
        /** @type {DictionaryWorkerTransportError|null} */
        this._fatalError = null;
        this._createWorker();
    }

    /** @returns {void} */
    _createWorker() {
        const worker = new Worker(this._workerPath, {type: 'module'});
        this._worker = worker;
        this._fatalError = null;
        ++this._generation;
        /** @type {(event: MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>) => void} */
        const onMessage = (event) => { this._onMessage(worker, event); };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('messageerror', (event) => { this._onMessageError(worker, event); });
        worker.addEventListener('error', (event) => { this._onError(worker, event); });
    }

    /**
     * @returns {Worker}
     * @throws {DictionaryWorkerTransportError} If a failed worker cannot be restarted.
     */
    _getWorkerForRequest() {
        if (this._fatalError !== null) {
            try {
                this._createWorker();
            } catch (error) {
                throw new DictionaryWorkerTransportError(
                    `${this._context} could not be restarted`,
                    {cause: error, retryable: false},
                );
            }
        }
        return this._worker;
    }

    /**
     * @template [TReturn=unknown]
     * @param {string} action
     * @param {import('core').SerializableObject} [params]
     * @param {Transferable[]} [transferables]
     * @returns {Promise<TReturn>}
     */
    async invoke(action, params = {}, transferables = []) {
        const policy = getDictionaryRuntimeActionPolicy(action);
        const attemptCount = policy.retryable && transferables.length === 0 ? 2 : 1;
        for (let attempt = 0; attempt < attemptCount; ++attempt) {
            try {
                return await this._invokeOnce(action, params, transferables);
            } catch (error) {
                if (!(error instanceof DictionaryWorkerTransportError) || !error.retryable || attempt + 1 >= attemptCount) {
                    throw error;
                }
                reportDiagnostics('dictionary-worker-request-retry', {
                    context: this._context,
                    action,
                    attempt: attempt + 2,
                    reason: error.message,
                });
            }
        }
        throw new Error('Dictionary worker retry loop exited unexpectedly');
    }

    /**
     * @template [TReturn=unknown]
     * @param {string} action
     * @param {import('core').SerializableObject} params
     * @param {Transferable[]} transferables
     * @returns {Promise<TReturn>}
     */
    async _invokeOnce(action, params, transferables) {
        const worker = this._getWorkerForRequest();
        const id = ++this._requestId;
        const timeoutMs = timeoutByClass[getDictionaryRuntimeActionPolicy(action).timeoutClass];
        return await new Promise((resolve, reject) => {
            /** @type {ReturnType<typeof globalThis.setTimeout>|null} */
            let timeoutId = null;
            this._responseHandlers.set(id, {
                action,
                resolve: (value) => {
                    if (timeoutId !== null) { globalThis.clearTimeout(timeoutId); }
                    resolve(/** @type {TReturn} */ (value));
                },
                reject: (reason) => {
                    if (timeoutId !== null) { globalThis.clearTimeout(timeoutId); }
                    reject(reason);
                },
            });
            if (timeoutMs !== null) {
                timeoutId = globalThis.setTimeout(() => {
                    if (!this._responseHandlers.has(id)) { return; }
                    this._setFatalError(
                        new DictionaryWorkerTransportError(
                            `Timed out waiting for ${this._context} response to ${action} after ${String(timeoutMs)}ms`,
                        ),
                        worker,
                    );
                }, timeoutMs);
            }
            try {
                worker.postMessage({id, action, params}, transferables);
            } catch (error) {
                this._responseHandlers.delete(id);
                if (timeoutId !== null) {
                    globalThis.clearTimeout(timeoutId);
                }
                const transportError = new DictionaryWorkerTransportError(
                    `${this._context} failed to send ${action}`,
                    {cause: error, retryable: false},
                );
                this._setFatalError(transportError, worker);
                reject(transportError);
            }
        });
    }

    /**
     * Sends a request whose completion is reported through a transferred port.
     * @param {string} action
     * @param {import('core').SerializableObject} [params]
     * @param {Transferable[]} [transferables]
     * @returns {void}
     * @throws {DictionaryWorkerTransportError} If the request cannot be sent.
     */
    post(action, params = {}, transferables = []) {
        const worker = this._getWorkerForRequest();
        const id = ++this._requestId;
        this._oneWayRequestIds.add(id);
        try {
            worker.postMessage({id, action, params}, transferables);
        } catch (error) {
            this._oneWayRequestIds.delete(id);
            const transportError = new DictionaryWorkerTransportError(
                `${this._context} failed to send ${action}`,
                {cause: error, retryable: false},
            );
            this._setFatalError(transportError, worker);
            throw transportError;
        }
    }

    /**
     * @param {DictionaryWorkerTransportError} error
     * @param {Worker} [worker]
     * @returns {void}
     */
    _setFatalError(error, worker = this._worker) {
        if (worker !== this._worker || this._fatalError !== null) {
            return;
        }
        this._fatalError = error;
        for (const [, handler] of this._responseHandlers) {
            handler.reject(error);
        }
        this._responseHandlers.clear();
        this._oneWayRequestIds.clear();
        try {
            worker.terminate();
        } catch (_) {
            // Ignore termination failures after a fatal worker error.
        }
        reportDiagnostics('dictionary-worker-client-fatal', {
            context: this._context,
            generation: this._generation,
            message: error.message,
        });
        try {
            this._onFatalError?.(error);
        } catch (callbackError) {
            reportDiagnostics('dictionary-worker-fatal-callback-failed', {
                context: this._context,
                message: callbackError instanceof Error ? callbackError.message : String(callbackError),
            });
        }
    }

    /**
     * @param {Worker} worker
     * @param {MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>} event
     * @returns {void}
     */
    _onMessage(worker, event) {
        if (worker !== this._worker || this._fatalError !== null) { return; }
        const id = typeof event.data?.id === 'number' ? event.data.id : null;
        if (id === null) {
            this._setFatalError(new DictionaryWorkerTransportError(`${this._context} returned a response without a request id`), worker);
            return;
        }
        if (this._oneWayRequestIds.delete(id)) { return; }
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') {
            reportDiagnostics('dictionary-worker-unmatched-response', {
                context: this._context,
                reason: 'unknown-id',
                id,
                hasError: typeof event.data?.error !== 'undefined',
            });
            this._setFatalError(new DictionaryWorkerTransportError(`${this._context} returned an unknown request id: ${String(id)}`), worker);
            return;
        }
        this._responseHandlers.delete(id);
        if (typeof event.data?.error !== 'undefined') {
            try {
                handler.reject(ExtensionError.deserialize(event.data.error));
            } catch (error) {
                const transportError = new DictionaryWorkerTransportError(
                    `${this._context} returned an invalid error response for ${handler.action}`,
                    {cause: error},
                );
                handler.reject(transportError);
                this._setFatalError(transportError, worker);
            }
            return;
        }
        handler.resolve(event.data?.result);
    }

    /**
     * @param {Worker} worker
     * @param {MessageEvent} _event
     * @returns {void}
     */
    _onMessageError(worker, _event) {
        this._setFatalError(new DictionaryWorkerTransportError(`${this._context} message deserialization failed`), worker);
    }

    /**
     * @param {Worker} worker
     * @param {ErrorEvent} event
     * @returns {void}
     */
    _onError(worker, event) {
        const message = event.message ? `: ${event.message}` : '';
        this._setFatalError(new DictionaryWorkerTransportError(`${this._context} failed${message}`), worker);
    }
}
