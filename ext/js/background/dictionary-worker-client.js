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
const MAX_RETIRED_RESPONSE_IDS = 256;

/**
 * Serialization failures occur before a request is delivered. They are local
 * to that request and do not indicate that the shared worker is unhealthy.
 * @param {unknown} error
 * @returns {boolean}
 */
function isDataCloneError(error) {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'DataCloneError';
}

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
        /** @type {Map<number, {action: string, deadline: number|null, interruptsOnTimeout: boolean, resolve: (value: unknown) => void, reject: (reason?: unknown) => void}>} */
        this._responseHandlers = new Map();
        /** @type {Set<number>} */
        this._oneWayRequestIds = new Set();
        /** @type {Set<number>} */
        this._retiredResponseIds = new Set();
        /** @type {number} */
        this._retiredResponseIdFloor = 0;
        /** @type {number} */
        this._workerRequestIdStart = 1;
        /** @type {number} */
        this._requestId = 0;
        /** @type {number} */
        this._generation = 0;
        /** @type {DictionaryWorkerTransportError|null} */
        this._fatalError = null;
        this._createWorker();
    }

    /**
     * @returns {void}
     * @throws {unknown} If worker construction or listener setup fails.
     */
    _createWorker() {
        const worker = new Worker(this._workerPath, {type: 'module'});
        try {
            /** @type {(event: MessageEvent<{id?: number, result?: unknown, error?: import('core').SerializedError}>) => void} */
            const onMessage = (event) => { this._onMessage(worker, event); };
            worker.addEventListener('message', onMessage);
            worker.addEventListener('messageerror', (event) => { this._onMessageError(worker, event); });
            worker.addEventListener('error', (event) => { this._onError(worker, event); });
        } catch (error) {
            try { worker.terminate(); } catch (_) { /* Preserve the setup failure. */ }
            throw error;
        }
        // Publish only a fully configured owner. Failed recreation must leave
        // the prior fatal state intact so the next independent request retries.
        this._worker = worker;
        this._fatalError = null;
        this._retiredResponseIds.clear();
        this._retiredResponseIdFloor = 0;
        this._workerRequestIdStart = this._requestId + 1;
        ++this._generation;
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
        const timeoutMs = timeoutByClass[policy.timeoutClass];
        const deadline = timeoutMs === null ? null : globalThis.performance.now() + timeoutMs;
        for (let attempt = 0; attempt < attemptCount; ++attempt) {
            const attemptTimeoutMs = deadline === null ? null : Math.max(0, deadline - globalThis.performance.now());
            if (attemptTimeoutMs === 0) {
                throw new DictionaryWorkerTransportError(`Timed out waiting for ${this._context} response to ${action} after ${String(timeoutMs)}ms`);
            }
            try {
                return await this._invokeOnce(action, params, transferables, attemptTimeoutMs);
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
     * @param {number|null} timeoutMs
     * @returns {Promise<TReturn>}
     */
    async _invokeOnce(action, params, transferables, timeoutMs) {
        const worker = this._getWorkerForRequest();
        const id = ++this._requestId;
        return await new Promise((resolve, reject) => {
            /** @type {ReturnType<typeof globalThis.setTimeout>|null} */
            let timeoutId = null;
            this._responseHandlers.set(id, {
                action,
                deadline: timeoutMs === null ? null : globalThis.performance.now() + timeoutMs,
                interruptsOnTimeout: action === 'cancelDictionaryImportOffscreen' && params.lookupOnly !== true,
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
                    this._onRequestTimeout(id, action, timeoutMs, worker);
                }, timeoutMs);
            }
            try {
                worker.postMessage({id, action, params}, transferables);
            } catch (error) {
                this._responseHandlers.delete(id);
                if (this._requestId === id) { --this._requestId; }
                if (timeoutId !== null) {
                    globalThis.clearTimeout(timeoutId);
                }
                const transportError = new DictionaryWorkerTransportError(
                    `${this._context} failed to send ${action}`,
                    {cause: error, retryable: false},
                );
                if (!isDataCloneError(error)) {
                    this._setFatalError(transportError, worker);
                }
                reject(transportError);
            }
        });
    }

    /**
     * A short deadline must not terminate a worker that still owns a
     * longer-lived operation. Retire just the timed-out request and ignore its
     * eventual response; tracking stays bounded if many reads time out.
     * @param {number} id
     * @param {string} action
     * @param {number} timeoutMs
     * @param {Worker} worker
     */
    _onRequestTimeout(id, action, timeoutMs, worker) {
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') { return; }
        const error = new DictionaryWorkerTransportError(
            `Timed out waiting for ${this._context} response to ${action} after ${String(timeoutMs)}ms`,
        );
        if (handler.interruptsOnTimeout) {
            this._setFatalError(error, worker);
            return;
        }
        const currentTimeout = timeoutByClass[getDictionaryRuntimeActionPolicy(action).timeoutClass];
        const hasLongerOwner = [...this._responseHandlers].some(([otherId, other]) => {
            if (otherId === id) { return false; }
            const otherTimeout = timeoutByClass[getDictionaryRuntimeActionPolicy(other.action).timeoutClass];
            const longerLivedAction = otherTimeout === null || (
                currentTimeout !== null && otherTimeout > currentTimeout
            );
            return longerLivedAction && (other.deadline === null || (
                other.deadline > (handler.deadline ?? -Infinity) &&
                other.deadline > globalThis.performance.now()
            ));
        });
        if (!hasLongerOwner) {
            this._setFatalError(error, worker);
            return;
        }

        this._responseHandlers.delete(id);
        this._retireResponseId(id);
        handler.reject(error);
        reportDiagnostics('dictionary-worker-request-timeout-isolated', {
            context: this._context,
            action,
            generation: this._generation,
            timeoutMs,
        });
    }

    /** @param {number} id */
    _retireResponseId(id) {
        this._retiredResponseIds.add(id);
        while (this._retiredResponseIds.size > MAX_RETIRED_RESPONSE_IDS) {
            const oldest = this._retiredResponseIds.values().next().value;
            if (typeof oldest !== 'number') { break; }
            this._retiredResponseIds.delete(oldest);
            this._retiredResponseIdFloor = Math.max(this._retiredResponseIdFloor, oldest);
        }
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
            if (this._requestId === id) { --this._requestId; }
            const transportError = new DictionaryWorkerTransportError(
                `${this._context} failed to send ${action}`,
                {cause: error, retryable: false},
            );
            if (!isDataCloneError(error)) {
                this._setFatalError(transportError, worker);
            }
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
        const id = event.data?.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id < this._workerRequestIdStart || id > this._requestId) {
            this._setFatalError(new DictionaryWorkerTransportError(`${this._context} returned a response without a request id`), worker);
            return;
        }
        if (this._oneWayRequestIds.delete(id)) { return; }
        const handler = this._responseHandlers.get(id);
        if (typeof handler === 'undefined') {
            if (id <= this._retiredResponseIdFloor || this._retiredResponseIds.delete(id)) {
                reportDiagnostics('dictionary-worker-late-response', {
                    context: this._context,
                    generation: this._generation,
                    id,
                });
                return;
            }
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
