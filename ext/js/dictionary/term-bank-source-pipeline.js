/*
 * Copyright (C) 2026  Yomitan Authors
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

const SOURCE_TERM_BANK_BATCH_MAX_FILES = 80;
const SOURCE_TERM_BANK_BATCH_MAX_BYTES = 192 * 1024 * 1024;
const SOURCE_TERM_BANK_LOW_MEMORY_BATCH_MAX_BYTES = 64 * 1024 * 1024;
const SOURCE_TERM_BANK_PREFETCH_MAX_BYTES = 96 * 1024 * 1024;
const SOURCE_TERM_BANK_LOW_MEMORY_PREFETCH_MAX_BYTES = 24 * 1024 * 1024;
const SOURCE_TERM_BANK_UNKNOWN_SIZE_PREFETCH_MAX_FILES = 8;
const ZIP_LOCAL_FILE_HEADER_LENGTH = 30;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;

/** @typedef {import('@zip.js/zip.js').Entry|{filename: string}} TermBankSourceFile */
/** @typedef {{bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename: string}} CompressedTermBankSource */

/** Reads validated raw payloads directly from the already-owned source ZIP. */
export class RawZipPayloadReader {
    /** @param {ArrayBuffer|Blob} archiveContent */
    constructor(archiveContent) {
        if (!RawZipPayloadReader.supportsArchive(archiveContent)) {
            throw new RangeError('Raw ZIP archive exceeds the direct-read budget');
        }
        /** @type {ArrayBuffer|Blob} */
        this._archiveContent = archiveContent;
        /** @type {Promise<Uint8Array>|null} */
        this._archiveBytesPromise = null;
    }

    /**
     * @param {ArrayBuffer|Blob} archiveContent
     * @returns {boolean}
     */
    static supportsArchive(archiveContent) {
        const size = archiveContent instanceof Blob ? archiveContent.size : archiveContent.byteLength;
        return Number.isSafeInteger(size) && size >= ZIP_LOCAL_FILE_HEADER_LENGTH && size <= RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES;
    }

    /**
     * @param {TermBankSourceFile} file
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async read(file, signal) {
        signal.throwIfAborted();
        const archiveBytes = await this._getArchiveBytes();
        signal.throwIfAborted();
        const offset = /** @type {unknown} */ (Reflect.get(file, 'offset'));
        const compressedSize = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'));
        const compressionMethod = /** @type {unknown} */ (Reflect.get(file, 'compressionMethod'));
        if (
            typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof compressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            offset > archiveBytes.byteLength - ZIP_LOCAL_FILE_HEADER_LENGTH
        ) {
            throw new Error(`Raw ZIP metadata is invalid for '${file.filename}'`);
        }
        const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
        if (view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
            throw new Error(`Raw ZIP local header is invalid for '${file.filename}'`);
        }
        const localFlags = view.getUint16(offset + 6, true);
        const localCompressionMethod = view.getUint16(offset + 8, true);
        if ((localFlags & 0x1) !== 0 || localCompressionMethod !== compressionMethod) {
            throw new Error(`Raw ZIP local header disagrees with central metadata for '${file.filename}'`);
        }
        const filenameLength = view.getUint16(offset + 26, true);
        const extraFieldLength = view.getUint16(offset + 28, true);
        const rawFilename = /** @type {unknown} */ (Reflect.get(file, 'rawFilename'));
        if (rawFilename instanceof Uint8Array) {
            if (filenameLength !== rawFilename.byteLength) {
                throw new Error(`Raw ZIP local filename disagrees with central metadata for '${file.filename}'`);
            }
            const localFilenameOffset = offset + ZIP_LOCAL_FILE_HEADER_LENGTH;
            for (let i = 0; i < filenameLength; ++i) {
                if (archiveBytes[localFilenameOffset + i] !== rawFilename[i]) {
                    throw new Error(`Raw ZIP local filename disagrees with central metadata for '${file.filename}'`);
                }
            }
        }
        const dataOffset = offset + ZIP_LOCAL_FILE_HEADER_LENGTH + filenameLength + extraFieldLength;
        if (dataOffset < offset || dataOffset > archiveBytes.byteLength || compressedSize > archiveBytes.byteLength - dataOffset) {
            throw new Error(`Raw ZIP payload is out of bounds for '${file.filename}'`);
        }
        return Uint8Array.from(archiveBytes.subarray(dataOffset, dataOffset + compressedSize));
    }

    /** @returns {Promise<Uint8Array>} */
    _getArchiveBytes() {
        this._archiveBytesPromise ??= this._archiveContent instanceof Blob ?
            this._archiveContent.arrayBuffer().then((buffer) => new Uint8Array(buffer)) :
            Promise.resolve(new Uint8Array(this._archiveContent));
        return this._archiveBytesPromise;
    }
}

