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

export class RetryablePromiseCache {
    constructor() {
        /** @type {Promise<unknown>|null} */
        this._promise = null;
    }

    /**
     * @template T
     * @param {() => Promise<T>|T} factory
     * @returns {Promise<T>}
     */
    async get(factory) {
        if (this._promise === null) {
            this._promise = Promise.resolve().then(factory);
        }
        const promise = this._promise;
        try {
            return /** @type {T} */ (await promise);
        } catch (error) {
            if (this._promise === promise) {
                this._promise = null;
            }
            throw error;
        }
    }
}
