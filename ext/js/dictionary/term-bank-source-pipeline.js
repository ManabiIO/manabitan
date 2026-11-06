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

import {deferPromise} from '../core/utilities.js';

const SOURCE_TERM_BANK_BATCH_MAX_FILES = 80;
const SOURCE_TERM_BANK_BATCH_MAX_BYTES = 192 * 1024 * 1024;
const SOURCE_TERM_BANK_LOW_MEMORY_BATCH_MAX_BYTES = 64 * 1024 * 1024;
const SOURCE_TERM_BANK_PREFETCH_MAX_BYTES = 96 * 1024 * 1024;
const SOURCE_TERM_BANK_LOW_MEMORY_PREFETCH_MAX_BYTES = 24 * 1024 * 1024;
const SOURCE_TERM_BANK_UNKNOWN_SIZE_PREFETCH_MAX_FILES = 8;
const SOURCE_READ_CANCELLATION_POLL_MS = 25;
const ZIP_LOCAL_FILE_HEADER_LENGTH = 30;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const RAW_ZIP_BATCH_MAX_RANGE_BYTES = 16 * 1024 * 1024;
const RAW_ZIP_BATCH_MAX_GAP_BYTES = 256 * 1024;
const RAW_ZIP_BATCH_MAX_FILES = 256;
const RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** @typedef {import('@zip.js/zip.js').Entry|{filename: string}} TermBankSourceFile */
/** @typedef {{bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename: string}} CompressedTermBankSource */

/** @typedef {{promises: Promise<Uint8Array>[], estimatedByteLengths: number[], readAll: () => Promise<Uint8Array[]>}} DeferredTermBankSourceBatch */

