/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

import {reportDiagnostics} from '../core/diagnostics-reporter.js';
import {safePerformance} from '../core/safe-performance.js';
import {
    createRawTermContentCompactBlockDictName,
    decodeRawTermContentBlockReference,
    decodeRawTermContentCompactBlockReference,
    getRawTermContentBlockCompressionDictName,
    RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES,
    RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES,
    RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX,
    writeRawTermContentCompactBlockReference,
} from './raw-term-content.js';
import {
    TERM_CONTENT_BLOCK_ENVELOPE_BYTES,
    TERM_CONTENT_BLOCK_ENVELOPE_MAGIC,
    wrapCompressedTermContentBlock,
} from './term-content-block-envelope.js';
import {hashTermEntryContentBytesPair} from './term-entry-content-hash.js';
import {compressTermContentZstd, compressWrappedTermContentZstdBatch, compressWrappedTermContentZstdSpansBatch, decompressTermContentZstd} from './zstd-term-content.js';

export {wrapCompressedTermContentBlock} from './term-content-block-envelope.js';

class TermContentReadError extends Error {
    /**
     * @param {'temporarilyUnavailable'|'corrupt'} status
     * @param {string} message
     */
    constructor(status, message) {
        super(message);
        /** @type {string} */
        this.name = 'TermContentReadError';
        /** @type {'temporarilyUnavailable'|'corrupt'} */
        this.status = status;
    }
}

const DEFAULT_BLOCK_TARGET_BYTES = 4 * 1024 * 1024;
const DEFAULT_REFERENCE_PACK_TARGET_BYTES = 4 * 1024 * 1024;
const DEFAULT_MIN_INPUT_BYTES = 512 * 1024;
const DEFAULT_MIN_SAVINGS_RATIO = 0.1;
const DEFAULT_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const EARLY_SELECTION_MAX_SAMPLES = 32 * 1024;
const EARLY_SELECTION_MAX_SPANS = 512;
const EARLY_SELECTION_SAVINGS_MARGIN = 0.08;

export class TermContentBlockImportSession {
    /**
     * @param {TermContentBlockStore} store
     */
    constructor(store) {
        /** @type {TermContentBlockStore} */
        this._store = store;
        /** @type {Set<string>} */
        this._blockEnabledDictionaries = new Set();
        /** @type {boolean} */
        this._closed = false;
    }

    /**
     * @param {string} dictionary
     * @param {Uint8Array[]} contentBytesList
     * @param {string|null} compressionDictName
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async append(dictionary, contentBytesList, compressionDictName) {
        if (this._closed) { throw new Error('Term content block import session is closed'); }
        const result = await this._store.tryAppend(
            contentBytesList,
            compressionDictName,
            this._blockEnabledDictionaries.has(dictionary),
        );
        if (result !== null) {
            this._blockEnabledDictionaries.add(dictionary);
        }
        return result;
    }

    /**
     * @param {string} dictionary
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async appendSpans(dictionary, sourceBytes, sourceOffsets, sourceLengths, compressionDictName) {
        if (this._closed) { throw new Error('Term content block import session is closed'); }
        const result = await this._store.tryAppendSpans(
            sourceBytes,
            sourceOffsets,
            sourceLengths,
            compressionDictName,
            this._blockEnabledDictionaries.has(dictionary),
        );
        if (result !== null) {
            this._blockEnabledDictionaries.add(dictionary);
        }
        return result;
    }

    /**
     * Starts a shared-slab append when block storage was already selected or
     * the source itself has a conservative compressibility estimate. Stable
     * reference offsets are published before compression and physical append.
     * @param {string} dictionary
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>, initialSelection: boolean}|null}
     * @throws {Error} If the session is closed or the source spans are invalid.
     */
    tryBeginAppendSpans(dictionary, sourceBytes, sourceOffsets, sourceLengths, compressionDictName) {
        if (this._closed) { throw new Error('Term content block import session is closed'); }
        const force = this._blockEnabledDictionaries.has(dictionary);
        const operation = this._store.tryBeginAppendSpans(
            sourceBytes,
            sourceOffsets,
            sourceLengths,
            compressionDictName,
            force,
        );
        if (operation !== null) {
            this._blockEnabledDictionaries.add(dictionary);
        }
        return operation === null ? null : {...operation, initialSelection: !force};
    }

    /** */
    close() {
        this._closed = true;
        this._blockEnabledDictionaries.clear();
    }
}

export class ByteBoundedLruCache {
    /**
     * @param {number} maxBytes
     */
    constructor(maxBytes) {
        /** @type {number} */
        this._maxBytes = maxBytes;
        /** @type {Map<string, Uint8Array>} */
        this._values = new Map();
        /** @type {number} */
        this._bytes = 0;
    }

    /** @returns {number} */
    get size() { return this._values.size; }
    /** @returns {number} */
    get bytes() { return this._bytes; }
    /** @returns {number} */
    get maxBytes() { return this._maxBytes; }

    /** */
    clear() {
        this._values.clear();
        this._bytes = 0;
    }

    /**
     * @param {string} key
     * @returns {Uint8Array|undefined}
     */
    get(key) {
        const value = this._values.get(key);
        if (typeof value === 'undefined') { return void 0; }
        this._values.delete(key);
        this._values.set(key, value);
        return value;
    }

