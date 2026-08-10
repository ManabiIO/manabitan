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
import {
    createRawTermContentBlockDictName,
    decodeRawTermContentBlockReference,
    getRawTermContentBlockCompressionDictName,
    RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES,
    writeRawTermContentBlockReference,
} from './raw-term-content.js';
import {compressTermContentZstd, compressTermContentZstdBatch, decompressTermContentZstd} from './zstd-term-content.js';

const DEFAULT_BLOCK_TARGET_BYTES = 2 * 1024 * 1024;
const DEFAULT_REFERENCE_PACK_TARGET_BYTES = 4 * 1024 * 1024;
const DEFAULT_MIN_INPUT_BYTES = 512 * 1024;
const DEFAULT_MIN_SAVINGS_RATIO = 0.1;
const DEFAULT_CACHE_MAX_BYTES = 48 * 1024 * 1024;

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
     * @returns {Promise<{contentOffsets: number[], contentLengths: number[], contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
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
     * @returns {Promise<{contentOffsets: number[], contentLengths: number[], contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
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

    /** @returns {Record<string, unknown>} */
    getDiagnostics() {
        return {
            cacheEntries: this._cache.size,
            cacheBytes: this._cache.bytes,
            cacheMaxBytes: this._cacheMaxBytes,
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
        const compressionDictName = getRawTermContentBlockCompressionDictName(contentDictName);
        if (typeof compressionDictName === 'undefined') {
            return await this._contentStore.readSlice(contentOffset, contentLength);
        }
        const referenceBytes = await this._contentStore.readSlice(contentOffset, RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
        if (!(referenceBytes instanceof Uint8Array)) { return null; }
        const reference = decodeRawTermContentBlockReference(referenceBytes);
        if (reference === null || reference.entryLength !== contentLength) {
            this._recordError('term-content-block-reference-invalid', {
                contentOffset,
                contentLength,
                contentDictName,
                referencePrefix: [...referenceBytes.subarray(0, 8)],
                decodedEntryLength: reference?.entryLength ?? null,
            });
            return null;
        }
        const cacheKey = `${contentDictName}:${reference.blockOffset}:${reference.blockCompressedLength}:${reference.blockUncompressedLength}`;
        let block = this._cache.get(cacheKey);
        if (typeof block === 'undefined') {
            const loadedBlock = await this._getOrLoadBlock(cacheKey, reference, compressionDictName, {
                contentOffset,
                contentLength,
                contentDictName,
            });
            if (loadedBlock === null) { return null; }
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
            return null;
        }
        return block.subarray(reference.entryOffset, entryEnd);
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
        const compressed = await this._contentStore.readSlice(reference.blockOffset, reference.blockCompressedLength);
        if (!(compressed instanceof Uint8Array)) { return null; }
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
            return null;
        }
        if (block.byteLength !== reference.blockUncompressedLength) {
            this._recordError('term-content-block-length-mismatch', {
                contentDictName: context.contentDictName,
                blockOffset: reference.blockOffset,
                expectedLength: reference.blockUncompressedLength,
                actualLength: block.byteLength,
            });
            return null;
        }
        this._lastError = null;
        this._cache.set(cacheKey, block);
        return block;
    }

    /**
     * @param {Uint8Array[]} contentBytesList
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: number[], contentLengths: number[], contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
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
     * @returns {Promise<{contentOffsets: number[], contentLengths: number[], contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async tryAppendSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force = false) {
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
        if (sourceOffsets.length === 0) { return null; }
        for (let i = 0; i < sourceOffsets.length; ++i) {
            const start = sourceOffsets[i];
            const length = sourceLengths[i];
            if (start > sourceBytes.byteLength || length > sourceBytes.byteLength - start) {
                throw new RangeError(`Term content span ${i} is out of bounds`);
            }
        }
        return await this._tryAppendPacked(
            () => packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, this._blockTargetBytes),
            sourceLengths,
            compressionDictName,
            force,
        );
    }

    /**
     * @param {() => ReturnType<typeof packContentChunksIntoSlabs>} pack
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: number[], contentLengths: number[], contentDictName: string, compressedBytes: number, uncompressedBytes: number}|null>}
     */
    async _tryAppendPacked(pack, sourceLengths, compressionDictName, force) {
        let uncompressedBytes = 0;
        for (const length of sourceLengths) { uncompressedBytes += length; }
        if (!force && uncompressedBytes < this._minInputBytes) { return null; }

        let packed = pack();
        let packedChunkLengths = Uint32Array.from(packed.packedChunks, ({byteLength}) => byteLength);
        /** @type {Uint8Array[]} */
        let compressedChunks;
        try {
            compressedChunks = await compressTermContentZstdBatch(packed.packedChunks, compressionDictName);
            validateCompressedChunks(compressedChunks, packed.packedChunks.length);
        } catch (_) {
            // Worker dispatch may detach packed slabs. Repack from stable source
            // bytes before using the synchronous fallback.
            packed = pack();
            packedChunkLengths = Uint32Array.from(packed.packedChunks, ({byteLength}) => byteLength);
            compressedChunks = packed.packedChunks.map(
                (content) => Uint8Array.from(compressTermContentZstd(content, compressionDictName)),
            );
            validateCompressedChunks(compressedChunks, packed.packedChunks.length);
        }
        let compressedBytes = 0;
        for (const compressed of compressedChunks) {
            compressedBytes += compressed.byteLength;
        }
        const referenceBytes = sourceLengths.length * RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES;
        if (!force && (compressedBytes + referenceBytes) > uncompressedBytes * (1 - this._minSavingsRatio)) {
            return null;
        }

        const referenceEntriesPerSlab = Math.max(1, Math.floor(this._referencePackTargetBytes / RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES));
        const appendResult = await this._contentStore.appendBatchWithDerivedChunks(
            compressedChunks,
            (blockOffsets, blockLengths) => {
                const slabCount = Math.ceil(sourceLengths.length / referenceEntriesPerSlab);
                /** @type {Uint8Array[]} */
                const referenceSlabs = new Array(slabCount);
                for (let slabIndex = 0; slabIndex < slabCount; ++slabIndex) {
                    const startIndex = slabIndex * referenceEntriesPerSlab;
                    const entryCount = Math.min(referenceEntriesPerSlab, sourceLengths.length - startIndex);
                    const slab = new Uint8Array(entryCount * RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES);
                    const view = new DataView(slab.buffer, slab.byteOffset, slab.byteLength);
                    for (let localIndex = 0; localIndex < entryCount; ++localIndex) {
                        const contentIndex = startIndex + localIndex;
                        const blockIndex = packed.sourceChunkIndices[contentIndex];
                        writeRawTermContentBlockReference(
                            view,
                            localIndex * RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES,
                            blockOffsets[blockIndex],
                            blockLengths[blockIndex],
                            packedChunkLengths[blockIndex],
                            packed.sourceChunkLocalOffsets[contentIndex],
                            sourceLengths[contentIndex],
                        );
                    }
                    referenceSlabs[slabIndex] = slab;
                }
                return referenceSlabs;
            },
        );
        const referenceSlabOffsets = appendResult.derivedOffsets;
        const contentOffsets = new Array(sourceLengths.length);
        const contentLengths = new Array(sourceLengths.length);
        for (let i = 0; i < sourceLengths.length; ++i) {
            const referenceSlabIndex = Math.floor(i / referenceEntriesPerSlab);
            const referenceSlabLocalIndex = i % referenceEntriesPerSlab;
            contentOffsets[i] = referenceSlabOffsets[referenceSlabIndex] + referenceSlabLocalIndex * RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES;
            contentLengths[i] = sourceLengths[i];
        }
        return {
            contentOffsets,
            contentLengths,
            contentDictName: createRawTermContentBlockDictName(compressionDictName),
            compressedBytes,
            uncompressedBytes,
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