/** Reads validated raw payloads directly from the already-owned source ZIP. */
export class RawZipPayloadReader {
    /** @param {ArrayBuffer|Blob} archiveContent */
    constructor(archiveContent) {
        if (!RawZipPayloadReader.supportsArchive(archiveContent)) {
            throw new RangeError('Raw ZIP archive size is invalid');
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
        return Number.isSafeInteger(size) && size >= ZIP_LOCAL_FILE_HEADER_LENGTH &&
        (archiveContent instanceof Blob || size <= RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES);
    }

    /** @returns {boolean} */
    supportsBatchReads() {
        return this.supportsCachedBatchReads() || (
            this._archiveContent instanceof Blob &&
            this._archiveContent.size > RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES
        );
    }

    /**
     * Automatic media batching must not materialize a previously unread Blob.
     * Owned buffers and the small archive cache populated by term reads are free
     * to reuse; large Blobs retain their existing ranged-read/prefetch policy.
     * @returns {boolean}
     */
    supportsCachedBatchReads() {
        if (!(this._archiveContent instanceof Blob)) { return true; }
        return this._archiveContent.size <= RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES && this._archiveBytesPromise !== null;
    }

    /**
     * @param {TermBankSourceFile} file
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async read(file, signal) {
        signal.throwIfAborted();
        const archiveSize = this._archiveContent instanceof Blob ? this._archiveContent.size : this._archiveContent.byteLength;
        const offset = /** @type {unknown} */ (Reflect.get(file, 'offset'));
        const compressedSize = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'));
        const compressionMethod = /** @type {unknown} */ (Reflect.get(file, 'compressionMethod'));
        if (
            typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof compressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
            compressedSize > RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            offset > archiveSize - ZIP_LOCAL_FILE_HEADER_LENGTH
        ) {
            throw new Error(`Raw ZIP metadata is invalid for '${file.filename}'`);
        }
        // Keep the existing small-archive path. Large Files/Blobs read only
        // validated entry ranges; an already-owned ArrayBuffer needs no copy.
        const ranged = this._archiveContent instanceof Blob && archiveSize > RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES;
        const archiveBytes = ranged ?
            await this._readBlobRange(offset, ZIP_LOCAL_FILE_HEADER_LENGTH, signal) :
            await this._getArchiveBytes();
        signal.throwIfAborted();
        const headerOffset = ranged ? 0 : offset;
        const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
        if (view.getUint32(headerOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
            throw new Error(`Raw ZIP local header is invalid for '${file.filename}'`);
        }
        const localFlags = view.getUint16(headerOffset + 6, true);
        const localCompressionMethod = view.getUint16(headerOffset + 8, true);
        if ((localFlags & 0x1) !== 0 || localCompressionMethod !== compressionMethod) {
            throw new Error(`Raw ZIP local header disagrees with central metadata for '${file.filename}'`);
        }
        const filenameLength = view.getUint16(headerOffset + 26, true);
        const extraFieldLength = view.getUint16(headerOffset + 28, true);
        const dataOffset = offset + ZIP_LOCAL_FILE_HEADER_LENGTH + filenameLength + extraFieldLength;
        if (!Number.isSafeInteger(dataOffset) || dataOffset > archiveSize || compressedSize > archiveSize - dataOffset) {
            throw new Error(`Raw ZIP payload is out of bounds for '${file.filename}'`);
        }
        const rawFilename = /** @type {unknown} */ (Reflect.get(file, 'rawFilename'));
        if (rawFilename instanceof Uint8Array) {
            if (filenameLength !== rawFilename.byteLength) {
                throw new Error(`Raw ZIP local filename disagrees with central metadata for '${file.filename}'`);
            }
            const localFilenameOffset = offset + ZIP_LOCAL_FILE_HEADER_LENGTH;
            const localFilename = ranged ?
                await this._readBlobRange(localFilenameOffset, filenameLength, signal) :
                archiveBytes.subarray(localFilenameOffset, localFilenameOffset + filenameLength);
            for (let i = 0; i < filenameLength; ++i) {
                if (localFilename[i] !== rawFilename[i]) {
                    throw new Error(`Raw ZIP local filename disagrees with central metadata for '${file.filename}'`);
                }
            }
        }
        return ranged ?
            await this._readBlobRange(dataOffset, compressedSize, signal) :
            Uint8Array.from(archiveBytes.subarray(dataOffset, dataOffset + compressedSize));
    }

    /**
     * Reads nearby ZIP entries through a bounded number of coalesced archive
     * ranges. The returned byte arrays own their storage and preserve the
     * source metadata needed by the native inflater.
     * @param {TermBankSourceFile[]} files
     * @param {AbortSignal} [signal]
     * @param {() => boolean} [isCancelled]
     * @returns {Promise<{sources: Array<{file: TermBankSourceFile, bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename: string}>, rangeReadCount: number, rangeReadBytes: number}|null>}
     */
    async readBatch(files, signal = new AbortController().signal, isCancelled = () => false) {
        if (!Array.isArray(files) || files.length === 0) { return {sources: [], rangeReadCount: 0, rangeReadBytes: 0}; }
        if (files.length > RAW_ZIP_BATCH_MAX_FILES) { return null; }
        const archiveSize = this._archiveContent instanceof Blob ? this._archiveContent.size : this._archiveContent.byteLength;
        /** @type {Array<{file: TermBankSourceFile, offset: number, rawFilename: Uint8Array, compressedSize: number, uncompressedSize: number, compressionMethod: 0|8, signature: number, filename: string}>} */
        const entries = [];
        let compressedBytes = 0;
        let uncompressedBytes = 0;
        for (const file of files) {
            const offset = /** @type {unknown} */ (Reflect.get(file, 'offset'));
            const compressedSize = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'));
            const uncompressedSize = /** @type {unknown} */ (Reflect.get(file, 'uncompressedSize'));
            const compressionMethod = /** @type {unknown} */ (Reflect.get(file, 'compressionMethod'));
            const signature = /** @type {unknown} */ (Reflect.get(file, 'signature'));
            const rawFilename = /** @type {unknown} */ (Reflect.get(file, 'rawFilename'));
            if (
                typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
                typeof compressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
                typeof uncompressedSize !== 'number' || !Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0 ||
                (compressionMethod !== 0 && compressionMethod !== 8) ||
                typeof signature !== 'number' || !Number.isInteger(signature) || signature < 0 || signature > 0xffffffff ||
                !(rawFilename instanceof Uint8Array) || rawFilename.byteLength === 0 || rawFilename.byteLength > 0xffff ||
                typeof file.filename !== 'string' || offset > archiveSize - ZIP_LOCAL_FILE_HEADER_LENGTH
            ) {
                return null;
            }
            compressedBytes += compressedSize;
            uncompressedBytes += uncompressedSize;
            if (compressedBytes > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES || uncompressedBytes > RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES) { return null; }
            entries.push({file, offset, rawFilename, compressedSize, uncompressedSize, compressionMethod, signature, filename: file.filename});
        }

        entries.sort((a, b) => a.offset - b.offset);
        /** @type {Array<{file: TermBankSourceFile, bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number, filename: string}>} */
        const result = [];
        let rangeReadCount = 0;
        let rangeReadBytes = 0;
        for (let startIndex = 0; startIndex < entries.length;) {
            signal.throwIfAborted();
            if (isCancelled()) { throw new Error('Dictionary import was cancelled'); }
            const first = entries[startIndex];
            const firstOffset = first.offset;
            let endIndex = startIndex;
            let rangeEnd = firstOffset;
            while (endIndex < entries.length) {
                const entry = entries[endIndex];
                // The local name must match the known central name. Only the
                // extra field needs its maximum legal size in this read bound.
                const entryUpperLength = ZIP_LOCAL_FILE_HEADER_LENGTH + entry.rawFilename.byteLength + 0xffff + entry.compressedSize;
                const entryUpperEnd = entry.offset + Math.min(archiveSize - entry.offset, entryUpperLength);
                const rangeLength = Math.min(archiveSize, entryUpperEnd) - firstOffset;
                const gap = endIndex === startIndex ? 0 : entry.offset - rangeEnd;
                if (
                    endIndex > startIndex &&
                    (gap > RAW_ZIP_BATCH_MAX_GAP_BYTES || rangeLength > RAW_ZIP_BATCH_MAX_RANGE_BYTES)
                ) {
                    break;
                }
                if (rangeLength > RAW_ZIP_BATCH_MAX_RANGE_BYTES) {
                    // Decline rather than allocate beyond the range budget.
                    return null;
                }
                rangeEnd = Math.max(rangeEnd, entryUpperEnd);
                ++endIndex;
            }
            const boundedEnd = Math.min(archiveSize, rangeEnd);
            const rangeLength = boundedEnd - firstOffset;
            const bytes = this._archiveContent instanceof Blob && archiveSize > RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES ?
                await this._readBlobRange(firstOffset, rangeLength, signal) :
                (await this._getArchiveBytes()).subarray(firstOffset, boundedEnd);
            signal.throwIfAborted();
            ++rangeReadCount;
            rangeReadBytes += rangeLength;
            if (isCancelled()) { throw new Error('Dictionary import was cancelled'); }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = startIndex; i < endIndex; ++i) {
                const entry = entries[i];
                const headerOffset = entry.offset - firstOffset;
                if (headerOffset < 0 || headerOffset > bytes.byteLength - ZIP_LOCAL_FILE_HEADER_LENGTH || view.getUint32(headerOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
                    throw new Error(`Raw ZIP local header is invalid for '${entry.filename}'`);
                }
                const localFlags = view.getUint16(headerOffset + 6, true);
                const localCompressionMethod = view.getUint16(headerOffset + 8, true);
                if ((localFlags & 0x1) !== 0 || localCompressionMethod !== entry.compressionMethod) {
                    throw new Error(`Raw ZIP local header disagrees with central metadata for '${entry.filename}'`);
                }
                const filenameLength = view.getUint16(headerOffset + 26, true);
                const extraFieldLength = view.getUint16(headerOffset + 28, true);
                const {rawFilename} = entry;
                if (filenameLength !== rawFilename.byteLength) {
                    throw new Error(`Raw ZIP local filename disagrees with central metadata for '${entry.filename}'`);
                }
                const localFilenameOffset = headerOffset + ZIP_LOCAL_FILE_HEADER_LENGTH;
                const dataOffset = localFilenameOffset + filenameLength + extraFieldLength;
                const payloadEnd = dataOffset + entry.compressedSize;
                const absoluteDataOffset = entry.offset + ZIP_LOCAL_FILE_HEADER_LENGTH + filenameLength + extraFieldLength;
                if (
                    !Number.isSafeInteger(payloadEnd) || payloadEnd > bytes.byteLength ||
                    !Number.isSafeInteger(absoluteDataOffset) || absoluteDataOffset > archiveSize ||
                    entry.compressedSize > archiveSize - absoluteDataOffset
                ) {
                    throw new Error(`Raw ZIP payload is out of bounds for '${entry.filename}'`);
                }
                for (let j = 0; j < filenameLength; ++j) {
                    if (bytes[localFilenameOffset + j] !== rawFilename[j]) {
                        throw new Error(`Raw ZIP local filename disagrees with central metadata for '${entry.filename}'`);
                    }
                }
                result.push({
                    file: entry.file,
                    bytes: Uint8Array.from(bytes.subarray(dataOffset, payloadEnd)),
                    compressionMethod: entry.compressionMethod,
                    compressedSize: entry.compressedSize,
                    uncompressedSize: entry.uncompressedSize,
                    signature: entry.signature,
                    filename: entry.filename,
                });
            }
            startIndex = endIndex;
        }
        return {sources: result, rangeReadCount, rangeReadBytes};
    }

    /**
     * Blob.arrayBuffer cannot be interrupted. Join its completion and check
     * cancellation before exposing bytes or starting the next bounded read.
     * @param {number} offset
     * @param {number} length
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async _readBlobRange(offset, length, signal) {
        signal.throwIfAborted();
        const bytes = new Uint8Array(await /** @type {Blob} */ (this._archiveContent).slice(offset, offset + length).arrayBuffer());
        signal.throwIfAborted();
        if (bytes.byteLength !== length) { throw new Error('Raw ZIP range read is incomplete'); }
        return bytes;
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
/** @template T @template [File=TermBankSourceFile] */
export class AbortableZipReadPool {
    /**
     * @param {(file: File, signal: AbortSignal) => Promise<T>} read
     */
    constructor(read) {
        /** @type {(file: File, signal: AbortSignal) => Promise<T>} */
        this._read = read;
        /** @type {Map<File, {promise: Promise<T>, abortController: AbortController}>} */
        this._reads = new Map();
        // Cache eviction does not end a read's lifetime. In particular, a
        // released Blob read can still be running when disposal begins.
        /** @type {Set<{promise: Promise<T>, abortController: AbortController}>} */
        this._pendingReads = new Set();
        /** @type {Set<Promise<void>>} */
        this._pendingJoins = new Set();
        /** @type {Promise<void>|null} */
        this._disposePromise = null;
        /** @type {boolean} */
        this._disposed = false;
    }