    /**
     * @param {string} key
     * @param {Uint8Array} value
     */
    set(key, value) {
        if (value.byteLength > this._maxBytes) { return; }
        const previous = this._values.get(key);
        if (typeof previous !== 'undefined') { this._bytes -= previous.byteLength; }
        this._values.delete(key);
        this._values.set(key, value);
        this._bytes += value.byteLength;
        while (this._bytes > this._maxBytes && this._values.size > 0) {
            const first = this._values.entries().next();
            if (first.done) { break; }
            this._values.delete(first.value[0]);
            this._bytes -= first.value[1].byteLength;
        }
    }
}

export class TermContentBlockStore {
    /**
     * @param {import('./term-content-opfs-store.js').TermContentOpfsStore} contentStore
     * @param {{blockTargetBytes?: number, referencePackTargetBytes?: number, minInputBytes?: number, minSavingsRatio?: number, cacheMaxBytes?: number}} [options]
     */
    constructor(contentStore, options = {}) {
        /** @type {import('./term-content-opfs-store.js').TermContentOpfsStore} */
        this._contentStore = contentStore;
        /** @type {number} */
        this._blockTargetBytes = options.blockTargetBytes ?? DEFAULT_BLOCK_TARGET_BYTES;
        /** @type {number} */
        this._referencePackTargetBytes = options.referencePackTargetBytes ?? DEFAULT_REFERENCE_PACK_TARGET_BYTES;
        /** @type {number} */
        this._minInputBytes = options.minInputBytes ?? DEFAULT_MIN_INPUT_BYTES;
        /** @type {number} */
        this._minSavingsRatio = options.minSavingsRatio ?? DEFAULT_MIN_SAVINGS_RATIO;
        /** @type {number} */
        this._cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
        /** @type {ByteBoundedLruCache} */
        this._cache = new ByteBoundedLruCache(this._cacheMaxBytes);
        /** @type {Map<string, Promise<Uint8Array|null>>} */
        this._inFlightBlocks = new Map();
        /** @type {Record<string, unknown>|null} */
        this._lastError = null;
    }

    /** @returns {TermContentBlockImportSession} */
    beginImportSession() {
        return new TermContentBlockImportSession(this);
    }

    /** */
    clearCache() {
        this._cache.clear();
    }

