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

const COPY_TIMEOUT_MS = 300_000;
const CANCELLATION_POLL_MS = 25;

/**
 * @typedef {(source: Uint8Array, start: number, end: number) => Promise<Uint8Array>|null} BorrowedContentRangeCopy
 */

/**
 * A parser result keeps its worker idle until both its sink and any requested
 * source copy have settled. Only the original shared source can use this RPC.
 * @param {Worker} worker
 * @param {number} id
 * @param {Uint8Array} source
 * @param {() => boolean} shouldCancel
 * @param {(error: Error) => void} onFailure
 * @returns {{consumed: Promise<void>, release: () => void, copyRange: BorrowedContentRangeCopy}}
 */
export function createTermBankSourceLease(worker, id, source, shouldCancel, onFailure) {
    let releaseRequested = false;
    let copying = false;
    let nextRequestId = 0;
    /** @type {() => void} */
    let resolveConsumed = () => {};
    /** @type {Promise<void>} */
    const consumed = new Promise((resolve) => { resolveConsumed = resolve; });
    const release = () => {
        releaseRequested = true;
        if (!copying) { resolveConsumed(); }
    };
    /** @type {BorrowedContentRangeCopy} */
    const copyRange = (input, start, end) => {
        if (
            releaseRequested || copying ||
            typeof SharedArrayBuffer !== 'function' || !(source.buffer instanceof SharedArrayBuffer) ||
            input.buffer !== source.buffer || input.byteOffset < source.byteOffset ||
            input.byteLength > source.byteLength - (input.byteOffset - source.byteOffset)
        ) {
            return null;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > input.byteLength) {
            throw new RangeError('Invalid parser content copy range');
        }
        const offset = input.byteOffset - source.byteOffset + start;
        const length = end - start;
        const requestId = ++nextRequestId;
        copying = true;
        /** @type {Promise<Uint8Array>} */
        const copy = new Promise((resolve, reject) => {
            let settled = false;
            /**
             * @param {Error|null} error
             * @param {Uint8Array|null} [bytes]
             */
            const finish = (error, bytes = /** @type {Uint8Array|null} */ (null)) => {
                if (settled) { return; }
                settled = true;
                const errors = error === null ? [] : [error];
                for (const cleanup of [
                    () => { clearTimeout(timeoutId); },
                    () => { clearInterval(cancellationId); },
                    () => { worker.removeEventListener('message', onMessage); },
                    () => { worker.removeEventListener('error', onError); },
                    () => { worker.removeEventListener('messageerror', onMessageError); },
                ]) {
                    try { cleanup(); } catch (cleanupError) {
                        errors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
                    }
                }
                copying = false;
                if (errors.length === 0) {
                    resolve(/** @type {Uint8Array} */ (bytes));
                } else {
                    try { worker.terminate(); } catch (terminationError) {
                        errors.push(terminationError instanceof Error ? terminationError : new Error(String(terminationError)));
                    }
                    let failure = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Parser content copy cleanup failed');
                    try { onFailure(failure); } catch (notificationError) {
                        failure = new AggregateError([failure, notificationError], 'Parser content copy failure notification failed');
                    }
                    reject(failure);
                }
                if (releaseRequested) { resolveConsumed(); }
            };
            /** @param {MessageEvent<unknown>} event */
            const onMessage = (event) => {
                const data = /** @type {{type?: unknown, id?: unknown, requestId?: unknown, bytes?: unknown, error?: unknown}|null} */ (event.data);
                if (data?.type !== 'content-copy-result' || data.id !== id || data.requestId !== requestId) { return; }
                if (typeof data.error !== 'undefined') {
                    finish(new Error(typeof data.error === 'string' ? `Parser content copy failed: ${data.error}` : 'Parser content copy failed'));
                } else if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength !== length) {
                    finish(new Error('Parser content copy returned invalid owned bytes'));
                } else {
                    finish(null, new Uint8Array(data.bytes));
                }
            };
            /** @param {ErrorEvent} event */
            const onError = (event) => { finish(new Error(event.message || 'Parser content copy worker failed')); };
            const onMessageError = () => { finish(new Error('Parser content copy returned an invalid message')); };
            const timeoutId = setTimeout(() => { finish(new Error('Parser content copy timed out')); }, COPY_TIMEOUT_MS);
            const cancellationId = setInterval(() => {
                try {
                    if (!shouldCancel()) { return; }
                    const error = new Error('Term-bank parser cancelled');
                    error.name = 'AbortError';
                    finish(error);
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            }, CANCELLATION_POLL_MS);
            try {
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onError);
                worker.addEventListener('messageerror', onMessageError);
                worker.postMessage({type: 'copy-content-range', id, requestId, offset, length});
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        void copy.catch(() => {});
        return copy;
    };
    return {consumed, release, copyRange};
}

/**
 * Copies the exact admitted range on the parser owner, using the same owned
 * typed-array slice as the synchronous cache path.
 * @param {Uint8Array|null} source
 * @param {unknown} offset
 * @param {unknown} length
 * @returns {Uint8Array}
 * @throws {RangeError} If the leased source or requested range is invalid.
 */
export function copyTermBankSourceRange(source, offset, length) {
    if (
        source === null || typeof offset !== 'number' || typeof length !== 'number' ||
        !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset > source.byteLength || length > source.byteLength - offset
    ) {
        throw new RangeError('Invalid leased parser content copy range');
    }
    return source.slice(offset, offset + length);
}