/** Owns entry-identity-keyed, independently abortable ZIP reads. */
/** @template T */
export class AbortableZipReadPool {
    /**
     * @param {(file: TermBankSourceFile, signal: AbortSignal) => Promise<T>} read
     */
    constructor(read) {
        /** @type {(file: TermBankSourceFile, signal: AbortSignal) => Promise<T>} */
        this._read = read;
        /** @type {Map<TermBankSourceFile, {promise: Promise<T>, abortController: AbortController}>} */
        this._reads = new Map();
        /** @type {Set<Promise<void>>} */
        this._pendingJoins = new Set();
        /** @type {Promise<void>|null} */
        this._disposePromise = null;
        /** @type {boolean} */
        this._disposed = false;
    }

    /**
     * @param {TermBankSourceFile} file
     * @returns {Promise<T>}
     * @throws {Error} If the pool has been disposed.
     */
    read(file) {
        if (this._disposed) {
            throw new Error('Term bank ZIP read pool is disposed');
        }
        let read = this._reads.get(file);
        if (typeof read === 'undefined') {
            const abortController = new AbortController();
            let promise;
            try {
                promise = this._read(file, abortController.signal);
            } catch (error) {
                promise = Promise.reject(error);
            }
            read = {promise, abortController};
            this._reads.set(file, read);
            void promise.catch(() => {});
        }
        return read.promise;
    }

    /**
     * @param {TermBankSourceFile} file
     */
    release(file) {
        this._reads.delete(file);
    }

    /** Aborts every obsolete inflation and waits for all prior abort joins. */
    async abortAndJoin() {
        const activeReads = [...this._reads.values()];
        this._reads.clear();
        for (const {abortController} of activeReads) {
            abortController.abort();
        }
        const join = Promise.allSettled(activeReads.map(({promise}) => promise)).then(() => {});
        this._pendingJoins.add(join);
        void join.finally(() => { this._pendingJoins.delete(join); });
        await Promise.all(this._pendingJoins);
    }

    /** @returns {Promise<void>} */
    dispose() {
        this._disposed = true;
        this._disposePromise ??= this.abortAndJoin();
        return this._disposePromise;
    }
}