    /**
     * @param {number} value
     * @throws {RangeError} If the byte target cannot be represented safely.
     */
    setBlockTargetBytes(value) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
            throw new RangeError('Term content block target must be a positive 32-bit byte count');
        }
        this._blockTargetBytes = value;
    }

    /** @returns {Record<string, unknown>} */
    getDiagnostics() {
        return {
            cacheEntries: this._cache.size,
            cacheBytes: this._cache.bytes,
            cacheMaxBytes: this._cacheMaxBytes,
            blockTargetBytes: this._blockTargetBytes,
            inFlightBlocks: this._inFlightBlocks.size,
            lastError: this._lastError === null ? null : {...this._lastError},
        };
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<Uint8Array|null>}
     */
    async read(contentOffset, contentLength, contentDictName) {
        const result = await this.readDetailed(contentOffset, contentLength, contentDictName);
        return result.status === 'ok' ? result.bytes : null;
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<{status: 'ok', bytes: Uint8Array}|{status: 'temporarilyUnavailable'|'corrupt', reason: string}>}
     */
    async readDetailed(contentOffset, contentLength, contentDictName) {
        try {
            return await this._readDetailed(contentOffset, contentLength, contentDictName);
        } catch (error) {
            if (error instanceof TermContentReadError) {
                return {status: error.status, reason: error.message};
            }
            return {
                status: 'temporarilyUnavailable',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<{status: 'ok', bytes: Uint8Array}>}
     */
    async _readDetailed(contentOffset, contentLength, contentDictName) {
        const compressionDictName = getRawTermContentBlockCompressionDictName(contentDictName);
        if (typeof compressionDictName === 'undefined') {
            const bytes = await this._contentStore.readSlice(contentOffset, contentLength);
            if (!(bytes instanceof Uint8Array)) {
                throw new TermContentReadError('temporarilyUnavailable', 'Term content could not be read from OPFS');
            }
            return {status: 'ok', bytes};
        }
        const compact = contentDictName === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX ||
        contentDictName.startsWith(`${RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX}:`);
        const referenceLength = compact ? RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES : RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES;
        const referenceBytes = await this._contentStore.readSlice(contentOffset, referenceLength);
        if (!(referenceBytes instanceof Uint8Array)) {
            throw new TermContentReadError('temporarilyUnavailable', 'Term content block reference could not be read from OPFS');
        }
        const reference = compact ?
            decodeRawTermContentCompactBlockReference(referenceBytes, contentLength) :
            decodeRawTermContentBlockReference(referenceBytes);
        if (reference === null || reference.entryLength !== contentLength) {
            this._recordError('term-content-block-reference-invalid', {
                contentOffset,
                contentLength,
                contentDictName,
                referencePrefix: [...referenceBytes.subarray(0, 8)],
                decodedEntryLength: reference?.entryLength ?? null,
            });
            throw new TermContentReadError('corrupt', 'Term content block reference is invalid');
        }
        const cacheKey = `${contentDictName}:${reference.blockOffset}:${reference.blockCompressedLength}:${reference.blockUncompressedLength}`;
        let block = this._cache.get(cacheKey);
        if (typeof block === 'undefined') {
            const loadedBlock = await this._getOrLoadBlock(cacheKey, reference, compressionDictName, {
                contentOffset,
                contentLength,
                contentDictName,
            });
            if (loadedBlock === null) {
                throw new TermContentReadError('temporarilyUnavailable', 'Term content block could not be loaded');
            }
            block = loadedBlock;
        }
        const entryEnd = reference.entryOffset + reference.entryLength;
        if (entryEnd > block.byteLength) {
            this._recordError('term-content-block-entry-bounds-error', {
                contentOffset,
                contentLength,
                contentDictName,
                entryOffset: reference.entryOffset,
                entryLength: reference.entryLength,
                blockLength: block.byteLength,
            });
            throw new TermContentReadError('corrupt', 'Term content block entry is outside the decoded block');
        }
        return {status: 'ok', bytes: block.subarray(reference.entryOffset, entryEnd)};
    }

    /**
     * @param {string} cacheKey
     * @param {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number}} reference
     * @param {string|null} compressionDictName
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
     * @returns {Promise<Uint8Array|null>}
     */
    async _getOrLoadBlock(cacheKey, reference, compressionDictName, context) {
        const pending = this._inFlightBlocks.get(cacheKey);
        if (typeof pending !== 'undefined') {
            const block = await pending;
            return block !== null && block.byteLength === reference.blockUncompressedLength ? block : null;
        }
        const load = this._loadBlock(cacheKey, reference, compressionDictName, context);
        this._inFlightBlocks.set(cacheKey, load);
        try {
            return await load;
        } finally {
            if (this._inFlightBlocks.get(cacheKey) === load) {
                this._inFlightBlocks.delete(cacheKey);
            }
        }
    }

    /**
     * @param {string} cacheKey
     * @param {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number}} reference
     * @param {string|null} compressionDictName
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
     * @returns {Promise<Uint8Array|null>}
     */
    async _loadBlock(cacheKey, reference, compressionDictName, context) {
        const storedBlock = await this._contentStore.readSlice(reference.blockOffset, reference.blockCompressedLength);
        if (!(storedBlock instanceof Uint8Array)) {
            throw new TermContentReadError('temporarilyUnavailable', 'Compressed term content block could not be read from OPFS');
        }
        if (
            storedBlock.byteLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES ||
            !TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.every((value, index) => storedBlock[index] === value)
        ) {
            throw new TermContentReadError('corrupt', 'Term content block checksum envelope is invalid');
        }
        const storedBlockView = new DataView(storedBlock.buffer, storedBlock.byteOffset, storedBlock.byteLength);
        const expectedHash1 = storedBlockView.getUint32(4, true);
        const expectedHash2 = storedBlockView.getUint32(8, true);
        const compressed = storedBlock.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES);
        const [actualHash1, actualHash2] = hashTermEntryContentBytesPair(compressed);
        if (actualHash1 !== expectedHash1 || actualHash2 !== expectedHash2) {
            this._recordError('term-content-block-checksum-mismatch', {
                contentDictName: context.contentDictName,
                blockOffset: reference.blockOffset,
                expectedHash1,
                expectedHash2,
                actualHash1,
                actualHash2,
            });
            throw new TermContentReadError('corrupt', 'Term content block checksum does not match its stored payload');
        }
        /** @type {Uint8Array} */
        let block;
        try {
            // zstd-wasm reuses its output heap between calls.
            block = Uint8Array.from(decompressTermContentZstd(compressed, compressionDictName));
        } catch (error) {
            this._recordError('term-content-block-decompress-error', {
                ...context,
                blockOffset: reference.blockOffset,
                blockCompressedLength: reference.blockCompressedLength,
                blockUncompressedLength: reference.blockUncompressedLength,
                compressedPrefix: [...compressed.subarray(0, 8)],
                error: `${error}`,
            });
            throw new TermContentReadError('corrupt', 'Term content block decompression failed');
        }
        if (block.byteLength !== reference.blockUncompressedLength) {
            this._recordError('term-content-block-length-mismatch', {
                contentDictName: context.contentDictName,
                blockOffset: reference.blockOffset,
                expectedLength: reference.blockUncompressedLength,
                actualLength: block.byteLength,
            });
            throw new TermContentReadError('corrupt', 'Term content block decoded length does not match its reference');
        }
        this._lastError = null;
        this._cache.set(cacheKey, block);
        return block;
    }

    /**
     * @param {Uint8Array[]} contentBytesList
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async tryAppend(contentBytesList, compressionDictName, force = false) {
        if (contentBytesList.length === 0) { return null; }
        const sourceLengths = Uint32Array.from(contentBytesList, ({byteLength}) => byteLength);
        return await this._tryAppendPacked(
            () => packContentChunksIntoSlabs(contentBytesList, this._blockTargetBytes),
            sourceLengths,
            compressionDictName,
            force,
        );
    }

    /**
     * Packs byte spans directly from a shared source slab, avoiding one
     * Uint8Array view allocation per logical content entry.
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async tryAppendSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force = false) {
        validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths);
        if (sourceOffsets.length === 0) { return null; }
        if (
            compressionDictName === 'jmdict' &&
            typeof SharedArrayBuffer === 'function' &&
            sourceBytes.buffer instanceof SharedArrayBuffer
        ) {
            return await this._tryAppendSharedSpans(
                sourceBytes,
                sourceOffsets,
                sourceLengths,
                compressionDictName,
                force,
            );
        }
        return await this._tryAppendPacked(
            () => packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, this._blockTargetBytes),
            sourceLengths,
            compressionDictName,
            force,
        );
    }

    /**
     * Begins the reservation-capable path without waiting for compression.
     * Initial JMdict slabs are admitted only when sampled byte entropy leaves
     * a conservative margin beyond the normal measured-savings threshold.
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>}|null}
     */
    tryBeginAppendSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force = false) {
        const uncompressedBytes = validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths);
        if (
            sourceOffsets.length === 0 ||
            compressionDictName !== 'jmdict' ||
            typeof SharedArrayBuffer !== 'function' ||
            !(sourceBytes.buffer instanceof SharedArrayBuffer)
        ) {
            return null;
        }
        if (
            !force &&
            !shouldSelectInitialSharedBlockStorage(
                sourceBytes,
                sourceOffsets,
                sourceLengths,
                uncompressedBytes,
                this._minInputBytes,
                this._minSavingsRatio,
            )
        ) {
            return null;
        }
        return this._beginAppendSharedSpans(
            sourceBytes,
            sourceOffsets,
            sourceLengths,
            compressionDictName,
            uncompressedBytes,
            !force,
        );
    }

    /**
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string} compressionDictName
     * @param {number} uncompressedBytes
     * @param {boolean} initialSelection
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>}}
     */
    _beginAppendSharedSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, uncompressedBytes, initialSelection) {
        const planStart = safePerformance.now();
        const packed = planContentSpansIntoSlabs(sourceLengths, this._blockTargetBytes);
        let packMs = safePerformance.now() - planStart;
        const compression = (async () => {
            let compressedChunks;
            let envelopeMs = 0;
            let compressionStart = safePerformance.now();
            try {
                const result = await compressWrappedTermContentZstdSpansBatch(
                    sourceBytes,
                    sourceOffsets,
                    sourceLengths,
                    packed.blockStartIndexes,
                    packed.packedChunkLengths,
                    compressionDictName,
                );
                compressedChunks = result.chunks;
                envelopeMs = result.envelopeMs;
                if (!result.wrapped) {
                    const envelopeStart = safePerformance.now();
                    compressedChunks = compressedChunks.map(wrapCompressedTermContentBlock);
                    envelopeMs += safePerformance.now() - envelopeStart;
                }
                validateCompressedChunks(compressedChunks, packed.packedChunkLengths.length);
            } catch (_) {
                const retryPackStart = safePerformance.now();
                const packedChunks = packPlannedContentSpansIntoSlabs(
                    sourceBytes,
                    sourceOffsets,
                    sourceLengths,
                    packed.blockStartIndexes,
                    packed.packedChunkLengths,
                );
                packMs += safePerformance.now() - retryPackStart;
                compressionStart = safePerformance.now();
                compressedChunks = packedChunks.map((content) => {
                    const compressed = compressTermContentZstd(content, compressionDictName);
                    const envelopeStart = safePerformance.now();
                    const wrapped = wrapCompressedTermContentBlock(compressed);
                    envelopeMs += safePerformance.now() - envelopeStart;
                    return wrapped;
                });
                validateCompressedChunks(compressedChunks, packed.packedChunkLengths.length);
            }
            const completedAt = safePerformance.now();
            const compressMs = Math.max(0, completedAt - compressionStart - envelopeMs);
            let compressedBytes = 0;
            for (const chunk of compressedChunks) { compressedBytes += chunk.byteLength; }
            return {chunks: compressedChunks, compressedBytes, packMs, compressMs, envelopeMs, completedAt};
        })();
        void compression.catch(() => {});

        const referenceLayout = createTermContentReferenceLayout(
            sourceLengths.length,
            this._referencePackTargetBytes,
        );
        let referenceMs = 0;
        const append = this._contentStore.beginAppendBatchWithDerivedPrefix(
            compression.then(({chunks}) => chunks),
            referenceLayout.slabLengths,
            (blockOffsets, blockLengths) => {
                const referenceStart = safePerformance.now();
                const references = createTermContentReferenceSlabs(
                    packed,
                    packed.packedChunkLengths,
                    sourceLengths,
                    blockOffsets,
                    blockLengths,
                    referenceLayout.entriesPerSlab,
                );
                referenceMs += safePerformance.now() - referenceStart;
                return references;
            },
        );
        const storage = append.reserved.then(({derivedOffsets}) => ({
            contentOffsets: createTermContentReferenceOffsets(
                sourceLengths.length,
                derivedOffsets,
                referenceLayout.entriesPerSlab,
            ),
            contentLengths: sourceLengths,
            contentDictName: createRawTermContentCompactBlockDictName(compressionDictName),
        }));
        void storage.catch(() => {});
        const completion = (async () => {
            const [, compressionResult, storageResult] = await Promise.all([
                append.completion,
                compression,
                storage,
            ]);
            const opfsAppendMs = Math.max(
                0,
                safePerformance.now() - compressionResult.completedAt - referenceMs,
            );
            const referenceBytes = sourceLengths.length * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
            const initialSelectionSavingsMiss = initialSelection && (
                compressionResult.compressedBytes + referenceBytes >
                uncompressedBytes * (1 - this._minSavingsRatio)
            );
            if (initialSelectionSavingsMiss) {
                reportDiagnostics('term-content-initial-reservation-savings-miss', {
                    compressionDictName,
                    compressedBytes: compressionResult.compressedBytes,
                    referenceBytes,
                    uncompressedBytes,
                    minSavingsRatio: this._minSavingsRatio,
                });
            }
            return {
                ...storageResult,
                compressedBytes: compressionResult.compressedBytes,
                uncompressedBytes,
                packMs: compressionResult.packMs,
                compressMs: compressionResult.compressMs,
                envelopeMs: compressionResult.envelopeMs,
                referenceMs,
                opfsAppendMs,
                initialSelectionSavingsMiss,
            };
        })();
        void completion.catch(() => {});
        return {storage, completion};
    }

    /**
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async _tryAppendSharedSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force) {
        let uncompressedBytes = 0;
        for (const length of sourceLengths) { uncompressedBytes += length; }
        if (!force && uncompressedBytes < this._minInputBytes) { return null; }

        let phaseStart = safePerformance.now();
        const packed = planContentSpansIntoSlabs(sourceLengths, this._blockTargetBytes);
        const packMs = safePerformance.now() - phaseStart;
        let compressedChunks;
        let envelopeMs = 0;
        phaseStart = safePerformance.now();
        try {
            const result = await compressWrappedTermContentZstdSpansBatch(
                sourceBytes,
                sourceOffsets,
                sourceLengths,
                packed.blockStartIndexes,
                packed.packedChunkLengths,
                compressionDictName,
            );
            compressedChunks = result.chunks;
            envelopeMs = result.envelopeMs;
            if (!result.wrapped) {
                const envelopeStart = safePerformance.now();
                compressedChunks = compressedChunks.map(wrapCompressedTermContentBlock);
                envelopeMs += safePerformance.now() - envelopeStart;
            }
            validateCompressedChunks(compressedChunks, packed.packedChunkLengths.length);
        } catch (_) {
            return await this._tryAppendPacked(
                () => packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, this._blockTargetBytes),
                sourceLengths,
                compressionDictName,
                force,
            );
        }
        const compressMs = Math.max(0, safePerformance.now() - phaseStart - envelopeMs);
        return await this._appendCompressedBlocks(
            packed,
            packed.packedChunkLengths,
            sourceLengths,
            compressionDictName,
            force,
            compressedChunks,
            uncompressedBytes,
            packMs,
            compressMs,
            envelopeMs,
        );
    }

    /**
     * @param {() => ReturnType<typeof packContentChunksIntoSlabs>} pack
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async _tryAppendPacked(pack, sourceLengths, compressionDictName, force) {
        let uncompressedBytes = 0;
        for (const length of sourceLengths) { uncompressedBytes += length; }
        if (!force && uncompressedBytes < this._minInputBytes) { return null; }

        let phaseStart = safePerformance.now();
        let packed = pack();
        let packMs = safePerformance.now() - phaseStart;
        let packedChunkLengths = Uint32Array.from(packed.packedChunks, ({byteLength}) => byteLength);
        /** @type {Uint8Array[]} */
        let compressedChunks;
        let envelopeMs = 0;
        phaseStart = safePerformance.now();
        try {
            const result = await compressWrappedTermContentZstdBatch(packed.packedChunks, compressionDictName);
            compressedChunks = result.chunks;
            envelopeMs = result.envelopeMs;
            if (!result.wrapped) {
                const envelopeStart = safePerformance.now();
                compressedChunks = compressedChunks.map(wrapCompressedTermContentBlock);
                envelopeMs += safePerformance.now() - envelopeStart;
            }
            validateCompressedChunks(compressedChunks, packed.packedChunks.length);
        } catch (_) {
            // Worker dispatch may detach packed slabs. Repack from stable source
            // bytes before using the synchronous fallback.
            const retryPackStart = safePerformance.now();
            packed = pack();
            packMs += safePerformance.now() - retryPackStart;
            phaseStart = safePerformance.now();
            packedChunkLengths = Uint32Array.from(packed.packedChunks, ({byteLength}) => byteLength);
            compressedChunks = packed.packedChunks.map((content) => {
                const compressed = compressTermContentZstd(content, compressionDictName);
                const envelopeStart = safePerformance.now();
                const wrapped = wrapCompressedTermContentBlock(compressed);
                envelopeMs += safePerformance.now() - envelopeStart;
                return wrapped;
            });
            validateCompressedChunks(compressedChunks, packed.packedChunks.length);
        }
        const compressMs = Math.max(0, safePerformance.now() - phaseStart - envelopeMs);
        return await this._appendCompressedBlocks(
            packed,
            packedChunkLengths,
            sourceLengths,
            compressionDictName,
            force,
            compressedChunks,
            uncompressedBytes,
            packMs,
            compressMs,
            envelopeMs,
        );
    }

    /**
     * @param {{sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}} packed
     * @param {Uint32Array} packedChunkLengths
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @param {Uint8Array[]} compressedChunks
     * @param {number} uncompressedBytes
     * @param {number} packMs
     * @param {number} compressMs
     * @param {number} envelopeMs
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async _appendCompressedBlocks(
        packed,
        packedChunkLengths,
        sourceLengths,
        compressionDictName,
        force,
        compressedChunks,
        uncompressedBytes,
        packMs,
        compressMs,
        envelopeMs,
    ) {
        let compressedBytes = 0;
        for (const compressed of compressedChunks) {
            compressedBytes += compressed.byteLength;
        }
        const referenceBytes = sourceLengths.length * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
        if (!force && (compressedBytes + referenceBytes) > uncompressedBytes * (1 - this._minSavingsRatio)) {
            return null;
        }

        const referenceLayout = createTermContentReferenceLayout(
            sourceLengths.length,
            this._referencePackTargetBytes,
        );
        let referenceMs = 0;
        const phaseStart = safePerformance.now();
        const appendResult = await this._contentStore.appendBatchWithDerivedChunks(
            compressedChunks,
            (blockOffsets, blockLengths) => {
                const referenceStart = safePerformance.now();
                const referenceSlabs = createTermContentReferenceSlabs(
                    packed,
                    packedChunkLengths,
                    sourceLengths,
                    blockOffsets,
                    blockLengths,
                    referenceLayout.entriesPerSlab,
                );
                referenceMs += safePerformance.now() - referenceStart;
                return referenceSlabs;
            },
        );
        const opfsAppendMs = safePerformance.now() - phaseStart - referenceMs;
        const contentOffsets = createTermContentReferenceOffsets(
            sourceLengths.length,
            appendResult.derivedOffsets,
            referenceLayout.entriesPerSlab,
        );
        return {
            contentOffsets,
            contentLengths: sourceLengths,
            contentDictName: createRawTermContentCompactBlockDictName(compressionDictName),
            compressedBytes,
            uncompressedBytes,
            packMs,
            compressMs,
            envelopeMs,
            referenceMs,
            opfsAppendMs,
        };
    }

    /**
     * @param {string} eventName
     * @param {Record<string, unknown>} details
     */
    _recordError(eventName, details) {
        this._lastError = details;
        reportDiagnostics(eventName, details);
    }
}

