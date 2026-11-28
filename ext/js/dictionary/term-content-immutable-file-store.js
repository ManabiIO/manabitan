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

const DIRECTORY_NAME = 'manabitan-online-content-v1';
// Large raw-v4 monolithic frames are streamed as files. Quota admission is
// owned by the durable scheduler; the file layer still bounds each I/O chunk.
const MAX_FILE_BYTES = 2 ** 40;
const MAX_IO_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Small-range reader and streaming writer for optimizer-owned immutable OPFS
 * files. SQLite intents must be committed before write() is called; active
 * roots may reference only files whose writer completed and whose size was
 * observed after close.
 */
export class TermContentImmutableFileStore {
    /**
     * @param {string} [directoryName]
     * @param {(bytes: number, signal?: AbortSignal) => Promise<void>} [beforeWrite]
     */
    constructor(directoryName = DIRECTORY_NAME, beforeWrite) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(directoryName)) { throw new TypeError('Invalid optimizer OPFS directory'); }
        /**
         *
         */
        this._directoryName = directoryName;
        /**
         *
         */
        this._beforeWrite = beforeWrite;
    }

    /**
     * Observes one reserved artifact without creating its directory or file.
     * A missing name is distinct from transient OPFS access failures.
     * @param {string} fileId
     * @returns {Promise<number|null>}
     */
    async observe(fileId) {
        this._getFileName(fileId);
        let handle;
        try {
            handle = await this._getFileHandle(fileId, false);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotFoundError') { return null; }
            throw error;
        }
        const file = await handle.getFile();
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
            throw new RangeError('Immutable OPFS observation exceeds its byte bound');
        }
        return file.size;
    }

    /**
     * Writes one reserved file without assembling it in memory.
     * @param {string} fileId
     * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} chunks
     * @param {{expectedByteLength: number, signal?: AbortSignal}} options
     * @returns {Promise<number>}
     */
    async write(fileId, chunks, {expectedByteLength, signal}) {
        this._getFileName(fileId);
        if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0 || expectedByteLength > MAX_FILE_BYTES) {
            throw new RangeError('Immutable OPFS file exceeds its bounded write size');
        }
        await this._beforeWrite?.(expectedByteLength, signal);
        signal?.throwIfAborted();
        const handle = await this._getFileHandle(fileId, true);
        const file = await handle.getFile();
        signal?.throwIfAborted();
        if (file.size > 0) { throw new Error('Reserved immutable OPFS file already contains bytes'); }
        const writable = await handle.createWritable({keepExistingData: false});
        let written = 0;
        try {
            signal?.throwIfAborted();
            for await (const chunk of chunks) {
                signal?.throwIfAborted();
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > MAX_IO_CHUNK_BYTES ||
                written > expectedByteLength - chunk.byteLength) {
                    throw new TypeError('Immutable OPFS writer received an invalid or oversized chunk');
                }
                await writable.write(chunk);
                written += chunk.byteLength;
            }
            if (written !== expectedByteLength) { throw new Error('Immutable OPFS write ended at the wrong byte length'); }
            signal?.throwIfAborted();
            await writable.close();
        } catch (error) {
            try { await writable.abort(); } catch (_) { /* The durable intent owns any partial file for recovery. */ }
            throw error;
        }
        const observed = await handle.getFile();
        if (observed.size !== written) { throw new Error('Immutable OPFS file length changed after close'); }
        return observed.size;
    }

    /**
     * Reads a bounded byte range and checks it against the durable observation.
     * @param {string} fileId
     * @param {number} expectedFileLength
     * @param {number} offset
     * @param {number} length
     * @returns {Promise<Uint8Array>}
     */
    async readSlice(fileId, expectedFileLength, offset, length) {
        if (!Number.isSafeInteger(expectedFileLength) || expectedFileLength < 0 || expectedFileLength > MAX_FILE_BYTES ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > MAX_IO_CHUNK_BYTES || offset > expectedFileLength - length) {
            throw new RangeError('Immutable OPFS read range is outside its observed file');
        }
        const handle = await this._getFileHandle(fileId, false);
        const file = await handle.getFile();
        if (file.size !== expectedFileLength) { throw new Error('Immutable OPFS file identity or observed length changed'); }
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        if (bytes.byteLength !== length) { throw new Error('Immutable OPFS file read returned a short range'); }
        return bytes;
    }

    /**
     * Streams a file through bounded chunks without a whole-file allocation.
     * @param {string} fileId
     * @param {number} expectedFileLength
     * @param {number} [chunkBytes]
     * @yields {Uint8Array} An owned bounded file slice.
     */
    async *readChunks(fileId, expectedFileLength, chunkBytes = MAX_IO_CHUNK_BYTES) {
        if (!Number.isSafeInteger(expectedFileLength) || expectedFileLength <= 0 || expectedFileLength > MAX_FILE_BYTES ||
        !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_IO_CHUNK_BYTES) {
            throw new RangeError('Immutable OPFS stream chunk size is outside its bound');
        }
        for (let offset = 0; offset < expectedFileLength; offset += chunkBytes) {
            const length = Math.min(chunkBytes, expectedFileLength - offset);
            yield await this.readSlice(fileId, expectedFileLength, offset, length);
        }
    }

    /**
     * @param {string} fileId Removes only one deterministically named optimizer-owned file.
     */
    async remove(fileId) {
        const directory = await this._getDirectory(false);
        await directory.removeEntry(this._getFileName(fileId));
    }

    /**
     * @param {string} fileId
     * @param {boolean} create
     * @returns {Promise<FileSystemFileHandle>}
     */
    async _getFileHandle(fileId, create) {
        const directory = await this._getDirectory(create);
        return await directory.getFileHandle(this._getFileName(fileId), {create});
    }

    /**
     * @param {boolean} create
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async _getDirectory(create) {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
            throw new Error('Origin private file storage is unavailable for online content optimization');
        }
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(this._directoryName, {create});
    }

    /**
     * @param {string} fileId
     * @returns {string}
     * @throws {TypeError} If the file identity is unsafe.
     */
    _getFileName(fileId) {
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(fileId)) { throw new TypeError('Invalid immutable OPFS file identity'); }
        return `${fileId}.bin`;
    }
}