/** Owns source term-bank batching and the lifetime of prefetched ZIP bytes. */
export class TermBankSourcePipeline {
    /**
     * @param {{
     *   termFiles: TermBankSourceFile[],
     *   enabled: boolean,
     *   read: (file: TermBankSourceFile, signal: AbortSignal) => Promise<Uint8Array>,
     *   readCompressed?: (file: TermBankSourceFile, signal: AbortSignal) => Promise<Uint8Array>,
     *   deviceMemory?: number,
     * }} options
     */
    constructor({termFiles, enabled, read, readCompressed = void 0, deviceMemory = TermBankSourcePipeline.getDeviceMemory()}) {
        /** @type {TermBankSourceFile[]} */
        this._termFiles = termFiles;
        /** @type {boolean} */
        this._enabled = enabled;
        /** @type {AbortableZipReadPool<Uint8Array>} */
        this._readPool = new AbortableZipReadPool(read);
        /** @type {AbortableZipReadPool<Uint8Array>|null} */
        this._compressedReadPool = typeof readCompressed === 'function' ? new AbortableZipReadPool(readCompressed) : null;
        /** @type {number} */
        this._batchMaxBytes = (
            typeof deviceMemory === 'number' &&
            Number.isFinite(deviceMemory) &&
            deviceMemory <= 4
        ) ?
            SOURCE_TERM_BANK_LOW_MEMORY_BATCH_MAX_BYTES :
            SOURCE_TERM_BANK_BATCH_MAX_BYTES;
        /** @type {number} */
        this._prefetchMaxBytes = this._batchMaxBytes === SOURCE_TERM_BANK_LOW_MEMORY_BATCH_MAX_BYTES ?
            SOURCE_TERM_BANK_LOW_MEMORY_PREFETCH_MAX_BYTES :
            SOURCE_TERM_BANK_PREFETCH_MAX_BYTES;
        /** @type {boolean} */
        this._lowMemory = this._batchMaxBytes === SOURCE_TERM_BANK_LOW_MEMORY_BATCH_MAX_BYTES;
    }

    /** @returns {number} */
    get batchMaxBytes() {
        return this._batchMaxBytes;
    }

    /** @returns {number} */
    get prefetchMaxBytes() {
        return this._prefetchMaxBytes;
    }

    /**
     * @param {TermBankSourceFile} file
     * @returns {boolean}
     */
    canPrefetch(file) {
        return (
            this._enabled &&
            typeof file === 'object' &&
            file !== null &&
            typeof file.filename === 'string' &&
            /\.json$/i.test(file.filename) &&
            'getData' in file
        );
    }

    /**
     * @param {number} startIndex
     * @returns {TermBankSourceFile[]}
     */
    getBatch(startIndex) {
        return this.getBatchPlan(startIndex).files;
    }

    /**
     * Returns the batch and the size information used to bound it. The first
     * source file is always admitted so an oversized bank can still make
     * progress, therefore callers must inspect `estimatedBytes` before
     * treating a one-batch import as small.
     * @param {number} startIndex
     * @returns {{files: TermBankSourceFile[], estimatedBytes: number, unknownSizeCount: number}}
     */
    getBatchPlan(startIndex) {
        /** @type {TermBankSourceFile[]} */
        const batch = [];
        let estimatedBytes = 0;
        let unknownSizeCount = 0;
        for (let i = startIndex; i < this._termFiles.length; ++i) {
            const candidate = this._termFiles[i];
            if (!this.canPrefetch(candidate)) { break; }
            const candidateBytes = this._getEstimatedBytes(candidate);
            if (
                batch.length > 0 &&
                candidateBytes > 0 &&
                estimatedBytes + candidateBytes > this._batchMaxBytes
            ) {
                break;
            }
            if (
                candidateBytes === 0 &&
                unknownSizeCount >= SOURCE_TERM_BANK_UNKNOWN_SIZE_PREFETCH_MAX_FILES
            ) {
                break;
            }
            batch.push(candidate);
            if (candidateBytes > 0) {
                estimatedBytes += candidateBytes;
            } else {
                ++unknownSizeCount;
            }
            if (batch.length >= SOURCE_TERM_BANK_BATCH_MAX_FILES) { break; }
        }
        return {files: batch, estimatedBytes, unknownSizeCount};
    }