/**
 * @param {unknown} chunks
 * @param {number} expectedCount
 * @returns {asserts chunks is Uint8Array[]}
 * @throws {TypeError} If the compressor returns malformed output.
 */
function validateCompressedChunks(chunks, expectedCount) {
    if (
        !Array.isArray(chunks) ||
        chunks.length !== expectedCount ||
        chunks.some((chunk) => !(chunk instanceof Uint8Array))
    ) {
        throw new Error(
            `Invalid term content compression result: expected ${expectedCount} byte chunks`,
        );
    }
}

/**
 * Uses evenly distributed samples from logical content spans, rather than the
 * parser's capacity-sized backing slab. The entropy estimate is deliberately
 * charged an extra savings margin because it is only a predictor of Zstd's
 * eventual output size.
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} uncompressedBytes
 * @param {number} minInputBytes
 * @param {number} minSavingsRatio
 * @returns {boolean}
 */
function shouldSelectInitialSharedBlockStorage(
    sourceBytes,
    sourceOffsets,
    sourceLengths,
    uncompressedBytes,
    minInputBytes,
    minSavingsRatio,
) {
    if (uncompressedBytes < minInputBytes || uncompressedBytes === 0) { return false; }
    const referenceBytes = sourceLengths.length * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
    const targetBytes = uncompressedBytes * (1 - minSavingsRatio - EARLY_SELECTION_SAVINGS_MARGIN);
    if (referenceBytes >= targetBytes) { return false; }

    const sampledSpanCount = Math.min(sourceLengths.length, EARLY_SELECTION_MAX_SPANS);
    const samplesPerSpan = Math.max(1, Math.floor(EARLY_SELECTION_MAX_SAMPLES / sampledSpanCount));
    const frequencies = new Uint32Array(256);
    let sampleCount = 0;
    for (let sampleSpanIndex = 0; sampleSpanIndex < sampledSpanCount; ++sampleSpanIndex) {
        const spanIndex = Math.floor(sampleSpanIndex * sourceLengths.length / sampledSpanCount);
        const spanLength = sourceLengths[spanIndex];
        const spanSampleCount = Math.min(spanLength, samplesPerSpan);
        const spanOffset = sourceOffsets[spanIndex];
        for (let i = 0; i < spanSampleCount; ++i) {
            frequencies[sourceBytes[spanOffset + Math.floor(i * spanLength / spanSampleCount)]] += 1;
        }
        sampleCount += spanSampleCount;
    }
    if (sampleCount === 0) { return false; }

    let entropyBits = 0;
    for (const frequency of frequencies) {
        if (frequency === 0) { continue; }
        const probability = frequency / sampleCount;
        entropyBits -= probability * Math.log2(probability);
    }
    const estimatedCompressedBytes = uncompressedBytes * entropyBits / 8;
    return estimatedCompressedBytes + referenceBytes <= targetBytes;
}

