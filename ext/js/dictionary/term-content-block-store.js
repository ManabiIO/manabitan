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

import {getLegacyTermContentZstdCodecId} from './term-content-zstd-codec.js';
import {snapshotTermBankExperiments} from './term-bank-experiments.js';
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
import {TermContentIntegrityError} from './term-content-opfs-store.js';
import {hashTermEntryContentBytesPair} from './term-entry-content-hash.js';
import {beginCompressWrappedTermContentZstdSpansBatch, compressTermContentZstd, compressWrappedTermContentZstdBatch, compressWrappedTermContentZstdBlocks, compressWrappedTermContentZstdSpansBatch, decompressTermContentZstd} from './zstd-term-content.js';
import {isZstdResourceError} from './zstd-resource-error.js';
import {advanceZstdFrameInspection, beginZstdFrameInspection, ZstdFrameInspectionError} from './term-content-zstd-frame-inspector.js';

export {wrapCompressedTermContentBlock} from './term-content-block-envelope.js';

/**
 * @typedef {import('./term-content-layout.js').FrameIdentity} TermContentFrameIdentity
 * @typedef {{bytes: Uint8Array, codecId: string|null, envelope: 'mbc2'|'none', decodedLength: number|null, physicalKey: string, release: () => void}} TermContentResolvedFrame
 * @typedef {{status: 'ok', bytes: Uint8Array}|{status: 'unavailable'}|{status: 'error', error: unknown}} TermContentSliceResult
 * @typedef {object} TermContentReadContext
 * @property {(offset: number, length: number) => Promise<Uint8Array|null>} readSlice
 * @property {(requests: Array<{offset: number, length: number}>) => Promise<TermContentSliceResult[]>} readSlicesDetailed
 * @property {(identity: TermContentFrameIdentity) => Promise<TermContentResolvedFrame|null>} resolveFrame
 * @property {number} [logicalHighWater] Committed end under the leased root.
 * @property {(query: {kind: 'legacy-entry', logicalOffset: number, recordLength: number, originalCodecId: string|null}) => Promise<TermContentFrameIdentity|null>} [findFrameOverride] Looks up replacement identity before inspecting retired source bytes.
 * @property {() => TermContentReadContext} fork
 * @property {() => void} release
 * @property {string} [rootKey] Stable immutable root identity for sharing pending I/O.
 * @property {(identity: TermContentFrameIdentity, physicalKey: string) => Promise<boolean>} [isCurrentFrame] Compares physical source, not merely root epoch.
 * @property {(identity: TermContentFrameIdentity, layoutId: string) => Promise<boolean>} [isCurrentFrameLayout] Compares the owner of a failed frame manifest.
 * @property {(offset: number, length: number) => Promise<boolean>} [isCurrentRange] Compares retained reference/header physical spans across roots.
 */

