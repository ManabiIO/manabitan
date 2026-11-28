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

// Owns one optional, disposable training worker. The database scheduler owns
// admission, durable checkpoints, and every interaction with live storage.
/** @typedef {{dictionary: Uint8Array, initializeMs: number, trainMs: number, heapBytes: number}} TrainerResult */
/** @typedef {{id: number, samples: Uint8Array, lengths: Uint8Array, dictionaryCapacity: number, strategy: number, level: number, dictionary?: Uint8Array, initializeMs?: number, trainMs?: number, heapBytes?: number, error?: string, errorKind?: 'invalid-input'|'resource'|'corpus'|'invalid-output'|'unavailable'}} TrainerMessage */
/** @typedef {{id: number, worker: Worker|null, timer: ReturnType<typeof setTimeout>|null, settled: boolean}} TrainerJob */
export class ZstdTrainingUnavailableError extends Error {
    /** @param {string} message @param {unknown} [cause] */
    constructor(message, cause) {
        super(message, {cause});
        this.name = 'ZstdTrainingUnavailableError';
    }
}

export class ZstdTrainingResourceError extends ZstdTrainingUnavailableError {
    /** @param {string} message @param {unknown} [cause] */
    constructor(message, cause) {
        super(message, cause);
        this.name = 'ZstdTrainingResourceError';
    }
}

export class ZstdTrainingCorpusError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ZstdTrainingCorpusError';
    }
}

export class ZstdTrainingOutputError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ZstdTrainingOutputError';
    }
}

let nextJobId = 0;