    /**
     * @param {TermBankSourceFile[]} batch
     * @returns {Promise<Uint8Array|Uint8Array[]|{promises: Promise<Uint8Array>[], estimatedByteLengths: number[]}|null>}
     */
    async readBatch(batch) {
        if (batch.length <= 1) {
            return batch.length === 1 && this.canPrefetch(batch[0]) ? await this._readPool.read(batch[0]) : null;
        }
        const promises = batch.map((candidate) => this._readPool.read(candidate));
        const estimatedByteLengths = batch.map((candidate) => {
            const uncompressedSize = /** @type {unknown} */ (Reflect.get(candidate, 'uncompressedSize'));
            return typeof uncompressedSize === 'number' && Number.isSafeInteger(uncompressedSize) && uncompressedSize > 0 ? uncompressedSize : 0;
        });
        if (batch.length >= 4 && estimatedByteLengths.every((length) => length > 0)) {
            return {promises, estimatedByteLengths};
        }
        const byteArrays = await Promise.all(promises);
        return byteArrays.every((bytes) => this._getJsonArrayContentSpan(bytes) !== null) ? byteArrays : null;
    }

    /**
     * @param {TermBankSourceFile} file
     * @returns {Promise<Uint8Array>}
     */
    read(file) {
        return this._readPool.read(file);
    }

    /**
     * @param {number} startIndex
     * @returns {{fileCount: number, estimatedBytes: number}}
     */
    prefetchNext(startIndex) {
        const batch = this.getBatchPlan(startIndex).files;
        let estimatedBytes = 0;
        let unknownSizeCount = 0;
        let prefetchedCount = 0;
        for (const candidate of batch) {
            const candidateBytes = this._getEstimatedBytes(candidate);
            if (
                prefetchedCount > 0 &&
                candidateBytes > 0 &&
                estimatedBytes + candidateBytes > this._prefetchMaxBytes
            ) {
                break;
            }
            if (
                candidateBytes === 0 &&
                unknownSizeCount >= SOURCE_TERM_BANK_UNKNOWN_SIZE_PREFETCH_MAX_FILES
            ) {
                break;
            }
            void this._readPool.read(candidate);
            ++prefetchedCount;
            if (candidateBytes > 0) {
                estimatedBytes += candidateBytes;
            } else {
                ++unknownSizeCount;
            }
        }
        return {fileCount: prefetchedCount, estimatedBytes};
    }