/**
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @returns {number} The total number of logical source bytes.
 * @throws {TypeError|RangeError} If the source span table is malformed.
 */
function validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths) {
    if (!(sourceBytes instanceof Uint8Array)) {
        throw new TypeError('Term content source must be a Uint8Array');
    }
    if (
        !(sourceOffsets instanceof Uint32Array) ||
        !(sourceLengths instanceof Uint32Array) ||
        sourceOffsets.length !== sourceLengths.length
    ) {
        throw new TypeError('Term content span offsets and lengths must be equally sized Uint32Arrays');
    }
    let totalBytes = 0;
    for (let i = 0; i < sourceOffsets.length; ++i) {
        const start = sourceOffsets[i];
        const length = sourceLengths[i];
        if (start > sourceBytes.byteLength || length > sourceBytes.byteLength - start) {
            throw new RangeError(`Term content span ${i} is out of bounds`);
        }
        totalBytes += length;
    }
    return totalBytes;
}

/**
 * @param {number} entryCount
 * @param {number} targetBytes
 * @returns {{entriesPerSlab: number, slabLengths: Uint32Array}}
 */
function createTermContentReferenceLayout(entryCount, targetBytes) {
    const entriesPerSlab = Math.max(
        1,
        Math.floor(targetBytes / RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES),
    );
    const slabCount = Math.ceil(entryCount / entriesPerSlab);
    const slabLengths = new Uint32Array(slabCount);
    for (let slabIndex = 0; slabIndex < slabCount; ++slabIndex) {
        slabLengths[slabIndex] = Math.min(
            entriesPerSlab,
            entryCount - slabIndex * entriesPerSlab,
        ) * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
    }
    return {entriesPerSlab, slabLengths};
}

