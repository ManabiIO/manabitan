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
import {AbortableZipReadPool} from './term-bank-source-pipeline.js';

const CANCELLATION_POLL_MS = 25;

/** Owns direct ZIP reads which have no source-pipeline cancellation owner. */
export class DictionaryZipReadScope {
    /** @param {() => void} checkCancellation */
    constructor(checkCancellation) {
        /** @type {() => void} */
        this._checkCancellation = checkCancellation;
        /** @type {AbortableZipReadPool<unknown, (signal: AbortSignal) => Promise<unknown>>} */
        this._pool = new AbortableZipReadPool((read, signal) => read(signal));
        /** @type {number} */
        this._activeCount = 0;
        /** @type {ReturnType<typeof setInterval>|null} */
        this._timer = null;
        /** @type {boolean} */
        this._cancelled = false;
        /** @type {unknown} */
        this._cancellationError = void 0;
        /** @type {Promise<void>|null} */
        this._cancellationJoin = null;
    }

    /**
     * @template T
     * @param {(signal: AbortSignal) => Promise<T>} read
     * @returns {Promise<T>}
     */
    async read(read) {
        this._poll();
        if (this._cancelled) {
            await this._cancellationJoin;
            throw this._cancellationError;
        }
        ++this._activeCount;
        if (this._timer === null) {
            this._timer = setInterval(() => { this._poll(); }, CANCELLATION_POLL_MS);
        }
        try {
            const result = await this._pool.read(read);
            this._poll();
            if (this._cancelled) { throw this._cancellationError; }
            return /** @type {T} */ (result);
        } catch (error) {
            if (!this._cancelled) { throw error; }
            await this._cancellationJoin;
            throw this._cancellationError;
        } finally {
            this._pool.release(read);
            if (--this._activeCount === 0) { this._stopObserver(); }
        }
    }

    /** Stop admitting reads, abort every pending decoder, and join its cleanup. */
    async dispose() {
        this._stopObserver();
        await this._pool.dispose();
    }

    /** Capture predicate failures, including undefined, without throwing from a timer. */
    _poll() {
        if (this._cancelled) { return; }
        try {
            this._checkCancellation();
        } catch (error) {
            this._cancelled = true;
            this._cancellationError = error;
            this._stopObserver();
            this._cancellationJoin = this._pool.dispose();
            void this._cancellationJoin.catch(() => {});
        }
    }

    /** */
    _stopObserver() {
        if (this._timer === null) { return; }
        clearInterval(this._timer);
        this._timer = null;
    }
}