    /**
     * Builds a lazy import-wide source plan only when ordinary batching would
     * require more than one pass. Reads start when parser workers claim a
     * bounded source group, while any initial prefetch remains shared through
     * the identity-keyed read pool.
     * @param {number} startIndex
     * @returns {{files: TermBankSourceFile[], loaders: Array<() => Promise<Uint8Array>>, estimatedByteLengths: number[]}|null}
     */
    createImportRunPlan(startIndex) {
        if (!this._enabled || this._lowMemory) { return null; }
        const firstBatch = this.getBatchPlan(startIndex).files;
        if (firstBatch.length === 0 || startIndex + firstBatch.length >= this._termFiles.length) {
            return null;
        }
        const files = this._termFiles.slice(startIndex);
        const estimatedByteLengths = [];
        for (const file of files) {
            if (!this.canPrefetch(file)) { return null; }
            const estimatedBytes = this._getEstimatedBytes(file);
            if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) { return null; }
            estimatedByteLengths.push(estimatedBytes);
        }
        const loaders = files.map((file) => async () => await this._readPool.read(file));
        return {files, loaders, estimatedByteLengths};
    }

    /**
     * Builds an import-wide plan over raw ZIP payloads only when every source
     * has complete central-directory metadata required for exact validation.
     * @param {number} startIndex
     * @returns {{files: TermBankSourceFile[], loaders: Array<() => Promise<CompressedTermBankSource>>, estimatedByteLengths: number[]}|null}
     */
    createCompressedImportRunPlan(startIndex) {
        if (!this._enabled || this._lowMemory || this._compressedReadPool === null) { return null; }
        const files = this._termFiles.slice(startIndex);
        if (files.length < 4) { return null; }
        /** @type {Array<{compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number}>} */
        const metadata = [];
        for (const file of files) {
            const value = this._getCompressedSourceMetadata(file);
            if (value === null) { return null; }
            metadata.push(value);
        }
        const estimatedByteLengths = metadata.map(({uncompressedSize}) => uncompressedSize);
        const loaders = files.map((file, index) => async () => {
            const bytes = await /** @type {AbortableZipReadPool<Uint8Array>} */ (this._compressedReadPool).read(file);
            const sourceMetadata = metadata[index];
            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== sourceMetadata.compressedSize) {
                throw new Error(`Compressed term-bank ZIP size mismatch in '${file.filename}'`);
            }
            return {bytes, ...sourceMetadata, filename: file.filename};
        });
        return {files, loaders, estimatedByteLengths};
    }

    /**
     * @param {TermBankSourceFile[]} batch
     */
    releaseBatch(batch) {
        for (const file of batch) {
            this._readPool.release(file);
            this._compressedReadPool?.release(file);
        }
    }

    /** @returns {Promise<void>} */
    async abortAndJoin() {
        await Promise.all([
            this._readPool.abortAndJoin(),
            this._compressedReadPool?.abortAndJoin(),
        ]);
    }

    /** @returns {Promise<void>} */
    async dispose() {
        await Promise.all([
            this._readPool.dispose(),
            this._compressedReadPool?.dispose(),
        ]);
    }

    /**
     * @param {TermBankSourceFile} file
     * @returns {number}
     */
    _getEstimatedBytes(file) {
        const uncompressedSize = /** @type {unknown} */ (Reflect.get(file, 'uncompressedSize'));
        if (typeof uncompressedSize === 'number' && Number.isFinite(uncompressedSize) && uncompressedSize > 0) {
            return Math.trunc(uncompressedSize);
        }
        const size = /** @type {unknown} */ (Reflect.get(file, 'size'));
        return (typeof size === 'number' && Number.isFinite(size) && size > 0) ? Math.trunc(size) : 0;
    }

    /**
     * @param {TermBankSourceFile} file
     * @returns {{compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number}|null}
     */
    _getCompressedSourceMetadata(file) {
        if (!this.canPrefetch(file) || Reflect.get(file, 'encrypted') === true) { return null; }
        const offset = /** @type {unknown} */ (Reflect.get(file, 'offset'));
        const compressionMethod = /** @type {unknown} */ (Reflect.get(file, 'compressionMethod'));
        const compressedSize = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'));
        const uncompressedSize = /** @type {unknown} */ (Reflect.get(file, 'uncompressedSize'));
        const signature = /** @type {unknown} */ (Reflect.get(file, 'signature'));
        const rawFilename = /** @type {unknown} */ (Reflect.get(file, 'rawFilename'));
        if (
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof compressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
            typeof uncompressedSize !== 'number' || !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0 ||
            typeof signature !== 'number' || !Number.isInteger(signature) || signature < 0 || signature > 0xffffffff ||
            ('rawFilename' in file && !(rawFilename instanceof Uint8Array))
        ) {
            return null;
        }
        if (compressionMethod === 0 && compressedSize !== uncompressedSize) { return null; }
        return {compressionMethod, compressedSize, uncompressedSize, signature};
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {{start: number, end: number}|null}
     */
    _getJsonArrayContentSpan(bytes) {
        let start = 0;
        while (start < bytes.length && this._isJsonWhitespaceByte(bytes[start])) { ++start; }
        if (start >= bytes.length || bytes[start] !== 0x5b) { return null; }
        let end = bytes.length;
        while (end > start && this._isJsonWhitespaceByte(bytes[end - 1])) { --end; }
        return end > start && bytes[end - 1] === 0x5d ? {start: start + 1, end: end - 1} : null;
    }

    /**
     * @param {number} value
     * @returns {boolean}
     */
    _isJsonWhitespaceByte(value) {
        return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
    }

    /** @returns {number|undefined} */
    static getDeviceMemory() {
        const deviceMemory = /** @type {unknown} */ (
            typeof navigator === 'undefined' ? void 0 : Reflect.get(navigator, 'deviceMemory')
        );
        return typeof deviceMemory === 'number' ? deviceMemory : void 0;
    }
}