class TermContentReadError extends Error {
    /**
     * @param {'temporarilyUnavailable'|'corrupt'} status
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(status, message, options) {
        super(message, options);
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
const RAW_CONTENT_SELECTORS = new Set(['raw', 'raw-v2', 'raw-v3', 'raw-v4', 'raw-v6']);
const LEGACY_INSPECTION_MAX_BLOCKS = 1024;
const LEGACY_DECODE_MAX_BYTES = 128 * 1024 * 1024;
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
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
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
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
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
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, sourceConsumed: Promise<void>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>, initialSelection: boolean}|null}
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

    /**
     * @returns {number}
     */
    get size() { return this._values.size; }
    /**
     * @returns {number}
     */
    get bytes() { return this._bytes; }
    /**
     * @returns {number}
     */
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
        /** @type {ReturnType<typeof snapshotTermBankExperiments>} */
        this._compressionExperiments = snapshotTermBankExperiments();
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
        /** @type {Map<string|symbol, Promise<Uint8Array|null>>} */
        this._inFlightBlocks = new Map();
        /** @type {((identity: TermContentFrameIdentity) => Promise<TermContentResolvedFrame|null>)|null} */
        this._onlineFrameResolver = null;
        /** @type {(() => TermContentReadContext|null)|null} */
        this._readContextProvider = null;
        /** @type {number} */
        this._cacheGeneration = 0;
        /** @type {Record<string, unknown>|null} */
        this._lastError = null;
    }

    /**
     * @returns {TermContentBlockImportSession}
     */
    beginImportSession() {
        return new TermContentBlockImportSession(this);
    }

    /** */
    clearCache() {
        ++this._cacheGeneration;
        this._cache.clear();
        // Old readers retain their promises, but new readers must not join them.
        this._inFlightBlocks.clear();
    }

    /**
     * @param {import('dictionary-importer').ImportExperiments} [options]
     */
    setCompressionExperiments(options = {}) {
        this._compressionExperiments = snapshotTermBankExperiments(options);
    }

    /**
     * Installs the optional immutable physical-frame resolver. A null result
     * means the original OPFS content stream remains authoritative.
     * @param {(identity: TermContentFrameIdentity) => Promise<TermContentResolvedFrame|null>} resolver
     * @throws {TypeError} If the provider is not callable.
     */
    setOnlineFrameResolver(resolver) {
        if (typeof resolver !== 'function') { throw new TypeError('Online frame resolver must be callable'); }
        this._onlineFrameResolver = resolver;
    }

    /**
     * Acquires the request root synchronously, before reference I/O starts.
     * Logical decoded caches survive compression-only root publication.
     * @param {(() => TermContentReadContext|null)|null} provider
     * @throws {TypeError} If the provider is not callable.
     */
    setReadContextProvider(provider) {
        if (provider !== null && typeof provider !== 'function') { throw new TypeError('Content read context provider must be callable'); }
        this._readContextProvider = provider;
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

    /**
     * @returns {Record<string, unknown>}
     */
    getDiagnostics() {
        return {
            compressionExperiments: this._compressionExperiments,
            cacheEntries: this._cache.size,
            cacheBytes: this._cache.bytes,
            cacheMaxBytes: this._cacheMaxBytes,
            blockTargetBytes: this._blockTargetBytes,
            inFlightBlocks: this._inFlightBlocks.size,
            lastError: this._lastError === null ? null : {...this._lastError},
        };
    }

    /**
     * Returns canonical entry payload bytes for every stored representation.
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
        const generation = this._cacheGeneration;
        for (let attempt = 0; attempt < 2; ++attempt) {
            /** @type {TermContentReadContext|null} */
            let readContext = null;
            try {
                readContext = this._readContextProvider?.() ?? null;
                const result = await this._readDetailed(contentOffset, contentLength, contentDictName, readContext);
                this._assertReadGeneration(generation);
                return result;
            } catch (error) {
                if (generation !== this._cacheGeneration) { return this._createInvalidatedReadFailure(); }
                const failure = this._createReadFailure(error);
                if (attempt === 0 && failure.status === 'corrupt' && readContext?.isCurrentRange &&
                (RAW_CONTENT_SELECTORS.has(contentDictName) || typeof getRawTermContentBlockCompressionDictName(contentDictName) !== 'undefined')) {
                    try {
                        const current = await readContext.isCurrentRange(contentOffset, this._getReferenceReadLength(contentLength, contentDictName));
                        this._assertReadGeneration(generation);
                        if (!current) { continue; }
                    } catch (currentError) { return this._createReadFailure(currentError); }
                }
                return failure;
            } finally {
                readContext?.release();
            }
        }
        return this._createInvalidatedReadFailure();
    }

    /**
     * Reads a verification wave while loading each referenced compressed block
     * once. Results preserve request order and every started operation settles
     * before this method returns.
     * @param {Array<{contentOffset: number, contentLength: number, contentDictName: string}>} requests
     * @returns {Promise<Array<{status: 'ok', bytes: Uint8Array}|{status: 'temporarilyUnavailable'|'corrupt', reason: string}>>}
     */
    async readDetailedBatch(requests) {
        const generation = this._cacheGeneration;
        for (let attempt = 0; attempt < 2; ++attempt) {
            /** @type {TermContentReadContext|null} */
            let readContext = null;
            try {
                readContext = this._readContextProvider?.() ?? null;
                const results = await this._readDetailedBatch(requests, readContext);
                if (attempt === 0 && readContext?.isCurrentRange && results.some((result) => result.status === 'corrupt')) {
                    const context = readContext;
                    const checks = await Promise.allSettled(results.map(async (result, index) => {
                        if (result.status !== 'corrupt') { return true; }
                        const request = requests[index];
                        if (!RAW_CONTENT_SELECTORS.has(request.contentDictName) &&
                        typeof getRawTermContentBlockCompressionDictName(request.contentDictName) === 'undefined') { return true; }
                        return await context.isCurrentRange?.(
                            request.contentOffset,
                            this._getReferenceReadLength(request.contentLength, request.contentDictName),
                        );
                    }));
                    this._assertReadGeneration(generation);
                    let retry = false;
                    for (let index = 0; index < checks.length; ++index) {
                        const check = checks[index];
                        if (check.status === 'rejected') {
                            results[index] = this._createReadFailure(check.reason);
                        } else
                            if (check.value === false) {
                                retry = true;
                            }
                    }
                    if (retry) { continue; }
                }
                return results;
            } catch (error) {
                return requests.map(() => this._createReadFailure(error));
            } finally {
                readContext?.release();
            }
        }
        return requests.map(() => this._createInvalidatedReadFailure());
    }

    /**
     * Decodes an explicitly typed block, legacy entry or shared artifact under
     * one leased root. Raw-v4 per-entry headers use readDetailed instead.
     * @param {TermContentFrameIdentity} identity
     * @returns {Promise<{status: 'ok', bytes: Uint8Array}|{status: 'temporarilyUnavailable'|'corrupt', reason: string, cause?: unknown}>}
     */
    async readDecodedFrameDetailed(identity) {
        const generation = this._cacheGeneration;
        /** @type {TermContentReadContext|null} */
        let readContext = null;
        try {
            readContext = this._readContextProvider?.() ?? null;
            const bytes = await this._getOrLoadFrame(this._createFrameCacheKey(identity), identity, {
                contentOffset: identity.logicalOffset,
                contentLength: identity.recordLength,
                contentDictName: identity.originalCodecId ?? '',
            }, readContext);
            this._assertReadGeneration(generation);
            if (bytes === null) { throw new TermContentReadError('temporarilyUnavailable', 'Term content frame could not be loaded'); }
            return {status: 'ok', bytes};
        } catch (error) {
            if (generation !== this._cacheGeneration) { return this._createInvalidatedReadFailure(); }
            const failure = this._createReadFailure(error);
            return error instanceof Error && typeof error.cause !== 'undefined' ? {...failure, cause: error.cause} : failure;
        } finally { readContext?.release(); }
    }

    /**
     * @param {number} length
     * @param {string} dictName
     * @returns {number}
     */
    _getReferenceReadLength(length, dictName) {
        if (typeof getRawTermContentBlockCompressionDictName(dictName) === 'undefined') { return length; }
        return dictName === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX || dictName.startsWith(`${RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX}:`) ?
            RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES :
RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES;
    }

    /**
     * @param {Array<{contentOffset: number, contentLength: number, contentDictName: string}>} requests
     * @param {TermContentReadContext|null} readContext
     * @returns {Promise<Array<{status: 'ok', bytes: Uint8Array}|{status: 'temporarilyUnavailable'|'corrupt', reason: string}>>}
     */
    async _readDetailedBatch(requests, readContext) {
        const generation = this._cacheGeneration;
        const results = new Array(requests.length);
        /** @type {Array<{index: number, request: {contentOffset: number, contentLength: number, contentDictName: string}, compact: boolean|null, compressionDictName: string|null|undefined, sliceLength: number}>} */
        const sliceRequests = [];
        /** @type {Array<{index: number, request: {contentOffset: number, contentLength: number, contentDictName: string}}>} */
        const legacyRequests = [];
        for (let index = 0; index < requests.length; ++index) {
            const request = requests[index];
            const {contentLength, contentDictName} = request;
            const compressionDictName = getRawTermContentBlockCompressionDictName(contentDictName);
            if (typeof compressionDictName === 'undefined') {
                if (!RAW_CONTENT_SELECTORS.has(contentDictName)) {
                    legacyRequests.push({index, request});
                    continue;
                }
                sliceRequests.push({
                    index,
                    request,
                    compact: null,
                    compressionDictName,
                    sliceLength: contentLength,
                });
                continue;
            }
            const compact = contentDictName === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX ||
            contentDictName.startsWith(`${RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX}:`);
            sliceRequests.push({
                index,
                request,
                compact,
                compressionDictName,
                sliceLength: compact ? RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES : RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES,
            });
        }

        const sliceResults = sliceRequests.length === 0 ?
[] :
await (readContext ?? this._contentStore).readSlicesDetailed(sliceRequests.map(({request, sliceLength}) => ({
    offset: request.contentOffset,
    length: sliceLength,
})));
        if (generation !== this._cacheGeneration) {
            return requests.map(() => this._createInvalidatedReadFailure());
        }
        if (sliceResults.length !== sliceRequests.length) {
            throw new Error('Term content batch read returned an invalid result count');
        }
        /** @type {Map<string, {cacheKey: string, reference: {blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number, entryOffset: number, entryLength: number}, compressionDictName: string|null, context: {contentOffset: number, contentLength: number, contentDictName: string}, entries: Array<{index: number, reference: {blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number, entryOffset: number, entryLength: number}}>} >} */
        const groups = new Map();
        for (let i = 0; i < sliceRequests.length; ++i) {
            const {index, request, compact, compressionDictName} = sliceRequests[i];
            const {contentOffset, contentLength, contentDictName} = request;
            const sliceResult = sliceResults[i];
            if (sliceResult.status === 'error') {
                results[index] = this._createReadFailure(sliceResult.error);
                continue;
            }
            if (sliceResult.status === 'unavailable') {
                results[index] = {
                    status: 'temporarilyUnavailable',
                    reason: compact === null ?
                        'Term content could not be read from OPFS' :
                        'Term content block reference could not be read from OPFS',
                };
                continue;
            }
            const referenceBytes = sliceResult.bytes;
            if (compact === null || typeof compressionDictName === 'undefined') {
                results[index] = {status: 'ok', bytes: referenceBytes};
                continue;
            }
            const reference = compact ?
                decodeRawTermContentCompactBlockReference(referenceBytes, contentLength) :
                decodeRawTermContentBlockReference(referenceBytes);
            if (reference === null || reference.entryLength !== contentLength) {
                this._recordInvalidReference(contentOffset, contentLength, contentDictName, referenceBytes, reference);
                results[index] = {status: 'corrupt', reason: 'Term content block reference is invalid'};
                continue;
            }
            const cacheKey = this._createBlockCacheKey(contentDictName, reference);
            let group = groups.get(cacheKey);
            if (typeof group === 'undefined') {
                group = {
                    cacheKey,
                    reference,
                    compressionDictName,
                    context: {contentOffset, contentLength, contentDictName},
                    entries: [],
                };
                groups.set(cacheKey, group);
            }
            group.entries.push({index, reference});
        }

        const groupList = [...groups.values()];
        const [groupSettled, legacySettled] = await Promise.all([Promise.allSettled(groupList.map(async ({cacheKey, reference, compressionDictName, context}) => {
            const cached = this._cache.get(cacheKey);
            if (typeof cached !== 'undefined') { return cached; }
            const block = await this._getOrLoadBlock(cacheKey, reference, compressionDictName, context, readContext);
            if (block === null) {
                throw new TermContentReadError('temporarilyUnavailable', 'Term content block could not be loaded');
            }
            return block;
        })), Promise.allSettled(legacyRequests.map(async ({request}) => await this._readLegacyEntry(request.contentOffset, request.contentLength, request.contentDictName, readContext)))]);
        if (generation !== this._cacheGeneration) {
            return requests.map(() => this._createInvalidatedReadFailure());
        }
        for (let i = 0; i < legacyRequests.length; ++i) {
            const settled = legacySettled[i];
            results[legacyRequests[i].index] = settled.status === 'rejected' ?
                this._createReadFailure(settled.reason) :
{status: 'ok', bytes: settled.value};
        }
        for (let i = 0; i < groupList.length; ++i) {
            const group = groupList[i];
            const settled = groupSettled[i];
            if (settled.status === 'rejected') {
                const failure = this._createReadFailure(settled.reason);
                for (const {index} of group.entries) { results[index] = failure; }
                continue;
            }
            const block = settled.value;
            for (const {index, reference} of group.entries) {
                const request = requests[index];
                const entryEnd = reference.entryOffset + reference.entryLength;
                if (entryEnd > block.byteLength) {
                    this._recordEntryBoundsError(request, reference, block.byteLength);
                    results[index] = {status: 'corrupt', reason: 'Term content block entry is outside the decoded block'};
                    continue;
                }
                results[index] = {status: 'ok', bytes: block.subarray(reference.entryOffset, entryEnd)};
            }
        }
        return results;
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @param {TermContentReadContext|null} [readContext]
     * @returns {Promise<{status: 'ok', bytes: Uint8Array}>}
     */
    async _readDetailed(contentOffset, contentLength, contentDictName, readContext = null) {
        const generation = this._cacheGeneration;
        const compressionDictName = getRawTermContentBlockCompressionDictName(contentDictName);
        if (typeof compressionDictName === 'undefined') {
            if (!RAW_CONTENT_SELECTORS.has(contentDictName)) {
                return {status: 'ok', bytes: await this._readLegacyEntry(contentOffset, contentLength, contentDictName, readContext)};
            }
            const bytes = await (readContext ?? this._contentStore).readSlice(contentOffset, contentLength);
            if (!(bytes instanceof Uint8Array)) {
                throw new TermContentReadError('temporarilyUnavailable', 'Term content could not be read from OPFS');
            }
            return {status: 'ok', bytes};
        }
        const compact = contentDictName === RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX ||
        contentDictName.startsWith(`${RAW_TERM_CONTENT_DIRECT_BLOCK_DICT_NAME_PREFIX}:`);
        const referenceLength = compact ? RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES : RAW_TERM_CONTENT_BLOCK_REFERENCE_BYTES;
        const referenceBytes = await (readContext ?? this._contentStore).readSlice(contentOffset, referenceLength);
        this._assertReadGeneration(generation);
        if (!(referenceBytes instanceof Uint8Array)) {
            throw new TermContentReadError('temporarilyUnavailable', 'Term content block reference could not be read from OPFS');
        }
        const reference = compact ?
            decodeRawTermContentCompactBlockReference(referenceBytes, contentLength) :
            decodeRawTermContentBlockReference(referenceBytes);
        if (reference === null || reference.entryLength !== contentLength) {
            this._recordInvalidReference(contentOffset, contentLength, contentDictName, referenceBytes, reference);
            throw new TermContentReadError('corrupt', 'Term content block reference is invalid');
        }
        const cacheKey = this._createBlockCacheKey(contentDictName, reference);
        let block = this._cache.get(cacheKey);
        if (typeof block === 'undefined') {
            const loadedBlock = await this._getOrLoadBlock(cacheKey, reference, compressionDictName, {
                contentOffset,
                contentLength,
                contentDictName,
            }, readContext);
            this._assertReadGeneration(generation);
            if (loadedBlock === null) {
                throw new TermContentReadError('temporarilyUnavailable', 'Term content block could not be loaded');
            }
            block = loadedBlock;
        }
        const entryEnd = reference.entryOffset + reference.entryLength;
        if (entryEnd > block.byteLength) {
            this._recordEntryBoundsError({contentOffset, contentLength, contentDictName}, reference, block.byteLength);
            throw new TermContentReadError('corrupt', 'Term content block entry is outside the decoded block');
        }
        return {status: 'ok', bytes: block.subarray(reference.entryOffset, entryEnd)};
    }

    /**
     * Legacy record lengths do not define their compressed spans. Discover
     * exact frame boundaries without reading past the committed root.
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @param {TermContentReadContext|null} readContext
     * @returns {Promise<Uint8Array>}
     * @param {boolean} [allowSourceRetry]
     */
    async _readLegacyEntry(contentOffset, contentLength, contentDictName, readContext, allowSourceRetry = true) {
        const generation = this._cacheGeneration;
        if (!Number.isSafeInteger(contentOffset) || contentOffset < 0 ||
        !Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw new TermContentReadError('corrupt', 'Legacy term content reference is invalid');
        }
        const cacheKey = JSON.stringify(['legacy-entry', contentOffset, contentLength, contentDictName]);
        const cached = this._cache.get(cacheKey);
        if (typeof cached !== 'undefined') { return cached; }
        const originalCodecId = getLegacyTermContentZstdCodecId(contentDictName);
        const query = {kind: /** @type {const} */ ('legacy-entry'), logicalOffset: contentOffset, recordLength: contentLength, originalCodecId};
        const metadataState = {lastRead: /** @type {{offset: number, length: number}|null} */ (null)};
        /** @type {TermContentFrameIdentity|null} */
        let initialOverride = null;
        let overrideKnown = false;
        try {
            if (readContext !== null && typeof readContext.findFrameOverride !== 'function') {
                throw new Error('Leased legacy frame identity lookup is unavailable');
            }
            let identity = await readContext?.findFrameOverride?.(query) ?? null;
            initialOverride = identity;
            overrideKnown = true;
            this._assertReadGeneration(generation);
            if (identity === null) {
                const highWater = readContext?.logicalHighWater ?? this._contentStore.getLogicalLength();
                const read = async (/** @type {number} */ offset, /** @type {number} */ length) => {
                    metadataState.lastRead = {offset, length};
                    const bytes = await (readContext ?? this._contentStore).readSlice(offset, length);
                    this._assertReadGeneration(generation);
                    if (!(bytes instanceof Uint8Array)) { throw new Error('Legacy frame metadata is temporarily unavailable'); }
                    return bytes;
                };
                try {
                    let cursor = await beginZstdFrameInspection(read, contentOffset, highWater);
                    if ((cursor.decodedLength ?? cursor.windowSize) > LEGACY_DECODE_MAX_BYTES) {
                        throw new TermContentReadError('temporarilyUnavailable', 'Legacy term content frame exceeds decoded resource admission');
                    }
                    let sourceStoredLength = null;
                    while (cursor.blocks < LEGACY_INSPECTION_MAX_BLOCKS && sourceStoredLength === null) {
                        const result = await advanceZstdFrameInspection(read, cursor, {maxBlockHeaders: 256});
                        cursor = result.cursor;
                        sourceStoredLength = result.sourceStoredLength;
                    }
                    if (sourceStoredLength === null || sourceStoredLength > LEGACY_DECODE_MAX_BYTES + 1024 * 1024) {
                        throw new TermContentReadError('temporarilyUnavailable', 'Legacy term content frame exceeds metadata resource admission');
                    }
                    identity = {...query, sourceStoredLength, expectedDecodedLength: null, originalEnvelope: 'none'};
                } catch (error) {
                    if (error instanceof ZstdFrameInspectionError) { throw new TermContentReadError('corrupt', error.message); }
                    throw error;
                }
            }
            const bytes = await this._getOrLoadFrame(cacheKey, identity, {contentOffset, contentLength, contentDictName}, readContext);
            if (bytes === null) { throw new TermContentReadError('temporarilyUnavailable', 'Legacy term content frame could not be loaded'); }
            return bytes;
        } catch (error) {
            const failure = this._createReadFailure(error);
            if (allowSourceRetry && failure.status === 'corrupt' && readContext !== null && initialOverride === null) {
                const current = this._readContextProvider?.() ?? null;
                try {
                    if (current !== null && current.rootKey !== readContext.rootKey) {
                        let changed = false;
                        const layoutId = /** @type {unknown} */ (error instanceof Error ? Reflect.get(error, 'layoutId') : void 0);
                        if (!overrideKnown && typeof layoutId === 'string' && readContext.isCurrentFrameLayout) {
                            changed = !await readContext.isCurrentFrameLayout({...query,
                                sourceStoredLength: 1,
                                expectedDecodedLength: null,
                                originalEnvelope: 'none'}, layoutId);
                        } else if (overrideKnown && initialOverride === null && current.findFrameOverride) {
                            const replacement = await current.findFrameOverride(query);
                            changed = replacement !== null;
                            if (!changed && metadataState.lastRead !== null && readContext.isCurrentRange) {
                                changed = !await readContext.isCurrentRange(metadataState.lastRead.offset, metadataState.lastRead.length);
                            }
                        }
                        this._assertReadGeneration(generation);
                        if (changed) {
                            return await this._readLegacyEntry(contentOffset, contentLength, contentDictName, current, false);
                        }
                    }
                } finally { current?.release(); }
            }
            throw error;
        }
    }

    /**
     * @param {TermContentFrameIdentity} identity
     * @returns {string}
     */
    _createFrameCacheKey(identity) {
        return JSON.stringify(['frame',
            identity.kind,
            identity.logicalOffset,
            identity.recordLength,
            identity.sourceStoredLength,
            identity.originalCodecId,
            identity.expectedDecodedLength,
            identity.originalEnvelope]);
    }

    /**
     * @returns {{status: 'temporarilyUnavailable', reason: string}}
     */
    _createInvalidatedReadFailure() {
        return {status: 'temporarilyUnavailable', reason: 'Term content changed during read'};
    }

    /**
     * @param {number} generation
     * @throws {TermContentReadError} If the read belongs to an invalidated generation.
     */
    _assertReadGeneration(generation) {
        if (generation !== this._cacheGeneration) {
            const {status, reason} = this._createInvalidatedReadFailure();
            throw new TermContentReadError(status, reason);
        }
    }

    /**
     * @param {unknown} error
     * @returns {{status: 'temporarilyUnavailable'|'corrupt', reason: string}}
     */
    _createReadFailure(error) {
        if (error instanceof TermContentReadError) {
            return {status: error.status, reason: error.message};
        }
        if (error instanceof TermContentIntegrityError) {
            return {status: 'corrupt', reason: error.message};
        }
        return {
            status: 'temporarilyUnavailable',
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    /**
     * @param {string} contentDictName
     * @param {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number}} reference
     * @returns {string}
     */
    _createBlockCacheKey(contentDictName, reference) {
        return `${contentDictName}:${reference.blockOffset}:${reference.blockCompressedLength}:${reference.blockUncompressedLength}`;
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @param {Uint8Array} referenceBytes
     * @param {{entryLength: number}|null} reference
     */
    _recordInvalidReference(contentOffset, contentLength, contentDictName, referenceBytes, reference) {
        this._recordError('term-content-block-reference-invalid', {
            contentOffset,
            contentLength,
            contentDictName,
            referencePrefix: [...referenceBytes.subarray(0, 8)],
            decodedEntryLength: reference?.entryLength ?? null,
        });
    }

    /**
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} request
     * @param {{entryOffset: number, entryLength: number}} reference
     * @param {number} blockLength
     */
    _recordEntryBoundsError({contentOffset, contentLength, contentDictName}, reference, blockLength) {
        this._recordError('term-content-block-entry-bounds-error', {
            contentOffset,
            contentLength,
            contentDictName,
            entryOffset: reference.entryOffset,
            entryLength: reference.entryLength,
            blockLength,
        });
    }

    /**
     * @param {string} cacheKey
     * @param {{blockOffset: number, blockCompressedLength: number, blockUncompressedLength: number}} reference
     * @param {string|null} compressionDictName
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
     * @param {TermContentReadContext|null} [readContext]
     * @returns {Promise<Uint8Array|null>}
     */
    async _getOrLoadBlock(cacheKey, reference, compressionDictName, context, readContext = null) {
        return await this._getOrLoadFrame(cacheKey, {
            kind: 'block',
            logicalOffset: reference.blockOffset,
            recordLength: reference.blockCompressedLength,
            sourceStoredLength: reference.blockCompressedLength,
            originalCodecId: getLegacyTermContentZstdCodecId(compressionDictName),
            expectedDecodedLength: reference.blockUncompressedLength,
            originalEnvelope: 'mbc2',
        }, context, readContext);
    }

    /**
     * @param {string} cacheKey
     * @param {TermContentFrameIdentity} identity
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
     * @param {TermContentReadContext|null} readContext
     * @returns {Promise<Uint8Array|null>}
     */
    async _getOrLoadFrame(cacheKey, identity, context, readContext) {
        const cached = this._cache.get(cacheKey);
        if (typeof cached !== 'undefined') { return cached; }
        const pendingKey = readContext === null ?
            `legacy:${cacheKey}` :
            (typeof readContext.rootKey === 'string' ? `root:${readContext.rootKey}:${cacheKey}` : Symbol(cacheKey));
        const pending = this._inFlightBlocks.get(pendingKey);
        if (typeof pending !== 'undefined') { return await pending; }
        const loaderContext = readContext?.fork() ?? null;
        const load = this._loadFrame(cacheKey, identity, context, loaderContext).finally(() => { loaderContext?.release(); });
        this._inFlightBlocks.set(pendingKey, load);
        try {
            return await load;
        } finally {
            if (this._inFlightBlocks.get(pendingKey) === load) { this._inFlightBlocks.delete(pendingKey); }
        }
    }

    /**
     * @param {string} cacheKey
     * @param {TermContentFrameIdentity} identity
     * @param {{contentOffset: number, contentLength: number, contentDictName: string}} context
     * @param {TermContentReadContext|null} [readContext]
     * @param {boolean} [allowSourceRetry]
     * @returns {Promise<Uint8Array|null>}
     */
    async _loadFrame(cacheKey, identity, context, readContext = null, allowSourceRetry = true) {
        const generation = this._cacheGeneration;
        /** @type {TermContentResolvedFrame|null} */
        let onlineFrame = null;
        try {
            onlineFrame = readContext !== null ?
await readContext.resolveFrame(identity) :
                (this._onlineFrameResolver === null ? null : await this._onlineFrameResolver(identity));
            this._assertReadGeneration(generation);
            const storedBlock = onlineFrame?.bytes ?? await (readContext ?? this._contentStore).readSlice(identity.logicalOffset, identity.sourceStoredLength);
            // Check before integrity validation or publication: these bytes may belong
            // to a removed import whose offsets have already been reused.
            this._assertReadGeneration(generation);
            if (!(storedBlock instanceof Uint8Array)) {
                throw new TermContentReadError('temporarilyUnavailable', 'Compressed term content block could not be read from OPFS');
            }
            const storedEnvelope = onlineFrame?.envelope ?? identity.originalEnvelope;
            if (storedEnvelope === 'mbc2' && (storedBlock.byteLength <= TERM_CONTENT_BLOCK_ENVELOPE_BYTES ||
            !TERM_CONTENT_BLOCK_ENVELOPE_MAGIC.every((value, index) => storedBlock[index] === value))) {
                throw new TermContentReadError('corrupt', 'Term content block checksum envelope is invalid');
            }
            const compressed = storedEnvelope === 'mbc2' ? storedBlock.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES) : storedBlock;
            if (storedEnvelope === 'mbc2') {
                const storedBlockView = new DataView(storedBlock.buffer, storedBlock.byteOffset, storedBlock.byteLength);
                const expectedHash1 = storedBlockView.getUint32(4, true);
                const expectedHash2 = storedBlockView.getUint32(8, true);
                const [actualHash1, actualHash2] = hashTermEntryContentBytesPair(compressed);
                if (actualHash1 !== expectedHash1 || actualHash2 !== expectedHash2) {
                    this._recordError('term-content-block-checksum-mismatch', {
                        contentDictName: context.contentDictName,
                        blockOffset: identity.logicalOffset,
                        expectedHash1,
                        expectedHash2,
                        actualHash1,
                        actualHash2,
                    });
                    throw new TermContentReadError('corrupt', 'Term content block checksum does not match its stored payload');
                }
            }
            const decodedLength = onlineFrame?.decodedLength ?? identity.expectedDecodedLength;
            if (identity.kind === 'legacy-entry' && decodedLength !== null && decodedLength > LEGACY_DECODE_MAX_BYTES) {
                throw new TermContentReadError('temporarilyUnavailable', 'Legacy term content frame exceeds decoded resource admission');
            }
            if (identity.expectedDecodedLength !== null && decodedLength !== identity.expectedDecodedLength) {
                throw new TermContentReadError('corrupt', 'Term content frame decoded length differs from its identity');
            }
            /** @type {Uint8Array} */
            let block;
            try {
                // The decoder returns owned bytes that remain safe to cache.
                const codecId = onlineFrame === null ? identity.originalCodecId : onlineFrame.codecId;
                /** @type {NonNullable<Parameters<typeof decompressTermContentZstd>[2]>} */
                const options = {
                    defaultHeapSize: decodedLength ?? Math.min(identity.recordLength, LEGACY_DECODE_MAX_BYTES),
                    maxOutputSize: decodedLength ?? LEGACY_DECODE_MAX_BYTES,
                };
                if (onlineFrame !== null && codecId !== null && codecId !== 'jmdict') {
                    options.codecSource = 'immutable-layout';
                }
                block = decompressTermContentZstd(compressed, codecId, options);
                if (!(block instanceof Uint8Array)) { throw new TypeError('Zstd decoder returned non-byte data'); }
            } catch (error) {
                this._recordError('term-content-block-decompress-error', {
                    ...context,
                    blockOffset: identity.logicalOffset,
                    blockCompressedLength: identity.sourceStoredLength,
                    blockUncompressedLength: identity.expectedDecodedLength,
                    compressedPrefix: [...compressed.subarray(0, 8)],
                    error: `${error}`,
                });
                throw new TermContentReadError(
                    isZstdResourceError(error) || (identity.kind === 'legacy-entry' && decodedLength === null &&
                    error instanceof RangeError && /^Zstd frame output size [0-9]+ exceeds configured output limit 134217728$/.test(error.message)) ?
                        'temporarilyUnavailable' :
'corrupt',
                    identity.kind === 'shared-glossary' ? 'Shared glossary decompression failed' : 'Term content block decompression failed',
                    {cause: error},
                );
            }
            if (decodedLength !== null && block.byteLength !== decodedLength) {
                this._recordError('term-content-block-length-mismatch', {
                    contentDictName: context.contentDictName,
                    blockOffset: identity.logicalOffset,
                    expectedLength: decodedLength,
                    actualLength: block.byteLength,
                });
                throw new TermContentReadError('corrupt', identity.kind === 'shared-glossary' ?
                    `Shared glossary decoded length mismatch: expected ${decodedLength}, got ${block.byteLength}` :
                    'Term content block decoded length does not match its reference');
            }
            this._lastError = null;
            this._cache.set(cacheKey, block);
            return block;
        } catch (error) {
            const failure = this._createReadFailure(error);
            const physicalKey = /** @type {unknown} */ (onlineFrame?.physicalKey ?? (error instanceof Error ? Reflect.get(error, 'physicalKey') : void 0));
            const layoutId = /** @type {unknown} */ (error instanceof Error ? Reflect.get(error, 'layoutId') : void 0);
            let changed = false;
            if (allowSourceRetry && failure.status === 'corrupt' && readContext !== null) {
                if (typeof physicalKey === 'string' && readContext.isCurrentFrame) {
                    changed = !await readContext.isCurrentFrame(identity, physicalKey);
                } else if (typeof layoutId === 'string' && readContext.isCurrentFrameLayout) {
                    changed = !await readContext.isCurrentFrameLayout(identity, layoutId);
                }
            }
            this._assertReadGeneration(generation);
            if (changed) {
                const currentContext = this._readContextProvider?.() ?? null;
                if (currentContext !== null) {
                    try {
                        return await this._loadFrame(cacheKey, identity, context, currentContext, false);
                    } finally { currentContext.release(); }
                }
            }
            throw error;
        } finally {
            onlineFrame?.release();
        }
    }

    /**
     * @param {Uint8Array[]} contentBytesList
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async tryAppend(contentBytesList, compressionDictName, force = false) {
        if (contentBytesList.length === 0) { return null; }
        const sourceLengths = Uint32Array.from(contentBytesList, ({byteLength}) => byteLength);
        return await this._tryAppendPacked(
            () => packContentChunksIntoSlabs(contentBytesList, sourceLengths, this._blockTargetBytes),
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
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async tryAppendSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force = false) {
        const uncompressedBytes = validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths);
        if (uncompressedBytes === 0) { return null; }
        if (
            (compressionDictName === 'jmdict' || this._compressionExperiments.experimentalGenericSpanCompression === true) &&
            typeof SharedArrayBuffer === 'function' &&
            sourceBytes.buffer instanceof SharedArrayBuffer
        ) {
            return await this._tryAppendSharedSpans(
                sourceBytes,
                sourceOffsets,
                sourceLengths,
                compressionDictName,
                force,
                uncompressedBytes,
            );
        }
        return await this._tryAppendPacked(
            () => packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, this._blockTargetBytes),
            sourceLengths,
            compressionDictName,
            force,
            () => {
                const plan = planContentSpansIntoSlabs(sourceLengths, this._blockTargetBytes);
                return {
                    ...plan,
                    createBlock: (blockIndex) => packContentSpanBlock(
                        sourceBytes,
                        sourceOffsets,
                        sourceLengths,
                        plan.blockStartIndexes[blockIndex],
                        plan.blockStartIndexes[blockIndex + 1],
                        plan.packedChunkLengths[blockIndex],
                        blockIndex,
                    ),
                };
            },
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
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, sourceConsumed: Promise<void>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>}|null}
     */
    tryBeginAppendSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force = false) {
        const uncompressedBytes = validateTermContentSpans(sourceBytes, sourceOffsets, sourceLengths);
        if (
            uncompressedBytes === 0 ||
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
     * @returns {{storage: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string}>, sourceConsumed: Promise<void>, completion: Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>}}
     */
    _beginAppendSharedSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, uncompressedBytes, initialSelection) {
        const compressionExperiments = this._compressionExperiments;
        const planStart = safePerformance.now();
        const packed = planContentSpansIntoSlabs(sourceLengths, this._blockTargetBytes);
        let packMs = safePerformance.now() - planStart;
        const referenceLayout = createTermContentReferenceLayout(
            sourceLengths.length,
            this._referencePackTargetBytes,
        );
        /** @type {(value?: void|PromiseLike<void>) => void} */
        let resolveSourceConsumed = () => {};
        /** @type {(reason?: unknown) => void} */
        let rejectSourceConsumed = () => {};
        /** @type {Promise<void>} */
        const sourceConsumed = new Promise((resolve, reject) => {
            resolveSourceConsumed = resolve;
            rejectSourceConsumed = reject;
        });
        void sourceConsumed.catch(() => {});
        const compression = (async () => {
            let compressedChunks;
            let envelopeMs = 0;
            let compressionStart = safePerformance.now();
            let sourceWasConsumed = false;
            try {
                const operation = beginCompressWrappedTermContentZstdSpansBatch(
                    sourceBytes,
                    sourceOffsets,
                    sourceLengths,
                    packed.blockStartIndexes,
                    packed.packedChunkLengths,
                    compressionDictName,
                    compressionExperiments,
                );
                const consumed = operation.sourceConsumed.then(() => {
                    sourceWasConsumed = true;
                    resolveSourceConsumed();
                });
                void consumed.catch(() => {});
                let result;
                try {
                    result = await operation.completion;
                } catch (error) {
                    await consumed.catch(() => {});
                    throw error;
                }
                compressedChunks = result.chunks;
                envelopeMs = result.envelopeMs;
                if (!result.wrapped) {
                    const envelopeStart = safePerformance.now();
                    compressedChunks = compressedChunks.map(wrapCompressedTermContentBlock);
                    envelopeMs += safePerformance.now() - envelopeStart;
                }
                validateCompressedChunks(compressedChunks, packed.packedChunkLengths.length);
            } catch (error) {
                if (sourceWasConsumed) {
                    throw error;
                }
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
                resolveSourceConsumed();
            }
            const completedAt = safePerformance.now();
            const compressMs = Math.max(0, completedAt - compressionStart - envelopeMs);
            let compressedBytes = 0;
            for (const chunk of compressedChunks) { compressedBytes += chunk.byteLength; }
            return {chunks: compressedChunks, compressedBytes, packMs, compressMs, envelopeMs, completedAt};
        })();
        void compression.catch((error) => { rejectSourceConsumed(error); });

        let referenceMs = 0;
        const primaryChunks = compression.then(({chunks}) => chunks);
        /** @type {ReturnType<import('./term-content-opfs-store.js').TermContentOpfsStore['beginAppendBatchWithDerivedPrefix']>} */
        let append;
        try {
            append = this._contentStore.beginAppendBatchWithDerivedPrefix(
                primaryChunks,
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
        } catch (error) {
            // Reservation setup may fail before it takes ownership of this
            // promise. Keep the operation's terminal drain responsible for the
            // compressor and prevent its unconsumed derived promise escaping.
            void primaryChunks.catch(() => {});
            const failed = Promise.reject(error);
            void failed.catch(() => {});
            append = {reserved: failed, completion: failed};
        }
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
            const pending = /** @type {const} */ ([append.completion, compression, storage]);
            let results;
            try {
                results = await Promise.all(pending);
            } catch (error) {
                // Storage can fail before it awaits compression. The caller
                // may release borrowed parser memory only after this terminal
                // promise has drained every owner of that source.
                await Promise.allSettled(pending);
                throw error;
            }
            const [, compressionResult, storageResult] = results;
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
        return {storage, sourceConsumed, completion};
    }

    /**
     * @param {Uint8Array} sourceBytes
     * @param {Uint32Array} sourceOffsets
     * @param {Uint32Array} sourceLengths
     * @param {string|null} compressionDictName
     * @param {boolean} force
     * @param {number} uncompressedBytes
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async _tryAppendSharedSpans(sourceBytes, sourceOffsets, sourceLengths, compressionDictName, force, uncompressedBytes) {
        const compressionExperiments = this._compressionExperiments;
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
                compressionExperiments,
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
     * @param {(() => {blockStartIndexes: Uint32Array, packedChunkLengths: Uint32Array, createBlock: (index: number) => Uint8Array})|null} [prepareBlocks]
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, contentDictName: string, compressedBytes: number, uncompressedBytes: number, packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null>}
     */
    async _tryAppendPacked(pack, sourceLengths, compressionDictName, force, prepareBlocks = null) {
        const compressionExperiments = this._compressionExperiments;
        let uncompressedBytes = 0;
        for (const length of sourceLengths) { uncompressedBytes += length; }
        if (uncompressedBytes === 0 || (!force && uncompressedBytes < this._minInputBytes)) { return null; }

        let phaseStart = safePerformance.now();
        let packed = prepareBlocks === null ? pack() : prepareBlocks();
        let packMs = safePerformance.now() - phaseStart;
        let packedChunkLengths = 'packedChunks' in packed ?
            Uint32Array.from(packed.packedChunks, ({byteLength}) => byteLength) :
            packed.packedChunkLengths;
        /** @type {Uint8Array[]} */
        let compressedChunks;
        let envelopeMs = 0;
        let compressionPackMs = 0;
        phaseStart = safePerformance.now();
        try {
            const createBlock = 'createBlock' in packed ? packed.createBlock : null;
            const result = 'packedChunks' in packed ?
                await compressWrappedTermContentZstdBatch(packed.packedChunks, compressionDictName, compressionExperiments) :
                await compressWrappedTermContentZstdBlocks(packedChunkLengths, (blockIndex) => {
                    const packStart = safePerformance.now();
                    const content = /** @type {(index: number) => Uint8Array} */ (createBlock)(blockIndex);
                    const elapsed = safePerformance.now() - packStart;
                    packMs += elapsed;
                    compressionPackMs += elapsed;
                    return content;
                }, compressionDictName, compressionExperiments);
            compressedChunks = result.chunks;
            envelopeMs = result.envelopeMs;
            if (!result.wrapped) {
                const envelopeStart = safePerformance.now();
                compressedChunks = compressedChunks.map(wrapCompressedTermContentBlock);
                envelopeMs += safePerformance.now() - envelopeStart;
            }
            validateCompressedChunks(compressedChunks, packedChunkLengths.length);
        } catch (_) {
            // Worker dispatch may detach packed slabs. Repack from stable source
            // bytes before using the synchronous fallback.
            const retryPackStart = safePerformance.now();
            packed = pack();
            packMs += safePerformance.now() - retryPackStart;
            phaseStart = safePerformance.now();
            compressionPackMs = 0;
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
        const compressMs = Math.max(0, safePerformance.now() - phaseStart - envelopeMs - compressionPackMs);
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
     * @param {{blockStartIndexes: Uint32Array}} packed
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
 * @param {{blockStartIndexes: Uint32Array}} packed
 * @param {Uint32Array} packedChunkLengths
 * @param {Uint32Array} sourceLengths
 * @param {number[]} blockOffsets
 * @param {number[]} blockLengths
 * @param {number} entriesPerSlab
 * @returns {Uint8Array[]}
 * @throws {RangeError} If a block field or entry offset cannot be encoded.
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
    // Both block and reference-slab boundaries partition the same ordered
    // rows. Keep the block cursor across reference slabs.
    let blockIndex = -1;
    let nextBlockStart = 0;
    let sourceOffset = 0;
    const blockPrefix = new Uint8Array(RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES);
    const blockPrefixView = new DataView(blockPrefix.buffer);
    let blockUncompressedLength = 0;
    for (let slabIndex = 0; slabIndex < slabCount; ++slabIndex) {
        const startIndex = slabIndex * entriesPerSlab;
        const entryCount = Math.min(entriesPerSlab, sourceLengths.length - startIndex);
        const slab = new Uint8Array(entryCount * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES);
        const view = new DataView(slab.buffer, slab.byteOffset, slab.byteLength);
        for (let localIndex = 0; localIndex < entryCount;) {
            const contentIndex = startIndex + localIndex;
            if (contentIndex === nextBlockStart) {
                ++blockIndex;
                nextBlockStart = packed.blockStartIndexes[blockIndex + 1];
                if (
                    packed.blockStartIndexes[blockIndex] !== contentIndex ||
                    !Number.isInteger(nextBlockStart) || nextBlockStart <= contentIndex || nextBlockStart > sourceLengths.length
                ) {
                    throw new RangeError('Invalid compact term-content block reference');
                }
                sourceOffset = 0;
                blockUncompressedLength = packedChunkLengths[blockIndex];
                // Validate the invariant fields once per compressed block.
                writeRawTermContentCompactBlockReference(
                    blockPrefixView,
                    0,
                    blockOffsets[blockIndex],
                    blockLengths[blockIndex],
                    blockUncompressedLength,
                    0,
                );
            }
            const runEnd = Math.min(entryCount, nextBlockStart - startIndex);
            const runStartByte = localIndex * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
            const runEndByte = runEnd * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
            slab.set(blockPrefix, runStartByte);
            // Repeat complete templates in-place, retaining explicit little-
            // endian bytes without rewriting four invariant words per entry.
            for (let filledEnd = runStartByte + RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES; filledEnd < runEndByte;) {
                const copyLength = Math.min(filledEnd - runStartByte, runEndByte - filledEnd);
                slab.copyWithin(filledEnd, runStartByte, runStartByte + copyLength);
                filledEnd += copyLength;
            }
            for (; localIndex < runEnd; ++localIndex) {
                const index = startIndex + localIndex;
                const entryOffset = sourceOffset;
                sourceOffset += sourceLengths[index];
                // Empty trailing rows keep an in-block placeholder offset.
                if (sourceOffset > blockUncompressedLength || (index + 1 === nextBlockStart && sourceOffset !== blockUncompressedLength)) {
                    throw new RangeError('Invalid compact term-content block reference');
                }
                view.setUint32(
                    localIndex * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES + RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES - 4,
                    entryOffset === blockUncompressedLength ? 0 : entryOffset,
                    true,
                );
            }
        }
        referenceSlabs[slabIndex] = slab;
    }
    return referenceSlabs;
}

/**
 * @param {number} entryCount
 * @param {number[]} slabOffsets
 * @param {number} entriesPerSlab Positive integral capacity from the reference layout.
 * @returns {Float64Array}
 * @throws {RangeError} If a reserved slab offset is invalid.
 */
function createTermContentReferenceOffsets(entryCount, slabOffsets, entriesPerSlab) {
    const contentOffsets = new Float64Array(entryCount);
    for (let startIndex = 0, slabIndex = 0; startIndex < entryCount; startIndex += entriesPerSlab, ++slabIndex) {
        const slabOffset = slabOffsets[slabIndex];
        if (!Number.isSafeInteger(slabOffset) || slabOffset < 0) {
            throw new RangeError(`Invalid term content reference slab offset: ${slabOffset}`);
        }
        const count = Math.min(entriesPerSlab, entryCount - startIndex);
        // A safe largest offset also proves every earlier integer-stride offset.
        const maximumOffset = slabOffset + (count - 1) * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
        if (!Number.isSafeInteger(maximumOffset)) {
            throw new RangeError(`Term content reference offset exceeds the safe integer range: ${maximumOffset}`);
        }
        for (let localIndex = 0; localIndex < count; ++localIndex) {
            contentOffsets[startIndex + localIndex] = slabOffset + localIndex * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES;
        }
    }
    return contentOffsets;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunks: Uint8Array[], blockStartIndexes: Uint32Array}}
 */
function packContentChunksIntoSlabs(chunks, sourceLengths, targetBytes) {
    const {blockStartIndexes, packedChunkLengths} = planContentSpansIntoSlabs(sourceLengths, targetBytes);
    const packedChunks = Array.from(packedChunkLengths, (length, blockIndex) => {
        const output = new Uint8Array(length);
        let offset = 0;
        for (let i = blockStartIndexes[blockIndex]; i < blockStartIndexes[blockIndex + 1]; ++i) {
            const bytes = chunks[i];
            output.set(bytes, offset);
            offset += bytes.byteLength;
        }
        return output;
    });
    return {packedChunks, blockStartIndexes};
}

/**
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunkLengths: Uint32Array, blockStartIndexes: Uint32Array}}
 * @throws {RangeError} If a planned block cannot use the 32-bit storage format.
 */
function planContentSpansIntoSlabs(sourceLengths, targetBytes) {
    /** @type {number[]} */
    const packedChunkLengths = [];
    /** @type {number[]} */
    const blockStartIndexes = [0];
    let startIndex = 0;
    while (startIndex < sourceLengths.length) {
        let totalBytes = 0;
        let endIndex = startIndex;
        while (endIndex < sourceLengths.length) {
            const nextBytes = sourceLengths[endIndex];
            if (totalBytes > 0 && (totalBytes + nextBytes) > targetBytes && nextBytes > 0) {
                break;
            }
            totalBytes += nextBytes;
            ++endIndex;
        }
        if (totalBytes > 0xffffffff) {
            throw new RangeError('Packed term content block exceeds the 32-bit storage format');
        }
        packedChunkLengths.push(totalBytes);
        blockStartIndexes.push(endIndex);
        startIndex = endIndex;
    }
    return {
        packedChunkLengths: Uint32Array.from(packedChunkLengths),
        blockStartIndexes: Uint32Array.from(blockStartIndexes),
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
        packedChunks[blockIndex] = packContentSpanBlock(
            sourceBytes,
            sourceOffsets,
            sourceLengths,
            blockStartIndexes[blockIndex],
            blockStartIndexes[blockIndex + 1],
            packedChunkLengths[blockIndex],
            blockIndex,
        );
    }
    return packedChunks;
}

/**
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {number} packedLength
 * @param {number} blockIndex
 * @returns {Uint8Array}
 * @throws {RangeError} If the preserved block length is inconsistent.
 */
function packContentSpanBlock(sourceBytes, sourceOffsets, sourceLengths, startIndex, endIndex, packedLength, blockIndex) {
    const output = new Uint8Array(packedLength);
    let outputOffset = 0;
    let runStart = sourceOffsets[startIndex];
    let runEnd = runStart;
    let runOutputOffset = 0;
    for (let i = startIndex; i < endIndex; ++i) {
        const sourceOffset = sourceOffsets[i];
        const length = sourceLengths[i];
        if (sourceOffset !== runEnd) {
            if (runEnd > runStart) { output.set(sourceBytes.subarray(runStart, runEnd), runOutputOffset); }
            runStart = sourceOffset;
            runOutputOffset = outputOffset;
        }
        runEnd = sourceOffset + length;
        outputOffset += length;
    }
    if (runEnd > runStart) { output.set(sourceBytes.subarray(runStart, runEnd), runOutputOffset); }
    if (outputOffset !== output.byteLength) {
        throw new RangeError(`Packed term content fallback block ${blockIndex} has an invalid length`);
    }
    return output;
}

/**
 * @param {Uint8Array} sourceBytes
 * @param {Uint32Array} sourceOffsets
 * @param {Uint32Array} sourceLengths
 * @param {number} targetBytes
 * @returns {{packedChunks: Uint8Array[], blockStartIndexes: Uint32Array}}
 */
function packContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, targetBytes) {
    const {blockStartIndexes, packedChunkLengths} = planContentSpansIntoSlabs(sourceLengths, targetBytes);
    const packedChunks = packPlannedContentSpansIntoSlabs(sourceBytes, sourceOffsets, sourceLengths, blockStartIndexes, packedChunkLengths);
    return {packedChunks, blockStartIndexes};
}