/**
 * @param {{sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}} packed
 * @param {Uint32Array} packedChunkLengths
 * @param {Uint32Array} sourceLengths
 * @param {number[]} blockOffsets
 * @param {number[]} blockLengths
 * @param {number} entriesPerSlab
 * @returns {Uint8Array[]}
 */
function createTermContentReferenceSlabs(
    packed,
    packedChunkLengths,
    sourceLengths,
    blockOffsets,
    blockLengths,
    entriesPerSlab,
) {
    const slabCount = Math.ceil(sourceLengths.length / entriesPerSlab);
    const referenceSlabs = new Array(slabCount);
    for (let slabIndex = 0; slabIndex < slabCount; ++slabIndex) {
        const startIndex = slabIndex * entriesPerSlab;
        const entryCount = Math.min(entriesPerSlab, sourceLengths.length - startIndex);
        const slab = new Uint8Array(entryCount * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES);
        const view = new DataView(slab.buffer, slab.byteOffset, slab.byteLength);
        for (let localIndex = 0; localIndex < entryCount; ++localIndex) {
            const contentIndex = startIndex + localIndex;
            const blockIndex = packed.sourceChunkIndices[contentIndex];
            writeRawTermContentCompactBlockReference(
                view,
                localIndex * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES,
                blockOffsets[blockIndex],
                blockLengths[blockIndex],
                packedChunkLengths[blockIndex],
                packed.sourceChunkLocalOffsets[contentIndex],
            );
        }
        referenceSlabs[slabIndex] = slab;
    }
    return referenceSlabs;
}