    /**
     * @param {File} file
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
            const {promise, resolve, reject} = /** @type {import('core').DeferredPromiseDetails<T>} */ (deferPromise());
            const pendingRead = {promise, abortController};
            read = pendingRead;
            this._reads.set(file, pendingRead);
            this._pendingReads.add(pendingRead);
            const settled = () => { this._pendingReads.delete(pendingRead); };
            void promise.then(settled, settled);
            // Register ownership before invoking callbacks which may release,
            // replace, or cancel this read synchronously. Keep reader timing eager.
            try {
                void this._read(file, abortController.signal).then(resolve, reject);
            } catch (error) {
                reject(error);
            }
        }
        return read.promise;
    }

    /**
     * @param {File} file
     */
    release(file) {
        this._reads.delete(file);
    }

    /** Aborts every obsolete inflation and waits for all prior abort joins. */
    async abortAndJoin() {
        const activeReads = [...new Set([...this._reads.values(), ...this._pendingReads])];
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
        if (this._disposePromise === null) {
            const {promise, resolve, reject} = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
            // Aborting dispatches listeners synchronously. Publish disposal
            // ownership before those listeners can reenter dispose().
            this._disposePromise = promise;
            void this.abortAndJoin().then(resolve, reject);
        }
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
     * @param {() => void} [checkCancellation]
     * @returns {Promise<Uint8Array|Uint8Array[]|DeferredTermBankSourceBatch|null>}
     */
    async readBatch(batch, checkCancellation) {
        if (batch.length <= 1) {
            return batch.length === 1 && this.canPrefetch(batch[0]) ? await this.read(batch[0], checkCancellation) : null;
        }
        const promises = batch.map((candidate) => this._readPool.read(candidate));
        const estimatedByteLengths = batch.map((candidate) => {
            const uncompressedSize = /** @type {unknown} */ (Reflect.get(candidate, 'uncompressedSize'));
            return typeof uncompressedSize === 'number' && Number.isSafeInteger(uncompressedSize) && uncompressedSize > 0 ? uncompressedSize : 0;
        });
        // Parallel parsing owns cancellation after accepting the deferred plan.
        // Its fallback must take ownership only if that parser declines the job.
        const readAll = () => {
            const reads = Promise.all(promises);
            return typeof checkCancellation === 'function' ? this._awaitRead(reads, checkCancellation) : reads;
        };
        if (batch.length >= 4 && estimatedByteLengths.every((length) => length > 0)) {
            return {promises, estimatedByteLengths, readAll};
        }
        const byteArrays = await readAll();
        return byteArrays.every((bytes) => this._getJsonArrayContentSpan(bytes) !== null) ? byteArrays : null;
    }

    /**
     * @param {TermBankSourceFile} file
     * @param {() => void} [checkCancellation]
     * @returns {Promise<Uint8Array>}
     */
    read(file, checkCancellation) {
        const promise = this._readPool.read(file);
        return typeof checkCancellation === 'function' ? this._awaitRead(promise, checkCancellation) : promise;
    }

    /**
     * Serial source reads have no parser job polling cancellation yet. Abort
     * their owned reads and join decoder cleanup before returning the failure.
     * Deferred parallel plans retain their existing parser cancellation owner.
     * @template T
     * @param {Promise<T>} promise
     * @param {() => void} checkCancellation
     * @returns {Promise<T>}
     */
    async _awaitRead(promise, checkCancellation) {
        const cancellation = {
            active: false,
            error: /** @type {unknown} */ (void 0),
            join: /** @type {Promise<void>|null} */ (null),
        };
        const poll = () => {
            if (cancellation.active) { return; }
            try {
                checkCancellation();
            } catch (error) {
                cancellation.active = true;
                cancellation.error = error;
                cancellation.join = this.abortAndJoin();
                void cancellation.join.catch(() => {});
            }
        };
        const timer = setInterval(poll, SOURCE_READ_CANCELLATION_POLL_MS);
        try {
            poll();
            const result = await promise;
            poll();
            if (cancellation.active) { throw cancellation.error; }
            return result;
        } catch (error) {
            if (!cancellation.active) { throw error; }
            if (cancellation.join !== null) { await cancellation.join; }
            throw cancellation.error;
        } finally {
            clearInterval(timer);
        }
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
            // Prefetch owns no immediate consumer, so observe failures here to
            // avoid a transient global unhandled rejection. The cached promise
            // itself remains rejected and the eventual consumer still receives it.
            void this._readPool.read(candidate).catch(() => {});
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
     * Builds a lazy raw-ZIP plan with complete validation metadata. On a
     * low-memory device, preserve ordinary single-batch imports and admit only
     * the current batch of multi-batch imports. The parser's independent source-size guard still applies.
     * @param {number} startIndex
     * @returns {{files: TermBankSourceFile[], loaders: Array<() => Promise<CompressedTermBankSource>>, estimatedByteLengths: number[]}|null}
     */
    createCompressedImportRunPlan(startIndex) {
        if (!this._enabled || this._compressedReadPool === null) { return null; }
        // Keep the established transport when the archive needs only one
        // ordinary batch. Inspect the whole import even after a fallback;
        // small final batches of genuinely multi-batch imports remain eligible.
        if (this._lowMemory && this.getBatchPlan(0).files.length === this._termFiles.length) { return null; }
        const boundedBatch = this._lowMemory ? this.getBatchPlan(startIndex) : null;
        if (boundedBatch !== null && (
            boundedBatch.unknownSizeCount !== 0 ||
            boundedBatch.estimatedBytes > this._batchMaxBytes
        )) { return null; }
        const files = boundedBatch === null ? this._termFiles.slice(startIndex) : boundedBatch.files;
        if (files.length < 4) { return null; }
        /** @type {Array<{compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number}>} */
        const metadata = [];
        let compressedBytes = 0;
        for (const file of files) {
            const value = this._getCompressedSourceMetadata(file);
            if (value === null) { return null; }
            // Preserve the old 128 MiB archive ceiling as a compressed-source
            // budget, independently of decoded sizes or overlapping entries.
            // Large media/unused entries need not disqualify small term banks.
            const compressedBudget = this._lowMemory ? this._batchMaxBytes : RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES;
            if (value.compressedSize > compressedBudget - compressedBytes) { return null; }
            compressedBytes += value.compressedSize;
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
