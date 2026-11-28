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
import {DictionarySourceIntegrityError} from './dictionary-source-integrity-error.js';

/** A speculative text read must bound actual decoder output, not just ZIP metadata. */
export class BoundedZipTextWriter {
    /**
     * @param {string} filename
     * @param {number} expectedSize
     */
    constructor(filename, expectedSize) {
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 64 * 1024) {
            throw new RangeError('Bounded ZIP text size must be at most 64 KiB');
        }
        /** @type {string} */
        this._filename = filename;
        /** @type {Uint8Array} */
        this._bytes = new Uint8Array(expectedSize);
        /** @type {number} */
        this._offset = 0;
        /** @type {DictionarySourceIntegrityError|null} */
        this._failure = null;
        /** @type {WritableStream<Uint8Array>} */
        this.writable = new WritableStream({write: (chunk) => this.writeUint8Array(chunk)});
    }

    /**
     * @param {Uint8Array} chunk
     * @returns {Promise<void>}
     */
    async writeUint8Array(chunk) {
        if (chunk.byteLength > this._bytes.byteLength - this._offset) {
            throw this._fail();
        }
        this._bytes.set(chunk, this._offset);
        this._offset += chunk.byteLength;
    }

    /** @returns {Promise<string>} */
    async getData() {
        if (this._offset !== this._bytes.byteLength) {
            throw this._fail();
        }
        return new TextDecoder().decode(this._bytes);
    }

    /** @returns {DictionarySourceIntegrityError|null} */
    getFailure() {
        return this._failure;
    }

    /** @returns {DictionarySourceIntegrityError} */
    _fail() {
        this._failure ??= new DictionarySourceIntegrityError(`ZIP decoded size mismatch in '${this._filename}'`);
        return this._failure;
    }
}