/**
 * @param {number} entryCount
 * @param {number[]} slabOffsets
 * @param {number} entriesPerSlab
 * @returns {Float64Array}
 * @throws {RangeError} If a reserved slab offset is invalid.
 */
function createTermContentReferenceOffsets(entryCount, slabOffsets, entriesPerSlab) {
    const contentOffsets = new Float64Array(entryCount);
    for (let i = 0; i < entryCount; ++i) {
        const slabIndex = Math.floor(i / entriesPerSlab);
        const slabOffset = slabOffsets[slabIndex];
        if (!Number.isSafeInteger(slabOffset) || slabOffset < 0) {
            throw new RangeError(`Invalid term content reference slab offset: ${slabOffset}`);
        }
        const contentOffset = slabOffset +
        (i % entriesPerSlab) * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
        if (!Number.isSafeInteger(contentOffset)) {
            throw new RangeError(`Term content reference offset exceeds the safe integer range: ${contentOffset}`);
        }
        contentOffsets[i] = contentOffset;
    }
    return contentOffsets;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} targetBytes
 * @returns {{packedChunks: Uint8Array[], sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}}
 */
function packContentChunksIntoSlabs(chunks, targetBytes) {
    /** @type {Uint8Array[]} */
    const packedChunks = [];
    const sourceChunkIndices = new Uint32Array(chunks.length);
    const sourceChunkLocalOffsets = new Uint32Array(chunks.length);
    let startIndex = 0;
    while (startIndex < chunks.length) {
        let totalBytes = 0;
        let endIndex = startIndex;
        while (endIndex < chunks.length) {
            const nextBytes = chunks[endIndex].byteLength;
            if (totalBytes > 0 && (totalBytes + nextBytes) > targetBytes) {
                break;
            }
            totalBytes += nextBytes;
            ++endIndex;
        }
        const packedIndex = packedChunks.length;
        const output = new Uint8Array(totalBytes);
        let offset = 0;
        for (let i = startIndex; i < endIndex; ++i) {
            const bytes = chunks[i];
            sourceChunkIndices[i] = packedIndex;
            sourceChunkLocalOffsets[i] = offset;
            output.set(bytes, offset);
            offset += bytes.byteLength;
        }
        packedChunks.push(output);
        startIndex = endIndex;
    }
    return {packedChunks, sourceChunkIndices, sourceChunkLocalOffsets};
}