export class ZstdTrainerWorkerOwner {
    // createWorker must synchronously return a dedicated Worker owned only by this job.
    /** @param {{createWorker?: () => Worker, timeoutMs?: number}} [options] */
    constructor({createWorker = () => new Worker(new URL('./trainer-worker.js', import.meta.url), {type: 'module'}), timeoutMs = 30000} = {}) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
            throw new RangeError('Training timeout must be between 1 and 120000 ms');
        }
        this._createWorker = createWorker;
        this._timeoutMs = timeoutMs;
        this._used = false;
    }

    // Inputs are borrowed. Only exact, privately copied ArrayBuffers are transferred.
    // The returned dictionary is owned by the caller and survives worker termination.
    /**
     * @param {{samples: Uint8Array, lengths: Uint8Array, dictionaryCapacity?: number, strategy?: number, level?: number}} request
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<TrainerResult>}
     */
    train({samples, lengths, dictionaryCapacity = 32768, strategy = 0, level = 3}, {signal} = {}) {
        const promise = new Promise((
            /** @type {(value: TrainerResult) => void} */ resolve,
            /** @type {(reason?: unknown) => void} */ reject,
        ) => {
            if (this._used) {
                reject(new Error('Training worker owner already used'));
                return;
            }
            this._used = true;
            const job = /** @type {TrainerJob} */ ({id: nextJobId++, worker: null, timer: null, settled: false});
            /** @param {Error|null} error @param {TrainerResult} [result] */
            const finish = (error, result) => {
                if (job.settled) { return; }
                job.settled = true;
                if (job.timer !== null) { clearTimeout(job.timer); }
                signal?.removeEventListener('abort', onAbort);
                if (job.worker !== null) {
                    const worker = job.worker;
                    try { worker.removeEventListener('message', onMessage); } catch (e) { /* Continue disposal. */ }
                    try { worker.removeEventListener('error', onError); } catch (e) { /* Continue disposal. */ }
                    try { worker.removeEventListener('messageerror', onMessageError); } catch (e) { /* Continue disposal. */ }
                    try { worker.terminate(); } catch (e) { /* Settlement must still complete. */ }
                    job.worker = null;
                }
                if (error !== null) { reject(error); } else if (typeof result !== 'undefined') { resolve(result); }
            };
            const onAbort = () => {
                const error = new Error('Optional Zstd training aborted');
                error.name = 'AbortError';
                finish(error);
            };
            /** @param {ErrorEvent} event */
            const onError = (event) => {
                event.preventDefault();
                finish(new ZstdTrainingUnavailableError('Optional Zstd training worker failed', event.error));
            };
            /** @param {MessageEvent<TrainerMessage>} event */
            const onMessage = ({data}) => {
                // A queued callback cannot revive a settled job, even after listeners are removed.
                if (job.settled || data?.id !== job.id) { return; }
                if (typeof data.error === 'string') {
                    const error = data.errorKind === 'corpus' ?
new ZstdTrainingCorpusError(data.error) :
                        data.errorKind === 'invalid-output' ?
new ZstdTrainingOutputError(data.error) :
                            data.errorKind === 'resource' ?
new ZstdTrainingResourceError(data.error) :
                                data.errorKind === 'invalid-input' ?
new TypeError(data.error) :
                                    new ZstdTrainingUnavailableError(data.error);
                    finish(error);
                    return;
                }
                const {dictionary, initializeMs, trainMs, heapBytes} = data;
                if (!(dictionary instanceof Uint8Array) || !(dictionary.buffer instanceof ArrayBuffer) ||
                dictionary.byteLength < 8 || dictionary.byteLength > dictionaryCapacity ||
                typeof initializeMs !== 'number' || typeof trainMs !== 'number' || typeof heapBytes !== 'number' ||
                !Number.isFinite(initializeMs) || initializeMs < 0 ||
                !Number.isFinite(trainMs) || trainMs < 0 ||
                !Number.isSafeInteger(heapBytes) || heapBytes < dictionary.byteLength) {
                    finish(new ZstdTrainingUnavailableError('Invalid optional Zstd training response'));
                    return;
                }
                try {
                    const owned = dictionary.byteOffset === 0 && dictionary.byteLength === dictionary.buffer.byteLength ?
                        dictionary :
new Uint8Array(dictionary);
                    finish(null, {dictionary: owned, initializeMs, trainMs, heapBytes});
                } catch (error) {
                    finish(new ZstdTrainingUnavailableError('Optional Zstd training output allocation failed', error));
                }
            };
            const onMessageError = () => { finish(new ZstdTrainingUnavailableError('Optional Zstd training message could not be decoded')); };
            let inputsValidated = false;
            try {
                if (signal?.aborted) { onAbort(); return; }
                signal?.addEventListener('abort', onAbort, {once: true});
                if (signal?.aborted) { onAbort(); return; }
                if (!(samples instanceof Uint8Array) || samples.byteLength === 0 || samples.byteLength > 32 * 1024 * 1024 ||
                !(lengths instanceof Uint8Array) || lengths.byteLength < 32 || lengths.byteLength > 200000 || lengths.byteLength % 4 !== 0 ||
                !Number.isInteger(dictionaryCapacity) || dictionaryCapacity < 1024 || dictionaryCapacity > 112640 ||
                !Number.isInteger(strategy) || strategy < 0 || strategy > 2 ||
                !Number.isInteger(level) || level < -1 || level > 9) {
                    throw new TypeError('Invalid optional Zstd training input');
                }
                const ownedSamples = new Uint8Array(samples);
                const ownedLengths = new Uint8Array(lengths);
                const sizes = new DataView(ownedLengths.buffer);
                let total = 0;
                for (let offset = 0; offset < sizes.byteLength; offset += 4) {
                    const size = sizes.getUint32(offset, true);
                    if (size === 0 || size > 262144) { throw new TypeError('Invalid optional Zstd sample length'); }
                    total += size;
                }
                if (total !== ownedSamples.byteLength) { throw new TypeError('Optional Zstd sample lengths do not cover input'); }
                inputsValidated = true;
                const worker = this._createWorker();
                if (job.settled) {
                    // An injected factory can synchronously cause foreground preemption.
                    try { worker.terminate(); } catch (e) { /* Already settled. */ }
                    return;
                }
                job.worker = worker;
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onError);
                worker.addEventListener('messageerror', onMessageError);
                job.timer = setTimeout(() => {
                    finish(new ZstdTrainingUnavailableError('Optional Zstd training timed out'));
                }, this._timeoutMs);
                // A throw does not imply transfer succeeded; source inputs were never transferred.
                worker.postMessage({id: job.id, samples: ownedSamples, lengths: ownedLengths, dictionaryCapacity, strategy, level}, [ownedSamples.buffer, ownedLengths.buffer]);
            } catch (error) {
                finish(!inputsValidated && error instanceof TypeError ? error : new ZstdTrainingUnavailableError('Optional Zstd training could not start', error));
            }
        });
        // Observe internally too: a caller may wait until foreground work completes to await.
        // Returning the original promise preserves rejection for that caller.
        void promise.catch(() => {});
        return promise;
    }
}