/**
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunkLengths: Uint32Array, blockStartIndexes: Uint32Array, sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}}
 * @throws {RangeError} If a planned block cannot use the 32-bit storage format.
 */
function planContentSpansIntoSlabs(sourceLengths, targetBytes) {
    /** @type {number[]} */
    const packedChunkLengths = [];
    /** @type {number[]} */
    const blockStartIndexes = [0];
    const sourceChunkIndices = new Uint32Array(sourceLengths.length);
    const sourceChunkLocalOffsets = new Uint32Array(sourceLengths.length);
    let startIndex = 0;
    while (startIndex < sourceLengths.length) {
        let totalBytes = 0;
        let endIndex = startIndex;
        while (endIndex < sourceLengths.length) {
            const nextBytes = sourceLengths[endIndex];
            if (totalBytes > 0 && (totalBytes + nextBytes) > targetBytes) {
                break;
            }
            totalBytes += nextBytes;
            ++endIndex;
        }
        if (totalBytes > 0xffffffff) {
            throw new RangeError('Packed term content block exceeds the 32-bit storage format');
        }
        const packedIndex = packedChunkLengths.length;
        let localOffset = 0;
        for (let i = startIndex; i < endIndex; ++i) {
            sourceChunkIndices[i] = packedIndex;
            sourceChunkLocalOffsets[i] = localOffset;
            localOffset += sourceLengths[i];
        }
        packedChunkLengths.push(totalBytes);
        blockStartIndexes.push(endIndex);
        startIndex = endIndex;
    }
    return {
        packedChunkLengths: Uint32Array.from(packedChunkLengths),
        blockStartIndexes: Uint32Array.from(blockStartIndexes),
        sourceChunkIndices,
        sourceChunkLocalOffsets,
    };
}

/**
 * Re-packs a stable shared source using the exact block plan whose reference
 * offsets were already reserved.
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {Uint32Array} blockStartIndexes
 * @param {Uint32Array} packedChunkLengths
 * @returns {Uint8Array[]}
 * @throws {RangeError} If the preserved block plan is inconsistent.
 */
function packPlannedContentSpansIntoSlabs(
    sourceBytes,
    sourceOffsets,
    sourceLengths,
    blockStartIndexes,
    packedChunkLengths,
) {
    if (blockStartIndexes.length !== packedChunkLengths.length + 1) {
        throw new RangeError('Packed term content fallback plan is invalid');
    }
    const packedChunks = new Array(packedChunkLengths.length);
    for (let blockIndex = 0; blockIndex < packedChunks.length; ++blockIndex) {
        const output = new Uint8Array(packedChunkLengths[blockIndex]);
        let outputOffset = 0;
        const startIndex = blockStartIndexes[blockIndex];
        const endIndex = blockStartIndexes[blockIndex + 1];
        for (let i = startIndex; i < endIndex; ++i) {
            const length = sourceLengths[i];
            output.set(sourceBytes.subarray(sourceOffsets[i], sourceOffsets[i] + length), outputOffset);
            outputOffset += length;
        }
        if (outputOffset !== output.byteLength) {
            throw new RangeError(`Packed term content fallback block ${blockIndex} has an invalid length`);
        }
        packedChunks[blockIndex] = output;
    }
    return packedChunks;
}

/**
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunks: Uint8Array[], sourceChunkIndices: Uint32Array, sourceChunkLocalOffsets: Uint32Array}}
 */
function packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, targetBytes) {
    const packedChunks = [];
    const sourceChunkIndices = new Uint32Array(sourceLengths.length);
    const sourceChunkLocalOffsets = new Uint32Array(sourceLengths.length);
    let startIndex = 0;
    while (startIndex < sourceLengths.length) {
        let totalBytes = 0;
        let endIndex = startIndex;
        while (endIndex < sourceLengths.length) {
            const nextBytes = sourceLengths[endIndex];
            if (totalBytes > 0 && (totalBytes + nextBytes) > targetBytes) {
                break;
            }
            totalBytes += nextBytes;
            ++endIndex;
        }
        const packedIndex = packedChunks.length;
        const output = new Uint8Array(totalBytes);
        let outputOffset = 0;
        for (let i = startIndex; i < endIndex; ++i) {
            const sourceOffset = sourceOffsets[i];
            const length = sourceLengths[i];
            sourceChunkIndices[i] = packedIndex;
            sourceChunkLocalOffsets[i] = outputOffset;
            output.set(sourceBytes.subarray(sourceOffset, sourceOffset + length), outputOffset);
            outputOffset += length;
        }
        packedChunks.push(output);
        startIndex = endIndex;
    }
    return {packedChunks, sourceChunkIndices, sourceChunkLocalOffsets};
}
