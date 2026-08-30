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

/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import {initWasm, Resvg} from '../../lib/resvg-wasm.js';
import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {isDevDiagnosticsBuild, reportDiagnostics, reportDiagnosticsLazy} from '../core/diagnostics-reporter.js';
import {ExtensionError} from '../core/extension-error.js';
import {parseJson} from '../core/json.js';
import {log} from '../core/log.js';
import {safePerformance} from '../core/safe-performance.js';
import {toError} from '../core/to-error.js';
import {WeightedLruMap} from '../core/weighted-lru-map.js';
import {stringReverse} from '../core/utilities.js';
import {deleteOpfsDatabaseFiles, didLastOpenUseFallbackStorage, getLastOpenStorageDiagnostics, getSqlite3, openOpfsDatabase} from './sqlite-wasm.js';
import {
    compressTermContentZstd,
    decompressTermContentZstd,
    initializeTermContentZstd,
    logTermContentZstdError,
    resolveTermContentZstdDictName,
} from './zstd-term-content.js';
import {
    decodeRawTermContentHeader,
    decodeRawTermContentTokenHeader,
    RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
    decodeRawTermContentSharedGlossaryHeader,
    encodeRawTermContentBinary,
    getRawTermContentGlossaryJsonBytes,
    isRawTermContentBinary,
    isRawTermContentSharedGlossaryBinary,
    isRawTermContentTokenBinary,
    getRawTermContentBlockCompressionDictName,
    RAW_TERM_CONTENT_DICT_NAME,
    RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from './raw-term-content.js';
import {decompress as zstdDecompress} from '../../lib/zstd-wasm.js';
import {TermContentOpfsStore} from './term-content-opfs-store.js';
import {TermContentBlockStore} from './term-content-block-store.js';
import {createTermImportMetrics} from './term-import-metrics.js';
import {createDictionaryImportSessionId, DictionaryImportJournal} from './dictionary-import-journal.js';
import {hashPairToHex, hashTermEntryContentBytes, hashTermEntryContentBytesPair} from './term-entry-content-hash.js';
import {TermRecordOpfsStore} from './term-record-opfs-store.js';
import {hasCompletePreparedTermLookupIndexes} from './term-lookup-index-preparation.js';
import {getTermRecordPreinternedPlan, sliceTermRecordPreinternedPlan} from './term-record-preinterned-plan.js';

const CURRENT_DICTIONARY_SCHEMA_VERSION = 10;
const TRANSIENT_UPDATE_TITLE_PATTERN = /\[(?:update-staging|cutover|replaced) [^\]]+\]/;
const TERM_ENTRY_CONTENT_CACHE_MAX_ENTRIES = 4096;
const TERM_ENTRY_CONTENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TERM_ROW_CACHE_MAX_ENTRIES = 8192;
const DEFAULT_STATEMENT_CACHE_MAX_ENTRIES = 256;
const LOW_MEMORY_STATEMENT_CACHE_MAX_ENTRIES = 128;
const DEFAULT_TERM_EXACT_PRESENCE_CACHE_MAX_ENTRIES = 25000;
const LOW_MEMORY_TERM_EXACT_PRESENCE_CACHE_MAX_ENTRIES = 8000;
const TERM_EXACT_MATCH_CACHE_MAX_ENTRIES = 4096;
const TERM_EXACT_MATCH_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const TERM_EXACT_MATCH_CACHE_MAX_IDS_PER_TERM = 256;
const TERM_BULK_ADD_STAGING_MAX_ROWS = 3000;
const DEFAULT_TERM_BULK_ADD_STAGING_MAX_ROWS = 4096;
const HIGH_MEMORY_TERM_BULK_ADD_STAGING_MAX_ROWS = 10240;
const TERM_CONTENT_STORAGE_MODE_BASELINE = 'baseline';
const TERM_CONTENT_STORAGE_MODE_RAW_BYTES = 'raw-bytes';
const DEFAULT_RAW_TERM_CONTENT_PACK_TARGET_BYTES = 4 * 1024 * 1024;
const TERM_CONTENT_BLOCK_TARGET_BYTES = 1024 * 1024;
const DEFAULT_ARTIFACT_FIXED_PACK_MIN_TOTAL_ROWS = 0;
const EXTERNAL_MEDIA_BULK_INSERT_BATCH_SIZE = 512;
const ZIP_COMPRESSION_METHOD_STORE = 0;
const ZIP_COMPRESSION_METHOD_DEFLATE = 8;
const TERM_CONTENT_META_U32_NULL = 0xffffffff;
const TERM_CONTENT_META_SLOT_EMPTY = 0;
const TERM_CONTENT_META_SLOT_PUBLISHED = 1;
const TERM_CONTENT_META_SLOT_PENDING = 2;
const TERM_CONTENT_META_PREALLOC_MAX_ENTRIES = 1024 * 1024;
const BULK_IMPORT_STATE_IDLE = 'idle';
const BULK_IMPORT_STATE_ACTIVE = 'active';
const BULK_IMPORT_STATE_FINALIZING = 'finalizing';
const VALIDATED_TERM_CONTENT_METADATA = Symbol('validatedTermContentMetadata');

/**
 * @typedef {object} ArtifactTermContentDedupPlan
 * @property {Uint8Array} resolvedFlags
 * @property {Float64Array} resolvedOffsets
 * @property {Uint32Array} resolvedLengths
 * @property {string[]|null} resolvedDictNames
 * @property {string} [resolvedUniformDictName]
 * @property {Uint32Array} pendingEpochs
 * @property {Uint32Array} pendingIndexes
 * @property {Uint32Array} [uniqueRowIndexes]
 * @property {Uint32Array} [uniqueSignatures]
 * @property {number} nextEpoch
 * @property {number} [nextUnresolvedUniqueIndex]
 * @property {boolean|null} [persistedLookupRequired]
 * @property {number} [sourceRowCount]
 * @property {number} [uniqueCount]
 * @property {Uint32Array} [pendingSpanOffsetsScratch]
 * @property {Uint32Array} [pendingSpanLengthsScratch]
 */

/**
 * @typedef {object} ArtifactTermContentChunk
 * @property {number} rowCount
 * @property {number} [contentRowStart]
 * @property {Uint8Array[]} contentBytesList
 * @property {Uint32Array|number[]} contentHash1List
 * @property {Uint32Array|number[]} contentHash2List
 * @property {Uint8Array} [contentBytesBuffer]
 * @property {number} [contentBytesBaseOffset]
 * @property {() => void} [releaseBorrowedContent]
 * @property {Uint32Array} [contentMetaList]
 * @property {Uint32Array|null} [contentUniqueIndexList]
 * @property {ArtifactTermContentDedupPlan|null} [contentDedupPlan]
 * @property {boolean} [useResolvedContentReferences]
 * @property {(string|null)[]|null} contentDictNameList
 * @property {string|null} [uniformContentDictName]
 */

class TermContentLookupReadError extends Error {
    /**
     * @param {'temporarilyUnavailable'|'corrupt'} status
     * @param {string} message
     * @param {{cause?: unknown}} [options]
     */
    constructor(status, message, options) {
        super(message, options);
        this.name = 'TermContentLookupReadError';
        this.status = status;
    }
}

/**
 * @param {ArtifactTermContentDedupPlan} plan
 * @param {'pendingSpanOffsetsScratch'|'pendingSpanLengthsScratch'} property
 * @param {number} count
 * @returns {Uint32Array}
 */
function getOrCreateTermContentPlanScratch(plan, property, count) {
    const existing = plan[property];
    if (existing instanceof Uint32Array && existing.length >= count) {
        return existing;
    }
    const scratch = new Uint32Array(count);
    plan[property] = scratch;
    return scratch;
}

/**
 * @param {Uint32Array} values
 * @param {number} target
 * @returns {number}
 */
function lowerBoundUint32(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + ((high - low) >>> 1);
        if (values[middle] < target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

/**
 * @param {ArtifactTermContentDedupPlan} plan
 * @param {number} uniqueIndex
 * @returns {string}
 */
function getResolvedTermContentPlanDictName(plan, uniqueIndex) {
    const names = plan.resolvedDictNames;
    if (Array.isArray(names)) {
        return names[uniqueIndex] ?? plan.resolvedUniformDictName ?? 'raw';
    }
    return typeof plan.resolvedUniformDictName === 'string' ? plan.resolvedUniformDictName : 'raw';
}

/**
 * Keeps the common single-codec import allocation-free and promotes to a
 * per-unique array only if a later block actually uses another codec.
 * @param {ArtifactTermContentDedupPlan} plan
 * @param {number} uniqueIndex
 * @param {string} value
 */
function setResolvedTermContentPlanDictName(plan, uniqueIndex, value) {
    const names = plan.resolvedDictNames;
    if (Array.isArray(names)) {
        names[uniqueIndex] = value;
        return;
    }
    const uniform = plan.resolvedUniformDictName;
    if (typeof uniform !== 'string' || uniform === value) {
        plan.resolvedUniformDictName = value;
        return;
    }
    const promotedNames = new Array(plan.resolvedFlags.length).fill(uniform);
    promotedNames[uniqueIndex] = value;
    plan.resolvedDictNames = promotedNames;
}

/**
 * Returns a scalar for the common single-codec case and projects only names
 * when persisted content genuinely spans multiple codecs.
 * @param {ArtifactTermContentDedupPlan} plan
 * @param {Uint32Array} uniqueIndexList
 * @param {number} count
 * @returns {string|string[]}
 */
function resolveArtifactTermContentPlanDictNames(plan, uniqueIndexList, count) {
    if (!Array.isArray(plan.resolvedDictNames)) {
        return plan.resolvedUniformDictName ?? 'raw';
    }
    const result = new Array(count);
    for (let i = 0; i < count; ++i) {
        const uniqueIndex = uniqueIndexList[i];
        if (uniqueIndex >= plan.resolvedFlags.length || plan.resolvedFlags[uniqueIndex] !== 1) {
            throw new Error(`Artifact term content unique index ${uniqueIndex} was not published`);
        }
        result[i] = getResolvedTermContentPlanDictName(plan, uniqueIndex);
    }
    return result;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function estimateCachedTermEntryContentBytes(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { return 0; }
    const content = /** @type {{definitionTags?: unknown, termTags?: unknown, rules?: unknown, glossaryJson?: unknown}} */ (value);
    let stringCodeUnits = 0;
    for (const item of [content.definitionTags, content.termTags, content.rules]) {
        if (typeof item === 'string') { stringCodeUnits += item.length; }
    }
    // Parsed glossary objects generally occupy several times their JSON text.
    const glossaryCodeUnits = typeof content.glossaryJson === 'string' ? content.glossaryJson.length : 0;
    return 128 + stringCodeUnits * 2 + glossaryCodeUnits * 4;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} compressionMethod
 * @param {number} uncompressedLength
 * @returns {Promise<Uint8Array>}
 */
async function inflateZipMediaContent(bytes, compressionMethod, uncompressedLength) {
    switch (compressionMethod) {
        case ZIP_COMPRESSION_METHOD_STORE:
            return bytes;
        case ZIP_COMPRESSION_METHOD_DEFLATE: {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('DecompressionStream is unavailable for compressed media content');
            }
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
            if (uncompressedLength > 0 && inflated.byteLength !== uncompressedLength) {
                throw new Error(`Compressed media length mismatch: expected ${uncompressedLength}, got ${inflated.byteLength}`);
            }
            return inflated;
        }
        default:
            throw new Error(`Unsupported zip media compression method: ${compressionMethod}`);
    }
}

/**
 * @param {string} value
 * @returns {[number, number]|null}
 */
function parseContentHashHexPair(value) {
    if (value.length !== 16) { return null; }
    const hash1 = Number.parseInt(value.slice(0, 8), 16);
    const hash2 = Number.parseInt(value.slice(8, 16), 16);
    if (!Number.isFinite(hash1) || !Number.isFinite(hash2)) { return null; }
    return [hash1 >>> 0, hash2 >>> 0];
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
        if (totalBytes <= 0) {
            sourceChunkIndices[startIndex] = packedChunks.length;
            sourceChunkLocalOffsets[startIndex] = 0;
            packedChunks.push(chunks[startIndex]);
            ++startIndex;
            continue;
        }
        const packedIndex = packedChunks.length;
        const packed = new Uint8Array(totalBytes);
        let offset = 0;
        for (let i = startIndex; i < endIndex; ++i) {
            const chunk = chunks[i];
            sourceChunkIndices[i] = packedIndex;
            sourceChunkLocalOffsets[i] = offset;
            packed.set(chunk, offset);
            offset += chunk.byteLength;
        }
        packedChunks.push(packed);
        startIndex = endIndex;
    }
    return {packedChunks, sourceChunkIndices, sourceChunkLocalOffsets};
}

/**
 * @param {string} title
 * @returns {{stage: string, token: string}|null}
 */
function parseTransientUpdateTitleInfo(title) {
    const match = `${title}`.trim().match(/\[(update-staging|cutover|replaced) ([^\]]+)\]$/);
    if (match === null) { return null; }
    const [, stage, token] = match;
    if (typeof stage !== 'string' || typeof token !== 'string' || token.length === 0) {
        return null;
    }
    return {stage, token};
}

/**
 * @param {string} title
 * @param {unknown} summary
 * @returns {boolean}
 */
function isRecognizedTransientUpdateTitle(title, summary) {
    const transientInfo = parseTransientUpdateTitleInfo(title);
    if (transientInfo === null) { return false; }
    if (!(typeof summary === 'object' && summary !== null && !Array.isArray(summary))) {
        return false;
    }
    const summaryToken = typeof Reflect.get(summary, 'updateSessionToken') === 'string' ? Reflect.get(summary, 'updateSessionToken').trim() : '';
    const summaryStage = typeof Reflect.get(summary, 'transientUpdateStage') === 'string' ? Reflect.get(summary, 'transientUpdateStage').trim() : '';
    return summaryToken === transientInfo.token && summaryStage === transientInfo.stage;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {number} targetBytes
 * @param {number} fixedChunkBytes
 * @returns {{packedChunks: Uint8Array[], packedRowStarts: Uint32Array, packedRowCounts: Uint32Array}}
 */
function packFixedSizeContentChunksIntoSlabs(chunks, targetBytes, fixedChunkBytes) {
    /** @type {Uint8Array[]} */
    const packedChunks = [];
    if (chunks.length === 0 || fixedChunkBytes <= 0) {
        return {
            packedChunks,
            packedRowStarts: new Uint32Array(0),
            packedRowCounts: new Uint32Array(0),
        };
    }
    const rowsPerPackedChunk = Math.max(1, Math.floor(targetBytes / fixedChunkBytes));
    const packedChunkCount = Math.ceil(chunks.length / rowsPerPackedChunk);
    const packedRowStarts = new Uint32Array(packedChunkCount);
    const packedRowCounts = new Uint32Array(packedChunkCount);
    for (let startIndex = 0, packedIndex = 0; startIndex < chunks.length; ++packedIndex) {
        const endIndex = Math.min(chunks.length, startIndex + rowsPerPackedChunk);
        const rowCount = endIndex - startIndex;
        const packed = new Uint8Array(rowCount * fixedChunkBytes);
        let offset = 0;
        for (let i = startIndex; i < endIndex; ++i) {
            packed.set(chunks[i], offset);
            offset += fixedChunkBytes;
        }
        packedChunks.push(packed);
        packedRowStarts[packedIndex] = startIndex;
        packedRowCounts[packedIndex] = rowCount;
        startIndex = endIndex;
    }
    return {packedChunks, packedRowStarts, packedRowCounts};
}

/**
 * @typedef {object} InsertStatement
 * @property {string} sql
 * @property {(item: unknown) => import('@sqlite.org/sqlite-wasm').BindingSpec} bind
 */

export class DictionaryDatabase {
    constructor() {
        /** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static|null} */
        this._sqlite3 = null;
        /** @type {import('@sqlite.org/sqlite-wasm').Database|null} */
        this._db = null;
        /** @type {boolean} */
        this._isOpening = false;
        /** @type {Promise<void>|null} */
        this._openingPromise = null;
        /** @type {Promise<void>|null} */
        this._closingPromise = null;
        /** @type {Promise<boolean>|null} */
        this._purgingPromise = null;
        /** @type {boolean} */
        this._usesFallbackStorage = false;
        /** @type {{mode: string, forceFallback: boolean, hasOpfsDbCtor: boolean, hasOpfsImportDb: boolean, hasWasmfsDir: boolean, attempts?: Array<{strategy: string, target: string, flags: string, error: string}>, lastError?: string|null}|null} */
        this._openStorageDiagnostics = null;
        /** @type {Record<string, unknown>|null} */
        this._startupCleanupIncompleteImportsSummary = null;
        /** @type {Record<string, unknown>|null} */
        this._startupCleanupMissingTermRecordShardsSummary = null;
        /** @type {'idle'|'active'|'finalizing'} */
        this._bulkImportState = BULK_IMPORT_STATE_IDLE;
        /** @type {Promise<void>|null} */
        this._bulkImportSetupPromise = null;
        /** @type {boolean} */
        this._bulkImportTransactionOpen = false;
        /** @type {DictionaryImportJournal} */
        this._importJournal = new DictionaryImportJournal();
        /** @type {import('dictionary-import-journal').DictionaryImportJournalRecord|null} */
        this._bulkImportJournalRecord = null;
        /** @type {boolean} */
        this._importJournalRecoveryPending = false;
        /** @type {boolean} */
        this._deferTermsVirtualTableSync = false;
        /** @type {boolean} */
        this._termsVirtualTableDirty = false;
        /** @type {Map<string, number>} */
        this._termEntryContentIdByKey = new Map();
        /** @type {Map<string, number>} */
        this._termEntryContentIdByHash = new Map();
        /** @type {Map<string, {id: number, offset: number, length: number, dictName: string}>} */
        this._termEntryContentMetaByHash = new Map();
        /** @type {Uint32Array} Sparse hash slots containing dense metadata indexes plus one. */
        this._termEntryContentMetaHashPairTable = new Uint32Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaHash1Table = new Uint32Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaHash2Table = new Uint32Array(0);
        /** @type {Uint8Array} */
        this._termEntryContentMetaStateTable = new Uint8Array(0);
        /** @type {Float64Array} */
        this._termEntryContentMetaIdTable = new Float64Array(0);
        /** @type {Float64Array} */
        this._termEntryContentMetaOffsetTable = new Float64Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaLengthTable = new Uint32Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaDictNameIdTable = new Uint32Array(0);
        /** @type {Uint8Array} */
        this._termEntryContentMetaSignaturePresentTable = new Uint8Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaSignature1Table = new Uint32Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaSignature2Table = new Uint32Array(0);
        /** @type {Uint32Array} */
        this._termEntryContentMetaSignature3Table = new Uint32Array(0);
        /** @type {Map<string, number>} */
        this._termEntryContentMetaDictNameIdByValue = new Map([['raw', 0]]);
        /** @type {string[]} */
        this._termEntryContentMetaDictNames = ['raw'];
        /** @type {number} */
        this._termEntryContentMetaHashPairMask = 0;
        /** @type {number} */
        this._termEntryContentMetaHashPairCount = 0;
        /** @type {number} */
        this._termEntryContentMetaHashPairPendingCount = 0;
        /** @type {number} */
        this._termEntryContentMetaDenseCount = 0;
        /** @type {number[]} */
        this._termEntryContentMetaFreeIndexes = [];
        /** @type {Map<string, Array<{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}>>} */
        this._termEntryContentMetaCollisionsByHashPair = new Map();
        /** @type {boolean} */
        this._termEntryContentHasExistingRows = true;
        /** @type {boolean} */
        this._enableTermEntryContentDedup = true;
        /** @type {Array<{hash1Table: Uint32Array, hash2Table: Uint32Array, indexTable: Uint32Array}>} */
        this._artifactTermContentDedupScratchPool = [];
        /** @type {Map<string, import('@sqlite.org/sqlite-wasm').PreparedStatement>} */
        this._statementCache = new Map();
        /** @type {number} */
        this._statementCacheMaxEntries = this._computeStatementCacheMaxEntries();
        /** @type {Map<string, {definitionTags: string|null, termTags: string|undefined, rules: string, glossaryJson?: string, glossary?: import('dictionary-data').TermGlossary[]}>} */
        this._termEntryContentCache = new WeightedLruMap(
            TERM_ENTRY_CONTENT_CACHE_MAX_ENTRIES,
            TERM_ENTRY_CONTENT_CACHE_MAX_BYTES,
            estimateCachedTermEntryContentBytes,
        );
        /** @type {Map<number, import('dictionary-database').DatabaseTermEntryWithId>} */
        this._termRowCache = new Map();
        /** @type {Map<string, {contentOffset: number, contentLength: number, contentDictName: string, uncompressedLength: number}>} */
        this._sharedGlossaryArtifactMetaByDictionary = new Map();
        /** @type {Map<string, Uint8Array>} */
        this._sharedGlossaryArtifactInflatedByDictionary = new Map();
        /** @type {Map<string, Promise<Uint8Array>>} */
        this._sharedGlossaryArtifactInflatePromiseByDictionary = new Map();
        /** @type {number} */
        this._sharedGlossaryArtifactGeneration = 0;
        /** @type {Record<string, unknown>|null} */
        this._lastReplaceDictionaryTitleDebug = null;
        /** @type {TextEncoder} */
        this._textEncoder = new TextEncoder();
        /** @type {TextDecoder} */
        this._textDecoder = new TextDecoder();
        /** @type {boolean} */
        this._termContentZstdInitialized = false;
        /** @type {'baseline'|'raw-bytes'} */
        this._termContentStorageMode = TERM_CONTENT_STORAGE_MODE_BASELINE;
        /** @type {Map<string, boolean>} */
        this._termExactPresenceCache = new Map();
        /** @type {number} */
        this._termExactPresenceCacheMaxEntries = this._computeTermExactPresenceCacheMaxEntries();
        /** @type {Map<string, {expression: number[], reading: number[]}>} */
        this._termExactMatchCache = new WeightedLruMap(
            TERM_EXACT_MATCH_CACHE_MAX_ENTRIES,
            TERM_EXACT_MATCH_CACHE_MAX_BYTES,
            (value, key) => {
                const matches = /** @type {{expression?: number[], reading?: number[]}} */ (value);
                return `${key}`.length * 2 + ((matches.expression?.length ?? 0) + (matches.reading?.length ?? 0)) * 8 + 64;
            },
        );
        /** @type {Map<string, boolean>} */
        this._termPrefixNegativeCache = new Map();
        /** @type {WeakMap<Map<string, number[]>, {size: number, keys: string[]}>} */
        this._termIndexSortedKeysByLookup = new WeakMap();
        /** @type {Map<string, Promise<void>>} */
        this._directTermIndexLoadPromiseByDictionary = new Map();
        /** @type {Set<string>} */
        this._directTermIndexLoadedDictionaryNames = new Set();
        /** @type {number} */
        this._directTermIndexGeneration = 0;
        /** @type {Map<string, {expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}>} */
        this._directTermIndexByDictionary = new Map();
        /** @type {Map<string, string>} */
        this._termRecordStorageNameByDictionary = new Map();
        /** @type {Map<string, string>} */
        this._dictionaryNameByTermRecordStorage = new Map();
        /** @type {import('@sqlite.org/sqlite-wasm').sqlite3_module|null} */
        this._termsVtabModule = null;
        /** @type {boolean} */
        this._termsVtabModuleRegistered = false;
        /** @type {Map<number, {ids: number[], index: number}>} */
        this._termsVtabCursorState = new Map();
        /** @type {boolean} */
        this._enableSqliteSecondaryIndexes = false;
        /** @type {number} */
        this._termContentCompressionMinBytes = 1048576;
        /** @type {number} */
        this._rawTermContentPackTargetBytes = DEFAULT_RAW_TERM_CONTENT_PACK_TARGET_BYTES;
        this._artifactFixedPackMinTotalRows = DEFAULT_ARTIFACT_FIXED_PACK_MIN_TOTAL_ROWS;
        /** @type {boolean} */
        this._importDebugLogging = false;
        /** @type {number} */
        this._termBulkAddLogIntervalMs = 3000;
        /** @type {number} */
        this._termBulkAddFailFastMinRowsPerSecond = 1200;
        /** @type {number} */
        this._termBulkAddFailFastSlowBatchMs = 15000;
        /** @type {number} */
        this._termBulkAddFailFastMinRowsBeforeCheck = 32768;
        /** @type {number} */
        this._termBulkAddFailFastWindowSize = 5;
        /** @type {number} */
        this._termBulkAddBatchSize = 25000;
        /** @type {boolean} */
        this._adaptiveTermBulkAddBatchSize = true;
        /** @type {boolean} */
        this._retryBeginImmediateTransaction = false;
        /** @type {boolean} */
        this._skipIntraBatchContentDedup = false;
        /** @type {number} */
        this._termBulkAddStagingMaxRows = this._computeDefaultTermBulkAddStagingMaxRows();
        /** @type {boolean} */
        this._termRecordRowAppendFastPath = true;
        /** @type {{contentAppendMs: number, dedupScanMs?: number, contentStoreMs?: number, contentMetadataMs?: number, termRecordBuildMs: number, termRecordEncodeMs: number, termRecordWriteMs: number, termsVtabInsertMs: number}|null} */
        this._lastBulkAddTermsMetrics = null;
        /** @type {TermContentOpfsStore} */
        this._termContentStore = new TermContentOpfsStore();
        /** @type {TermContentBlockStore} */
        this._termContentBlockStore = new TermContentBlockStore(this._termContentStore, {
            blockTargetBytes: TERM_CONTENT_BLOCK_TARGET_BYTES,
        });
        /** @type {import('./term-content-block-store.js').TermContentBlockImportSession|null} */
        this._termContentBlockImportSession = null;
        /** @type {TermRecordOpfsStore} */
        this._termRecordStore = new TermRecordOpfsStore();
        this._termRecordStore.setDictionaryHealthChangeHandler(
            this._onTermRecordDictionaryHealthChanged.bind(this),
        );
        /**
         * @type {Worker?}
         */
        this._worker = null;

        /**
         * @type {Uint8Array?}
         */
        this._resvgFontBuffer = null;

        /** @type {import('dictionary-database').ApiMap} */
        this._apiMap = createApiMap([
            ['drawMedia', this._onDrawMedia.bind(this)],
        ]);
    }

    /** */
    async prepare() {
        if (this._purgingPromise !== null) {
            await this._purgingPromise;
            return;
        }
        await this._prepareOnce(false);
    }

    /**
     * @param {boolean} preserveBulkImportLifecycle
     */
    async _prepareOnce(preserveBulkImportLifecycle) {
        if (this._closingPromise !== null) {
            await this._closingPromise;
        }
        if (this._db !== null) {
            throw new Error('Database already open');
        }
        if (this._isOpening) {
            if (this._openingPromise !== null) {
                await this._openingPromise;
                return;
            }
            throw new Error('Already opening');
        }

        this._openingPromise = (async () => {
            this._isOpening = true;
            try {
                await this._openConnection();
                await initializeTermContentZstd();
                this._termContentZstdInitialized = true;
                await this._deleteLegacyIndexedDb();
                this._refreshTermRecordStorageNameMappings();
                await this._cleanupIncompleteImports();
                this._refreshTermRecordStorageNameMappings();
                await this._cleanupMissingTermRecordShards();

                // keep existing draw worker split behaviour.
                const isWorker = self.constructor.name !== 'Window';
                if (!isWorker && this._worker === null) {
                    this._worker = new Worker('/js/dictionary/dictionary-database-worker-main.js', {type: 'module'});
                    this._worker.addEventListener('error', (event) => {
                        log.log('Worker terminated with error:', event);
                    });
                    this._worker.addEventListener('unhandledrejection', (event) => {
                        log.log('Unhandled promise rejection in worker:', event);
                    });
                } else if (isWorker && this._resvgFontBuffer === null) {
                    try {
                        await initWasm(fetch('/lib/resvg.wasm'));
                    } catch (error) {
                        const message = (error instanceof Error) ? error.message : String(error);
                        if (!/Already initialized/i.test(message)) {
                            throw error;
                        }
                    }

                    const font = await fetch('/fonts/NotoSansJP-Regular.ttf');
                    const fontData = await font.arrayBuffer();
                    this._resvgFontBuffer = new Uint8Array(fontData);
                }
            } catch (error) {
                const cleanupErrors = await this._cleanupAfterPrepareFailure(preserveBulkImportLifecycle);
                if (cleanupErrors.length > 0) {
                    throw new AggregateError(
                        [toError(error), ...cleanupErrors],
                        'Dictionary database preparation and cleanup failed',
                    );
                }
                throw error;
            } finally {
                this._isOpening = false;
            }
        })();
        try {
            await this._openingPromise;
        } finally {
            this._openingPromise = null;
        }
    }

    /** */
    async close() {
        if (this._purgingPromise !== null) {
            await this._purgingPromise;
        }
        if (this._closingPromise !== null) {
            await this._closingPromise;
            return;
        }
        const closingPromise = this._closeOnce();
        this._closingPromise = closingPromise;
        try {
            await closingPromise;
        } finally {
            if (this._closingPromise === closingPromise) {
                this._closingPromise = null;
            }
        }
    }

    /** */
    async _closeOnce() {
        if (this._isOpening && this._openingPromise !== null) {
            await this._openingPromise;
        }
        if (this._bulkImportSetupPromise !== null) {
            try {
                await this._bulkImportSetupPromise;
            } catch (_) {
                // Setup performs its own rollback; close still owns releasing the runtime.
            }
        }
        if (this._db === null) {
            return;
        }
        this._beginExclusiveDatabaseCleanup();
        /** @type {Error[]} */
        const errors = [];
        try {
            const db = this._requireDb();
            if (this._bulkImportJournalRecord !== null) {
                await this._rollbackBulkImport(db, errors, true, true);
            } else {
                this._rollbackBulkImportSqlite(db, errors);
                await this._endBulkImportStoreSessions(errors, true, true);
            }
            this._releaseRuntimeConnection(errors);
        } finally {
            this._endBulkImportLifecycle();
            this._deferTermsVirtualTableSync = false;
            this._termsVirtualTableDirty = false;
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, 'Dictionary database close encountered cleanup failures');
        }
    }

    /**
     * Releases resources owned by the active SQLite connection while preserving
     * every failure for the caller to report after cleanup completes.
     * @param {Error[]} errors
     */
    _releaseRuntimeConnection(errors) {
        try {
            this._termContentBlockImportSession?.close();
        } catch (error) {
            errors.push(toError(error));
        }
        this._termContentBlockImportSession = null;
        this._clearCachedStatements();
        this._clearSharedGlossaryArtifactCaches();
        this._clearTermsVtabCursorState();
        this._termsVtabModuleRegistered = false;
        const db = this._db;
        this._db = null;
        if (db !== null) {
            try {
                db.close();
            } catch (error) {
                errors.push(toError(error));
            }
        }
        this._usesFallbackStorage = false;
    }

    /**
     * @param {'idle'|'active'|'finalizing'} expectedState
     * @param {'idle'|'active'|'finalizing'} nextState
     * @throws {Error} If the current state does not match the expected state.
     */
    _transitionBulkImportState(expectedState, nextState) {
        if (this._bulkImportState !== expectedState) {
            throw new Error(`Invalid dictionary bulk import lifecycle transition: ${this._bulkImportState} -> ${nextState}`);
        }
        this._bulkImportState = nextState;
    }

    /**
     * Reserves import ownership synchronously before setup begins.
     * @throws {Error} If an import already owns the lifecycle.
     */
    _beginBulkImportLifecycle() {
        if (this._bulkImportState !== BULK_IMPORT_STATE_IDLE) {
            throw new Error('A dictionary bulk import is already active');
        }
        this._transitionBulkImportState(BULK_IMPORT_STATE_IDLE, BULK_IMPORT_STATE_ACTIVE);
    }

    /**
     * @returns {import('@sqlite.org/sqlite-wasm').Database|null}
     * @throws {Error} If finalization already owns the lifecycle or the database is closed.
     */
    _beginBulkImportFinalization() {
        if (this._bulkImportState === BULK_IMPORT_STATE_IDLE) { return null; }
        if (this._bulkImportState === BULK_IMPORT_STATE_FINALIZING) {
            throw new Error('Dictionary bulk import finalization is already active');
        }
        const db = this._requireDb();
        this._transitionBulkImportState(BULK_IMPORT_STATE_ACTIVE, BULK_IMPORT_STATE_FINALIZING);
        return db;
    }

    /** Claims lifecycle ownership for close or purge after import setup settles. */
    _beginExclusiveDatabaseCleanup() {
        if (this._bulkImportState === BULK_IMPORT_STATE_FINALIZING) {
            throw new Error('Dictionary bulk import finalization is already active');
        }
        const expectedState = this._bulkImportState;
        this._transitionBulkImportState(expectedState, BULK_IMPORT_STATE_FINALIZING);
    }

    /** Waits until active import setup has either completed or cleaned itself up. */
    async _waitForBulkImportSetup() {
        const setupPromise = this._bulkImportSetupPromise;
        if (setupPromise !== null) {
            await setupPromise;
        }
    }

    /** Returns the lifecycle to idle after setup or finalization cleanup. */
    _endBulkImportLifecycle() {
        if (this._bulkImportState === BULK_IMPORT_STATE_IDLE) { return; }
        if (this._bulkImportState === BULK_IMPORT_STATE_ACTIVE) {
            this._transitionBulkImportState(BULK_IMPORT_STATE_ACTIVE, BULK_IMPORT_STATE_IDLE);
            return;
        }
        this._transitionBulkImportState(BULK_IMPORT_STATE_FINALIZING, BULK_IMPORT_STATE_IDLE);
    }

    /**
     * @returns {boolean}
     */
    _isBulkImportInProgress() {
        return this._bulkImportState === BULK_IMPORT_STATE_ACTIVE || this._bulkImportState === BULK_IMPORT_STATE_FINALIZING;
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').Database} db
     * @param {Error[]} errors
     * @returns {boolean}
     */
    _rollbackBulkImportSqlite(db, errors) {
        if (!this._bulkImportTransactionOpen) { return true; }
        let succeeded = true;
        try {
            db.exec('ROLLBACK');
        } catch (error) {
            const rollbackError = toError(error);
            if (!this._isNoActiveTransactionError(rollbackError)) {
                succeeded = false;
                errors.push(rollbackError);
            }
        }
        this._bulkImportTransactionOpen = false;
        return succeeded;
    }

    /**
     * @param {Error[]} errors
     * @param {boolean} endTermContentSession
     * @param {boolean} endTermRecordSession
     * @returns {Promise<boolean>}
     */
    async _endBulkImportStoreSessions(errors, endTermContentSession, endTermRecordSession) {
        const operations = [];
        if (endTermContentSession) {
            operations.push(Promise.resolve().then(() => this._termContentStore.endImportSession()));
        }
        if (endTermRecordSession) {
            operations.push(Promise.resolve().then(() => this._termRecordStore.endImportSession()));
        }
        const results = await Promise.allSettled(operations);
        for (const result of results) {
            if (result.status === 'rejected') { errors.push(toError(result.reason)); }
        }
        return results.every((result) => result.status === 'fulfilled');
    }

    /**
     * Rolls SQLite back before OPFS checkpoints and only releases the journal
     * after every requested rollback succeeds.
     * @param {import('@sqlite.org/sqlite-wasm').Database} db
     * @param {Error[]} errors
     * @param {boolean} rollbackTermContent
     * @param {boolean} rollbackTermRecords
     * @returns {Promise<boolean>}
     */
    async _rollbackBulkImport(db, errors, rollbackTermContent, rollbackTermRecords) {
        const sqliteRollbackSucceeded = this._rollbackBulkImportSqlite(db, errors);
        const journalRecord = this._bulkImportJournalRecord;
        if (journalRecord === null) {
            await this._endBulkImportStoreSessions(errors, rollbackTermContent, rollbackTermRecords);
            return sqliteRollbackSucceeded;
        }

        const operations = [];
        if (rollbackTermContent) {
            operations.push(Promise.resolve().then(() => this._termContentStore.rollbackImportSession(journalRecord.contentCheckpoint)));
        }
        if (rollbackTermRecords) {
            operations.push(Promise.resolve().then(() => this._termRecordStore.rollbackImportSession(journalRecord.recordCheckpoint)));
        }
        const results = await Promise.allSettled(operations);
        const storageRollbackSucceeded = results.every((result) => result.status === 'fulfilled');
        for (const result of results) {
            if (result.status === 'rejected') { errors.push(toError(result.reason)); }
        }
        const rollbackSucceeded = sqliteRollbackSucceeded && storageRollbackSucceeded;
        if (rollbackSucceeded) {
            try {
                await this._importJournal.clear();
                this._bulkImportJournalRecord = null;
            } catch (error) {
                errors.push(toError(error));
            }
        }
        if (this._bulkImportJournalRecord !== null) {
            this._importJournalRecoveryPending = true;
        }
        return rollbackSucceeded;
    }

    /** @param {Error[]} errors */
    _closeBulkImportBlockSession(errors) {
        try {
            this._termContentBlockImportSession?.close();
        } catch (error) {
            errors.push(toError(error));
        }
        this._termContentBlockImportSession = null;
    }

    /** Clears lookup state that may reference rolled-back import rows. */
    _clearBulkImportRuntimeCaches() {
        this._termEntryContentIdByKey.clear();
        this._termEntryContentIdByHash.clear();
        this._clearTermEntryContentMetaCaches();
        this._termEntryContentCache.clear();
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').Database} db
     * @param {Error[]} errors
     */
    _restoreRuntimeAfterBulkImportFailure(db, errors) {
        for (const createIndexSql of this._createIndexesSql()) {
            try {
                db.exec(createIndexSql);
            } catch (error) {
                errors.push(toError(error));
            }
        }
        this._clearBulkImportRuntimeCaches();
        this._deferTermsVirtualTableSync = false;
        this._termsVirtualTableDirty = false;
        try {
            this._applyRuntimePragmas();
        } catch (error) {
            errors.push(toError(error));
        }
        this._closeBulkImportBlockSession(errors);
        if (this._bulkImportJournalRecord !== null) {
            this._importJournalRecoveryPending = true;
        }
    }

    /** @param {Error[]} errors */
    _quarantineBulkImportConnection(errors) {
        this._releaseRuntimeConnection(errors);
    }

    /**
     * @param {boolean} clearImportJournal
     * @returns {Promise<Error[]>}
     */
    async _collectPersistentStoreResetErrors(clearImportJournal) {
        const operations = [
            this._termContentStore.reset(),
            this._termRecordStore.reset(),
        ];
        if (clearImportJournal) {
            operations.push(this._importJournal.clear());
        }
        const results = await Promise.allSettled(operations);
        return results
            .filter((result) => result.status === 'rejected')
            .map((result) => toError(result.reason));
    }

    /**
     * @returns {boolean}
     */
    isPrepared() {
        return this._db !== null;
    }

    /**
     * Imports and lookups share this database instance in the local worker
     * runtime. Keep the prepared connection and its newly built indexes warm.
     * @returns {Promise<void>}
     */
    async adoptCurrentConnectionAfterImport() {
        if (!this.isPrepared()) {
            throw new Error('Dictionary runtime is not prepared after import');
        }
    }

    /**
     * @returns {boolean}
     */
    isOpening() {
        return this._isOpening;
    }

    /**
     * @param {boolean} suspended
     * @returns {Promise<void>}
     */
    async setSuspended(suspended) {
        if (suspended) {
            await this.close();
            return;
        }
        if (this._closingPromise !== null) {
            await this._closingPromise;
        }
        if (this._db === null) {
            await this.prepare();
        }
    }

    /**
     * @returns {boolean}
     */
    usesFallbackStorage() {
        return this._usesFallbackStorage;
    }

    /**
     * @returns {{mode: string, forceFallback: boolean, hasOpfsDbCtor: boolean, hasOpfsImportDb: boolean, hasWasmfsDir: boolean, attempts?: Array<{strategy: string, target: string, flags: string, error: string}>, lastError?: string|null}|null}
     */
    getOpenStorageDiagnostics() {
        if (this._openStorageDiagnostics === null) {
            return null;
        }
        return {...this._openStorageDiagnostics};
    }

    /**
     * @param {string} dictionaryName
     * @param {number} [sampleLimit=8]
     * @returns {Promise<{dictionary: string, totalLength: number, sampledRecordCount: number, outOfBoundsRecordCount: number, sampledRecords: Array<{id: number, expression: string, reading: string, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, outOfBounds: boolean}>}>}
     */
    async debugSampleTermContentIntegrity(dictionaryName, sampleLimit = 8) {
        const logicalStoreState = this._termContentStore.getDebugState();
        const logicalTotalLength = this._asNumber(logicalStoreState?.totalLength, -1);
        await this._termContentStore.ensureLoadedForRead();
        const termRecordStorageName = this._getTermRecordStorageName(dictionaryName);
        await this._termRecordStore.ensureDictionariesLoaded([termRecordStorageName]);
        const persistedStoreState = this._termContentStore.getDebugState();
        const persistedTotalLength = this._asNumber(persistedStoreState?.totalLength, -1);
        const ids = this._getDirectDictionarySampleIds(dictionaryName, sampleLimit);
        /** @type {Array<{id: number, expression: string, reading: string, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, outOfBounds: boolean}>} */
        const sampledRecords = [];
        let outOfBoundsRecordCount = 0;
        const recordsById = await this._termRecordStore.getByIdsAsync(ids);
        for (const id of ids) {
            const record = recordsById.get(id);
            if (typeof record === 'undefined') { continue; }
            const entryContentOffset = this._asNumber(record.entryContentOffset, -1);
            const entryContentLength = this._asNumber(record.entryContentLength, -1);
            const outOfBounds = (
                persistedTotalLength >= 0 &&
                entryContentOffset >= 0 &&
                entryContentLength > 0 &&
                (entryContentOffset + entryContentLength) > persistedTotalLength
            );
            if (outOfBounds) {
                ++outOfBoundsRecordCount;
            }
            sampledRecords.push({
                id,
                expression: this._asString(record.expression),
                reading: this._asString(record.reading),
                entryContentOffset,
                entryContentLength,
                entryContentDictName: this._asNullableString(record.entryContentDictName),
                outOfBounds,
            });
        }
        return {
            dictionary: dictionaryName,
            logicalTotalLength,
            persistedTotalLength,
            sampledRecordCount: sampledRecords.length,
            outOfBoundsRecordCount,
            logicalStoreState,
            persistedStoreState,
            sampledRecords,
        };
    }

    /**
     * @returns {Record<string, unknown>|null}
     */
    getStartupCleanupIncompleteImportsSummary() {
        return this._startupCleanupIncompleteImportsSummary;
    }

    /**
     * @returns {Record<string, unknown>|null}
     */
    getStartupCleanupMissingTermRecordShardsSummary() {
        return this._startupCleanupMissingTermRecordShardsSummary;
    }

    /** */
    async startBulkImport() {
        if (this._isOpening || this._closingPromise !== null || this._purgingPromise !== null) {
            throw new Error('Cannot start a dictionary bulk import while the database lifecycle is busy');
        }
        const db = this._requireDb();
        // Reserve ownership before the first await so two import requests cannot
        // initialize overlapping journals and OPFS sessions.
        this._beginBulkImportLifecycle();
        const setupPromise = this._startBulkImportSetup(db);
        this._bulkImportSetupPromise = setupPromise;
        try {
            await setupPromise;
        } finally {
            if (this._bulkImportSetupPromise === setupPromise) {
                this._bulkImportSetupPromise = null;
            }
        }
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').Database} db
     * @returns {Promise<void>}
     */
    async _startBulkImportSetup(db) {
        try {
            if (this._importJournalRecoveryPending) {
                await this._recoverInterruptedImportSession();
                if (this._importJournalRecoveryPending) {
                    throw new Error('Cannot import dictionaries until interrupted-import recovery metadata is cleared');
                }
            }
            let termContentSessionStartAttempted = false;
            let termRecordSessionStartAttempted = false;
            try {
                const [contentCheckpoint, recordCheckpoint] = await Promise.all([
                    this._termContentStore.createImportCheckpoint(),
                    this._termRecordStore.createImportCheckpoint(),
                ]);
                this._bulkImportJournalRecord = {
                    version: 1,
                    sessionId: createDictionaryImportSessionId(),
                    contentCheckpoint,
                    recordCheckpoint,
                    createdAt: Date.now(),
                };
                await this._importJournal.write(this._bulkImportJournalRecord);
                termContentSessionStartAttempted = true;
                await this._termContentStore.beginImportSession();
                termRecordSessionStartAttempted = true;
                await this._termRecordStore.beginImportSession();
                this._applyImportPragmas();
                this._deferTermsVirtualTableSync = true;
                this._termsVirtualTableDirty = false;
                this._termEntryContentHasExistingRows = this._asNumber(db.selectValue('SELECT 1 FROM termEntryContent LIMIT 1'), 0) === 1;
                for (const dropIndexSql of this._createDropIndexesSql()) {
                    db.exec(dropIndexSql);
                }
                this._termEntryContentIdByKey.clear();
                this._termEntryContentIdByHash.clear();
                this._clearTermEntryContentMetaCaches();
                this._termContentBlockImportSession?.close();
                this._termContentBlockImportSession = this._termContentBlockStore.beginImportSession();
                this._termEntryContentCache.clear();
                this._termExactPresenceCache.clear();
                this._termPrefixNegativeCache.clear();
                this._clearDirectTermIndexCaches();
                await this._beginImmediateTransaction(db, false);
                this._bulkImportTransactionOpen = true;
            } catch (e) {
                const errors = [toError(e)];
                const rollbackSucceeded = await this._rollbackBulkImport(
                    db,
                    errors,
                    termContentSessionStartAttempted,
                    termRecordSessionStartAttempted,
                );
                this._restoreRuntimeAfterBulkImportFailure(db, errors);
                if (!rollbackSucceeded) {
                    this._quarantineBulkImportConnection(errors);
                }
                if (errors.length === 1) {
                    throw errors[0];
                }
                throw new AggregateError(errors, 'Failed to start and clean up dictionary import storage');
            }
        } catch (error) {
            this._endBulkImportLifecycle();
            throw error;
        }
    }

    /** Rolls back an active import without publishing any partial state. */
    async abortBulkImport() {
        await this._waitForBulkImportSetup();
        const db = this._beginBulkImportFinalization();
        if (db === null) { return; }
        /** @type {Error[]} */
        const errors = [];
        let rollbackSucceeded = true;
        try {
            rollbackSucceeded = await this._rollbackBulkImport(db, errors, true, true);
            this._restoreRuntimeAfterBulkImportFailure(db, errors);
            if (!rollbackSucceeded || errors.length > 0) {
                this._quarantineBulkImportConnection(errors);
            }
        } finally {
            this._endBulkImportLifecycle();
        }
        if (errors.length > 1 || !rollbackSucceeded) {
            throw new AggregateError(errors, 'Failed to roll back dictionary import storage');
        }
        if (errors.length === 1) { throw errors[0]; }
    }

    /**
     * @param {((index: number, count: number) => void)?} [onCheckpoint]
     * @param {{summary: import('dictionary-importer').Summary, primaryKey: number}|null} [publication]
     * @returns {Promise<{commitMs: number, termContentEndImportSessionMs: number, termContentEndImportSessionFlushPendingWritesMs: number, termContentEndImportSessionAwaitQueuedWritesMs: number, termContentEndImportSessionCloseWritableMs: number, termContentDrainCycleCount: number, termContentWriteCallCount: number, termContentSingleChunkWriteCount: number, termContentMergedWriteCount: number, termContentTotalWriteBytes: number, termContentMergedWriteBytes: number, termContentMaxWriteBytes: number, termContentMergedGroupChunkCount: number, termContentMaxMergedGroupChunkCount: number, termContentFlushDueToBytesCount: number, termContentFlushDueToChunkCount: number, termContentFlushFinalGroupCount: number, termContentWriteCoalesceTargetBytes: number, termContentWriteCoalesceMaxChunks: number, termContentWriteFlushThresholdBytes: number, termRecordEndImportSessionMs: number, termRecordEndImportSessionFlushPendingWritesMs: number, termRecordEndImportSessionAwaitQueuedWritesMs: number, termRecordEndImportSessionCloseWritableMs: number, termsVirtualTableSyncMs: number, createIndexesMs: number, createIndexesCheckpointCount: number, cacheResetMs: number, runtimePragmasMs: number, totalMs: number}|null>}
     */
    async finishBulkImport(onCheckpoint = null, publication = null) {
        await this._waitForBulkImportSetup();
        const db = this._beginBulkImportFinalization();
        if (db !== null) {
            const tFinishBulkImportStart = safePerformance.now();
            let commitMs = 0;
            let termContentEndImportSessionMs = 0;
            let termContentEndImportSessionFlushPendingWritesMs = 0;
            let termContentEndImportSessionAwaitQueuedWritesMs = 0;
            let termContentEndImportSessionCloseWritableMs = 0;
            let termContentDrainCycleCount = 0;
            let termContentWriteCallCount = 0;
            let termContentSingleChunkWriteCount = 0;
            let termContentMergedWriteCount = 0;
            let termContentTotalWriteBytes = 0;
            let termContentMergedWriteBytes = 0;
            let termContentMaxWriteBytes = 0;
            let termContentMergedGroupChunkCount = 0;
            let termContentMaxMergedGroupChunkCount = 0;
            let termContentFlushDueToBytesCount = 0;
            let termContentFlushDueToChunkCount = 0;
            let termContentFlushFinalGroupCount = 0;
            let termContentWriteCoalesceTargetBytes = 0;
            let termContentWriteCoalesceMaxChunks = 0;
            let termContentWriteFlushThresholdBytes = 0;
            let termRecordEndImportSessionMs = 0;
            let termRecordEndImportSessionFlushPendingWritesMs = 0;
            let termRecordEndImportSessionAwaitQueuedWritesMs = 0;
            let termRecordEndImportSessionCloseWritableMs = 0;
            let termRecordDrainCycleCount = 0;
            let termRecordWriteCallCount = 0;
            let termRecordSingleChunkWriteCount = 0;
            let termRecordMergedWriteCount = 0;
            let termRecordTotalWriteBytes = 0;
            let termRecordMergedWriteBytes = 0;
            let termRecordMaxWriteBytes = 0;
            let termRecordMergedGroupChunkCount = 0;
            let termRecordMaxMergedGroupChunkCount = 0;
            let termRecordWriteCoalesceTargetBytes = 0;
            let termRecordLookupIndexWriteCallCount = 0;
            let termRecordLookupIndexWriteBytes = 0;
            let termRecordLookupIndexAwaitMs = 0;
            let termRecordLookupIndexMaxQueuedBytes = 0;
            let termsVirtualTableSyncMs = 0;
            let createIndexesMs = 0;
            let createIndexesCheckpointCount = 0;
            let cacheResetMs = 0;
            let runtimePragmasMs = 0;
            /** @type {Awaited<ReturnType<DictionaryDatabase['finishBulkImport']>>} */
            let result = null;
            /** @type {Error|null} */
            let operationError = null;
            /** @type {Error[]} */
            const cleanupErrors = [];
            let termContentSessionEnded = false;
            let termRecordSessionEnded = false;
            let sqlitePublished = false;
            try {
                const tTermContentEndImportSessionStart = safePerformance.now();
                const termContentEndImportSessionPromise = this._termContentStore.endImportSession()
                    .then(() => {
                        termContentSessionEnded = true;
                        termContentEndImportSessionMs = safePerformance.now() - tTermContentEndImportSessionStart;
                        const metrics = this._termContentStore.getLastEndImportSessionMetrics();
                        if (metrics !== null) {
                            termContentEndImportSessionFlushPendingWritesMs = metrics.flushPendingWritesMs;
                            termContentEndImportSessionAwaitQueuedWritesMs = metrics.awaitQueuedWritesMs;
                            termContentEndImportSessionCloseWritableMs = metrics.closeWritableMs;
                            termContentDrainCycleCount = metrics.drainCycleCount;
                            termContentWriteCallCount = metrics.writeCallCount;
                            termContentSingleChunkWriteCount = metrics.singleChunkWriteCount;
                            termContentMergedWriteCount = metrics.mergedWriteCount;
                            termContentTotalWriteBytes = metrics.totalWriteBytes;
                            termContentMergedWriteBytes = metrics.mergedWriteBytes;
                            termContentMaxWriteBytes = metrics.maxWriteBytes;
                            termContentMergedGroupChunkCount = metrics.mergedGroupChunkCount;
                            termContentMaxMergedGroupChunkCount = metrics.maxMergedGroupChunkCount;
                            termContentFlushDueToBytesCount = metrics.flushDueToBytesCount;
                            termContentFlushDueToChunkCount = metrics.flushDueToChunkCount;
                            termContentFlushFinalGroupCount = metrics.flushFinalGroupCount;
                            termContentWriteCoalesceTargetBytes = metrics.writeCoalesceTargetBytes;
                            termContentWriteCoalesceMaxChunks = metrics.writeCoalesceMaxChunks;
                            termContentWriteFlushThresholdBytes = metrics.writeFlushThresholdBytes;
                        }
                    });
                const tTermRecordEndImportSessionStart = safePerformance.now();
                const termRecordEndImportSessionPromise = this._termRecordStore.endImportSession()
                    .then(() => {
                        termRecordSessionEnded = true;
                        termRecordEndImportSessionMs = safePerformance.now() - tTermRecordEndImportSessionStart;
                        const metrics = this._termRecordStore.getLastEndImportSessionMetrics();
                        if (metrics !== null) {
                            termRecordEndImportSessionFlushPendingWritesMs = metrics.flushPendingWritesMs;
                            termRecordEndImportSessionAwaitQueuedWritesMs = metrics.awaitQueuedWritesMs;
                            termRecordEndImportSessionCloseWritableMs = metrics.closeWritableMs;
                            termRecordDrainCycleCount = metrics.drainCycleCount;
                            termRecordWriteCallCount = metrics.writeCallCount;
                            termRecordSingleChunkWriteCount = metrics.singleChunkWriteCount;
                            termRecordMergedWriteCount = metrics.mergedWriteCount;
                            termRecordTotalWriteBytes = metrics.totalWriteBytes;
                            termRecordMergedWriteBytes = metrics.mergedWriteBytes;
                            termRecordMaxWriteBytes = metrics.maxWriteBytes;
                            termRecordMergedGroupChunkCount = metrics.mergedGroupChunkCount;
                            termRecordMaxMergedGroupChunkCount = metrics.maxMergedGroupChunkCount;
                            termRecordWriteCoalesceTargetBytes = metrics.writeCoalesceTargetBytes;
                            termRecordLookupIndexWriteCallCount = metrics.lookupIndexWriteCallCount ?? 0;
                            termRecordLookupIndexWriteBytes = metrics.lookupIndexWriteBytes ?? 0;
                            termRecordLookupIndexAwaitMs = metrics.lookupIndexAwaitMs ?? 0;
                            termRecordLookupIndexMaxQueuedBytes = metrics.lookupIndexMaxQueuedBytes ?? 0;
                        }
                    });
                const endImportSessionResults = await Promise.allSettled([
                    termContentEndImportSessionPromise,
                    termRecordEndImportSessionPromise,
                ]);
                const endImportSessionErrors = endImportSessionResults
                    .filter((endResult) => endResult.status === 'rejected')
                    .map((endResult) => toError(endResult.reason));
                if (endImportSessionErrors.length === 1) {
                    throw endImportSessionErrors[0];
                }
                if (endImportSessionErrors.length > 1) {
                    throw new AggregateError(endImportSessionErrors, 'Failed to finalize dictionary import storage');
                }
                if (this._termsVirtualTableDirty) {
                    try {
                        const tTermsVirtualTableSyncStart = safePerformance.now();
                        await this._syncTermsVirtualTableFromRecordStore();
                        termsVirtualTableSyncMs = safePerformance.now() - tTermsVirtualTableSyncStart;
                        this._termsVirtualTableDirty = false;
                    } catch (e) {
                        throw e;
                    }
                }
                const createIndexStatements = this._createIndexesSql();
                const tCreateIndexesStart = safePerformance.now();
                for (let i = 0; i < createIndexStatements.length; ++i) {
                    db.exec(createIndexStatements[i]);
                    if (typeof onCheckpoint === 'function') {
                        onCheckpoint(i + 1, createIndexStatements.length);
                    }
                }
                createIndexesMs = safePerformance.now() - tCreateIndexesStart;
                createIndexesCheckpointCount = createIndexStatements.length;
                if (this._bulkImportTransactionOpen) {
                    if (publication !== null) {
                        await this.bulkUpdate(
                            'dictionaries',
                            [{data: publication.summary, primaryKey: publication.primaryKey}],
                            0,
                            1,
                        );
                    }
                    const sessionId = this._bulkImportJournalRecord?.sessionId;
                    if (typeof sessionId !== 'string') {
                        throw new Error('Missing dictionary import journal before publication');
                    }
                    db.exec({
                        sql: 'INSERT OR REPLACE INTO dictionaryImportPublications (sessionId, publishedAt) VALUES (?, ?)',
                        bind: [sessionId, Date.now()],
                    });
                    const tCommitStart = safePerformance.now();
                    db.exec('COMMIT');
                    commitMs = safePerformance.now() - tCommitStart;
                    this._bulkImportTransactionOpen = false;
                    sqlitePublished = true;
                    // SQLite now owns the published state. A failed journal
                    // deletion must not let close() roll the committed OPFS
                    // data back in this process.
                    this._bulkImportJournalRecord = null;
                    try {
                        await this._importJournal.clear();
                        this._deleteImportPublicationMarkerBestEffort(sessionId);
                    } catch (error) {
                        this._importJournalRecoveryPending = true;
                        reportDiagnostics('dictionary-import-publication-cleanup-failed', {
                            sessionId,
                            error: toError(error).message,
                        });
                    }
                }
                const tCacheResetStart = safePerformance.now();
                this._clearBulkImportRuntimeCaches();
                cacheResetMs = safePerformance.now() - tCacheResetStart;
                this._deferTermsVirtualTableSync = false;
                const tRuntimePragmasStart = safePerformance.now();
                this._applyRuntimePragmas();
                runtimePragmasMs = safePerformance.now() - tRuntimePragmasStart;
                const totalMs = safePerformance.now() - tFinishBulkImportStart;
                if (this._importDebugLogging) {
                    log.log(
                        '[manabitan-db-import] finishBulkImport ' +
                        `total=${totalMs.toFixed(1)}ms ` +
                        `commit=${commitMs.toFixed(1)}ms ` +
                        `termContentEnd=${termContentEndImportSessionMs.toFixed(1)}ms ` +
                        `termContentFlush=${termContentEndImportSessionFlushPendingWritesMs.toFixed(1)}ms ` +
                        `termContentAwait=${termContentEndImportSessionAwaitQueuedWritesMs.toFixed(1)}ms ` +
                        `termContentClose=${termContentEndImportSessionCloseWritableMs.toFixed(1)}ms ` +
                        `termContentDrainCycles=${termContentDrainCycleCount} ` +
                        `termContentWrites=${termContentWriteCallCount} ` +
                        `termContentSingleWrites=${termContentSingleChunkWriteCount} ` +
                        `termContentMergedWrites=${termContentMergedWriteCount} ` +
                        `termContentTotalWriteBytes=${termContentTotalWriteBytes} ` +
                        `termContentMergedWriteBytes=${termContentMergedWriteBytes} ` +
                        `termContentMaxWriteBytes=${termContentMaxWriteBytes} ` +
                        `termContentMergedGroupChunks=${termContentMergedGroupChunkCount} ` +
                        `termContentMaxMergedGroupChunks=${termContentMaxMergedGroupChunkCount} ` +
                        `termContentFlushDueToBytes=${termContentFlushDueToBytesCount} ` +
                        `termContentFlushDueToChunks=${termContentFlushDueToChunkCount} ` +
                        `termContentFlushFinalGroups=${termContentFlushFinalGroupCount} ` +
                        `termContentWriteCoalesceTargetBytes=${termContentWriteCoalesceTargetBytes} ` +
                        `termContentWriteCoalesceMaxChunks=${termContentWriteCoalesceMaxChunks} ` +
                        `termContentWriteFlushThresholdBytes=${termContentWriteFlushThresholdBytes} ` +
                        `termRecordEnd=${termRecordEndImportSessionMs.toFixed(1)}ms ` +
                        `termRecordDrainCycles=${termRecordDrainCycleCount} ` +
                        `termRecordWrites=${termRecordWriteCallCount} ` +
                        `termRecordSingleWrites=${termRecordSingleChunkWriteCount} ` +
                        `termRecordMergedWrites=${termRecordMergedWriteCount} ` +
                        `termRecordTotalWriteBytes=${termRecordTotalWriteBytes} ` +
                        `termRecordMergedWriteBytes=${termRecordMergedWriteBytes} ` +
                        `termRecordMaxWriteBytes=${termRecordMaxWriteBytes} ` +
                        `termRecordMergedGroupChunks=${termRecordMergedGroupChunkCount} ` +
                        `termRecordMaxMergedGroupChunks=${termRecordMaxMergedGroupChunkCount} ` +
                        `termRecordWriteCoalesceTargetBytes=${termRecordWriteCoalesceTargetBytes} ` +
                        `termRecordLookupIndexWrites=${termRecordLookupIndexWriteCallCount} ` +
                        `termRecordLookupIndexWriteBytes=${termRecordLookupIndexWriteBytes} ` +
                        `termRecordLookupIndexAwait=${termRecordLookupIndexAwaitMs.toFixed(1)}ms ` +
                        `termRecordLookupIndexMaxQueuedBytes=${termRecordLookupIndexMaxQueuedBytes} ` +
                        `termsVtabSync=${termsVirtualTableSyncMs.toFixed(1)}ms ` +
                        `createIndexes=${createIndexesMs.toFixed(1)}ms ` +
                        `cacheReset=${cacheResetMs.toFixed(1)}ms ` +
                        `runtimePragmas=${runtimePragmasMs.toFixed(1)}ms ` +
                        `indexStatements=${createIndexesCheckpointCount}`,
                    );
                }
                result = {
                    commitMs,
                    termContentEndImportSessionMs,
                    termContentEndImportSessionFlushPendingWritesMs,
                    termContentEndImportSessionAwaitQueuedWritesMs,
                    termContentEndImportSessionCloseWritableMs,
                    termContentDrainCycleCount,
                    termContentWriteCallCount,
                    termContentSingleChunkWriteCount,
                    termContentMergedWriteCount,
                    termContentTotalWriteBytes,
                    termContentMergedWriteBytes,
                    termContentMaxWriteBytes,
                    termContentMergedGroupChunkCount,
                    termContentMaxMergedGroupChunkCount,
                    termContentFlushDueToBytesCount,
                    termContentFlushDueToChunkCount,
                    termContentFlushFinalGroupCount,
                    termContentWriteCoalesceTargetBytes,
                    termContentWriteCoalesceMaxChunks,
                    termContentWriteFlushThresholdBytes,
                    termRecordEndImportSessionMs,
                    termRecordEndImportSessionFlushPendingWritesMs,
                    termRecordEndImportSessionAwaitQueuedWritesMs,
                    termRecordEndImportSessionCloseWritableMs,
                    termRecordDrainCycleCount,
                    termRecordWriteCallCount,
                    termRecordSingleChunkWriteCount,
                    termRecordMergedWriteCount,
                    termRecordTotalWriteBytes,
                    termRecordMergedWriteBytes,
                    termRecordMaxWriteBytes,
                    termRecordMergedGroupChunkCount,
                    termRecordMaxMergedGroupChunkCount,
                    termRecordWriteCoalesceTargetBytes,
                    termRecordLookupIndexWriteCallCount,
                    termRecordLookupIndexWriteBytes,
                    termRecordLookupIndexAwaitMs,
                    termRecordLookupIndexMaxQueuedBytes,
                    termsVirtualTableSyncMs,
                    createIndexesMs,
                    createIndexesCheckpointCount,
                    cacheResetMs,
                    runtimePragmasMs,
                    totalMs,
                };
            } catch (e) {
                operationError = toError(e);
            } finally {
                let rollbackSucceeded = true;
                if (operationError !== null && !sqlitePublished) {
                    const hasJournal = this._bulkImportJournalRecord !== null;
                    rollbackSucceeded = await this._rollbackBulkImport(
                        db,
                        cleanupErrors,
                        hasJournal || !termContentSessionEnded,
                        hasJournal || !termRecordSessionEnded,
                    );
                } else {
                    rollbackSucceeded = this._rollbackBulkImportSqlite(db, cleanupErrors);
                    await this._endBulkImportStoreSessions(
                        cleanupErrors,
                        !termContentSessionEnded,
                        !termRecordSessionEnded,
                    );
                }
                if (operationError !== null) {
                    this._restoreRuntimeAfterBulkImportFailure(db, cleanupErrors);
                } else {
                    this._closeBulkImportBlockSession(cleanupErrors);
                }
                if (this._bulkImportJournalRecord !== null) {
                    this._importJournalRecoveryPending = true;
                }
                if (!rollbackSucceeded) {
                    this._quarantineBulkImportConnection(cleanupErrors);
                }
                this._endBulkImportLifecycle();
            }
            if (operationError !== null) {
                if (cleanupErrors.length > 0) {
                    throw new AggregateError(
                        [operationError, ...cleanupErrors],
                        'Dictionary import finalization and cleanup failed',
                    );
                }
                throw operationError;
            }
            if (cleanupErrors.length === 1) {
                throw cleanupErrors[0];
            }
            if (cleanupErrors.length > 1) {
                throw new AggregateError(cleanupErrors, 'Failed to clean up dictionary import storage');
            }
            return result;
        }
        return null;
    }

    /**
     * @param {boolean} value
     */
    setTermEntryContentDedupEnabled(value) {
        this._enableTermEntryContentDedup = value;
    }

    /**
     * @param {boolean} value
     */
    setImportDebugLogging(value) {
        this._importDebugLogging = value;
    }

    /**
     * @param {{termContentStorageMode?: 'baseline'|'raw-bytes', expectedTermContentImportBytes?: number, expectedTermRecordImportBytes?: number, artifactFixedPackMinTotalRows?: number|null, queueTermContentWrites?: boolean, termContentBlockTargetBytes?: number|null}} [options]
     */
    setImportOptimizationFlags(options = {}) {
        this._adaptiveTermBulkAddBatchSize = true;
        this._retryBeginImmediateTransaction = false;
        this._skipIntraBatchContentDedup = false;
        this._termBulkAddStagingMaxRows = this._computeDefaultTermBulkAddStagingMaxRows();
        this._termRecordRowAppendFastPath = true;
        this._termContentStorageMode = (options.termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES) ?
            options.termContentStorageMode :
            TERM_CONTENT_STORAGE_MODE_BASELINE;
        this._termContentCompressionMinBytes = 1048576;
        this._rawTermContentPackTargetBytes = DEFAULT_RAW_TERM_CONTENT_PACK_TARGET_BYTES;
        this._artifactFixedPackMinTotalRows = Number.isFinite(options.artifactFixedPackMinTotalRows) ?
            Math.max(0, Math.min(4_000_000, Math.trunc(/** @type {number} */ (options.artifactFixedPackMinTotalRows)))) :
            DEFAULT_ARTIFACT_FIXED_PACK_MIN_TOTAL_ROWS;
        this._termContentStore.setImportStorageMode(this._termContentStorageMode);
        const termContentBlockTargetBytes = Number.isFinite(options.termContentBlockTargetBytes) ?
            Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(/** @type {number} */ (options.termContentBlockTargetBytes)))) :
            TERM_CONTENT_BLOCK_TARGET_BYTES;
        this._termContentBlockStore.setBlockTargetBytes(termContentBlockTargetBytes);
        this._termContentStore.setExpectedImportBytes(options.expectedTermContentImportBytes ?? null);
        this._termContentStore.setWriteCoalesceMaxChunksOverride(null);
        this._termContentStore.setQueueImportWritesEnabled(options.queueTermContentWrites === true);
        this._termRecordStore.setExpectedImportBytes(options.expectedTermRecordImportBytes ?? null);
    }

    /**
     * @returns {Promise<boolean>}
     */
    async purge() {
        if (this._purgingPromise !== null) {
            return await this._purgingPromise;
        }
        const purgingPromise = this._purgeOnce();
        this._purgingPromise = purgingPromise;
        try {
            return await purgingPromise;
        } finally {
            if (this._purgingPromise === purgingPromise) {
                this._purgingPromise = null;
            }
        }
    }

    /**
     * @returns {Promise<boolean>}
     */
    async _purgeOnce() {
        if (this._closingPromise !== null) {
            await this._closingPromise;
        }
        if (this._isOpening) {
            throw new Error('Cannot purge database while opening');
        }
        if (this._bulkImportSetupPromise !== null) {
            try {
                await this._bulkImportSetupPromise;
            } catch (_) {
                // Setup performs its own rollback; purge still resets all persistence.
            }
        }
        this._beginExclusiveDatabaseCleanup();

        /** @type {Error[]} */
        const errors = [];
        try {
            if (this._db !== null) {
                if (this._bulkImportTransactionOpen) {
                    try {
                        this._db.exec('ROLLBACK');
                    } catch (error) {
                        if (!this._isNoActiveTransactionError(toError(error))) {
                            errors.push(toError(error));
                        }
                    }
                    this._bulkImportTransactionOpen = false;
                }
                try {
                    this._applyRuntimePragmas();
                } catch (error) {
                    errors.push(toError(error));
                }
            }
            this._releaseRuntimeConnection(errors);
            errors.push(...await this._collectPersistentStoreResetErrors(true));
            this._bulkImportTransactionOpen = false;
            this._bulkImportJournalRecord = null;
            this._importJournalRecoveryPending = false;
            this._deferTermsVirtualTableSync = false;
            this._termsVirtualTableDirty = false;
            if (this._worker !== null) {
                try {
                    this._worker.terminate();
                } catch (error) {
                    errors.push(toError(error));
                }
                this._worker = null;
            }

            let result = false;
            try {
                result = await deleteOpfsDatabaseFiles();
            } catch (error) {
                errors.push(toError(error));
            }

            try {
                await this._prepareOnce(true);
            } catch (error) {
                errors.push(toError(error));
            }
            this._clearCachedStatements();
            this._clearSharedGlossaryArtifactCaches();
            if (errors.length === 1) {
                throw errors[0];
            }
            if (errors.length > 1) {
                throw new AggregateError(errors, 'Dictionary database purge encountered cleanup failures');
            }
            return result;
        } finally {
            this._endBulkImportLifecycle();
        }
    }

    /**
     * @param {string} dictionaryName
     * @param {number} progressRate
     * @param {import('dictionary-database').DeleteDictionaryProgressCallback} onProgress
     */
    async deleteDictionary(dictionaryName, progressRate, onProgress) {
        const db = this._requireDb();

        /** @type {[table: string, keyColumn: string][]} */
        const targets = [
            ['kanji', 'dictionary'],
            ['kanjiMeta', 'dictionary'],
            ['termMeta', 'dictionary'],
            ['tagMeta', 'dictionary'],
            ['media', 'dictionary'],
            ['sharedGlossaryArtifacts', 'dictionary'],
            ['dictionaries', 'title'],
        ];

        /** @type {import('dictionary-database').DeleteDictionaryProgressData} */
        const progressData = {
            count: 0,
            processed: 0,
            storeCount: targets.length + 1,
            storesProcesed: 0,
        };

        /** @type {number[]} */
        const counts = [];
        const termRecordStorageName = this._getTermRecordStorageName(dictionaryName);
        await this._termRecordStore.ensureDictionariesLoaded([termRecordStorageName]);
        const termCount = this._getDirectDictionaryRecordCount(dictionaryName);
        progressData.count += termCount;
        counts.push(termCount);
        for (const [table, keyColumn] of targets) {
            const count = this._asNumber(db.selectValue(`SELECT COUNT(*) FROM ${table} WHERE ${keyColumn} = $value`, {$value: dictionaryName}), 0);
            counts.push(count);
            progressData.count += count;
            ++progressData.storesProcesed;
            onProgress(progressData);
        }

        progressData.storesProcesed = 0;

        await this._beginImmediateTransaction(db);
        try {
            let countIndex = 1;
            for (let i = 0; i < targets.length; ++i) {
                const [table, keyColumn] = targets[i];
                db.exec({sql: `DELETE FROM ${table} WHERE ${keyColumn} = $value`, bind: {$value: dictionaryName}});
                progressData.processed += counts[countIndex++];
                ++progressData.storesProcesed;
                if ((progressData.processed % progressRate) === 0 || progressData.processed >= progressData.count) {
                    onProgress(progressData);
                }
            }
            db.exec('COMMIT');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            throw e;
        }

        // SQLite and OPFS cannot share a transaction. Publish the logical
        // deletion first: a crash can then leave only an orphan shard, which
        // startup integrity cleanup can safely remove. The opposite order can
        // leave an installed dictionary pointing at records that no longer exist.
        const deletedTerms = await this._termRecordStore.deleteByDictionary(termRecordStorageName);
        this._unregisterTermRecordStorageName(dictionaryName);
        this._termsVirtualTableDirty = true;
        progressData.processed += deletedTerms;
        ++progressData.storesProcesed;
        onProgress(progressData);

        await this._cleanupTermContentAfterDictionaryDelete();

        onProgress(progressData);
        this._termEntryContentCache.clear();
        this._termEntryContentIdByHash.clear();
        this._clearTermEntryContentMetaCaches();
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
        this._termEntryContentIdByKey.clear();
        this._clearSharedGlossaryArtifactCaches();
        try {
            this._requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch (_) {
            // In-memory/non-WAL databases may reject checkpoint pragmas.
        }
    }

    /**
     * @param {string} fromDictionaryTitle
     * @param {string} toDictionaryTitle
     * @param {import('dictionary-importer').Summary|null} [summaryOverride]
     * @param {string|null} [replacedDictionaryTitle]
     * @returns {Promise<void>}
     */
    async replaceDictionaryTitle(fromDictionaryTitle, toDictionaryTitle, summaryOverride = null, replacedDictionaryTitle = null) {
        const fromTitle = `${fromDictionaryTitle}`.trim();
        const toTitle = `${toDictionaryTitle}`.trim();
        const replacedTitle = typeof replacedDictionaryTitle === 'string' ? replacedDictionaryTitle.trim() : null;
        const explicitTransientSessionToken = (
            summaryOverride &&
            typeof summaryOverride === 'object' &&
            !Array.isArray(summaryOverride) &&
            typeof Reflect.get(summaryOverride, 'updateSessionToken') === 'string' &&
            Reflect.get(summaryOverride, 'updateSessionToken').trim().length > 0
        ) ? Reflect.get(summaryOverride, 'updateSessionToken').trim() : null;
        const matchTransientToken = fromTitle.match(/\[(?:update-staging|cutover|replaced) ([^\]]+)\]$/);
        const transientSessionToken = explicitTransientSessionToken ?? (matchTransientToken ? matchTransientToken[1] : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
        if (fromTitle.length === 0 || toTitle.length === 0) {
            throw new Error('Dictionary titles must be non-empty');
        }
        const getSummaryRowByTitle = (title) => {
            const db = this._requireDb();
            return db.selectObject('SELECT id, version, summaryJson FROM dictionaries WHERE title = $title ORDER BY id DESC LIMIT 1', {$title: title});
        };
        const snapshotRows = () => {
            const snapshotDb = this._requireDb();
            return snapshotDb.selectObjects('SELECT id, title, version, summaryJson FROM dictionaries ORDER BY id ASC').map((row) => {
                const summaryJson = this._asString(row.summaryJson);
                let summary = null;
                try {
                    summary = parseJson(summaryJson);
                } catch (_) {
                    summary = null;
                }
                const summaryObject = (typeof summary === 'object' && summary !== null && !Array.isArray(summary)) ? summary : null;
                return {
                    id: this._asNumber(row.id, 0),
                    titleColumn: this._asString(row.title),
                    versionColumn: this._asNumber(row.version, 0),
                    summaryTitle: summaryObject !== null && typeof Reflect.get(summaryObject, 'title') === 'string' ? Reflect.get(summaryObject, 'title') : null,
                    summaryImportSuccess: summaryObject !== null && typeof Reflect.get(summaryObject, 'importSuccess') === 'boolean' ? Reflect.get(summaryObject, 'importSuccess') : null,
                };
            });
        };
        this._lastReplaceDictionaryTitleDebug = {
            fromTitle,
            toTitle,
            replacedTitle,
            transientSessionToken,
            beforeDeleteRows: snapshotRows(),
        };

        const buildSummaryForTitle = (summaryRow, title, summaryValue = null) => {
            const parsedSummary = (() => {
                const summaryJson = this._asString(Reflect.get(summaryRow, 'summaryJson'));
                if (summaryJson.length === 0) { return null; }
                try {
                    const value = parseJson(summaryJson);
                    return (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value : null;
                } catch (_) {
                    return null;
                }
            })();
            const nextSummary = (
                summaryValue && typeof summaryValue === 'object' && !Array.isArray(summaryValue) ?
                    {...summaryValue, title} :
                    (parsedSummary !== null ? {...parsedSummary, title} : {title, version: this._asNumber(Reflect.get(summaryRow, 'version'), 0)})
            );
            const fallbackStorageName = parsedSummary !== null ?
                this._getSummaryTermRecordStorageName(parsedSummary, this._asString(Reflect.get(parsedSummary, 'title')) || title) :
                title;
            nextSummary.termRecordStorageName = this._getSummaryTermRecordStorageName(nextSummary, fallbackStorageName);
            return nextSummary;
        };
        const buildTransientSummaryForTitle = (summaryRow, title, stage, summaryValue = null) => ({
            ...buildSummaryForTitle(summaryRow, title, summaryValue),
            transientUpdateStage: stage,
            updateSessionToken: transientSessionToken,
        });
        const renameDictionaryData = async (sourceTitle, targetTitle, summaryValue, debugKey) => {
            const db = this._requireDb();
            const summaryRow = getSummaryRowByTitle(sourceTitle);
            if (!(summaryRow && typeof summaryRow === 'object')) {
                throw new Error(`Dictionary title not found for replacement: ${sourceTitle}`);
            }
            const summaryId = this._asNumber(Reflect.get(summaryRow, 'id'), -1);
            if (summaryId < 0) {
                throw new Error(`Invalid dictionary row id for replacement: ${sourceTitle}`);
            }
            const nextSummary = buildSummaryForTitle(summaryRow, targetTitle, summaryValue);
            const termRecordStorageName = this._getSummaryTermRecordStorageName(
                nextSummary,
                this._getTermRecordStorageName(sourceTitle),
            );
            nextSummary.termRecordStorageName = termRecordStorageName;
            await this._beginImmediateTransaction(db);
            try {
                db.exec({sql: 'UPDATE dictionaries SET title = $toTitle, version = $version, summaryJson = $summaryJson WHERE id = $id', bind: {
                    $id: summaryId,
                    $toTitle: targetTitle,
                    $version: this._asNumber(Reflect.get(nextSummary, 'version'), 0),
                    $summaryJson: JSON.stringify(nextSummary),
                }});
                for (const table of ['termMeta', 'kanji', 'kanjiMeta', 'tagMeta', 'media', 'sharedGlossaryArtifacts']) {
                    db.exec({sql: `UPDATE ${table} SET dictionary = $toTitle WHERE dictionary = $fromTitle`, bind: {$fromTitle: sourceTitle, $toTitle: targetTitle}});
                }
                db.exec('COMMIT');
            } catch (e) {
                let rollbackError = null;
                try {
                    db.exec('ROLLBACK');
                } catch (error) {
                    rollbackError = toError(error);
                }
                if (rollbackError !== null) {
                    throw new AggregateError(
                        [toError(e), rollbackError],
                        `Dictionary title metadata replacement and rollback failed for ${sourceTitle} to ${targetTitle}`,
                    );
                }
                throw e;
            }
            this._unregisterTermRecordStorageName(sourceTitle);
            this._registerTermRecordStorageName(targetTitle, termRecordStorageName);
            this._lastReplaceDictionaryTitleDebug = {
                ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                [debugKey]: snapshotRows(),
            };
            this._lastReplaceDictionaryTitleDebug = {
                ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                [`${debugKey}AfterTermRecordRows`]: snapshotRows(),
            };
        };
        const forceCleanupTransientDictionaryTitle = async (dictionaryTitle) => {
            const title = `${dictionaryTitle}`.trim();
            if (title.length === 0) { return; }
            const summaryRow = getSummaryRowByTitle(title);
            const parsedSummary = (() => {
                if (!(summaryRow && typeof summaryRow === 'object')) { return null; }
                const summaryJson = this._asString(Reflect.get(summaryRow, 'summaryJson'));
                if (summaryJson.length === 0) { return null; }
                try {
                    const value = parseJson(summaryJson);
                    return (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value : null;
                } catch (_) {
                    return null;
                }
            })();
            if (!isRecognizedTransientUpdateTitle(title, parsedSummary)) {
                throw new Error(`Refusing fallback cleanup for non-transient dictionary title: ${title}`);
            }
            /** @type {unknown} */
            let originalDeleteError = null;
            try {
                await this.deleteDictionary(title, 1000, () => {});
                return;
            } catch (e) {
                originalDeleteError = e;
                // Fall through to direct transient cleanup.
            }
            try {
                const db = this._requireDb();
                this._lastReplaceDictionaryTitleDebug = {
                    ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                    forcedCleanupStart: {
                        title,
                        originalDeleteError: originalDeleteError instanceof Error ? originalDeleteError.message : String(originalDeleteError),
                        rows: snapshotRows(),
                    },
                };
                await this._termRecordStore.deleteByDictionary(this._getTermRecordStorageName(title));
                await this.cleanupTransientTermRecordShards((dictionaryName) => String(dictionaryName || '').trim() === title);
                await this._beginImmediateTransaction(db);
                try {
                    for (const [table, keyColumn] of [
                        ['kanji', 'dictionary'],
                        ['kanjiMeta', 'dictionary'],
                        ['termMeta', 'dictionary'],
                        ['tagMeta', 'dictionary'],
                        ['media', 'dictionary'],
                        ['sharedGlossaryArtifacts', 'dictionary'],
                        ['dictionaries', 'title'],
                    ]) {
                        db.exec({sql: `DELETE FROM ${table} WHERE ${keyColumn} = $value`, bind: {$value: title}});
                    }
                    db.exec('COMMIT');
                } catch (e) {
                    try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
                    throw e;
                }
                this._unregisterTermRecordStorageName(title);
                await this._cleanupTermContentAfterDictionaryDelete();
                this._lastReplaceDictionaryTitleDebug = {
                    ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                    forcedCleanupEnd: {
                        title,
                        rows: snapshotRows(),
                    },
                };
            } catch (fallbackError) {
                const originalMessage = originalDeleteError instanceof Error ? originalDeleteError.message : String(originalDeleteError);
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                this._lastReplaceDictionaryTitleDebug = {
                    ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                    forcedCleanupFailure: {
                        title,
                        originalDeleteError: originalMessage,
                        fallbackError: fallbackMessage,
                        rows: snapshotRows(),
                    },
                };
                throw new Error(`Failed transient dictionary cleanup for ${title}. deleteDictionary error=${originalMessage}; fallback cleanup error=${fallbackMessage}`);
            }
        };
        const summaryRow = getSummaryRowByTitle(fromTitle);
        if (!(summaryRow && typeof summaryRow === 'object')) {
            throw new Error(`Dictionary title not found for replacement: ${fromTitle}`);
        }

        if (replacedTitle !== null && replacedTitle.length > 0 && replacedTitle === toTitle && replacedTitle !== fromTitle) {
            const temporaryReplacedTitle = `${replacedTitle} [replaced ${transientSessionToken}]`;
            let replacedDictionaryMovedAside = false;
            try {
                const replacedSummaryRow = getSummaryRowByTitle(replacedTitle);
                if (!(replacedSummaryRow && typeof replacedSummaryRow === 'object')) {
                    throw new Error(`Dictionary title not found for replacement delete stage: ${replacedTitle}`);
                }
                await renameDictionaryData(
                    replacedTitle,
                    temporaryReplacedTitle,
                    buildTransientSummaryForTitle(replacedSummaryRow, temporaryReplacedTitle, 'replaced', null),
                    'afterTemporaryReplacedRows',
                );
                replacedDictionaryMovedAside = true;
                this._lastReplaceDictionaryTitleDebug = {
                    ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                    afterDeleteRows: snapshotRows(),
                };

                const finalSummary = buildSummaryForTitle(summaryRow, toTitle, summaryOverride);
                await renameDictionaryData(fromTitle, toTitle, finalSummary, 'afterRenameRows');
            } catch (e) {
                if (replacedDictionaryMovedAside) {
                    try {
                        const movedAsideSummaryRow = getSummaryRowByTitle(temporaryReplacedTitle);
                        if (movedAsideSummaryRow && typeof movedAsideSummaryRow === 'object') {
                            await renameDictionaryData(
                                temporaryReplacedTitle,
                                replacedTitle,
                                buildSummaryForTitle(movedAsideSummaryRow, replacedTitle, null),
                                'afterRestoreReplacedRows',
                            );
                        }
                    } catch (_) {
                        // NOP - preserve the original failure, but leave debug breadcrumbs.
                    }
                }
                throw e;
            }
            try {
                await forceCleanupTransientDictionaryTitle(temporaryReplacedTitle);
            } catch (e) {
                const cleanupMessage = e instanceof Error ? e.message : String(e);
                this._lastReplaceDictionaryTitleDebug = {
                    ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                    postCutoverCleanupWarning: {
                        title: temporaryReplacedTitle,
                        message: cleanupMessage,
                        rows: snapshotRows(),
                    },
                };
                log.warn(new Error(`Post-cutover transient cleanup failed for ${temporaryReplacedTitle}: ${cleanupMessage}`));
            }
            this._lastReplaceDictionaryTitleDebug = {
                ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                afterDeleteRows: snapshotRows(),
            };
        } else {
            if (replacedTitle !== null && replacedTitle.length > 0 && replacedTitle !== fromTitle) {
                await this.deleteDictionary(replacedTitle, 1000, () => {});
            }
            this._lastReplaceDictionaryTitleDebug = {
                ...(this._lastReplaceDictionaryTitleDebug ?? {}),
                afterDeleteRows: snapshotRows(),
            };

            const finalSummary = buildSummaryForTitle(summaryRow, toTitle, summaryOverride);
            await renameDictionaryData(fromTitle, toTitle, finalSummary, 'afterRenameRows');
        }

        this._termsVirtualTableDirty = true;
        this._termEntryContentCache.clear();
        this._termEntryContentIdByHash.clear();
        this._clearTermEntryContentMetaCaches();
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
        this._termEntryContentIdByKey.clear();
        this._clearSharedGlossaryArtifactCaches();
    }

    /**
     * @returns {Record<string, unknown>|null}
     */
    getLastReplaceDictionaryTitleDebug() {
        return this._lastReplaceDictionaryTitleDebug;
    }

    /**
     * @returns {Promise<void>}
     */
    async _cleanupTermContentAfterDictionaryDelete() {
        const db = this._requireDb();
        const remainingDictionaryCount = this._asNumber(db.selectValue('SELECT COUNT(*) FROM dictionaries'), 0);
        if (remainingDictionaryCount <= 0) {
            await this._beginImmediateTransaction(db);
            try {
                db.exec('DELETE FROM termEntryContent');
                db.exec('DELETE FROM sharedGlossaryArtifacts');
                db.exec('COMMIT');
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
                throw e;
            }
            // Commit metadata removal before resetting OPFS. An interruption
            // may leave unreferenced bytes, but never offsets into deleted data.
            await this._termContentStore.reset();
            return;
        }
        await this._beginImmediateTransaction(db);
        try {
            this._pruneOrphanTermEntryContent();
            db.exec(`
                DELETE FROM sharedGlossaryArtifacts
                WHERE dictionary NOT IN (
                    SELECT title
                    FROM dictionaries
                )
            `);
            db.exec('COMMIT');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            throw e;
        }
    }

    /**
     * @param {string} sql
     * @returns {import('@sqlite.org/sqlite-wasm').PreparedStatement}
     */
    _getCachedStatement(sql) {
        const cached = this._statementCache.get(sql);
        if (typeof cached !== 'undefined') {
            this._statementCache.delete(sql);
            this._statementCache.set(sql, cached);
            return cached;
        }
        const db = this._requireDb();
        const created = /** @type {import('@sqlite.org/sqlite-wasm').PreparedStatement} */ (db.prepare(sql));
        while (this._statementCache.size >= this._statementCacheMaxEntries) {
            const first = this._statementCache.entries().next();
            if (first.done) {
                break;
            }
            this._statementCache.delete(first.value[0]);
            try {
                first.value[1].finalize();
            } catch (_) {
                // NOP
            }
        }
        this._statementCache.set(sql, created);
        return created;
    }

    /** */
    _clearCachedStatements() {
        for (const stmt of this._statementCache.values()) {
            try {
                stmt.finalize();
            } catch (_) {
                // NOP
            }
        }
        this._statementCache.clear();
        this._termEntryContentCache.clear();
        this._termRowCache.clear();
        this._termEntryContentIdByHash.clear();
        this._clearTermEntryContentMetaCaches();
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
    }

    /**
     * @param {Iterable<string>} values
     * @param {string} prefix
     * @returns {{clause: string, bind: Record<string, string>}}
     */
    _buildTextInClause(values, prefix) {
        /** @type {string[]} */
        const placeholders = [];
        /** @type {Record<string, string>} */
        const bind = {};
        let index = 0;
        for (const value of values) {
            const key = `${prefix}${index++}`;
            placeholders.push(`$${key}`);
            bind[`$${key}`] = value;
        }
        return {
            clause: placeholders.length > 0 ? placeholders.join(', ') : "''",
            bind,
        };
    }

    /**
     * @param {Iterable<number>} values
     * @param {string} prefix
     * @returns {{clause: string, bind: Record<string, number>}}
     */
    _buildNumberInClause(values, prefix) {
        /** @type {string[]} */
        const placeholders = [];
        /** @type {Record<string, number>} */
        const bind = {};
        let index = 0;
        for (const value of values) {
            const key = `${prefix}${index++}`;
            placeholders.push(`$${key}`);
            bind[`$${key}`] = value;
        }
        return {
            clause: placeholders.length > 0 ? placeholders.join(', ') : '-1',
            bind,
        };
    }

    /**
     * @template T
     * @param {T[]} values
     * @param {number} chunkSize
     * @returns {T[][]}
     */
    _chunkValues(values, chunkSize) {
        /** @type {T[][]} */
        const chunks = [];
        if (chunkSize <= 0) {
            return chunks;
        }
        for (let i = 0; i < values.length; i += chunkSize) {
            chunks.push(values.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * @param {string[]} dictionaryNames
     * @returns {string}
     */
    _getDictionaryCacheKey(dictionaryNames) {
        if (dictionaryNames.length <= 1) {
            return dictionaryNames[0] ?? '';
        }
        return [...dictionaryNames].sort().join('\u001f');
    }

    /** */
    _clearDirectTermIndexCaches() {
        this._directTermIndexByDictionary.clear();
        this._directTermIndexLoadPromiseByDictionary.clear();
        this._directTermIndexLoadedDictionaryNames.clear();
        this._termIndexSortedKeysByLookup = new WeakMap();
        this._termRowCache.clear();
        this._termExactMatchCache.clear();
        ++this._directTermIndexGeneration;
    }

    /**
     * @param {unknown} summary
     * @param {string} fallbackTitle
     * @returns {string}
     */
    _getSummaryTermRecordStorageName(summary, fallbackTitle) {
        if (typeof summary === 'object' && summary !== null && !Array.isArray(summary)) {
            const value = Reflect.get(summary, 'termRecordStorageName');
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        }
        return fallbackTitle;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} storageName
     * @throws {Error} If a physical storage name is already owned by another dictionary.
     */
    _registerTermRecordStorageName(dictionaryName, storageName) {
        const logicalName = `${dictionaryName}`.trim();
        const physicalName = `${storageName}`.trim();
        if (logicalName.length === 0 || physicalName.length === 0) { return; }
        const previousLogicalName = this._dictionaryNameByTermRecordStorage.get(physicalName);
        if (typeof previousLogicalName !== 'undefined' && previousLogicalName !== logicalName) {
            throw new Error(`Term-record storage name collision: ${physicalName}`);
        }
        const previousStorageName = this._termRecordStorageNameByDictionary.get(logicalName);
        if (typeof previousStorageName !== 'undefined' && previousStorageName !== physicalName) {
            this._dictionaryNameByTermRecordStorage.delete(previousStorageName);
        }
        this._termRecordStorageNameByDictionary.set(logicalName, physicalName);
        this._dictionaryNameByTermRecordStorage.set(physicalName, logicalName);
    }

    /**
     * @param {string} dictionaryName
     */
    _unregisterTermRecordStorageName(dictionaryName) {
        const storageName = this._termRecordStorageNameByDictionary.get(dictionaryName);
        this._termRecordStorageNameByDictionary.delete(dictionaryName);
        if (typeof storageName !== 'undefined' && this._dictionaryNameByTermRecordStorage.get(storageName) === dictionaryName) {
            this._dictionaryNameByTermRecordStorage.delete(storageName);
        }
    }

    /** */
    _refreshTermRecordStorageNameMappings() {
        const db = this._requireDb();
        const rows = db.selectObjects('SELECT title, summaryJson FROM dictionaries ORDER BY id ASC');
        this._termRecordStorageNameByDictionary.clear();
        this._dictionaryNameByTermRecordStorage.clear();
        for (const row of rows) {
            const title = this._asString(row.title).trim();
            if (title.length === 0) { continue; }
            const summary = this._safeParseJson(this._asString(row.summaryJson), null);
            this._registerTermRecordStorageName(
                title,
                this._getSummaryTermRecordStorageName(summary, title),
            );
        }
    }

    /**
     * @param {string} dictionaryName
     * @returns {string}
     */
    _getTermRecordStorageName(dictionaryName) {
        return this._termRecordStorageNameByDictionary.get(dictionaryName) ?? dictionaryName;
    }

    /**
     * @param {string} storageName
     * @returns {string}
     */
    _getDictionaryNameForTermRecordStorage(storageName) {
        return this._dictionaryNameByTermRecordStorage.get(storageName) ?? storageName;
    }

    /**
     * @param {string} dictionaryCacheKey
     * @param {string} term
     * @returns {string}
     */
    _createTermExactPresenceCacheKey(dictionaryCacheKey, term) {
        return `${dictionaryCacheKey}\u001f${term}`;
    }

    /**
     * Positive postings preserve dictionary traversal order, which can affect
     * stable result ordering even though negative presence does not.
     * @param {string[]} dictionaryNames
     * @param {string} term
     * @returns {string}
     */
    _createTermExactMatchCacheKey(dictionaryNames, term) {
        return `${dictionaryNames.join('\u001f')}\u001e${term}`;
    }

    /**
     * @param {string} dictionaryName
     * @returns {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}}
     */
    _ensureDirectTermIndex(dictionaryName) {
        const existing = this._directTermIndexByDictionary.get(dictionaryName);
        if (typeof existing !== 'undefined') {
            return existing;
        }
        const index = this._termRecordStore.getDictionaryIndex(this._getTermRecordStorageName(dictionaryName));
        this._directTermIndexByDictionary.set(dictionaryName, index);
        return index;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} query
     * @param {'expression'|'reading'} field
     * @returns {number[]}
     */
    _findDirectTermIds(dictionaryName, query, field) {
        const directFind = Reflect.get(this._termRecordStore, 'findTermIds');
        if (typeof directFind === 'function') {
            return directFind.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName), query, field);
        }
        return this._ensureDirectTermIndex(dictionaryName)[field].get(query) ?? [];
    }

    /**
     * @param {string} dictionaryName
     * @param {string} query
     * @returns {{expression: number[], reading: number[]}}
     */
    _findDirectTermIdMatches(dictionaryName, query) {
        const directFind = Reflect.get(this._termRecordStore, 'findTermIdMatches');
        if (typeof directFind === 'function') {
            return directFind.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName), query);
        }
        const index = this._ensureDirectTermIndex(dictionaryName);
        return {
            expression: index.expression.get(query) ?? [],
            reading: index.reading.get(query) ?? [],
        };
    }

    /**
     * @param {string} dictionaryName
     * @param {string} query
     * @param {'expression'|'reading'} field
     * @param {boolean} reverse
     * @returns {Array<{id: number, exact: boolean}>}
     */
    _findDirectTermPrefixIdMatches(dictionaryName, query, field, reverse) {
        const directFind = Reflect.get(this._termRecordStore, 'findTermPrefixIdMatches');
        if (typeof directFind === 'function') {
            return directFind.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName), query, field, reverse);
        }
        const index = this._ensureDirectTermIndex(dictionaryName);
        if (reverse) {
            this._termRecordStore.ensureDictionaryReverseIndex(this._getTermRecordStorageName(dictionaryName), index);
        }
        const lookup = reverse ?
            (field === 'expression' ? index.expressionReverse : index.readingReverse) :
            index[field];
        const lookupQuery = reverse ? stringReverse(query) : query;
        const result = [];
        for (const [value, ids] of this._findTermIndexPrefixMatches(lookup, lookupQuery)) {
            for (const id of ids) {
                result.push({id, exact: value === lookupQuery});
            }
        }
        return result;
    }

    /**
     * @param {string} dictionaryName
     * @param {number} sequence
     * @returns {number[]}
     */
    _findDirectTermIdsBySequence(dictionaryName, sequence) {
        const directFind = Reflect.get(this._termRecordStore, 'findTermIdsBySequence');
        if (typeof directFind === 'function') {
            return directFind.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName), sequence);
        }
        return this._ensureDirectTermIndex(dictionaryName).sequence.get(sequence) ?? [];
    }

    /**
     * @param {string} dictionaryName
     * @param {number} limit
     * @returns {number[]}
     */
    _getDirectDictionarySampleIds(dictionaryName, limit) {
        const getSampleIds = Reflect.get(this._termRecordStore, 'getDictionarySampleIds');
        if (typeof getSampleIds === 'function') {
            return getSampleIds.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName), limit);
        }
        const ids = [];
        for (const valueIds of this._ensureDirectTermIndex(dictionaryName).expression.values()) {
            for (const id of valueIds) {
                ids.push(id);
                if (ids.length >= limit) { return ids; }
            }
        }
        return ids;
    }

    /**
     * @param {string} dictionaryName
     * @returns {number}
     */
    _getDirectDictionaryRecordCount(dictionaryName) {
        const getRecordCount = Reflect.get(this._termRecordStore, 'getDictionaryRecordCount');
        if (typeof getRecordCount === 'function') {
            return getRecordCount.call(this._termRecordStore, this._getTermRecordStorageName(dictionaryName));
        }
        let count = 0;
        for (const ids of this._ensureDirectTermIndex(dictionaryName).expression.values()) {
            count += ids.length;
        }
        return count;
    }

    /**
     * @param {Iterable<string>} dictionaryNames
     * @returns {string[]}
     */
    _getUniqueDictionaryNames(dictionaryNames) {
        if (dictionaryNames instanceof Set) {
            return [...dictionaryNames].filter((value) => value.length > 0);
        }
        const names = [];
        const seen = new Set();
        for (const value of dictionaryNames) {
            if (value.length > 0 && !seen.has(value)) {
                seen.add(value);
                names.push(value);
            }
        }
        return names;
    }

    /**
     * @param {Iterable<string>} dictionaryNames
     * @returns {Promise<void>}
     */
    async _ensureDirectTermIndexesLoaded(dictionaryNames) {
        const names = this._getUniqueDictionaryNames(dictionaryNames);
        /** @type {Promise<void>[]} */
        const promises = [];
        /** @type {string[]} */
        const namesToLoad = [];
        for (const dictionaryName of names) {
            if (
                this._directTermIndexLoadedDictionaryNames.has(dictionaryName) ||
                this._directTermIndexByDictionary.has(dictionaryName)
            ) {
                continue;
            }
            const existing = this._directTermIndexLoadPromiseByDictionary.get(dictionaryName);
            if (typeof existing !== 'undefined') {
                promises.push(existing);
                continue;
            }
            namesToLoad.push(dictionaryName);
        }
        if (namesToLoad.length > 0) {
            const generation = this._directTermIndexGeneration;
            const promise = (async () => {
                const storageNamesToLoad = namesToLoad.map((name) => this._getTermRecordStorageName(name));
                await this._termRecordStore.ensureDictionariesLoaded(storageNamesToLoad);
                if (generation !== this._directTermIndexGeneration) {
                    return;
                }
                const isDictionaryAvailable = Reflect.get(this._termRecordStore, 'isDictionaryAvailable');
                const availableNames = typeof isDictionaryAvailable === 'function' ?
                    namesToLoad.filter((dictionaryName) => isDictionaryAvailable.call(
                        this._termRecordStore,
                        this._getTermRecordStorageName(dictionaryName),
                    )) :
                    namesToLoad;
                const hasPersistentTermLookupIndex = Reflect.get(this._termRecordStore, 'hasPersistentTermLookupIndex');
                const fallbackNames = typeof hasPersistentTermLookupIndex === 'function' ?
                    availableNames.filter(
                        (dictionaryName) => !hasPersistentTermLookupIndex.call(
                            this._termRecordStore,
                            this._getTermRecordStorageName(dictionaryName),
                        ),
                    ) :
                    availableNames;
                const ensureDictionaryIndexes = /** @type {unknown} */ (Reflect.get(this._termRecordStore, 'ensureDictionaryIndexes'));
                if (typeof ensureDictionaryIndexes === 'function' && fallbackNames.length > 0) {
                    /** @type {(dictionaryNames: Iterable<string>) => void} */ (ensureDictionaryIndexes).call(
                        this._termRecordStore,
                        fallbackNames.map((name) => this._getTermRecordStorageName(name)),
                    );
                }
                for (const dictionaryName of fallbackNames) {
                    this._ensureDirectTermIndex(dictionaryName);
                }
                for (const dictionaryName of availableNames) {
                    this._directTermIndexLoadedDictionaryNames.add(dictionaryName);
                }
            })();
            for (const dictionaryName of namesToLoad) {
                this._directTermIndexLoadPromiseByDictionary.set(dictionaryName, promise);
            }
            promises.push(promise);
            promise.then(
                () => {
                    for (const dictionaryName of namesToLoad) {
                        if (this._directTermIndexLoadPromiseByDictionary.get(dictionaryName) === promise) {
                            this._directTermIndexLoadPromiseByDictionary.delete(dictionaryName);
                        }
                    }
                },
                () => {
                    for (const dictionaryName of namesToLoad) {
                        if (this._directTermIndexLoadPromiseByDictionary.get(dictionaryName) === promise) {
                            this._directTermIndexLoadPromiseByDictionary.delete(dictionaryName);
                        }
                    }
                },
            );
        }
        await Promise.all(promises);
    }

    /**
     * Warms the storage and direct term indexes needed by the first visible
     * search or hover lookup after startup/import refresh.
     * @param {Iterable<string>} dictionaryNames
     * @returns {Promise<void>}
     */
    async warmTermLookupCaches(dictionaryNames) {
        const names = this._getUniqueDictionaryNames(dictionaryNames);
        if (names.length === 0) { return; }
        await this._termContentStore.ensureLoadedForRead();
        await this._ensureDirectTermIndexesLoaded(names);
        await Promise.all([
            this._warmSharedGlossaryArtifacts(names),
            this._warmLookupProbeTerms(names),
        ]);
        await this._termRecordStore.warmPrefixIndexes(names.map((name) => this._getTermRecordStorageName(name)));
    }

    /**
     * Runs a small exact lookup in the background warm path so the first visible
     * hover/search does not pay every row-content cache miss.
     * @param {string[]} dictionaryNames
     * @returns {Promise<void>}
     */
    async _warmLookupProbeTerms(dictionaryNames) {
        const terms = [
            '日本',
            'する',
            'ある',
            '見る',
            '言う',
            '食べる',
            '猫',
            '吾輩',
            '名前',
            '輩',
            '学',
            '食',
            '見',
            '言',
            '行',
            '水',
        ];
        for (const dictionaryName of dictionaryNames) {
            try {
                const probe = await this.getDictionaryTermProbe(dictionaryName);
                if (probe !== null) {
                    terms.push(probe.expression, probe.reading);
                }
            } catch (_) {
                // Probe warming is best-effort; lookup correctness does not depend on it.
            }
        }
        const uniqueTerms = [...new Set(terms.map((term) => `${term}`.trim()).filter((term) => term.length > 0))];
        if (uniqueTerms.length === 0) { return; }
        const startedAt = safePerformance.now();
        try {
            const entries = await this.findTermsBulk(uniqueTerms, new Set(dictionaryNames), 'exact');
            reportDiagnostics('dictionary-lookup-probe-warm-summary', {
                dictionaryNames,
                termCount: uniqueTerms.length,
                matchedEntryCount: entries.length,
                elapsedMs: safePerformance.now() - startedAt,
            });
        } catch (error) {
            reportDiagnostics('dictionary-lookup-probe-warm-error', {
                dictionaryNames,
                termCount: uniqueTerms.length,
                error: `${error}`,
            });
        }
    }

    /**
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {string[]}
     */
    _getDictionaryNames(dictionaries) {
        if (dictionaries instanceof Map) {
            return [...dictionaries.keys()];
        }
        return [...dictionaries];
    }

    /**
     * @param {string[]} terms
     * @returns {Map<string, number[]>}
     */
    _buildTermIndexMap(terms) {
        /** @type {Map<string, number[]>} */
        const result = new Map();
        for (let i = 0; i < terms.length; ++i) {
            const term = terms[i];
            const list = result.get(term);
            if (typeof list === 'undefined') {
                result.set(term, [i]);
            } else {
                list.push(i);
            }
        }
        return result;
    }

    /**
     * @param {Map<string, number[]>} lookup
     * @returns {string[]}
     */
    _getSortedTermIndexKeys(lookup) {
        const existing = this._termIndexSortedKeysByLookup.get(lookup);
        if (typeof existing !== 'undefined' && existing.size === lookup.size) {
            return existing.keys;
        }
        const keys = [...lookup.keys()].sort();
        this._termIndexSortedKeysByLookup.set(lookup, {size: lookup.size, keys});
        return keys;
    }

    /**
     * @param {string[]} keys
     * @param {string} query
     * @returns {number}
     */
    _findSortedTermIndexLowerBound(keys, query) {
        let low = 0;
        let high = keys.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (keys[mid] < query) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    /**
     * @param {Map<string, number[]>} lookup
     * @param {string} query
     * @yields {[string, number[]]}
     * @returns {IterableIterator<[string, number[]]>}
     */
    *_findTermIndexPrefixMatches(lookup, query) {
        const keys = this._getSortedTermIndexKeys(lookup);
        for (let i = this._findSortedTermIndexLowerBound(keys, query); i < keys.length; ++i) {
            const value = keys[i];
            if (!value.startsWith(query)) { break; }
            const ids = lookup.get(value);
            if (typeof ids !== 'undefined') {
                yield [value, ids];
            }
        }
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @param {import('dictionary-database').MatchType} matchType
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBulk(termList, dictionaries, matchType) {
        this._requireDb();
        if (termList.length === 0 || dictionaries.size === 0) {
            return [];
        }
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        const requestedDictionaryNames = this._getDictionaryNames(dictionaries);
        const shouldReportDiagnostics = isDevDiagnosticsBuild();
        if (shouldReportDiagnostics) {
            reportDiagnosticsLazy('dictionary-lookup-db-query', () => ({
                stage: 'findTermsBulk-start',
                matchType,
                termCount: termList.length,
                termsSample: termList.slice(0, 12),
                dictionaryNames: requestedDictionaryNames,
            }));
        }
        await this._ensureDirectTermIndexesLoaded(requestedDictionaryNames);
        const isDictionaryAvailable = Reflect.get(this._termRecordStore, 'isDictionaryAvailable');
        const dictionaryNames = typeof isDictionaryAvailable === 'function' ?
            requestedDictionaryNames.filter(
                (dictionaryName) => isDictionaryAvailable.call(
                    this._termRecordStore,
                    this._getTermRecordStorageName(dictionaryName),
                ),
            ) :
            requestedDictionaryNames;
        if (dictionaryNames.length === 0) {
            return [];
        }

        /** @type {('expression'|'reading')[]} */
        const columns = ['expression', 'reading'];

        if (matchType === 'exact') {
            /** @type {Map<string, number[]>} */
            const termIndexMap = new Map();
            /** @type {Map<number, {matchSource: import('dictionary-database').MatchSource, itemIndex: number}[]>} */
            const idMatches = new Map();
            const dictionaryCacheKey = this._getDictionaryCacheKey(dictionaryNames);
            /** @type {Map<string, {expressionHits: number, readingHits: number}>|null} */
            const dictionaryExactHitCounts = shouldReportDiagnostics ? new Map() : null;
            const appendExactMatches = (ids, matchSource, itemIndexes, visitedIds, cacheableIds) => {
                for (const id of ids) {
                    if (id <= 0 || visitedIds.has(id)) { continue; }
                    visitedIds.add(id);
                    if (cacheableIds.length <= TERM_EXACT_MATCH_CACHE_MAX_IDS_PER_TERM) {
                        cacheableIds.push(id);
                    }
                    const matches = idMatches.get(id);
                    const target = typeof matches === 'undefined' ? [] : matches;
                    if (typeof matches === 'undefined') { idMatches.set(id, target); }
                    for (const itemIndex of itemIndexes) {
                        target.push({matchSource, itemIndex});
                    }
                }
            };
            for (let i = 0; i < termList.length; ++i) {
                const term = termList[i];
                const termPresenceKey = this._createTermExactPresenceCacheKey(dictionaryCacheKey, term);
                const cachedPresence = this._termExactPresenceCache.get(termPresenceKey);
                if (cachedPresence === false) {
                    continue;
                }
                const existingList = termIndexMap.get(term);
                if (typeof existingList === 'undefined') {
                    termIndexMap.set(term, [i]);
                } else {
                    existingList.push(i);
                }
            }
            if (termIndexMap.size === 0) {
                return [];
            }
            for (const term of termIndexMap.keys()) {
                const itemIndexes = /** @type {number[]} */ (termIndexMap.get(term));
                let found = false;
                const visitedExpressionIds = new Set();
                const visitedReadingIds = new Set();
                /** @type {number[]} */
                const cacheableExpressionIds = [];
                /** @type {number[]} */
                const cacheableReadingIds = [];
                const termPresenceKey = this._createTermExactPresenceCacheKey(dictionaryCacheKey, term);
                const termMatchKey = this._createTermExactMatchCacheKey(dictionaryNames, term);
                const cachedMatches = shouldReportDiagnostics ? void 0 : this._termExactMatchCache.get(termMatchKey);
                if (typeof cachedMatches !== 'undefined') {
                    found = cachedMatches.expression.length > 0 || cachedMatches.reading.length > 0;
                    appendExactMatches(cachedMatches.expression, 'term', itemIndexes, visitedExpressionIds, cacheableExpressionIds);
                    appendExactMatches(cachedMatches.reading, 'reading', itemIndexes, visitedReadingIds, cacheableReadingIds);
                } else {
                    const directFindForDictionaries = Reflect.get(this._termRecordStore, 'findTermIdMatchesForDictionaries');
                    const dictionaryMatches = typeof directFindForDictionaries === 'function' ?
                        /** @type {(dictionaryNames: string[], query: string) => Array<{expression: number[], reading: number[]}>} */ (
                            directFindForDictionaries
                        ).call(
                            this._termRecordStore,
                            dictionaryNames.map((name) => this._getTermRecordStorageName(name)),
                            term,
                        ) :
                        dictionaryNames.map(
                            (dictionaryName) => this._findDirectTermIdMatches(dictionaryName, term),
                        );
                    for (let dictionaryIndex = 0; dictionaryIndex < dictionaryNames.length; ++dictionaryIndex) {
                        const dictionaryName = dictionaryNames[dictionaryIndex];
                        const expressionIds = dictionaryMatches[dictionaryIndex].expression;
                        if (expressionIds.length > 0 && dictionaryExactHitCounts !== null) {
                            const hitCounts = dictionaryExactHitCounts.get(dictionaryName) || {expressionHits: 0, readingHits: 0};
                            hitCounts.expressionHits += expressionIds.length;
                            dictionaryExactHitCounts.set(dictionaryName, hitCounts);
                        }
                        if (expressionIds.length > 0) { found = true; }
                        appendExactMatches(expressionIds, 'term', itemIndexes, visitedExpressionIds, cacheableExpressionIds);
                    }
                    for (let dictionaryIndex = 0; dictionaryIndex < dictionaryNames.length; ++dictionaryIndex) {
                        const dictionaryName = dictionaryNames[dictionaryIndex];
                        const readingIds = dictionaryMatches[dictionaryIndex].reading;
                        if (readingIds.length > 0 && dictionaryExactHitCounts !== null) {
                            const hitCounts = dictionaryExactHitCounts.get(dictionaryName) || {expressionHits: 0, readingHits: 0};
                            hitCounts.readingHits += readingIds.length;
                            dictionaryExactHitCounts.set(dictionaryName, hitCounts);
                        }
                        if (readingIds.length > 0) { found = true; }
                        appendExactMatches(readingIds, 'reading', itemIndexes, visitedReadingIds, cacheableReadingIds);
                    }
                    if (
                        found &&
                        cacheableExpressionIds.length + cacheableReadingIds.length <= TERM_EXACT_MATCH_CACHE_MAX_IDS_PER_TERM
                    ) {
                        this._termExactMatchCache.set(termMatchKey, {
                            expression: cacheableExpressionIds,
                            reading: cacheableReadingIds,
                        });
                    }
                }
                this._setTermExactPresenceCached(termPresenceKey, found);
            }

            if (idMatches.size === 0) {
                if (shouldReportDiagnostics) {
                    reportDiagnosticsLazy('dictionary-lookup-db-query', () => ({
                        stage: 'findTermsBulk-exact',
                        termCount: termList.length,
                        termsSample: termList.slice(0, 12),
                        dictionaryNames,
                        matchedRowCount: 0,
                        dictionaryHitCounts: dictionaryNames.map((dictionaryName) => {
                            const hitCounts = dictionaryExactHitCounts?.get(dictionaryName) || {expressionHits: 0, readingHits: 0};
                            return {dictionary: dictionaryName, ...hitCounts};
                        }),
                    }));
                }
                return [];
            }

            const rowsById = await this._fetchTermRowsByIds(idMatches.keys());
            if (shouldReportDiagnostics) {
                reportDiagnosticsLazy('dictionary-lookup-db-query', () => ({
                    stage: 'findTermsBulk-exact',
                    termCount: termList.length,
                    termsSample: termList.slice(0, 12),
                    dictionaryNames,
                    matchedIdCount: idMatches.size,
                    matchedRowCount: rowsById.size,
                    dictionaryHitCounts: dictionaryNames.map((dictionaryName) => {
                        const hitCounts = dictionaryExactHitCounts?.get(dictionaryName) || {expressionHits: 0, readingHits: 0};
                        return {dictionary: dictionaryName, ...hitCounts};
                    }),
                }));
            }
            for (const [id, matches] of idMatches) {
                const row = rowsById.get(id);
                if (typeof row === 'undefined') { continue; }
                for (const {matchSource, itemIndex} of matches) {
                    results.push(this._createTerm(matchSource, 'exact', row, itemIndex));
                }
            }
            return results;
        }

        const visited = new Set();
        /** @type {Map<number, {matchSource: import('dictionary-database').MatchSource, matchType: import('dictionary-database').MatchType, itemIndex: number}>} */
        const idMatches = new Map();
        /** @type {Map<string, {term: string, query: string, itemIndex: number}>} */
        const uniqueQueryMap = new Map();
        for (let itemIndex = 0; itemIndex < termList.length; ++itemIndex) {
            const term = termList[itemIndex];
            const query = matchType === 'suffix' ? stringReverse(term) : term;
            if (query.length === 0) { continue; }
            if (!uniqueQueryMap.has(query)) {
                uniqueQueryMap.set(query, {term, query, itemIndex});
            }
        }
        const dictionaryCacheKey = this._getDictionaryCacheKey(dictionaryNames);
        const negativeCachePrefix = `${matchType}\u001f${dictionaryCacheKey}\u001f`;
        const queriesToCheck = [...uniqueQueryMap.values()].filter(({query}) => !this._termPrefixNegativeCache.has(`${negativeCachePrefix}${query}`));
        /** @type {Set<string>} */
        const foundQueries = new Set();
        const directFindForDictionaries = Reflect.get(this._termRecordStore, 'findTermPrefixIdMatchesForDictionaries');
        for (const queryData of queriesToCheck) {
            const directQuery = matchType === 'suffix' ? queryData.term : queryData.query;
            const matchesByDictionary = typeof directFindForDictionaries === 'function' ?
                /** @type {(dictionaryNames: string[], query: string, reverse: boolean) => Array<{expression: Array<{id: number, exact: boolean}>, reading: Array<{id: number, exact: boolean}>}>} */ (
                    directFindForDictionaries
                ).call(
                    this._termRecordStore,
                    dictionaryNames.map((name) => this._getTermRecordStorageName(name)),
                    directQuery,
                    matchType === 'suffix',
                ) :
                dictionaryNames.map((dictionaryName) => ({
                    expression: this._findDirectTermPrefixIdMatches(dictionaryName, directQuery, 'expression', matchType === 'suffix'),
                    reading: this._findDirectTermPrefixIdMatches(dictionaryName, directQuery, 'reading', matchType === 'suffix'),
                }));
            for (let indexIndex = 0; indexIndex < columns.length; ++indexIndex) {
                const column = columns[indexIndex];
                for (let dictionaryIndex = 0; dictionaryIndex < dictionaryNames.length; ++dictionaryIndex) {
                    for (const {id, exact} of matchesByDictionary[dictionaryIndex][column]) {
                        foundQueries.add(queryData.query);
                        if (id <= 0 || visited.has(id)) { continue; }
                        visited.add(id);
                        const matchSource = (indexIndex === 0) ? 'term' : 'reading';
                        const matchType2 = exact ? 'exact' : matchType;
                        idMatches.set(id, {matchSource, matchType: matchType2, itemIndex: queryData.itemIndex});
                    }
                }
            }
        }
        for (const {query} of queriesToCheck) {
            const key = `${negativeCachePrefix}${query}`;
            if (foundQueries.has(query)) {
                this._termPrefixNegativeCache.delete(key);
            } else {
                this._termPrefixNegativeCache.set(key, true);
            }
        }
        if (this._termPrefixNegativeCache.size > 50000) {
            this._termPrefixNegativeCache.clear();
        }

        const rowsById = await this._fetchTermRowsByIds(idMatches.keys());
        if (shouldReportDiagnostics) {
            reportDiagnosticsLazy('dictionary-lookup-db-query', () => ({
                stage: 'findTermsBulk-prefix',
                matchType,
                termCount: termList.length,
                termsSample: termList.slice(0, 12),
                dictionaryNames,
                matchedIdCount: idMatches.size,
                matchedRowCount: rowsById.size,
            }));
        }
        for (const [id, {matchSource, matchType: matchType2, itemIndex}] of idMatches) {
            const row = rowsById.get(id);
            if (typeof row === 'undefined') { continue; }
            results.push(this._createTerm(matchSource, matchType2, row, itemIndex));
        }
        if (results.length === 0 && shouldReportDiagnostics) {
            reportDiagnosticsLazy('dictionary-lookup-db-query', () => ({
                stage: 'findTermsBulk-prefix-zero-result',
                matchType,
                termCount: termList.length,
                termsSample: termList.slice(0, 12),
                dictionaryNames,
                matchedIdCount: idMatches.size,
                matchedRowCount: rowsById.size,
            }));
        }
        return results;
    }

    /**
     * @param {import('dictionary-database').TermExactRequest[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsExactBulk(termList, dictionaries) {
        this._requireDb();
        if (termList.length === 0 || dictionaries.size === 0) {
            return [];
        }
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        const dictionaryNames = this._getDictionaryNames(dictionaries);
        await this._ensureDirectTermIndexesLoaded(dictionaryNames);
        /** @type {Map<string, {reading: string, itemIndex: number}[]>} */
        const requestsByTerm = new Map();
        for (let itemIndex = 0; itemIndex < termList.length; ++itemIndex) {
            const item = termList[itemIndex];
            const requests = requestsByTerm.get(item.term);
            if (typeof requests === 'undefined') {
                requestsByTerm.set(item.term, [{reading: item.reading, itemIndex}]);
            } else {
                requests.push({reading: item.reading, itemIndex});
            }
        }
        /** @type {Map<number, {reading: string, itemIndex: number}[]>} */
        const idMatches = new Map();
        for (const [term, requests] of requestsByTerm) {
            for (const dictionaryName of dictionaryNames) {
                const expressionIds = this._findDirectTermIds(dictionaryName, term, 'expression');
                if (expressionIds.length === 0) { continue; }
                for (const request of requests) {
                    /** @type {Set<number>|null} */
                    let readingIdSet = null;
                    if (request.reading !== term) {
                        const readingIds = this._findDirectTermIds(dictionaryName, request.reading, 'reading');
                        if (readingIds.length === 0) { continue; }
                        readingIdSet = new Set(readingIds);
                    }
                    for (const id of expressionIds) {
                        if (id <= 0 || (readingIdSet !== null && !readingIdSet.has(id))) { continue; }
                        const existingRequests = idMatches.get(id);
                        if (typeof existingRequests === 'undefined') {
                            idMatches.set(id, [request]);
                        } else {
                            existingRequests.push(request);
                        }
                    }
                }
            }
        }

        const rowsById = await this._fetchTermRowsByIds(idMatches.keys());
        for (const [id, requests] of idMatches) {
            const row = rowsById.get(id);
            if (typeof row === 'undefined') { continue; }
            for (const {reading, itemIndex} of requests) {
                if (row.reading !== reading) { continue; }
                results.push(this._createTerm('term', 'exact', row, itemIndex));
            }
        }

        return results;
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<import('dictionary-database').TermEntry[]>}
     */
    async findTermsBySequenceBulk(items) {
        this._requireDb();
        if (items.length === 0) {
            return [];
        }
        /** @type {import('dictionary-database').TermEntry[]} */
        const results = [];
        /** @type {Map<string, number[]>} */
        const dictionarySequenceIndexes = new Map();
        for (let itemIndex = 0; itemIndex < items.length; ++itemIndex) {
            const item = items[itemIndex];
            const sequence = this._asNumber(item.query, -1);
            if (sequence < 0) { continue; }
            const key = `${item.dictionary}\u001f${sequence}`;
            const itemIndexes = dictionarySequenceIndexes.get(key);
            if (typeof itemIndexes === 'undefined') {
                dictionarySequenceIndexes.set(key, [itemIndex]);
            } else {
                itemIndexes.push(itemIndex);
            }
        }
        if (dictionarySequenceIndexes.size === 0) {
            return [];
        }
        const dictionaryNames = [...new Set(items.map((item) => item.dictionary))];
        await this._ensureDirectTermIndexesLoaded(dictionaryNames);
        const sequenceValues = [...new Set(items.map((item) => this._asNumber(item.query, -1)).filter((value) => value >= 0))];
        /** @type {Map<number, number[]>} */
        const idMatches = new Map();
        for (const dictionaryName of dictionaryNames) {
            for (const sequence of sequenceValues) {
                const ids = this._findDirectTermIdsBySequence(dictionaryName, sequence);
                if (ids.length === 0) { continue; }
                const key = `${dictionaryName}\u001f${sequence}`;
                const itemIndexes = dictionarySequenceIndexes.get(key);
                if (typeof itemIndexes === 'undefined') { continue; }
                for (const id of ids) {
                    if (id <= 0) { continue; }
                    const existingIndexes = idMatches.get(id);
                    if (typeof existingIndexes === 'undefined') {
                        idMatches.set(id, [...itemIndexes]);
                    } else {
                        for (const itemIndex of itemIndexes) {
                            existingIndexes.push(itemIndex);
                        }
                    }
                }
            }
        }

        const rowsById = await this._fetchTermRowsByIds(idMatches.keys());
        for (const [id, itemIndexes] of idMatches) {
            const row = rowsById.get(id);
            if (typeof row === 'undefined') { continue; }
            for (const itemIndex of itemIndexes) {
                results.push(this._createTerm('sequence', 'exact', row, itemIndex));
            }
        }

        return results;
    }

    /**
     * @param {string[]} termList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').TermMeta[]>}
     */
    async findTermMetaBulk(termList, dictionaries) {
        if (termList.length === 0 || dictionaries.size === 0) {
            return [];
        }
        /** @type {import('dictionary-database').TermMeta[]} */
        const results = [];
        const termIndexMap = this._buildTermIndexMap(termList);
        const dictionaryNames = this._getDictionaryNames(dictionaries);
        const {clause: termInClause, bind: termBind} = this._buildTextInClause(termIndexMap.keys(), 'term');
        const {clause: dictionaryInClause, bind: dictionaryBind} = this._buildTextInClause(dictionaryNames, 'dict');
        const sql = `SELECT * FROM termMeta WHERE expression IN (${termInClause}) AND dictionary IN (${dictionaryInClause})`;
        const stmt = this._getCachedStatement(sql);
        stmt.reset(true);
        stmt.bind({...termBind, ...dictionaryBind});
        while (stmt.step()) {
            const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
            const expression = this._asString(row.expression);
            const itemIndexes = termIndexMap.get(expression);
            if (typeof itemIndexes === 'undefined') { continue; }
            const converted = this._deserializeTermMetaRow(row);
            for (const itemIndex of itemIndexes) {
                results.push(this._createTermMeta(converted, {itemIndex, indexIndex: 0, item: expression}));
            }
        }

        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiEntry[]>}
     */
    async findKanjiBulk(kanjiList, dictionaries) {
        if (kanjiList.length === 0 || dictionaries.size === 0) {
            return [];
        }
        /** @type {import('dictionary-database').KanjiEntry[]} */
        const results = [];
        const characterIndexMap = this._buildTermIndexMap(kanjiList);
        const dictionaryNames = this._getDictionaryNames(dictionaries);
        const {clause: characterInClause, bind: characterBind} = this._buildTextInClause(characterIndexMap.keys(), 'ch');
        const {clause: dictionaryInClause, bind: dictionaryBind} = this._buildTextInClause(dictionaryNames, 'dict');
        const sql = `SELECT * FROM kanji WHERE character IN (${characterInClause}) AND dictionary IN (${dictionaryInClause})`;
        const stmt = this._getCachedStatement(sql);
        stmt.reset(true);
        stmt.bind({...characterBind, ...dictionaryBind});
        while (stmt.step()) {
            const converted = this._deserializeKanjiRow(/** @type {import('core').SafeAny} */ (stmt.get({})));
            const itemIndexes = characterIndexMap.get(converted.character);
            if (typeof itemIndexes === 'undefined') { continue; }
            for (const itemIndex of itemIndexes) {
                results.push(this._createKanji(converted, {itemIndex, indexIndex: 0, item: converted.character}));
            }
        }

        return results;
    }

    /**
     * @param {string[]} kanjiList
     * @param {import('dictionary-database').DictionarySet} dictionaries
     * @returns {Promise<import('dictionary-database').KanjiMeta[]>}
     */
    async findKanjiMetaBulk(kanjiList, dictionaries) {
        if (kanjiList.length === 0 || dictionaries.size === 0) {
            return [];
        }
        /** @type {import('dictionary-database').KanjiMeta[]} */
        const results = [];
        const characterIndexMap = this._buildTermIndexMap(kanjiList);
        const dictionaryNames = this._getDictionaryNames(dictionaries);
        const {clause: characterInClause, bind: characterBind} = this._buildTextInClause(characterIndexMap.keys(), 'ch');
        const {clause: dictionaryInClause, bind: dictionaryBind} = this._buildTextInClause(dictionaryNames, 'dict');
        const sql = `SELECT * FROM kanjiMeta WHERE character IN (${characterInClause}) AND dictionary IN (${dictionaryInClause})`;
        const stmt = this._getCachedStatement(sql);
        stmt.reset(true);
        stmt.bind({...characterBind, ...dictionaryBind});
        while (stmt.step()) {
            const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
            const character = this._asString(row.character);
            const itemIndexes = characterIndexMap.get(character);
            if (typeof itemIndexes === 'undefined') { continue; }
            const converted = this._deserializeKanjiMetaRow(row);
            for (const itemIndex of itemIndexes) {
                results.push(this._createKanjiMeta(converted, {itemIndex, indexIndex: 0, item: character}));
            }
        }

        return results;
    }

    /**
     * @param {import('dictionary-database').DictionaryAndQueryRequest[]} items
     * @returns {Promise<(import('dictionary-database').Tag|undefined)[]>}
     */
    async findTagMetaBulk(items) {
        if (items.length === 0) {
            return [];
        }
        const results = new Array(items.length);
        /** @type {Map<string, number[]>} */
        const requestIndexes = new Map();
        for (let i = 0; i < items.length; ++i) {
            const item = items[i];
            const key = `${item.dictionary}\u001f${this._asString(item.query)}`;
            const itemIndexes = requestIndexes.get(key);
            if (typeof itemIndexes === 'undefined') {
                requestIndexes.set(key, [i]);
            } else {
                itemIndexes.push(i);
            }
        }

        const uniqueRequests = [...requestIndexes.keys()];
        for (const requestChunk of this._chunkValues(uniqueRequests, 256)) {
            /** @type {Record<string, string>} */
            const bind = {};
            const conditions = [];
            for (let i = 0; i < requestChunk.length; ++i) {
                const [dictionary, query] = requestChunk[i].split('\u001f');
                const dictionaryKey = `$dictionary${i}`;
                const queryKey = `$query${i}`;
                bind[dictionaryKey] = dictionary;
                bind[queryKey] = query;
                conditions.push(`(dictionary = ${dictionaryKey} AND name = ${queryKey})`);
            }
            const sql = `SELECT name, category, ord as "order", notes, score, dictionary FROM tagMeta WHERE ${conditions.join(' OR ')}`;
            const stmt = this._getCachedStatement(sql);
            stmt.reset(true);
            stmt.bind(bind);
            while (stmt.step()) {
                const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
                const tag = this._deserializeTagRow(row);
                const itemIndexes = requestIndexes.get(`${tag.dictionary}\u001f${tag.name}`);
                if (typeof itemIndexes === 'undefined') { continue; }
                for (const itemIndex of itemIndexes) {
                    if (typeof results[itemIndex] === 'undefined') {
                        results[itemIndex] = tag;
                    }
                }
            }
        }

        return results;
    }

    /**
     * @param {string} name
     * @param {string} dictionary
     * @returns {Promise<?import('dictionary-database').Tag>}
     */
    async findTagForTitle(name, dictionary) {
        const db = this._requireDb();
        const row = db.selectObject(
            'SELECT name, category, ord as "order", notes, score, dictionary FROM tagMeta WHERE name = $name AND dictionary = $dictionary LIMIT 1',
            {$name: name, $dictionary: dictionary},
        );
        return typeof row === 'undefined' ? null : this._deserializeTagRow(row);
    }

    /**
     * @param {import('dictionary-database').MediaRequest[]} items
     * @returns {Promise<import('dictionary-database').Media[]>}
     */
    async getMedia(items) {
        if (items.length === 0) {
            return [];
        }
        /** @type {import('dictionary-database').Media[]} */
        const results = [];
        /** @type {Map<string, number[]>} */
        const mediaRequestIndexes = new Map();
        for (let itemIndex = 0; itemIndex < items.length; ++itemIndex) {
            const item = items[itemIndex];
            const key = `${item.dictionary}\u001f${item.path}`;
            const itemIndexes = mediaRequestIndexes.get(key);
            if (typeof itemIndexes === 'undefined') {
                mediaRequestIndexes.set(key, [itemIndex]);
            } else {
                itemIndexes.push(itemIndex);
            }
        }
        const uniqueRequests = [...mediaRequestIndexes.keys()];
        for (const requestChunk of this._chunkValues(uniqueRequests, 128)) {
            /** @type {Record<string, string>} */
            const bind = {};
            const conditions = [];
            for (let i = 0; i < requestChunk.length; ++i) {
                const [dictionary, path] = requestChunk[i].split('\u001f');
                const dictionaryKey = `$dictionary${i}`;
                const pathKey = `$path${i}`;
                bind[dictionaryKey] = dictionary;
                bind[pathKey] = path;
                conditions.push(`(dictionary = ${dictionaryKey} AND path = ${pathKey})`);
            }
            const sql = `SELECT dictionary, path, mediaType, width, height, content, contentOffset, contentLength, contentCompressionMethod, contentUncompressedLength FROM media WHERE ${conditions.join(' OR ')}`;
            const stmt = this._getCachedStatement(sql);
            stmt.reset(true);
            stmt.bind(bind);
            while (stmt.step()) {
                const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
                const converted = await this._deserializeMediaRow(row);
                const itemIndexes = mediaRequestIndexes.get(`${converted.dictionary}\u001f${converted.path}`);
                if (typeof itemIndexes === 'undefined') { continue; }
                for (const itemIndex of itemIndexes) {
                    results.push(this._createMedia(converted, {itemIndex, indexIndex: 0, item: items[itemIndex]}));
                }
            }
        }

        return results;
    }

    /**
     * @param {import('dictionary-database').DrawMediaRequest[]} items
     * @param {MessagePort} source
     */
    async drawMedia(items, source) {
        if (this._worker !== null) {
            this._worker.postMessage({action: 'drawMedia', params: {items}}, [source]);
            return;
        }

        safePerformance.mark('drawMedia:start');

        /** @type {Map<string, import('dictionary-database').DrawMediaGroupedRequest>} */
        const groupedItems = new Map();
        for (const item of items) {
            const {path, dictionary, canvasIndex, canvasWidth, canvasHeight, generation} = item;
            const key = `${path}:::${dictionary}`;
            if (!groupedItems.has(key)) {
                groupedItems.set(key, {path, dictionary, canvasIndexes: [], canvasWidth, canvasHeight, generation});
            }
            groupedItems.get(key)?.canvasIndexes.push(canvasIndex);
        }
        const groupedItemsArray = [...groupedItems.values()];
        const media = await this.getMedia(groupedItemsArray);
        const results = media.map((item) => {
            const grouped = groupedItemsArray[item.index];
            return {
                ...item,
                canvasIndexes: grouped.canvasIndexes,
                canvasWidth: grouped.canvasWidth,
                canvasHeight: grouped.canvasHeight,
                generation: grouped.generation,
            };
        });

        results.sort((a, _b) => (a.mediaType === 'image/svg+xml' ? -1 : 1));

        safePerformance.mark('drawMedia:draw:start');
        for (const m of results) {
            if (m.mediaType === 'image/svg+xml') {
                safePerformance.mark('drawMedia:draw:svg:start');
                /** @type {import('@resvg/resvg-wasm').ResvgRenderOptions} */
                const opts = {
                    fitTo: {
                        mode: 'width',
                        value: m.canvasWidth,
                    },
                    font: {
                        fontBuffers: this._resvgFontBuffer !== null ? [this._resvgFontBuffer] : [],
                    },
                };
                const resvgJS = new Resvg(new Uint8Array(m.content), opts);
                const render = resvgJS.render();
                source.postMessage({action: 'drawBufferToCanvases', params: {buffer: render.pixels.buffer, width: render.width, height: render.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [render.pixels.buffer]);
                safePerformance.mark('drawMedia:draw:svg:end');
                safePerformance.measure('drawMedia:draw:svg', 'drawMedia:draw:svg:start', 'drawMedia:draw:svg:end');
            } else {
                safePerformance.mark('drawMedia:draw:raster:start');

                if ('serviceWorker' in navigator) {
                    const imageDecoder = new ImageDecoder({type: m.mediaType, data: m.content});
                    await imageDecoder.decode().then((decodedImageResult) => {
                        source.postMessage({action: 'drawDecodedImageToCanvases', params: {decodedImage: decodedImageResult.image, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [decodedImageResult.image]);
                    });
                } else {
                    const image = new Blob([m.content], {type: m.mediaType});
                    await createImageBitmap(image, {resizeWidth: m.canvasWidth, resizeHeight: m.canvasHeight, resizeQuality: 'high'}).then((decodedImage) => {
                        const canvas = new OffscreenCanvas(decodedImage.width, decodedImage.height);
                        const ctx = canvas.getContext('2d');
                        if (ctx !== null) {
                            ctx.drawImage(decodedImage, 0, 0);
                            const imageData = ctx.getImageData(0, 0, decodedImage.width, decodedImage.height);
                            source.postMessage({action: 'drawBufferToCanvases', params: {buffer: imageData.data.buffer, width: decodedImage.width, height: decodedImage.height, canvasIndexes: m.canvasIndexes, generation: m.generation}}, [imageData.data.buffer]);
                        }
                    });
                }
                safePerformance.mark('drawMedia:draw:raster:end');
                safePerformance.measure('drawMedia:draw:raster', 'drawMedia:draw:raster:start', 'drawMedia:draw:raster:end');
            }
        }
        safePerformance.mark('drawMedia:draw:end');
        safePerformance.measure('drawMedia:draw', 'drawMedia:draw:start', 'drawMedia:draw:end');

        safePerformance.mark('drawMedia:end');
        safePerformance.measure('drawMedia', 'drawMedia:start', 'drawMedia:end');
    }

    /**
     * @returns {Promise<import('dictionary-importer').Summary[]>}
     */
    async getDictionaryInfo() {
        const db = this._requireDb();
        const rows = db.selectObjects('SELECT summaryJson FROM dictionaries ORDER BY id ASC');
        return rows.map((row) => {
            const parsedSummary = /** @type {unknown} */ (
                this._safeParseJson(this._asString(row.summaryJson), {})
            );
            const summary = /** @type {import('dictionary-importer').Summary & {storageHealth?: string, storageHealthReason?: string|null}} */ (
                parsedSummary !== null && typeof parsedSummary === 'object' && !Array.isArray(parsedSummary) ?
                    parsedSummary :
                    {}
            );
            const title = this._asString(summary.title);
            const termRecordStorageName = this._getSummaryTermRecordStorageName(summary, title);
            const getDictionaryHealth = Reflect.get(this._termRecordStore, 'getDictionaryHealth');
            const health = typeof getDictionaryHealth === 'function' ?
                getDictionaryHealth.call(this._termRecordStore, termRecordStorageName) :
                {status: 'available', reason: null};
            summary.storageHealth = health.status;
            summary.storageHealthReason = health.reason;
            return summary;
        });
    }

    /**
     * Persists only terminal record-storage failures. Repairing and transient
     * states are runtime details and must not outlive the current worker.
     * @param {string} dictionaryName
     * @param {'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired'} status
     * @param {string|null} reason
     */
    _onTermRecordDictionaryHealthChanged(termRecordStorageName, status, reason) {
        if (this._db === null) { return; }
        const dictionaryName = this._getDictionaryNameForTermRecordStorage(termRecordStorageName);
        if (status === 'reimportRequired') {
            // A lookup may have populated these caches immediately before a
            // concurrent integrity failure invalidated the backing shard.
            this._clearDirectTermIndexCaches();
            this._db.exec({
                sql: `
                    INSERT INTO dictionaryStorageHealth (title, reason)
                    VALUES (?, ?)
                    ON CONFLICT(title) DO UPDATE SET reason = excluded.reason
                `,
                bind: [dictionaryName, reason ?? 'Dictionary record data is damaged'],
            });
        } else if (status === 'temporarilyUnavailable') {
            // A loaded marker suppresses ensureDictionariesLoaded on later
            // lookups. Drop it so a transient storage failure can recover on
            // the next lookup without requiring a separate cache warm-up.
            this._directTermIndexLoadedDictionaryNames.delete(dictionaryName);
            this._directTermIndexByDictionary.delete(dictionaryName);
        } else if (status === 'available') {
            this._db.exec({sql: 'DELETE FROM dictionaryStorageHealth WHERE title = ?', bind: [dictionaryName]});
        }
    }

    /** Restores terminal dictionary health before startup cleanup and prewarm. */
    _restoreTermRecordDictionaryHealth() {
        const db = this._requireDb();
        const rows = db.selectObjects(`
            SELECT h.title, h.reason
            FROM dictionaryStorageHealth h
            INNER JOIN dictionaries d ON d.title = h.title
            ORDER BY d.id ASC
        `);
        for (const row of rows) {
            const title = this._asString(row.title).trim();
            if (title.length === 0) { continue; }
            const reason = this._asString(row.reason).trim() || 'Dictionary record data is damaged';
            this._termRecordStore.markDictionaryReimportRequired(this._getTermRecordStorageName(title), reason);
        }
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<import('dictionary-database').DictionaryTermProbe|null>}
     */
    async getDictionaryTermProbe(dictionaryName) {
        await this._termRecordStore.ensureDictionariesLoaded([this._getTermRecordStorageName(dictionaryName)]);
        const probeId = this._getDirectDictionarySampleIds(dictionaryName, 1)[0] ?? null;
        if (probeId === null) { return null; }
        const record = (await this._termRecordStore.getByIdsAsync([probeId])).get(probeId);
        if (typeof record === 'undefined') { return null; }
        const expression = this._asString(record.expression).trim();
        const reading = this._asString(record.reading).trim();
        return expression.length === 0 && reading.length === 0 ? null : {expression, reading};
    }

    /**
     * @param {(dictionaryName: string) => boolean} predicate
     * @returns {Promise<string[]>}
     */
    async cleanupTransientTermRecordShards(predicate) {
        return await this._termRecordStore.cleanupShardFilesByDictionaryPredicate(predicate);
    }

    /**
     * @returns {Promise<Array<{
     *   id: number,
     *   titleColumn: string,
     *   versionColumn: number,
     *   summaryJsonLength: number,
     *   summaryParseOk: boolean,
     *   summaryTitle: string|null,
     *   summaryImportSuccess: boolean|null
     * }>>}
     */
    async debugGetDictionaryRows() {
        const db = this._requireDb();
        const rows = db.selectObjects('SELECT id, title, version, summaryJson FROM dictionaries ORDER BY id ASC');
        return rows.map((row) => {
            const summaryJson = this._asString(row.summaryJson);
            let summary = null;
            let summaryParseOk = false;
            try {
                summary = /** @type {unknown} */ (parseJson(summaryJson));
                summaryParseOk = true;
            } catch (_) {
                summary = null;
            }
            const summaryObject = (typeof summary === 'object' && summary !== null && !Array.isArray(summary)) ? summary : null;
            const summaryTitle = summaryObject !== null && typeof Reflect.get(summaryObject, 'title') === 'string' ?
                /** @type {string} */ (Reflect.get(summaryObject, 'title')) :
                null;
            const summaryImportSuccess = summaryObject !== null && typeof Reflect.get(summaryObject, 'importSuccess') === 'boolean' ?
                /** @type {boolean} */ (Reflect.get(summaryObject, 'importSuccess')) :
                null;
            return {
                id: this._asNumber(row.id, 0),
                titleColumn: this._asString(row.title),
                versionColumn: this._asNumber(row.version, 0),
                summaryJsonLength: summaryJson.length,
                summaryParseOk,
                summaryTitle,
                summaryImportSuccess,
            };
        });
    }

    /**
     * @returns {Promise<{
     *   scannedCount: number,
     *   removedCount: number,
     *   removedTitles: string[],
     *   restoredTitles: string[],
     *   removedEmptyTitleRows: number,
     *   failedCount: number,
     *   failedTitles: string[],
     *   parseErrorCount: number
     * }>}
     */
    async _cleanupIncompleteImports() {
        const db = this._requireDb();
        const rows = db.selectObjects('SELECT id, title, summaryJson FROM dictionaries ORDER BY id ASC');
        if (rows.length === 0) {
            const summary = {
                scannedCount: 0,
                removedCount: 0,
                removedTitles: [],
                restoredTitles: [],
                removedEmptyTitleRows: 0,
                failedCount: 0,
                failedTitles: [],
                parseErrorCount: 0,
            };
            this._startupCleanupIncompleteImportsSummary = summary;
            reportDiagnostics('dictionary-startup-cleanup-summary', summary);
            return summary;
        }

        /** @type {Set<string>} */
        const dictionaryTitlesToDelete = new Set();
        /** @type {Set<string>} */
        const installedTitles = new Set();
        /** @type {{title: string, originalTitle: string, summary: Record<string, unknown>}[]} */
        const restorableReplacedTitles = [];
        /** @type {number} */
        let removedEmptyTitleRows = 0;
        /** @type {number} */
        let parseErrorCount = 0;
        for (const row of rows) {
            const id = this._asNumber(row.id, 0);
            const title = this._asString(row.title).trim();
            const summaryJson = this._asString(row.summaryJson);
            let summaryParseFailed = false;
            /** @type {unknown} */
            let summary;
            try {
                summary = /** @type {unknown} */ (parseJson(summaryJson));
            } catch (_) {
                summary = null;
                summaryParseFailed = true;
            }
            if (summaryParseFailed) {
                parseErrorCount += 1;
            }
            const importSuccess = (
                typeof summary === 'object' &&
                summary !== null &&
                !Array.isArray(summary)
            ) ?
                /** @type {unknown} */ (Reflect.get(summary, 'importSuccess')) :
                void 0;
            if (title.length > 0 && !TRANSIENT_UPDATE_TITLE_PATTERN.test(title)) {
                installedTitles.add(title);
            }
            if (title.length > 0 && isRecognizedTransientUpdateTitle(title, summary)) {
                const transientInfo = parseTransientUpdateTitleInfo(title);
                const originalTitle = title.replace(/\s+\[(?:update-staging|cutover|replaced) [^\]]+\]$/, '').trim();
                if (
                    transientInfo !== null &&
                    transientInfo.stage === 'replaced' &&
                    originalTitle.length > 0 &&
                    typeof summary === 'object' &&
                    summary !== null &&
                    !Array.isArray(summary)
                ) {
                    const restoredSummary = {...summary, title: originalTitle};
                    delete restoredSummary.transientUpdateStage;
                    delete restoredSummary.updateSessionToken;
                    restorableReplacedTitles.push({title, originalTitle, summary: restoredSummary});
                }
                dictionaryTitlesToDelete.add(title);
                continue;
            }
            if (summary !== null && importSuccess !== false) {
                continue;
            }
            if (title.length === 0) {
                db.exec({sql: 'DELETE FROM dictionaries WHERE id = $id', bind: {$id: id}});
                log.warn('Removed incomplete dictionary summary row with empty title.');
                removedEmptyTitleRows += 1;
                continue;
            }
            dictionaryTitlesToDelete.add(title);
        }

        /** @type {string[]} */
        const restoredTitles = [];
        /** @type {string[]} */
        const failedTitles = [];
        for (const {title, originalTitle, summary} of restorableReplacedTitles) {
            if (installedTitles.has(originalTitle)) { continue; }
            try {
                // Term-record storage has immutable identity. Restoring the
                // logical title is a SQLite-only cutover and must retain the
                // storage name recorded by the moved-aside summary.
                await this.replaceDictionaryTitle(title, originalTitle, summary, null);
                dictionaryTitlesToDelete.delete(title);
                installedTitles.add(originalTitle);
                restoredTitles.push(originalTitle);
                log.warn(`Restored interrupted dictionary update during startup: ${title} -> ${originalTitle}`);
            } catch (e) {
                const error = toError(e);
                // Keep the authoritative recovery copy for the next startup.
                // Deleting it here can turn a transient OPFS failure into
                // permanent dictionary loss.
                dictionaryTitlesToDelete.delete(title);
                failedTitles.push(title);
                log.error(new Error(`Failed to restore interrupted dictionary update '${title}': ${error.message}`));
            }
        }

        /** @type {string[]} */
        const removedTitles = [];
        for (const dictionaryTitle of dictionaryTitlesToDelete) {
            try {
                await this.deleteDictionary(dictionaryTitle, 1000, () => {});
                log.warn(`Removed incomplete dictionary import during startup: ${dictionaryTitle}`);
                removedTitles.push(dictionaryTitle);
            } catch (e) {
                const error = toError(e);
                log.error(new Error(`Failed to remove incomplete dictionary import '${dictionaryTitle}': ${error.message}`));
                failedTitles.push(dictionaryTitle);
            }
        }

        const summary = {
            scannedCount: rows.length,
            removedCount: removedTitles.length + removedEmptyTitleRows,
            removedTitles: [...removedTitles].sort((a, b) => a.localeCompare(b)),
            restoredTitles: [...restoredTitles].sort((a, b) => a.localeCompare(b)),
            removedEmptyTitleRows,
            failedCount: failedTitles.length,
            failedTitles: [...failedTitles].sort((a, b) => a.localeCompare(b)),
            parseErrorCount,
        };
        this._startupCleanupIncompleteImportsSummary = summary;
        reportDiagnostics('dictionary-startup-cleanup-summary', summary);
        return summary;
    }

    /**
     * @returns {Promise<{
     *   scannedCount: number,
     *   expectedTermDictionaryCount: number,
     *   missingShardDictionaryCount: number,
     *   missingShardDictionaryNames: string[],
     *   removedCount: number,
     *   removedTitles: string[],
     *   markedReimportRequiredCount: number,
     *   markedReimportRequiredTitles: string[],
     *   failedCount: number,
     *   failedTitles: string[],
     *   parseErrorCount: number,
     *   shardIntegrity: {
     *     expectedShardCount: number,
     *     actualShardCount: number,
     *     missingShardCount: number,
     *     missingShardFileNames: string[],
     *     missingDictionaryNames: string[],
     *     orphanShardCount: number,
     *     orphanShardFileNames: string[],
     *     orphanDictionaryNames: string[],
     *     removedOrphanShardCount: number,
     *     invalidShardPayloadCount: number,
     *     invalidShardFileNames: string[],
     *     rewroteAllShardsFromMemory: boolean
     *   }
     * }>}
     */
    async _cleanupMissingTermRecordShards() {
        const db = this._requireDb();
        const rows = db.selectObjects('SELECT title, summaryJson FROM dictionaries ORDER BY id ASC');
        /** @type {string[]} */
        const expectedTermDictionaryNames = [];
        let parseErrorCount = 0;
        for (const row of rows) {
            const title = this._asString(row.title).trim();
            if (title.length === 0) { continue; }
            let summary;
            try {
                summary = /** @type {unknown} */ (parseJson(this._asString(row.summaryJson)));
            } catch (_) {
                ++parseErrorCount;
                continue;
            }
            if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
                continue;
            }
            const counts = /** @type {unknown} */ (Reflect.get(summary, 'counts'));
            const terms = (typeof counts === 'object' && counts !== null) ? /** @type {unknown} */ (Reflect.get(counts, 'terms')) : null;
            const total = (typeof terms === 'object' && terms !== null) ? this._asNumber(Reflect.get(terms, 'total'), 0) : 0;
            if (total > 0) {
                expectedTermDictionaryNames.push(this._getTermRecordStorageName(title));
            }
        }
        const shardIntegrity = await this._termRecordStore.verifyIntegrity(expectedTermDictionaryNames);
        const missingShardStorageNames = [...new Set(
            (Array.isArray(shardIntegrity.missingDictionaryNames) ? shardIntegrity.missingDictionaryNames : [])
                .filter((name) => typeof name === 'string' && name.length > 0),
        )].sort((a, b) => a.localeCompare(b));
        const missingShardDictionaryNames = missingShardStorageNames.map(
            (name) => this._getDictionaryNameForTermRecordStorage(name),
        );

        /** @type {string[]} */
        const markedReimportRequiredTitles = [];
        for (let i = 0; i < missingShardDictionaryNames.length; ++i) {
            const title = missingShardDictionaryNames[i];
            this._termRecordStore.markDictionaryReimportRequired(
                missingShardStorageNames[i],
                'Dictionary record data is missing',
            );
            markedReimportRequiredTitles.push(title);
        }

        const summary = {
            scannedCount: rows.length,
            expectedTermDictionaryCount: expectedTermDictionaryNames.length,
            missingShardDictionaryCount: missingShardDictionaryNames.length,
            missingShardDictionaryNames,
            removedCount: 0,
            removedTitles: [],
            markedReimportRequiredCount: markedReimportRequiredTitles.length,
            markedReimportRequiredTitles: [...markedReimportRequiredTitles].sort((a, b) => a.localeCompare(b)),
            failedCount: 0,
            failedTitles: [],
            parseErrorCount,
            shardIntegrity,
        };
        this._startupCleanupMissingTermRecordShardsSummary = summary;
        reportDiagnostics('dictionary-term-record-integrity-summary', summary);
        return summary;
    }

    /**
     * @param {string[]} dictionaryNames
     * @param {boolean} getTotal
     * @returns {Promise<import('dictionary-database').DictionaryCounts>}
     */
    async getDictionaryCounts(dictionaryNames, getTotal) {
        const db = this._requireDb();
        const tables = ['kanji', 'kanjiMeta', 'termMeta', 'tagMeta', 'media'];
        const summaryRows = db.selectObjects('SELECT title, summaryJson FROM dictionaries');
        /** @type {Map<string, number>} */
        const summaryTermCountByDictionary = new Map();
        /** @type {string[]} */
        const installedDictionaryNames = [];
        const installedDictionaryNameSet = new Set();
        for (const row of summaryRows) {
            const title = this._asString(row.title);
            if (title.length === 0) { continue; }
            if (!installedDictionaryNameSet.has(title)) {
                installedDictionaryNameSet.add(title);
                installedDictionaryNames.push(title);
            }
            const summary = this._safeParseJson(this._asString(row.summaryJson), null);
            const termCount = this._asNumber(summary?.counts?.terms?.total, -1);
            if (Number.isSafeInteger(termCount) && termCount >= 0) {
                summaryTermCountByDictionary.set(title, termCount);
            }
        }
        const fallbackDictionaryNames = new Set();
        for (const dictionaryName of dictionaryNames) {
            if (!summaryTermCountByDictionary.has(dictionaryName)) {
                fallbackDictionaryNames.add(dictionaryName);
            }
        }
        if (getTotal) {
            for (const dictionaryName of installedDictionaryNames) {
                if (!summaryTermCountByDictionary.has(dictionaryName)) {
                    fallbackDictionaryNames.add(dictionaryName);
                }
            }
        }
        if (fallbackDictionaryNames.size > 0) {
            await this._termRecordStore.ensureDictionariesLoaded(
                [...fallbackDictionaryNames].map((name) => this._getTermRecordStorageName(name)),
            );
        }
        const getTermCount = (dictionaryName) => summaryTermCountByDictionary.get(dictionaryName) ?? this._getDirectDictionaryRecordCount(dictionaryName);

        /** @type {import('dictionary-database').DictionaryCountGroup[]} */
        const counts = [];

        if (getTotal) {
            /** @type {import('dictionary-database').DictionaryCountGroup} */
            const total = {
                terms: installedDictionaryNames.reduce((sum, dictionaryName) => sum + getTermCount(dictionaryName), 0),
            };
            for (const table of tables) {
                total[table] = this._asNumber(db.selectValue(`SELECT COUNT(*) FROM ${table}`), 0);
            }
            counts.push(total);
        }

        for (const dictionaryName of dictionaryNames) {
            /** @type {import('dictionary-database').DictionaryCountGroup} */
            const countGroup = {terms: 0};
            countGroup.terms = getTermCount(dictionaryName);
            for (const table of tables) {
                countGroup[table] = this._asNumber(
                    db.selectValue(`SELECT COUNT(*) FROM ${table} WHERE dictionary = $dictionary`, {$dictionary: dictionaryName}),
                    0,
                );
            }
            counts.push(countGroup);
        }

        const total = getTotal ? /** @type {import('dictionary-database').DictionaryCountGroup} */ (counts.shift()) : null;
        return {total, counts};
    }

    /**
     * @param {string} title
     * @returns {Promise<boolean>}
     */
    async dictionaryExists(title) {
        const db = this._requireDb();
        const value = db.selectValue('SELECT 1 FROM dictionaries WHERE title = $title LIMIT 1', {$title: title});
        return typeof value !== 'undefined';
    }

    /**
     * @template {import('dictionary-database').ObjectStoreName} T
     * @param {T} objectStoreName
     * @param {import('dictionary-database').ObjectStoreData<T>[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async bulkAdd(objectStoreName, items, start, count) {
        const db = this._requireDb();

        if (start + count > items.length) {
            count = items.length - start;
        }
        if (count <= 0) { return; }
        if (objectStoreName === 'terms') {
            this._lastBulkAddTermsMetrics = null;
            this._termEntryContentCache.clear();
            if (!this._bulkImportTransactionOpen) {
                this._termEntryContentIdByHash.clear();
                this._termEntryContentIdByKey.clear();
                this._clearTermEntryContentMetaCaches();
            }
            this._termExactPresenceCache.clear();
            this._termPrefixNegativeCache.clear();
            this._clearDirectTermIndexCaches();
        }

        if (objectStoreName === 'terms') {
            await this._bulkAddTerms(/** @type {import('dictionary-database').ObjectStoreData<'terms'>[]} */ (items), start, count);
            return;
        }
        const descriptor = this._getBulkInsertDescriptor(objectStoreName);
        const useLocalTransaction = !this._bulkImportTransactionOpen;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(db);
        }
        try {
            await this._bulkInsertWithDescriptor(descriptor, items, start, count);
            if (useLocalTransaction) {
                db.exec('COMMIT');
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, contentBytesList: Uint8Array[], contentHash1List?: number[]|Uint32Array, contentHash2List?: number[]|Uint32Array, contentBytesBuffer?: Uint8Array, contentBytesBaseOffset?: number, contentMetaList?: Uint32Array, contentDictNameList: ((string|null)[]|null), termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null, uniformContentDictName?: string|null, dictionaryTotalRows?: number}} chunk
     * @returns {Promise<void>}
     */
    async bulkAddArtifactTermsChunk(chunk) {
        this._lastBulkAddTermsMetrics = null;
        this._termEntryContentCache.clear();
        if (!this._bulkImportTransactionOpen) {
            this._termEntryContentIdByHash.clear();
            this._termEntryContentIdByKey.clear();
            this._clearTermEntryContentMetaCaches();
        }
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
        if (this._enableTermEntryContentDedup) {
            const hasHashArrays = (
                (Array.isArray(chunk.contentHash1List) || chunk.contentHash1List instanceof Uint32Array) &&
                (Array.isArray(chunk.contentHash2List) || chunk.contentHash2List instanceof Uint32Array)
            );
            const hasContentSlab = (
                chunk.contentBytesBuffer instanceof Uint8Array &&
                chunk.contentMetaList instanceof Uint32Array &&
                chunk.contentMetaList.length >= chunk.rowCount * 4
            );
            if (hasHashArrays || hasContentSlab) {
                await this._bulkAddArtifactTermsChunkWithContentDedup(chunk);
                return;
            }
            const rows = this._materializeArtifactChunkTermEntries(chunk);
            await this._bulkAddTerms(rows, 0, rows.length);
            return;
        }
        await this._bulkAddArtifactTermsChunkWithoutContentDedup(chunk);
    }

    /**
     * @returns {{contentAppendMs: number, dedupScanMs?: number, contentStoreMs?: number, contentMetadataMs?: number, termRecordBuildMs: number, termRecordEncodeMs: number, termRecordWriteMs: number, termsVtabInsertMs: number, termRecordInternMs?: number, termRecordPackLengthsMs?: number, termRecordHeapCopyMs?: number, termRecordFieldEncodeMs?: number, termRecordValidationMs?: number, termLookupIndexEncodeMs?: number}|null}
     */
    getLastBulkAddTermsMetrics() {
        return this._lastBulkAddTermsMetrics;
    }

    /**
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[], scoreList: number[], sequenceList: (number|undefined)[], contentBytesList: Uint8Array[], contentDictNameList: ((string|null)[]|null)}} chunk
     * @returns {import('dictionary-database').DatabaseTermEntry[]}
     */
    _materializeArtifactChunkTermEntries(chunk) {
        const count = chunk.rowCount;
        /** @type {import('dictionary-database').DatabaseTermEntry[]} */
        const rows = new Array(count);
        for (let i = 0; i < count; ++i) {
            const expressionBytes = chunk.expressionBytesList[i];
            const readingEqualsExpression = chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1;
            const readingBytes = readingEqualsExpression ? expressionBytes : chunk.readingBytesList[i];
            const expression = this._textDecoder.decode(expressionBytes);
            const reading = readingEqualsExpression ? expression : this._textDecoder.decode(readingBytes);
            const sequenceValue = chunk.sequenceList[i];
            rows[i] = {
                dictionary: chunk.dictionary,
                expression,
                reading,
                expressionBytes,
                readingBytes: readingEqualsExpression ? void 0 : readingBytes,
                readingEqualsExpression,
                expressionReverse: null,
                readingReverse: null,
                rules: '',
                definitionTags: '',
                termTags: '',
                glossary: [],
                score: chunk.scoreList[i] ?? 0,
                sequence: typeof sequenceValue === 'number' && sequenceValue >= 0 ? sequenceValue : null,
                termEntryContentBytes: chunk.contentBytesList[i],
                termEntryContentDictName: Array.isArray(chunk.contentDictNameList) ? (chunk.contentDictNameList[i] ?? null) : null,
            };
        }
        return rows;
    }

    /**
     * @param {string} dictionary
     * @returns {{contentOffset: number, contentLength: number, contentDictName: string, uncompressedLength: number}|null}
     */
    _getSharedGlossaryArtifactMeta(dictionary) {
        const cached = this._sharedGlossaryArtifactMetaByDictionary.get(dictionary);
        if (typeof cached !== 'undefined') {
            return cached;
        }
        const db = this._requireDb();
        const row = db.selectObject(
            'SELECT contentOffset, contentLength, contentDictName, uncompressedLength FROM sharedGlossaryArtifacts WHERE dictionary = $dictionary LIMIT 1',
            {$dictionary: dictionary},
        );
        if (typeof row === 'undefined') {
            return null;
        }
        const meta = {
            contentOffset: this._asNumber(row.contentOffset, -1),
            contentLength: this._asNumber(row.contentLength, 0),
            contentDictName: this._asString(row.contentDictName),
            uncompressedLength: this._asNumber(row.uncompressedLength, 0),
        };
        this._sharedGlossaryArtifactMetaByDictionary.set(dictionary, meta);
        return meta;
    }

    /**
     * @param {string} dictionary
     * @param {number} glossaryOffset
     * @param {number} glossaryLength
     * @returns {Promise<Uint8Array>}
     */
    async _readCompressedSharedGlossarySlice(dictionary, glossaryOffset, glossaryLength) {
        const cached = this._sharedGlossaryArtifactInflatedByDictionary.get(dictionary);
        if (cached instanceof Uint8Array) {
            return this._getCheckedSharedGlossarySlice(dictionary, cached, glossaryOffset, glossaryLength);
        }
        const existingPromise = this._sharedGlossaryArtifactInflatePromiseByDictionary.get(dictionary);
        if (typeof existingPromise !== 'undefined') {
            const inflatedBytes = await existingPromise;
            return this._getCheckedSharedGlossarySlice(dictionary, inflatedBytes, glossaryOffset, glossaryLength);
        }
        const promise = this._inflateSharedGlossaryArtifact(dictionary);
        const generation = this._sharedGlossaryArtifactGeneration;
        this._sharedGlossaryArtifactInflatePromiseByDictionary.set(dictionary, promise);
        try {
            const inflatedBytes = await promise;
            if (generation === this._sharedGlossaryArtifactGeneration) {
                this._sharedGlossaryArtifactInflatedByDictionary.set(dictionary, inflatedBytes);
            }
            return this._getCheckedSharedGlossarySlice(dictionary, inflatedBytes, glossaryOffset, glossaryLength);
        } finally {
            if (this._sharedGlossaryArtifactInflatePromiseByDictionary.get(dictionary) === promise) {
                this._sharedGlossaryArtifactInflatePromiseByDictionary.delete(dictionary);
            }
        }
    }

    /** */
    _clearSharedGlossaryArtifactCaches() {
        ++this._sharedGlossaryArtifactGeneration;
        this._sharedGlossaryArtifactMetaByDictionary.clear();
        this._sharedGlossaryArtifactInflatedByDictionary.clear();
        this._sharedGlossaryArtifactInflatePromiseByDictionary.clear();
    }

    /**
     * @param {string} dictionary
     * @param {Uint8Array} bytes
     * @param {number} offset
     * @param {number} length
     * @returns {Uint8Array}
     */
    _getCheckedSharedGlossarySlice(dictionary, bytes, offset, length) {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 0 ||
            offset > bytes.byteLength ||
            length > bytes.byteLength - offset
        ) {
            throw new RangeError(
                `Shared glossary span is out of bounds for ${dictionary}: ` +
                `offset=${offset} length=${length} bytes=${bytes.byteLength}`,
            );
        }
        return bytes.subarray(offset, offset + length);
    }

    /**
     * @param {Iterable<string>} dictionaries
     * @returns {Promise<void>}
     */
    async _warmSharedGlossaryArtifacts(dictionaries) {
        for (const dictionary of dictionaries) {
            const meta = this._getSharedGlossaryArtifactMeta(dictionary);
            if (
                meta === null ||
                meta.contentDictName !== RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME ||
                this._sharedGlossaryArtifactInflatedByDictionary.has(dictionary)
            ) {
                continue;
            }
            try {
                await this._readCompressedSharedGlossarySlice(dictionary, 0, 0);
            } catch (error) {
                reportDiagnostics('dictionary-shared-glossary-warm-error', {
                    dictionary,
                    error: `${error}`,
                });
            }
        }
    }

    /**
     * @param {string} dictionary
     * @returns {Promise<Uint8Array>}
     */
    async _inflateSharedGlossaryArtifact(dictionary) {
        const meta = this._getSharedGlossaryArtifactMeta(dictionary);
        if (meta === null || meta.contentOffset < 0 || meta.contentLength <= 0) {
            return new Uint8Array(0);
        }
        const readResult = await this._termContentBlockStore.readDetailed(meta.contentOffset, meta.contentLength, 'raw');
        if (readResult.status !== 'ok') {
            throw new TermContentLookupReadError(readResult.status, readResult.reason);
        }
        const compressedBytes = readResult.bytes;
        let inflatedBytes = compressedBytes;
        if (meta.contentDictName === RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME) {
            const defaultHeapSize = meta.uncompressedLength > 0 ? meta.uncompressedLength : (compressedBytes.byteLength * 16);
            try {
                inflatedBytes = zstdDecompress(compressedBytes, {defaultHeapSize});
            } catch (error) {
                throw new TermContentLookupReadError('corrupt', 'Shared glossary decompression failed', {cause: error});
            }
        }
        if (meta.uncompressedLength > 0 && inflatedBytes.byteLength !== meta.uncompressedLength) {
            throw new TermContentLookupReadError(
                'corrupt',
                `Shared glossary decoded length mismatch: expected ${meta.uncompressedLength}, got ${inflatedBytes.byteLength}`,
            );
        }
        return inflatedBytes;
    }

    /**
     * @param {string} dictionary
     * @param {Uint8Array} bytes
     * @param {string} contentDictName
     * @param {number} uncompressedLength
     * @returns {Promise<{offset: number, length: number}>}
     */
    async appendRawSharedGlossaryArtifact(dictionary, bytes, contentDictName, uncompressedLength) {
        const spans = await this._termContentStore.appendBatch([bytes]);
        const span = spans.length > 0 ? spans[0] : {offset: 0, length: 0};
        const db = this._requireDb();
        db.exec({
            sql: `
                INSERT INTO sharedGlossaryArtifacts(dictionary, contentOffset, contentLength, contentDictName, uncompressedLength)
                VALUES($dictionary, $contentOffset, $contentLength, $contentDictName, $uncompressedLength)
                ON CONFLICT(dictionary) DO UPDATE SET
                    contentOffset = excluded.contentOffset,
                    contentLength = excluded.contentLength,
                    contentDictName = excluded.contentDictName,
                    uncompressedLength = excluded.uncompressedLength
            `,
            bind: {
                $dictionary: dictionary,
                $contentOffset: span.offset,
                $contentLength: span.length,
                $contentDictName: contentDictName,
                $uncompressedLength: Math.max(0, uncompressedLength),
            },
        });
        this._sharedGlossaryArtifactMetaByDictionary.set(dictionary, {
            contentOffset: span.offset,
            contentLength: span.length,
            contentDictName,
            uncompressedLength: Math.max(0, uncompressedLength),
        });
        ++this._sharedGlossaryArtifactGeneration;
        this._sharedGlossaryArtifactInflatedByDictionary.delete(dictionary);
        this._sharedGlossaryArtifactInflatePromiseByDictionary.delete(dictionary);
        return span;
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<{offset: number, length: number}>}
     */
    async appendMediaContentBytes(bytes) {
        const spans = await this._termContentStore.appendBatch([bytes]);
        return spans.length > 0 ? spans[0] : {offset: 0, length: 0};
    }

    /**
     * @param {Blob} blob
     * @returns {Promise<{offset: number, length: number}>}
     */
    async appendMediaContentBlob(blob) {
        return await this._termContentStore.appendBlob(blob);
    }

    /**
     * @returns {Promise<void>}
     */
    async flushMediaContentImportWrites() {
        await this._termContentStore.flushImportWrites();
    }

    /**
     * Lets residual term/media content persist while the importer processes
     * metadata and finalizes the dictionary descriptor.
     * @returns {Promise<void>}
     */
    async queuePendingTermContentImportWrites() {
        await this._termContentStore.queuePendingImportWrites();
    }

    /**
     * @param {import('dictionary-database').MediaDataArrayBufferContent[]} items
     * @returns {Promise<void>}
     */
    async bulkAddExternalMediaRows(items) {
        const db = this._requireDb();
        if (items.length === 0) { return; }
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        if (useLocalTransaction) {
            await this._beginImmediateTransaction(db);
        }
        try {
            for (let i = 0, ii = items.length; i < ii; i += EXTERNAL_MEDIA_BULK_INSERT_BATCH_SIZE) {
                const chunkCount = Math.min(EXTERNAL_MEDIA_BULK_INSERT_BATCH_SIZE, ii - i);
                /** @type {string[]} */
                const valueRows = [];
                /** @type {import('@sqlite.org/sqlite-wasm').Bindable[]} */
                const bind = [];
                for (let j = 0; j < chunkCount; ++j) {
                    const row = items[i + j];
                    valueRows.push('(?, ?, ?, ?, ?, x\'\', ?, ?, ?, ?)');
                    bind.push(
                        row.dictionary,
                        row.path,
                        row.mediaType,
                        row.width,
                        row.height,
                        typeof row.contentOffset === 'number' ? row.contentOffset : 0,
                        typeof row.contentLength === 'number' ? row.contentLength : 0,
                        typeof row.contentCompressionMethod === 'number' ? row.contentCompressionMethod : ZIP_COMPRESSION_METHOD_STORE,
                        typeof row.contentUncompressedLength === 'number' ? row.contentUncompressedLength : (typeof row.contentLength === 'number' ? row.contentLength : 0),
                    );
                }
                const sql = 'INSERT INTO media(dictionary, path, mediaType, width, height, content, contentOffset, contentLength, contentCompressionMethod, contentUncompressedLength) VALUES ' + valueRows.join(',');
                const stmt = this._getCachedStatement(sql);
                stmt.reset(true);
                stmt.bind(bind);
                stmt.step();
            }
            if (useLocalTransaction) {
                db.exec('COMMIT');
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {string} dictionary
     * @param {Array<{path: string, mediaType: string, packedOffset: number, packedLength: number, compressionMethod?: number, uncompressedLength?: number}>} items
     * @param {number} baseOffset
     * @param {boolean} preserveCompressedMedia
     * @returns {Promise<void>}
     */
    async bulkAddExternalMediaManifestRows(dictionary, items, baseOffset, preserveCompressedMedia = false) {
        const db = this._requireDb();
        if (items.length === 0) { return; }
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        if (useLocalTransaction) {
            await this._beginImmediateTransaction(db);
        }
        try {
            for (let i = 0, ii = items.length; i < ii; i += EXTERNAL_MEDIA_BULK_INSERT_BATCH_SIZE) {
                const chunkCount = Math.min(EXTERNAL_MEDIA_BULK_INSERT_BATCH_SIZE, ii - i);
                /** @type {string[]} */
                const valueRows = [];
                /** @type {import('@sqlite.org/sqlite-wasm').Bindable[]} */
                const bind = [];
                for (let j = 0; j < chunkCount; ++j) {
                    const row = items[i + j];
                    valueRows.push('(?, ?, ?, ?, ?, x\'\', ?, ?, ?, ?)');
                    const packedLength = row.packedLength;
                    bind.push(
                        dictionary,
                        row.path,
                        row.mediaType,
                        0,
                        0,
                        baseOffset + row.packedOffset,
                        packedLength,
                        preserveCompressedMedia ?
                            (typeof row.compressionMethod === 'number' ? row.compressionMethod : ZIP_COMPRESSION_METHOD_STORE) :
                            ZIP_COMPRESSION_METHOD_STORE,
                        preserveCompressedMedia ?
                            (typeof row.uncompressedLength === 'number' ? row.uncompressedLength : packedLength) :
                            packedLength,
                    );
                }
                const sql = 'INSERT INTO media(dictionary, path, mediaType, width, height, content, contentOffset, contentLength, contentCompressionMethod, contentUncompressedLength) VALUES ' + valueRows.join(',');
                const stmt = this._getCachedStatement(sql);
                stmt.reset(true);
                stmt.bind(bind);
                stmt.step();
            }
            if (useLocalTransaction) {
                db.exec('COMMIT');
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {{table: string, columnsSql: string, rowPlaceholderSql: string, batchSize: number, bindRow: (item: unknown) => import('@sqlite.org/sqlite-wasm').Bindable[]}} descriptor
     * @param {unknown[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async _bulkInsertWithDescriptor(descriptor, items, start, count) {
        const {table, columnsSql, rowPlaceholderSql, batchSize, bindRow} = descriptor;
        for (let i = start, ii = start + count; i < ii; i += batchSize) {
            const chunkCount = Math.min(batchSize, ii - i);
            /** @type {string[]} */
            const valueRows = [];
            /** @type {import('@sqlite.org/sqlite-wasm').Bindable[]} */
            const bind = [];
            for (let j = 0; j < chunkCount; ++j) {
                valueRows.push(rowPlaceholderSql);
                const rowBind = bindRow(items[i + j]);
                for (const value of rowBind) {
                    bind.push(value);
                }
            }
            const sql = `INSERT INTO ${table}(${columnsSql}) VALUES ${valueRows.join(',')}`;
            const stmt = this._getCachedStatement(sql);
            stmt.reset(true);
            stmt.bind(bind);
            stmt.step();
        }
    }

    /**
     * @param {import('dictionary-database').ObjectStoreName} objectStoreName
     * @returns {{table: string, columnsSql: string, rowPlaceholderSql: string, batchSize: number, bindRow: (item: unknown) => import('@sqlite.org/sqlite-wasm').Bindable[]}}
     * @throws {Error}
     */
    _getBulkInsertDescriptor(objectStoreName) {
        switch (objectStoreName) {
            case 'dictionaries':
                return {
                    table: 'dictionaries',
                    columnsSql: 'title, version, summaryJson',
                    rowPlaceholderSql: '(?, ?, ?)',
                    batchSize: 256,
                    bindRow: (item) => {
                        const summary = /** @type {import('dictionary-importer').Summary} */ (item);
                        return [summary.title, summary.version, JSON.stringify(summary)];
                    },
                };
            case 'termMeta':
                return {
                    table: 'termMeta',
                    columnsSql: 'dictionary, expression, mode, dataJson',
                    rowPlaceholderSql: '(?, ?, ?, ?)',
                    batchSize: 2048,
                    bindRow: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseTermMeta} */ (item);
                        return [row.dictionary, row.expression, row.mode, JSON.stringify(row.data)];
                    },
                };
            case 'kanji':
                return {
                    table: 'kanji',
                    columnsSql: 'dictionary, character, onyomi, kunyomi, tags, meaningsJson, statsJson',
                    rowPlaceholderSql: '(?, ?, ?, ?, ?, ?, ?)',
                    batchSize: 1024,
                    bindRow: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseKanjiEntry} */ (item);
                        return [
                            row.dictionary,
                            row.character,
                            row.onyomi,
                            row.kunyomi,
                            row.tags,
                            JSON.stringify(row.meanings),
                            typeof row.stats !== 'undefined' ? JSON.stringify(row.stats) : null,
                        ];
                    },
                };
            case 'kanjiMeta':
                return {
                    table: 'kanjiMeta',
                    columnsSql: 'dictionary, character, mode, dataJson',
                    rowPlaceholderSql: '(?, ?, ?, ?)',
                    batchSize: 2048,
                    bindRow: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseKanjiMeta} */ (item);
                        return [row.dictionary, row.character, row.mode, JSON.stringify(row.data)];
                    },
                };
            case 'tagMeta':
                return {
                    table: 'tagMeta',
                    columnsSql: 'dictionary, name, category, ord, notes, score',
                    rowPlaceholderSql: '(?, ?, ?, ?, ?, ?)',
                    batchSize: 2048,
                    bindRow: (item) => {
                        const row = /** @type {import('dictionary-database').Tag} */ (item);
                        return [row.dictionary, row.name, row.category, row.order, row.notes, row.score];
                    },
                };
            case 'media':
                return {
                    table: 'media',
                    columnsSql: 'dictionary, path, mediaType, width, height, content, contentOffset, contentLength, contentCompressionMethod, contentUncompressedLength',
                    rowPlaceholderSql: '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    batchSize: 8,
                    bindRow: (item) => {
                        const row = /** @type {import('dictionary-database').MediaDataArrayBufferContent} */ (item);
                        return [
                            row.dictionary,
                            row.path,
                            row.mediaType,
                            row.width,
                            row.height,
                            row.content,
                            typeof row.contentOffset === 'number' ? row.contentOffset : 0,
                            typeof row.contentLength === 'number' ? row.contentLength : 0,
                            typeof row.contentCompressionMethod === 'number' ? row.contentCompressionMethod : ZIP_COMPRESSION_METHOD_STORE,
                            typeof row.contentUncompressedLength === 'number' ? row.contentUncompressedLength : (typeof row.contentLength === 'number' ? row.contentLength : 0),
                        ];
                    },
                };
            default:
                throw new Error(`Unsupported object store: ${objectStoreName}`);
        }
    }

    /**
     * @template {import('dictionary-database').ObjectStoreName} T
     * @param {T} objectStoreName
     * @param {import('dictionary-database').ObjectStoreData<T>} item
     * @returns {Promise<number>}
     */
    async addWithResult(objectStoreName, item) {
        await this.bulkAdd(objectStoreName, [item], 0, 1);
        const db = this._requireDb();
        if (objectStoreName === 'dictionaries') {
            const summary = /** @type {import('dictionary-importer').Summary} */ (item);
            this._registerTermRecordStorageName(
                summary.title,
                this._getSummaryTermRecordStorageName(summary, summary.title),
            );
        }
        return this._asNumber(db.selectValue('SELECT last_insert_rowid()'), -1);
    }

    /**
     * Removes only the pre-transaction summary placeholder for a failed import.
     * @param {number} primaryKey
     */
    async deleteDictionaryImportPlaceholder(primaryKey) {
        if (!Number.isSafeInteger(primaryKey) || primaryKey < 0) { return; }
        const db = this._requireDb();
        await this._beginImmediateTransaction(db);
        try {
            db.exec({sql: 'DELETE FROM dictionaries WHERE id = $id', bind: {$id: primaryKey}});
            db.exec('COMMIT');
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            throw error;
        }
    }

    /**
     * @template {import('dictionary-database').ObjectStoreName} T
     * @param {T} objectStoreName
     * @param {import('dictionary-database').DatabaseUpdateItem[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async bulkUpdate(objectStoreName, items, start, count) {
        const db = this._requireDb();

        if (start + count > items.length) {
            count = items.length - start;
        }
        if (count <= 0) { return; }

        switch (objectStoreName) {
            case 'dictionaries':
                break;
            default:
                throw new Error(`Unsupported bulkUpdate store: ${objectStoreName}`);
        }

        const stmt = this._getCachedStatement('UPDATE dictionaries SET title = $title, version = $version, summaryJson = $summaryJson WHERE id = $id');
        const useLocalTransaction = !this._bulkImportTransactionOpen;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(db);
        }
        try {
            for (let i = start, ii = start + count; i < ii; ++i) {
                const {data, primaryKey} = items[i];
                const summary = /** @type {import('dictionary-importer').Summary} */ (data);
                stmt.reset(true);
                stmt.bind({
                    $id: this._asNumber(primaryKey, -1),
                    $title: summary.title,
                    $version: summary.version,
                    $summaryJson: JSON.stringify(summary),
                });
                stmt.step();
            }
            if (useLocalTransaction) {
                db.exec('COMMIT');
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {import('dictionary-database').ObjectStoreData<'terms'>[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async _bulkAddTerms(items, start, count) {
        if (!this._enableTermEntryContentDedup) {
            await this._bulkAddTermsWithoutContentDedup(items, start, count);
            return;
        }
        if (!this._termContentZstdInitialized) {
            await initializeTermContentZstd();
            this._termContentZstdInitialized = true;
        }
        const db = this._requireDb();
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        const tBulkStart = safePerformance.now();
        let lastProgressLog = tBulkStart;
        let computeContentMs = 0;
        let compressContentMs = 0;
        let appendContentMs = 0;
        let insertContentSqlMs = 0;
        let insertTermsSqlMs = 0;
        let insertTermRecordAppendMs = 0;
        let insertTermsVtabMs = 0;
        let commitMs = 0;
        let appendedContentBytes = 0;
        let resolvedFromCacheCount = 0;
        let minAssignedContentOffset = Number.POSITIVE_INFINITY;
        let maxAssignedContentEnd = -1;
        let maxObservedStoreLengthBeforeAppend = -1;
        let maxObservedStoreLengthAfterAppend = -1;
        /** @type {number[]} */
        const contentBatchDurationsMs = [];
        /** @type {number[]} */
        const termBatchDurationsMs = [];
        /** @type {number[]} */
        const termBatchRowsPerSecond = [];
        let failFastConsecutiveLowThroughputWindows = 0;
        const termBatchSize = this._getTermBulkAddBatchSizeForCount(count);
        const stagingBatchSize = Math.max(512, Math.min(this._termBulkAddStagingMaxRows, termBatchSize));
        const contentBatchSize = 8192;
        const shouldDedupWithinBatch = !this._skipIntraBatchContentDedup;
        let processedRowCount = 0;
        let insertedRowCount = 0;
        let totalPendingContentUniqueCount = 0;
        const compressionDictName = count > 0 ? resolveTermContentZstdDictName((/** @type {import('dictionary-database').DatabaseTermEntry} */ (items[start])).dictionary) : null;

        /** @type {import('dictionary-database').DatabaseTermEntry[]} */
        let stagedRows = [];
        /** @type {number[]} */
        let stagedPendingContentIndexes = [];
        /** @type {number[]} */
        let stagedContentOffsets = [];
        /** @type {number[]} */
        let stagedContentLengths = [];
        /** @type {(string|null)[]} */
        let stagedContentDictNames = [];
        /** @type {(string|null)[]} */
        let pendingContentHashes = [];
        /** @type {number[]} */
        let pendingContentHash1s = [];
        /** @type {number[]} */
        let pendingContentHash2s = [];
        /** @type {Uint8Array[]} */
        let pendingContentBytes = [];
        /** @type {Map<string, number>|null} */
        let pendingContentRowIndexByHash = shouldDedupWithinBatch ? new Map() : null;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(db);
        }
        try {
            const flushStagedRows = async () => {
                if (stagedRows.length === 0) {
                    stagedPendingContentIndexes = [];
                    stagedContentOffsets = [];
                    stagedContentLengths = [];
                    stagedContentDictNames = [];
                    pendingContentHashes = [];
                    pendingContentHash1s = [];
                    pendingContentHash2s = [];
                    pendingContentBytes = [];
                    if (pendingContentRowIndexByHash !== null) {
                        pendingContentRowIndexByHash.clear();
                    }
                    return;
                }

                if (pendingContentBytes.length > 0) {
                    totalPendingContentUniqueCount += pendingContentBytes.length;
                    const tCompressStart = safePerformance.now();
                    const storageChunks = this._createTermContentStorageChunks(
                        pendingContentBytes,
                        compressionDictName,
                        stagedRows.map((row, index) => {
                            const pendingIndex = stagedPendingContentIndexes[index];
                            return pendingIndex >= 0 ? (row.termEntryContentDictName ?? null) : null;
                        }),
                    );
                    compressContentMs += safePerformance.now() - tCompressStart;
                    if (this._importDebugLogging) {
                        const debugStateBeforeAppend = this._termContentStore.getDebugState();
                        maxObservedStoreLengthBeforeAppend = Math.max(
                            maxObservedStoreLengthBeforeAppend,
                            this._asNumber(debugStateBeforeAppend?.totalLength, -1),
                        );
                    }
                    const tAppendStart = safePerformance.now();
                    const spans = await this._termContentStore.appendBatch(storageChunks.storedChunks);
                    for (const chunk of storageChunks.storedChunks) {
                        appendedContentBytes += chunk.byteLength;
                    }
                    appendContentMs += safePerformance.now() - tAppendStart;
                    if (this._importDebugLogging) {
                        const debugStateAfterAppend = this._termContentStore.getDebugState();
                        maxObservedStoreLengthAfterAppend = Math.max(
                            maxObservedStoreLengthAfterAppend,
                            this._asNumber(debugStateAfterAppend?.totalLength, -1),
                        );
                    }

                    for (let i = 0, ii = stagedRows.length; i < ii; ++i) {
                        const pendingIndex = stagedPendingContentIndexes[i];
                        if (pendingIndex < 0) { continue; }
                        const span = spans[storageChunks.entryToStoredChunkIndexes[pendingIndex]];
                        if (typeof span === 'undefined') {
                            throw new Error('Failed to resolve staged term entry content span for bulk term insert');
                        }
                        const localOffset = storageChunks.entryToStoredChunkOffsets[pendingIndex] ?? 0;
                        stagedPendingContentIndexes[i] = -1;
                        stagedContentOffsets[i] = span.offset + localOffset;
                        stagedContentLengths[i] = pendingContentBytes[pendingIndex].byteLength;
                        stagedContentDictNames[i] = storageChunks.contentDictNames[pendingIndex] ?? 'raw';
                        if (stagedContentLengths[i] > 0) {
                            if (stagedContentOffsets[i] < minAssignedContentOffset) {
                                minAssignedContentOffset = stagedContentOffsets[i];
                            }
                            const spanEnd = stagedContentOffsets[i] + stagedContentLengths[i];
                            if (spanEnd > maxAssignedContentEnd) {
                                maxAssignedContentEnd = spanEnd;
                            }
                        }
                    }

                    this._ensureTermEntryContentMetaHashPairCapacity(
                        this._termEntryContentMetaHashPairCount + pendingContentBytes.length,
                    );
                    for (let i = 0, ii = pendingContentBytes.length; i < ii; i += contentBatchSize) {
                        const chunkCount = Math.min(contentBatchSize, ii - i);
                        const tContentSqlStart = safePerformance.now();
                        for (let j = i, jj = i + chunkCount; j < jj; ++j) {
                            const span = spans[storageChunks.entryToStoredChunkIndexes[j]];
                            const localOffset = storageChunks.entryToStoredChunkOffsets[j] ?? 0;
                            const contentDictName = storageChunks.contentDictNames[j];
                            const storedChunk = storageChunks.storedChunks[storageChunks.entryToStoredChunkIndexes[j]];
                            const exactContentBytes = contentDictName === 'raw' ?
                                storedChunk.subarray(localOffset, localOffset + pendingContentBytes[j].byteLength) :
                                pendingContentBytes[j];
                            this._cacheTermEntryContentMeta(
                                pendingContentHashes[j],
                                span.offset + localOffset,
                                pendingContentBytes[j].byteLength,
                                contentDictName,
                                0,
                                pendingContentHash1s[j],
                                pendingContentHash2s[j],
                                exactContentBytes,
                            );
                        }
                        const contentBatchMs = safePerformance.now() - tContentSqlStart;
                        insertContentSqlMs += contentBatchMs;
                        contentBatchDurationsMs.push(contentBatchMs);
                    }
                }

                for (let i = 0, ii = stagedRows.length; i < ii; i += termBatchSize) {
                    const chunkCount = Math.min(termBatchSize, ii - i);
                    const tTermSqlStart = safePerformance.now();
                    const split = await this._insertResolvedImportTermEntries(stagedRows, stagedContentOffsets, stagedContentLengths, stagedContentDictNames, i, chunkCount);
                    const termBatchMs = safePerformance.now() - tTermSqlStart;
                    insertTermsSqlMs += termBatchMs;
                    insertTermRecordAppendMs += split.termRecordAppendMs;
                    insertTermsVtabMs += split.termsVtabInsertMs;
                    termBatchDurationsMs.push(termBatchMs);

                    const batchRowsPerSecond = termBatchMs > 0 ? ((chunkCount * 1000) / termBatchMs) : 0;
                    termBatchRowsPerSecond.push(batchRowsPerSecond);
                    insertedRowCount += chunkCount;
                    if (this._importDebugLogging && termBatchMs >= this._termBulkAddFailFastSlowBatchMs) {
                        throw new Error(`term batch stalled: rows=${chunkCount} elapsed=${termBatchMs.toFixed(1)}ms`);
                    }

                    if (this._importDebugLogging && termBatchRowsPerSecond.length >= this._termBulkAddFailFastWindowSize) {
                        const windowStart = termBatchRowsPerSecond.length - this._termBulkAddFailFastWindowSize;
                        const window = termBatchRowsPerSecond.slice(windowStart);
                        const windowAverageRowsPerSecond = window.reduce((sum, value) => sum + value, 0) / window.length;
                        if (insertedRowCount >= this._termBulkAddFailFastMinRowsBeforeCheck && windowAverageRowsPerSecond < this._termBulkAddFailFastMinRowsPerSecond) {
                            ++failFastConsecutiveLowThroughputWindows;
                            if (failFastConsecutiveLowThroughputWindows >= 3) {
                                throw new Error(
                                    `term batch throughput degraded: window_avg_rps=${windowAverageRowsPerSecond.toFixed(1)} ` +
                                    `threshold=${this._termBulkAddFailFastMinRowsPerSecond.toFixed(1)} rows=${insertedRowCount}/${count}`,
                                );
                            }
                        } else {
                            failFastConsecutiveLowThroughputWindows = 0;
                        }
                    }
                }

                stagedRows = [];
                stagedPendingContentIndexes = [];
                stagedContentOffsets = [];
                stagedContentLengths = [];
                stagedContentDictNames = [];
                pendingContentHashes = [];
                pendingContentHash1s = [];
                pendingContentHash2s = [];
                pendingContentBytes = [];
                pendingContentRowIndexByHash = shouldDedupWithinBatch ? new Map() : null;
            };

            for (let i = start, ii = start + count; i < ii; ++i) {
                ++processedRowCount;
                const row = /** @type {import('dictionary-database').DatabaseTermEntry} */ (items[i]);
                const tComputeStart = safePerformance.now();
                const precomputedHash = (typeof row.termEntryContentHash === 'string' && row.termEntryContentHash.length > 0) ? row.termEntryContentHash : null;
                const precomputedHash1 = Number.isInteger(row.termEntryContentHash1) ? (/** @type {number} */ (row.termEntryContentHash1) >>> 0) : -1;
                const precomputedHash2 = Number.isInteger(row.termEntryContentHash2) ? (/** @type {number} */ (row.termEntryContentHash2) >>> 0) : -1;
                const precomputedBytes = row.termEntryContentBytes instanceof Uint8Array ? row.termEntryContentBytes : this._getRawTermContentBytesIfAvailable(row);
                let contentHash = precomputedHash;
                let contentHash1 = precomputedHash1;
                let contentHash2 = precomputedHash2;
                let contentBytes = precomputedBytes;
                if (contentBytes === null) {
                    const rules = row.rules;
                    const definitionTags = row.definitionTags ?? row.tags ?? '';
                    const termTags = row.termTags ?? '';
                    const contentJson = row.termEntryContentJson ?? this._serializeTermEntryContent(rules, definitionTags, termTags, row.glossary);
                    contentBytes = this._textEncoder.encode(contentJson);
                }
                if (contentHash1 < 0 || contentHash2 < 0) {
                    const hashPair = contentHash !== null ? parseContentHashHexPair(contentHash) : null;
                    if (hashPair !== null) {
                        [contentHash1, contentHash2] = hashPair;
                    } else {
                        [contentHash1, contentHash2] = hashTermEntryContentBytesPair(contentBytes);
                    }
                }
                contentHash = contentHash ?? hashPairToHex(contentHash1, contentHash2);
                computeContentMs += safePerformance.now() - tComputeStart;

                let existingMeta = this._findMatchingTermEntryContentMeta(contentHash1, contentHash2, contentBytes);
                if (existingMeta instanceof Promise) {
                    existingMeta = await existingMeta;
                }
                if (typeof existingMeta !== 'undefined') {
                    ++resolvedFromCacheCount;
                    stagedRows.push(row);
                    stagedPendingContentIndexes.push(-1);
                    stagedContentOffsets.push(existingMeta.offset);
                    stagedContentLengths.push(existingMeta.length);
                    stagedContentDictNames.push(existingMeta.dictName);
                    continue;
                }

                let pendingContentIndex = -1;
                if (pendingContentRowIndexByHash !== null && contentHash !== null) {
                    const existingPendingContentIndex = pendingContentRowIndexByHash.get(contentHash);
                    if (
                        typeof existingPendingContentIndex === 'number' &&
                        this._termContentBytesEqual(pendingContentBytes[existingPendingContentIndex], contentBytes)
                    ) {
                        pendingContentIndex = existingPendingContentIndex;
                    }
                }
                if (pendingContentIndex < 0) {
                    const tCompressStart = safePerformance.now();
                    compressContentMs += safePerformance.now() - tCompressStart;
                    pendingContentIndex = pendingContentBytes.length;
                    if (pendingContentRowIndexByHash !== null && contentHash !== null) {
                        pendingContentRowIndexByHash.set(contentHash, pendingContentIndex);
                    }
                    pendingContentHashes.push(contentHash);
                    pendingContentHash1s.push(contentHash1);
                    pendingContentHash2s.push(contentHash2);
                    pendingContentBytes.push(contentBytes);
                }

                stagedRows.push(row);
                stagedPendingContentIndexes.push(pendingContentIndex);
                stagedContentOffsets.push(-1);
                stagedContentLengths.push(-1);
                stagedContentDictNames.push(null);

                const tNow = safePerformance.now();
                if (this._importDebugLogging && (tNow - lastProgressLog) >= this._termBulkAddLogIntervalMs) {
                    lastProgressLog = tNow;
                    log.log(
                        `[manabitan-db-import] bulkAdd terms progress rows=${processedRowCount}/${count} ` +
                        `cached=${resolvedFromCacheCount} pendingUnique=${pendingContentBytes.length}`,
                    );
                }

                if (stagedRows.length >= stagingBatchSize) {
                    await flushStagedRows();
                }
            }
            await flushStagedRows();
            if (useLocalTransaction) {
                const tCommitStart = safePerformance.now();
                db.exec('COMMIT');
                commitMs = safePerformance.now() - tCommitStart;
            }
            if (this._importDebugLogging) {
                const totalMs = safePerformance.now() - tBulkStart;
                const rowsPerSecond = totalMs > 0 ? ((count * 1000) / totalMs) : 0;
                const bytesPerSecond = totalMs > 0 ? ((appendedContentBytes * 1000) / totalMs) : 0;
                const avgTermBatchMs = this._average(termBatchDurationsMs);
                const p95TermBatchMs = this._p95(termBatchDurationsMs);
                const avgContentBatchMs = this._average(contentBatchDurationsMs);
                const p95ContentBatchMs = this._p95(contentBatchDurationsMs);
                log.log(
                    `[manabitan-db-import] bulkAdd terms done rows=${count} total=${totalMs.toFixed(1)}ms ` +
                    `compute=${computeContentMs.toFixed(1)}ms compress=${compressContentMs.toFixed(1)}ms ` +
                    `append=${appendContentMs.toFixed(1)}ms contentSql=${insertContentSqlMs.toFixed(1)}ms ` +
                    `termsSql=${insertTermsSqlMs.toFixed(1)}ms termRecordAppend=${insertTermRecordAppendMs.toFixed(1)}ms ` +
                    `termsVtabInsert=${insertTermsVtabMs.toFixed(1)}ms commit=${commitMs.toFixed(1)}ms ` +
                    `intraBatchDedup=${String(shouldDedupWithinBatch)} ` +
                    `recordFastPath=${String(this._termRecordRowAppendFastPath)} ` +
                    `stagingBatchSize=${stagingBatchSize} ` +
                    `cached=${resolvedFromCacheCount} newUnique=${totalPendingContentUniqueCount} ` +
                    `assignedMinOffset=${Number.isFinite(minAssignedContentOffset) ? minAssignedContentOffset : -1} ` +
                    `assignedMaxEnd=${maxAssignedContentEnd} ` +
                    `storeLengthBeforeAppendMax=${maxObservedStoreLengthBeforeAppend} ` +
                    `storeLengthAfterAppendMax=${maxObservedStoreLengthAfterAppend} ` +
                    `rps=${rowsPerSecond.toFixed(1)} bps=${bytesPerSecond.toFixed(1)} ` +
                    `termBatchAvg=${avgTermBatchMs.toFixed(1)}ms termBatchP95=${p95TermBatchMs.toFixed(1)}ms ` +
                    `contentBatchAvg=${avgContentBatchMs.toFixed(1)}ms contentBatchP95=${p95ContentBatchMs.toFixed(1)}ms`,
                );
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').Bindable[][]} rows
     * @param {number} start
     * @param {number} count
     * @returns {Promise<{termRecordAppendMs: number, termsVtabInsertMs: number}>}
     */
    async _insertResolvedTermRows(rows, start, count) {
        const tRecordAppendStart = safePerformance.now();
        if (this._termRecordRowAppendFastPath) {
            await this._termRecordStore.appendBatchFromTermRows(rows, start, count);
        } else {
            /** @type {{dictionary: string, expression: string, reading: string, expressionReverse: string|null, readingReverse: string|null, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, score: number, sequence: number|null}[]} */
            const records = [];
            for (let i = start, ii = start + count; i < ii; ++i) {
                const row = rows[i];
                records.push({
                    dictionary: this._asString(row[0]),
                    expression: this._asString(row[1]),
                    reading: this._asString(row[2]),
                    expressionReverse: this._asNullableString(row[3]) ?? null,
                    readingReverse: this._asNullableString(row[4]) ?? null,
                    entryContentOffset: this._asNumber(row[6], -1),
                    entryContentLength: this._asNumber(row[7], -1),
                    entryContentDictName: this._asNullableString(row[8]),
                    score: this._asNumber(row[12], 0),
                    sequence: this._asNullableNumber(row[14]) ?? null,
                });
            }
            await this._termRecordStore.appendBatch(records);
        }
        const termRecordAppendMs = safePerformance.now() - tRecordAppendStart;
        let termsVtabInsertMs = 0;
        const deferVirtualTableWrite = this._deferTermsVirtualTableSync || this._isBulkImportInProgress();
        if (deferVirtualTableWrite) {
            this._termsVirtualTableDirty = true;
        } else {
            const tVtabStart = safePerformance.now();
            await this._insertTermRowsIntoVirtualTable(count);
            termsVtabInsertMs = safePerformance.now() - tVtabStart;
        }
        return {termRecordAppendMs, termsVtabInsertMs};
    }

    /**
     * @param {import('dictionary-database').DatabaseTermEntry[]} rows
     * @param {number[]} contentOffsets
     * @param {number[]} contentLengths
     * @param {(string|null)[]} contentDictNames
     * @param {number} start
     * @param {number} count
     * @returns {Promise<{termRecordAppendMs: number, termRecordEncodeMs: number, termRecordWriteMs: number, termsVtabInsertMs: number}>}
     */
    async _insertResolvedImportTermEntries(rows, contentOffsets, contentLengths, contentDictNames, start, count) {
        const tRecordAppendStart = safePerformance.now();
        let termRecordEncodeMs = 0;
        let termRecordWriteMs = 0;
        const termRecordPreinternedPlan = sliceTermRecordPreinternedPlan(getTermRecordPreinternedPlan(rows), start, count);
        if (this._termRecordRowAppendFastPath) {
            const metrics = await this._termRecordStore.appendBatchFromResolvedImportTermEntries(
                rows,
                start,
                count,
                contentOffsets,
                contentLengths,
                contentDictNames,
                termRecordPreinternedPlan,
            );
            termRecordEncodeMs = metrics.encodeMs;
            termRecordWriteMs = metrics.appendWriteMs;
        } else {
            /** @type {{dictionary: string, expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, expressionReverse: string|null, readingReverse: string|null, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, score: number, sequence: number|null}[]} */
            const records = [];
            for (let i = start, ii = start + count; i < ii; ++i) {
                const row = rows[i];
                records.push({
                    dictionary: row.dictionary,
                    expression: row.expression,
                    reading: row.reading,
                    expressionBytes: row.expressionBytes,
                    readingBytes: row.readingBytes,
                    expressionReverse: row.expressionReverse ?? null,
                    readingReverse: row.readingReverse ?? null,
                    entryContentOffset: contentOffsets[i],
                    entryContentLength: contentLengths[i],
                    entryContentDictName: contentDictNames[i],
                    score: row.score,
                    sequence: typeof row.sequence === 'number' ? row.sequence : null,
                });
            }
            await this._termRecordStore.appendBatch(records, termRecordPreinternedPlan);
        }
        const termRecordAppendMs = safePerformance.now() - tRecordAppendStart;
        let termsVtabInsertMs = 0;
        const deferVirtualTableWrite = this._deferTermsVirtualTableSync || this._isBulkImportInProgress();
        if (deferVirtualTableWrite) {
            this._termsVirtualTableDirty = true;
        } else {
            const tVtabStart = safePerformance.now();
            await this._insertTermRowsIntoVirtualTable(count);
            termsVtabInsertMs = safePerformance.now() - tVtabStart;
        }
        return {termRecordAppendMs, termRecordEncodeMs, termRecordWriteMs, termsVtabInsertMs};
    }

    /**
     * @param {number} count
     * @returns {Promise<void>}
     */
    async _insertTermRowsIntoVirtualTable(count) {
        this._termsVirtualTableDirty = count > 0;
    }

    /**
     * @param {{values: import('@sqlite.org/sqlite-wasm').Bindable[], contentKey: string|null}[]} rows
     * @throws {Error}
     */
    async _insertResolvedTermRowsWithContentKeys(rows) {
        for (const row of rows) {
            const {contentKey} = row;
            if (contentKey !== null) {
                const contentId = this._termEntryContentIdByKey.get(contentKey);
                if (typeof contentId !== 'number') {
                    throw new Error('Failed to resolve term entry content id for batched insert');
                }
                const meta = this._termEntryContentMetaByHash.get(contentKey);
                if (typeof meta === 'undefined') {
                    throw new Error('Failed to resolve term entry content metadata for batched insert');
                }
                row.values[5] = contentId;
                row.values[6] = meta.offset;
                row.values[7] = meta.length;
                row.values[8] = meta.dictName;
            }
        }
        await this._insertResolvedTermRows(rows.map((row) => row.values), 0, rows.length);
    }

    /** */
    _clearTermEntryContentMetaCaches() {
        this._termEntryContentMetaByHash.clear();
        this._termContentBlockStore.clearCache();
        this._termEntryContentMetaHashPairTable = new Uint32Array(0);
        this._termEntryContentMetaHash1Table = new Uint32Array(0);
        this._termEntryContentMetaHash2Table = new Uint32Array(0);
        this._termEntryContentMetaStateTable = new Uint8Array(0);
        this._termEntryContentMetaIdTable = new Float64Array(0);
        this._termEntryContentMetaOffsetTable = new Float64Array(0);
        this._termEntryContentMetaLengthTable = new Uint32Array(0);
        this._termEntryContentMetaDictNameIdTable = new Uint32Array(0);
        this._termEntryContentMetaSignaturePresentTable = new Uint8Array(0);
        this._termEntryContentMetaSignature1Table = new Uint32Array(0);
        this._termEntryContentMetaSignature2Table = new Uint32Array(0);
        this._termEntryContentMetaSignature3Table = new Uint32Array(0);
        this._termEntryContentMetaDictNameIdByValue = new Map([['raw', 0]]);
        this._termEntryContentMetaDictNames = ['raw'];
        this._termEntryContentMetaHashPairMask = 0;
        this._termEntryContentMetaHashPairCount = 0;
        this._termEntryContentMetaHashPairPendingCount = 0;
        this._termEntryContentMetaDenseCount = 0;
        this._termEntryContentMetaFreeIndexes.length = 0;
        this._termEntryContentMetaCollisionsByHashPair.clear();
    }

    /**
     * @param {Uint8Array} contentBytes
     * @param {number} offset
     * @returns {number}
     */
    _readTermContentSignature(contentBytes, offset) {
        return (
            (contentBytes[offset] ?? 0) |
            ((contentBytes[offset + 1] ?? 0) << 8) |
            ((contentBytes[offset + 2] ?? 0) << 16) |
            ((contentBytes[offset + 3] ?? 0) << 24)
        ) >>> 0;
    }

    /**
     * @param {{signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}} meta
     * @param {Uint8Array} contentBytes
     */
    _setTermContentSignatures(meta, contentBytes) {
        const lastOffset = Math.max(0, contentBytes.byteLength - 4);
        meta.signature1 = this._readTermContentSignature(contentBytes, 0);
        meta.signature2 = this._readTermContentSignature(contentBytes, Math.floor(lastOffset / 2));
        meta.signature3 = this._readTermContentSignature(contentBytes, lastOffset);
        const index = meta.tableIndex;
        if (
            typeof index === 'number' &&
            this._termEntryContentMetaStateTable[index] === TERM_CONTENT_META_SLOT_PUBLISHED
        ) {
            this._termEntryContentMetaSignaturePresentTable[index] = 1;
            this._termEntryContentMetaSignature1Table[index] = meta.signature1;
            this._termEntryContentMetaSignature2Table[index] = meta.signature2;
            this._termEntryContentMetaSignature3Table[index] = meta.signature3;
        }
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {boolean}
     * @throws {TypeError} If either input is not a byte array.
     */
    _termContentBytesEqual(a, b) {
        if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
            throw new TypeError('Term content byte comparison requires Uint8Array inputs');
        }
        if (a.byteLength !== b.byteLength) { return false; }
        let i = 0;
        const length = a.byteLength;
        const unrolledLength = length & ~7;
        for (; i < unrolledLength; i += 8) {
            if (
                a[i] !== b[i] ||
                a[i + 1] !== b[i + 1] ||
                a[i + 2] !== b[i + 2] ||
                a[i + 3] !== b[i + 3] ||
                a[i + 4] !== b[i + 4] ||
                a[i + 5] !== b[i + 5] ||
                a[i + 6] !== b[i + 6] ||
                a[i + 7] !== b[i + 7]
            ) {
                return false;
            }
        }
        for (; i < length; ++i) {
            if (a[i] !== b[i]) { return false; }
        }
        return true;
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} buffer
     * @param {number} offset
     * @param {number} length
     * @returns {boolean}
     */
    _termContentBytesEqualSpan(a, buffer, offset, length) {
        if (a.byteLength !== length) { return false; }
        let i = 0;
        const unrolledLength = length & ~7;
        for (; i < unrolledLength; i += 8) {
            const j = offset + i;
            if (
                a[i] !== buffer[j] ||
                a[i + 1] !== buffer[j + 1] ||
                a[i + 2] !== buffer[j + 2] ||
                a[i + 3] !== buffer[j + 3] ||
                a[i + 4] !== buffer[j + 4] ||
                a[i + 5] !== buffer[j + 5] ||
                a[i + 6] !== buffer[j + 6] ||
                a[i + 7] !== buffer[j + 7]
            ) {
                return false;
            }
        }
        for (; i < length; ++i) {
            if (a[i] !== buffer[offset + i]) { return false; }
        }
        return true;
    }

    /**
     * The hash pair selects candidates. Length and three fixed-position words
     * isolate collisions in the streaming hot path without retaining content.
     * Persisted rows without signatures receive a one-time exact comparison.
     * @param {number} hash1
     * @param {number} hash2
     * @param {Uint8Array} contentBytes
     * @param {{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}|undefined} [primary]
     * @returns {{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}|Promise<{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}|undefined>|undefined}
     */
    _findMatchingTermEntryContentMeta(hash1, hash2, contentBytes, primary = this._getTermEntryContentMetaByHashPair(hash1, hash2)) {
        const lastOffset = Math.max(0, contentBytes.byteLength - 4);
        const signature1 = this._readTermContentSignature(contentBytes, 0);
        const signature2 = this._readTermContentSignature(contentBytes, Math.floor(lastOffset / 2));
        const signature3 = this._readTermContentSignature(contentBytes, lastOffset);
        /** @type {Array<{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}>|null} */
        let persistedCandidates = null;
        if (typeof primary !== 'undefined' && primary.length === contentBytes.byteLength) {
            if (typeof primary.signature1 === 'number') {
                if (primary.signature1 === signature1 && primary.signature2 === signature2 && primary.signature3 === signature3) {
                    return primary;
                }
            } else if (this._canExactlyComparePersistedTermContent(primary.dictName)) {
                persistedCandidates = [primary];
            }
        }
        const collisions = this._termEntryContentMetaCollisionsByHashPair.size > 0 ?
            this._termEntryContentMetaCollisionsByHashPair.get(`${hash1 >>> 0}:${hash2 >>> 0}`) :
            void 0;
        if (typeof collisions !== 'undefined') {
            for (const meta of collisions) {
                if (meta.length !== contentBytes.byteLength) { continue; }
                if (typeof meta.signature1 === 'number') {
                    if (meta.signature1 === signature1 && meta.signature2 === signature2 && meta.signature3 === signature3) {
                        return meta;
                    }
                    continue;
                }
                if (!this._canExactlyComparePersistedTermContent(meta.dictName)) { continue; }
                if (persistedCandidates === null) { persistedCandidates = []; }
                persistedCandidates.push(meta);
            }
        }
        return persistedCandidates === null ?
            void 0 :
            this._findMatchingPersistedTermEntryContentMeta(persistedCandidates, contentBytes);
    }

    /**
     * @param {string} dictName
     * @returns {boolean}
     */
    _canExactlyComparePersistedTermContent(dictName) {
        return (
            dictName === 'raw' ||
            dictName === RAW_TERM_CONTENT_DICT_NAME ||
            dictName === RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME ||
            typeof getRawTermContentBlockCompressionDictName(dictName) !== 'undefined'
        );
    }

    /**
     * @param {Array<{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}>} candidates
     * @param {Uint8Array} contentBytes
     * @returns {Promise<{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number, tableIndex?: number}|undefined>}
     */
    async _findMatchingPersistedTermEntryContentMeta(candidates, contentBytes) {
        for (const meta of candidates) {
            const existingBytes = await this._readTermEntryContentBytes(meta.offset, meta.length, meta.dictName);
            if (!(existingBytes instanceof Uint8Array)) { continue; }
            this._setTermContentSignatures(meta, existingBytes);
            if (this._termContentBytesEqual(existingBytes, contentBytes)) { return meta; }
        }
        return void 0;
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<Uint8Array|null>}
     */
    async _readTermEntryContentBytes(contentOffset, contentLength, contentDictName) {
        return await this._termContentBlockStore.read(contentOffset, contentLength, contentDictName);
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<{status: 'ok', bytes: Uint8Array}|{status: 'temporarilyUnavailable'|'corrupt', reason: string}>}
     */
    async _readTermEntryContentBytesDetailed(contentOffset, contentLength, contentDictName) {
        return await this._termContentBlockStore.readDetailed(contentOffset, contentLength, contentDictName);
    }

    /**
     * Diagnostic-only content read which avoids exposing storage internals.
     * @param {number} contentOffset
     * @param {number} contentLength
     * @param {string} contentDictName
     * @returns {Promise<Uint8Array|null>}
     */
    async readTermEntryContentBytesForDiagnostics(contentOffset, contentLength, contentDictName) {
        return await this._readTermEntryContentBytes(contentOffset, contentLength, contentDictName);
    }

    /**
     * @param {number} contentOffset
     * @param {number} contentLength
     * @returns {Promise<Uint8Array|null>}
     */
    async readRawTermContentBytesForDiagnostics(contentOffset, contentLength) {
        return await this._termContentStore.readSlice(contentOffset, contentLength);
    }

    /**
     * @param {Iterable<string>} [dictionaryNames=[]]
     * @returns {{blockStore: Record<string, unknown>, opfsStore: Record<string, unknown>|null, opfsReadError: Record<string, unknown>|null, termRecordStore: Record<string, unknown>}}
     */
    getTermContentDiagnostics(dictionaryNames = []) {
        return {
            blockStore: this._termContentBlockStore.getDiagnostics(),
            opfsStore: this._termContentStore.getDebugState(),
            opfsReadError: this._termContentStore.getLastReadErrorDetails(),
            termRecordStore: this._termRecordStore.getDiagnostics(
                [...dictionaryNames].map((name) => this._getTermRecordStorageName(name)),
            ),
        };
    }

    /**
     * @param {number} hash1
     * @param {number} hash2
     * @param {number} mask
     * @returns {number}
     */
    _getTermEntryContentMetaHashPairSlot(hash1, hash2, mask) {
        let value = (hash1 ^ Math.imul(hash2, 0x9e3779b1)) >>> 0;
        value ^= value >>> 16;
        return value & mask;
    }

    /**
     * @param {string} value
     * @returns {number}
     */
    _internTermEntryContentMetaDictName(value) {
        const cached = this._termEntryContentMetaDictNameIdByValue.get(value);
        if (typeof cached === 'number') { return cached; }
        const id = this._termEntryContentMetaDictNames.length;
        this._termEntryContentMetaDictNames.push(value);
        this._termEntryContentMetaDictNameIdByValue.set(value, id);
        return id;
    }

    /**
     * @param {number} index
     * @returns {{id: number, offset: number, length: number, dictName: string, hash2: number, signature1?: number, signature2?: number, signature3?: number, tableIndex: number}}
     */
    _readTermEntryContentMetaHashPairIndex(index) {
        const meta = {
            id: this._termEntryContentMetaIdTable[index],
            offset: this._termEntryContentMetaOffsetTable[index],
            length: this._termEntryContentMetaLengthTable[index] === TERM_CONTENT_META_U32_NULL ?
                -1 :
                this._termEntryContentMetaLengthTable[index],
            dictName: this._termEntryContentMetaDictNames[this._termEntryContentMetaDictNameIdTable[index]] ?? 'raw',
            hash2: this._termEntryContentMetaHash2Table[index],
            tableIndex: index,
        };
        if (this._termEntryContentMetaSignaturePresentTable[index] === 1) {
            meta.signature1 = this._termEntryContentMetaSignature1Table[index];
            meta.signature2 = this._termEntryContentMetaSignature2Table[index];
            meta.signature3 = this._termEntryContentMetaSignature3Table[index];
        }
        return meta;
    }

    /**
     * @param {number} index
     * @param {{id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}} meta
     * @throws {RangeError} If the metadata cannot be represented by the typed tables.
     */
    _writeTermEntryContentMetaHashPairIndex(index, meta) {
        if (!Number.isSafeInteger(meta.id) || meta.id < 0) {
            throw new RangeError(`Invalid term content metadata id: ${meta.id}`);
        }
        if (!Number.isSafeInteger(meta.offset) || meta.offset < 0) {
            throw new RangeError(`Invalid term content metadata offset: ${meta.offset}`);
        }
        if (
            meta.length !== -1 &&
            (!Number.isSafeInteger(meta.length) || meta.length < 0 || meta.length >= TERM_CONTENT_META_U32_NULL)
        ) {
            throw new RangeError(`Invalid term content metadata length: ${meta.length}`);
        }
        this._termEntryContentMetaIdTable[index] = meta.id;
        this._termEntryContentMetaOffsetTable[index] = meta.offset;
        this._termEntryContentMetaLengthTable[index] = meta.length < 0 ? TERM_CONTENT_META_U32_NULL : meta.length;
        this._termEntryContentMetaDictNameIdTable[index] = this._internTermEntryContentMetaDictName(meta.dictName);
        const hasSignatures = (
            typeof meta.signature1 === 'number' &&
            typeof meta.signature2 === 'number' &&
            typeof meta.signature3 === 'number'
        );
        this._termEntryContentMetaSignaturePresentTable[index] = hasSignatures ? 1 : 0;
        if (hasSignatures) {
            this._termEntryContentMetaSignature1Table[index] = meta.signature1;
            this._termEntryContentMetaSignature2Table[index] = meta.signature2;
            this._termEntryContentMetaSignature3Table[index] = meta.signature3;
        }
    }

    /**
     * Grows only the cache-local metadata vectors. Hash-table growth reuses
     * these stable indexes and therefore never copies metadata during rehash.
     * @param {number} requiredCount
     */
    _ensureTermEntryContentMetaDenseCapacity(requiredCount) {
        const oldCapacity = this._termEntryContentMetaStateTable.length;
        if (oldCapacity >= requiredCount) { return; }
        let capacity = Math.max(16, oldCapacity);
        while (capacity < requiredCount) { capacity *= 2; }
        const hash1Table = new Uint32Array(capacity);
        hash1Table.set(this._termEntryContentMetaHash1Table);
        this._termEntryContentMetaHash1Table = hash1Table;
        const hash2Table = new Uint32Array(capacity);
        hash2Table.set(this._termEntryContentMetaHash2Table);
        this._termEntryContentMetaHash2Table = hash2Table;
        const stateTable = new Uint8Array(capacity);
        stateTable.set(this._termEntryContentMetaStateTable);
        this._termEntryContentMetaStateTable = stateTable;
        const idTable = new Float64Array(capacity);
        idTable.set(this._termEntryContentMetaIdTable);
        this._termEntryContentMetaIdTable = idTable;
        const offsetTable = new Float64Array(capacity);
        offsetTable.set(this._termEntryContentMetaOffsetTable);
        this._termEntryContentMetaOffsetTable = offsetTable;
        const lengthTable = new Uint32Array(capacity);
        lengthTable.set(this._termEntryContentMetaLengthTable);
        this._termEntryContentMetaLengthTable = lengthTable;
        const dictNameIdTable = new Uint32Array(capacity);
        dictNameIdTable.set(this._termEntryContentMetaDictNameIdTable);
        this._termEntryContentMetaDictNameIdTable = dictNameIdTable;
        const signaturePresentTable = new Uint8Array(capacity);
        signaturePresentTable.set(this._termEntryContentMetaSignaturePresentTable);
        this._termEntryContentMetaSignaturePresentTable = signaturePresentTable;
        const signature1Table = new Uint32Array(capacity);
        signature1Table.set(this._termEntryContentMetaSignature1Table);
        this._termEntryContentMetaSignature1Table = signature1Table;
        const signature2Table = new Uint32Array(capacity);
        signature2Table.set(this._termEntryContentMetaSignature2Table);
        this._termEntryContentMetaSignature2Table = signature2Table;
        const signature3Table = new Uint32Array(capacity);
        signature3Table.set(this._termEntryContentMetaSignature3Table);
        this._termEntryContentMetaSignature3Table = signature3Table;
    }

    /**
     * @returns {number}
     */
    _allocateTermEntryContentMetaIndex() {
        const reused = this._termEntryContentMetaFreeIndexes.pop();
        if (typeof reused === 'number') { return reused; }
        const index = this._termEntryContentMetaDenseCount;
        this._ensureTermEntryContentMetaDenseCapacity(index + 1);
        ++this._termEntryContentMetaDenseCount;
        return index;
    }

    /**
     * @param {number} requiredCount
     * @param {boolean} [forceRehash]
     */
    _ensureTermEntryContentMetaHashPairCapacity(requiredCount, forceRehash = false) {
        const additionalPublishedCount = Math.max(0, requiredCount - this._termEntryContentMetaHashPairCount);
        const effectiveRequiredCount = (
            this._termEntryContentMetaHashPairCount +
            this._termEntryContentMetaHashPairPendingCount +
            additionalPublishedCount
        );
        this._ensureTermEntryContentMetaDenseCapacity(
            this._termEntryContentMetaDenseCount + additionalPublishedCount,
        );
        if (!forceRehash && this._termEntryContentMetaHashPairTable.length >= effectiveRequiredCount * 2) {
            return;
        }
        let tableSize = 16;
        while (tableSize < effectiveRequiredCount * 2) {
            tableSize *= 2;
        }
        const oldSlotTable = this._termEntryContentMetaHashPairTable;
        const slotTable = new Uint32Array(tableSize);
        const mask = tableSize - 1;
        for (const encodedIndex of oldSlotTable) {
            if (encodedIndex === 0) { continue; }
            const index = encodedIndex - 1;
            if (this._termEntryContentMetaStateTable[index] === TERM_CONTENT_META_SLOT_EMPTY) { continue; }
            const hash1 = this._termEntryContentMetaHash1Table[index];
            const hash2 = this._termEntryContentMetaHash2Table[index];
            let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
            while (slotTable[slot] !== 0) {
                slot = (slot + 1) & mask;
            }
            slotTable[slot] = encodedIndex;
        }
        this._termEntryContentMetaHashPairTable = slotTable;
        this._termEntryContentMetaHashPairMask = mask;
    }

    /**
     * Reserves for later parser-worker results using the first result's exact
     * unique ratio. This avoids repeated whole-table copies and their transient
     * memory peak; the cap limits damage from malformed or skewed estimates.
     * @param {{rowCount: number, dictionaryTotalRows?: number, contentDedupPlan?: unknown}} chunk
     * @param {number} pendingContentCount
     * @returns {number}
     */
    _getArtifactTermContentMetaCapacityHint(chunk, pendingContentCount) {
        const baseline = this._termEntryContentMetaHashPairCount + pendingContentCount;
        if (this._termEntryContentMetaHashPairCount !== 0 || pendingContentCount <= 0) {
            return baseline;
        }
        const totalRows = chunk.dictionaryTotalRows;
        const rawPlan = chunk.contentDedupPlan;
        const plan = /** @type {{sourceRowCount?: unknown, uniqueCount?: unknown}|null} */ (
            typeof rawPlan === 'object' && rawPlan !== null ? rawPlan : null
        );
        const sourceRowCount = plan?.sourceRowCount;
        const uniqueCount = plan?.uniqueCount;
        if (
            typeof totalRows !== 'number' || !Number.isSafeInteger(totalRows) || totalRows <= chunk.rowCount ||
            typeof sourceRowCount !== 'number' || !Number.isSafeInteger(sourceRowCount) || sourceRowCount <= 0 ||
            typeof uniqueCount !== 'number' || !Number.isSafeInteger(uniqueCount) || uniqueCount <= 0 || uniqueCount > sourceRowCount
        ) {
            return baseline;
        }
        const estimatedUniqueCount = Math.ceil(totalRows * uniqueCount / sourceRowCount);
        return Math.max(
            baseline,
            Math.min(estimatedUniqueCount, totalRows, TERM_CONTENT_META_PREALLOC_MAX_ENTRIES),
        );
    }

    /**
     * Reserves collision-free metadata slots and computes content signatures
     * while block compression is running. Pending slots participate in probe
     * chains but are never returned to readers before their offsets exist.
     * @param {number[]} pendingContentHash1s
     * @param {number[]} pendingContentHash2s
     * @param {Uint8Array[]} pendingContentBytes
     * @param {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null} pendingContentSpans
     * @returns {{indexes: Int32Array, active: boolean, collisionEntries?: Array<{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}>}}
     * @throws {RangeError} If hash arrays or source spans are inconsistent.
     */
    _stageArtifactTermContentMetadata(pendingContentHash1s, pendingContentHash2s, pendingContentBytes, pendingContentSpans) {
        const count = pendingContentHash1s.length;
        if (pendingContentHash2s.length !== count) {
            throw new RangeError('Artifact term content hash pair counts do not match');
        }
        if (
            pendingContentSpans === null ?
                pendingContentBytes.length < count :
                (
                    !(pendingContentSpans.buffer instanceof Uint8Array) ||
                    pendingContentSpans.offsets.length < count ||
                    pendingContentSpans.lengths.length < count
                )
        ) {
            throw new RangeError('Artifact term content source count is smaller than its hash count');
        }
        this._ensureTermEntryContentMetaHashPairCapacity(this._termEntryContentMetaHashPairCount + count);
        const indexes = new Int32Array(count);
        indexes.fill(-1);
        const hash1Table = this._termEntryContentMetaHash1Table;
        const hash2Table = this._termEntryContentMetaHash2Table;
        const slotTable = this._termEntryContentMetaHashPairTable;
        const stateTable = this._termEntryContentMetaStateTable;
        const lengthTable = this._termEntryContentMetaLengthTable;
        const signaturePresentTable = this._termEntryContentMetaSignaturePresentTable;
        const signature1Table = this._termEntryContentMetaSignature1Table;
        const signature2Table = this._termEntryContentMetaSignature2Table;
        const signature3Table = this._termEntryContentMetaSignature3Table;
        const freeIndexes = this._termEntryContentMetaFreeIndexes;
        const mask = this._termEntryContentMetaHashPairMask;
        let stagedCount = 0;
        try {
            for (let i = 0; i < count; ++i) {
                const hash1 = pendingContentHash1s[i] >>> 0;
                const hash2 = pendingContentHash2s[i] >>> 0;
                const contentBytes = pendingContentSpans === null ?
                    pendingContentBytes[i] :
                    pendingContentSpans.buffer;
                const contentByteOffset = pendingContentSpans === null ? 0 : pendingContentSpans.offsets[i];
                const contentLength = pendingContentSpans === null ? contentBytes.byteLength : pendingContentSpans.lengths[i];
                if (
                    !(contentBytes instanceof Uint8Array) ||
                    !Number.isSafeInteger(contentByteOffset) ||
                    contentByteOffset < 0 ||
                    contentByteOffset > contentBytes.byteLength ||
                    !Number.isSafeInteger(contentLength) ||
                    contentLength < 0 ||
                    contentLength >= TERM_CONTENT_META_U32_NULL ||
                    contentLength > contentBytes.byteLength - contentByteOffset
                ) {
                    throw new RangeError(`Invalid staged term content source span: ${contentByteOffset}+${contentLength}`);
                }
                let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
                while (slotTable[slot] !== 0) {
                    const existingIndex = slotTable[slot] - 1;
                    if (hash1Table[existingIndex] === hash1 && hash2Table[existingIndex] === hash2) {
                        slot = -1;
                        break;
                    }
                    slot = (slot + 1) & mask;
                }
                if (slot < 0) { continue; }
                const index = freeIndexes.length === 0 ?
                    this._termEntryContentMetaDenseCount++ :
                    /** @type {number} */ (freeIndexes.pop());
                const lastOffset = Math.max(0, contentLength - 4);
                hash1Table[index] = hash1;
                hash2Table[index] = hash2;
                lengthTable[index] = contentLength;
                signaturePresentTable[index] = 1;
                signature1Table[index] = this._readTermContentSignature(contentBytes, contentByteOffset);
                signature2Table[index] = this._readTermContentSignature(
                    contentBytes,
                    contentByteOffset + Math.floor(lastOffset / 2),
                );
                signature3Table[index] = this._readTermContentSignature(contentBytes, contentByteOffset + lastOffset);
                stateTable[index] = TERM_CONTENT_META_SLOT_PENDING;
                slotTable[slot] = index + 1;
                indexes[i] = index;
                ++stagedCount;
            }
        } catch (error) {
            for (const index of indexes) {
                if (index < 0) { continue; }
                stateTable[index] = TERM_CONTENT_META_SLOT_EMPTY;
                this._termEntryContentMetaFreeIndexes.push(index);
            }
            this._ensureTermEntryContentMetaHashPairCapacity(
                this._termEntryContentMetaHashPairCount,
                true,
            );
            throw error;
        }
        this._termEntryContentMetaHashPairPendingCount += stagedCount;
        return {indexes, active: true};
    }

    /**
     * Reserves one metadata slot while the dedupe resolver already owns the
     * source span. This avoids probing and sampling every unique definition a
     * second time after resolution.
     * @param {number} hash1
     * @param {number} hash2
     * @param {Uint8Array} contentBytes
     * @param {number} contentByteOffset
     * @param {number} contentLength
     * @param {number|undefined} [signature1]
     * @param {number|undefined} [signature2]
     * @param {number|undefined} [signature3]
     * @returns {number}
     * @throws {RangeError} If the source span is invalid.
     */
    _reserveArtifactTermContentMetadata(
        hash1,
        hash2,
        contentBytes,
        contentByteOffset,
        contentLength,
        signature1 = void 0,
        signature2 = void 0,
        signature3 = void 0,
    ) {
        hash1 >>>= 0;
        hash2 >>>= 0;
        if (
            !(contentBytes instanceof Uint8Array) ||
            !Number.isSafeInteger(contentByteOffset) ||
            contentByteOffset < 0 ||
            contentByteOffset > contentBytes.byteLength ||
            !Number.isSafeInteger(contentLength) ||
            contentLength < 0 ||
            contentLength >= TERM_CONTENT_META_U32_NULL ||
            contentLength > contentBytes.byteLength - contentByteOffset
        ) {
            throw new RangeError(`Invalid reserved term content source span: ${contentByteOffset}+${contentLength}`);
        }
        const hash1Table = this._termEntryContentMetaHash1Table;
        const hash2Table = this._termEntryContentMetaHash2Table;
        const slotTable = this._termEntryContentMetaHashPairTable;
        const mask = this._termEntryContentMetaHashPairMask;
        let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
        let probeCount = 0;
        while (slotTable[slot] !== 0) {
            const existingIndex = slotTable[slot] - 1;
            if (hash1Table[existingIndex] === hash1 && hash2Table[existingIndex] === hash2) {
                return -1;
            }
            if (++probeCount >= slotTable.length) {
                throw new Error('Term content metadata hash table has no free slot');
            }
            slot = (slot + 1) & mask;
        }
        const index = this._allocateTermEntryContentMetaIndex();
        const lastOffset = Math.max(0, contentLength - 4);
        hash1Table[index] = hash1;
        hash2Table[index] = hash2;
        this._termEntryContentMetaLengthTable[index] = contentLength;
        this._termEntryContentMetaSignaturePresentTable[index] = 1;
        const hasPreparedSignatures = (
            typeof signature1 === 'number' &&
            typeof signature2 === 'number' &&
            typeof signature3 === 'number'
        );
        this._termEntryContentMetaSignature1Table[index] = hasPreparedSignatures ?
            signature1 >>> 0 :
            this._readTermContentSignature(contentBytes, contentByteOffset);
        this._termEntryContentMetaSignature2Table[index] = hasPreparedSignatures ?
            signature2 >>> 0 :
            this._readTermContentSignature(contentBytes, contentByteOffset + Math.floor(lastOffset / 2));
        this._termEntryContentMetaSignature3Table[index] = hasPreparedSignatures ?
            signature3 >>> 0 :
            this._readTermContentSignature(contentBytes, contentByteOffset + lastOffset);
        this._termEntryContentMetaStateTable[index] = TERM_CONTENT_META_SLOT_PENDING;
        slotTable[slot] = index + 1;
        ++this._termEntryContentMetaHashPairPendingCount;
        return index;
    }

    /**
     * @param {{indexes: Int32Array, active: boolean}} staged
     * @param {number} index
     * @param {number} hash1
     * @param {number} hash2
     * @returns {number}
     */
    _resolveStagedArtifactTermContentIndex(staged, index, hash1, hash2) {
        const metadataIndex = staged.indexes[index];
        if (
            metadataIndex >= 0 &&
            this._termEntryContentMetaStateTable[metadataIndex] === TERM_CONTENT_META_SLOT_PENDING &&
            this._termEntryContentMetaHash1Table[metadataIndex] === (hash1 >>> 0) &&
            this._termEntryContentMetaHash2Table[metadataIndex] === (hash2 >>> 0)
        ) {
            return metadataIndex;
        }
        return -1;
    }

    /**
     * @param {{indexes: Int32Array, active: boolean, collisionEntries?: Array<{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}>}|null} staged
     */
    _rollbackStagedArtifactTermContentMetadata(staged) {
        if (staged === null || !staged.active) { return; }
        staged.active = false;
        for (const {key, meta} of staged.collisionEntries ?? []) {
            const collisions = this._termEntryContentMetaCollisionsByHashPair.get(key);
            if (typeof collisions === 'undefined') { continue; }
            const index = collisions.indexOf(meta);
            if (index >= 0) { collisions.splice(index, 1); }
            if (collisions.length === 0) {
                this._termEntryContentMetaCollisionsByHashPair.delete(key);
            }
        }
        /** @type {number[]} */
        const indexesToClear = [];
        for (const index of staged.indexes) {
            if (index < 0) { continue; }
            if (this._termEntryContentMetaStateTable[index] !== TERM_CONTENT_META_SLOT_EMPTY) {
                indexesToClear.push(index);
            }
        }
        for (const index of indexesToClear) {
            const state = this._termEntryContentMetaStateTable[index];
            if (state === TERM_CONTENT_META_SLOT_PENDING) {
                --this._termEntryContentMetaHashPairPendingCount;
            } else if (state === TERM_CONTENT_META_SLOT_PUBLISHED) {
                --this._termEntryContentMetaHashPairCount;
            }
            this._termEntryContentMetaStateTable[index] = TERM_CONTENT_META_SLOT_EMPTY;
            this._termEntryContentMetaFreeIndexes.push(index);
        }
        if (indexesToClear.length > 0) {
            this._ensureTermEntryContentMetaHashPairCapacity(
                this._termEntryContentMetaHashPairCount,
                true,
            );
        }
    }

    /**
     * Restores parser-owned dedupe plan slots when a chunk fails after the
     * resolver advanced its contiguous cursor or published reserved offsets.
     * @param {{plan: ArtifactTermContentDedupPlan, start: number|null, indexes: number[], count: number, previousResolvedDictNames: string[]|null, previousResolvedUniformDictName: string|undefined}|null} state
     */
    _rollbackArtifactTermContentDedupPlan(state) {
        if (state === null) { return; }
        const {
            plan,
            start,
            indexes,
            count,
            previousResolvedDictNames,
            previousResolvedUniformDictName,
        } = state;
        for (let i = 0; i < count; ++i) {
            const uniqueIndex = start === null ? indexes[i] : start + i;
            plan.resolvedFlags[uniqueIndex] = 0;
            plan.resolvedOffsets[uniqueIndex] = 0;
            plan.resolvedLengths[uniqueIndex] = 0;
            if (Array.isArray(plan.resolvedDictNames)) {
                plan.resolvedDictNames[uniqueIndex] = void 0;
            }
        }
        if (!Array.isArray(previousResolvedDictNames)) {
            plan.resolvedDictNames = previousResolvedDictNames;
        }
        plan.resolvedUniformDictName = previousResolvedUniformDictName;
        if (
            start !== null &&
            plan.nextUnresolvedUniqueIndex === start + count
        ) {
            plan.nextUnresolvedUniqueIndex = start;
        }
    }

    /**
     * @param {number} hash1
     * @param {number} hash2
     * @returns {{id: number, offset: number, length: number, dictName: string, hash2?: number}|undefined}
     */
    _getTermEntryContentMetaByHashPair(hash1, hash2) {
        const index = this._findTermEntryContentMetaHashPairIndex(hash1, hash2);
        return index < 0 ? void 0 : this._readTermEntryContentMetaHashPairIndex(index);
    }

    /**
     * @param {number} hash1
     * @param {number} hash2
     * @returns {number}
     */
    _findTermEntryContentMetaHashPairIndex(hash1, hash2) {
        if (this._termEntryContentMetaHashPairCount <= 0) { return -1; }
        hash1 >>>= 0;
        hash2 >>>= 0;
        const hash1Table = this._termEntryContentMetaHash1Table;
        const hash2Table = this._termEntryContentMetaHash2Table;
        const stateTable = this._termEntryContentMetaStateTable;
        const slotTable = this._termEntryContentMetaHashPairTable;
        const mask = this._termEntryContentMetaHashPairMask;
        let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
        while (true) {
            const encodedIndex = slotTable[slot];
            if (encodedIndex === 0) { return -1; }
            const index = encodedIndex - 1;
            if (
                stateTable[index] === TERM_CONTENT_META_SLOT_PUBLISHED &&
                hash1Table[index] === hash1 && hash2Table[index] === hash2
            ) {
                return index;
            }
            slot = (slot + 1) & mask;
        }
    }

    /**
     * @param {number} hash1
     * @param {number} hash2
     * @param {{id: number, offset: number, length: number, dictName: string, hash2?: number}} meta
     */
    _setTermEntryContentMetaByHashPair(hash1, hash2, meta) {
        hash1 >>>= 0;
        hash2 >>>= 0;
        this._ensureTermEntryContentMetaHashPairCapacity(this._termEntryContentMetaHashPairCount + 1);
        const hash1Table = this._termEntryContentMetaHash1Table;
        const hash2Table = this._termEntryContentMetaHash2Table;
        const stateTable = this._termEntryContentMetaStateTable;
        const slotTable = this._termEntryContentMetaHashPairTable;
        const mask = this._termEntryContentMetaHashPairMask;
        let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
        while (true) {
            const encodedIndex = slotTable[slot];
            if (encodedIndex === 0) {
                const index = this._allocateTermEntryContentMetaIndex();
                hash1Table[index] = hash1;
                hash2Table[index] = hash2;
                stateTable[index] = TERM_CONTENT_META_SLOT_PUBLISHED;
                slotTable[slot] = index + 1;
                this._writeTermEntryContentMetaHashPairIndex(index, meta);
                ++this._termEntryContentMetaHashPairCount;
                return;
            }
            const index = encodedIndex - 1;
            if (
                stateTable[index] === TERM_CONTENT_META_SLOT_PUBLISHED &&
                hash1Table[index] === hash1 && hash2Table[index] === hash2
            ) {
                this._writeTermEntryContentMetaHashPairIndex(index, meta);
                return;
            }
            slot = (slot + 1) & mask;
        }
    }

    /**
     * Inserts the overwhelmingly common collision-free import case directly
     * into the typed metadata table.
     * @param {number} hash1
     * @param {number} hash2
     * @param {number} offset
     * @param {number} length
     * @param {string} dictName
     * @param {number} dictNameId
     * @param {Uint8Array} contentBytes
     * @param {number} [contentByteOffset]
     * @throws {RangeError} If persisted offsets or lengths are invalid.
     */
    _insertTermEntryContentMetaByHashPairFast(hash1, hash2, offset, length, dictName, dictNameId, contentBytes, contentByteOffset = 0) {
        hash1 >>>= 0;
        hash2 >>>= 0;
        const hash1Table = this._termEntryContentMetaHash1Table;
        const hash2Table = this._termEntryContentMetaHash2Table;
        const stateTable = this._termEntryContentMetaStateTable;
        const slotTable = this._termEntryContentMetaHashPairTable;
        const mask = this._termEntryContentMetaHashPairMask;
        let slot = this._getTermEntryContentMetaHashPairSlot(hash1, hash2, mask);
        let probeCount = 0;
        while (slotTable[slot] !== 0) {
            const existingIndex = slotTable[slot] - 1;
            if (
                stateTable[existingIndex] === TERM_CONTENT_META_SLOT_PUBLISHED &&
                hash1Table[existingIndex] === hash1 && hash2Table[existingIndex] === hash2
            ) {
                this._cacheTermEntryContentMeta(
                    null,
                    offset,
                    length,
                    dictName,
                    0,
                    hash1,
                    hash2,
                    contentBytes.subarray(contentByteOffset, contentByteOffset + length),
                );
                return;
            }
            if (++probeCount >= slotTable.length) {
                throw new Error('Term content metadata hash table has no free slot');
            }
            slot = (slot + 1) & mask;
        }
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new RangeError(`Invalid term content metadata offset: ${offset}`);
        }
        if (!Number.isSafeInteger(length) || length < 0 || length >= TERM_CONTENT_META_U32_NULL) {
            throw new RangeError(`Invalid term content metadata length: ${length}`);
        }
        if (
            !Number.isSafeInteger(contentByteOffset) ||
            contentByteOffset < 0 ||
            contentByteOffset > contentBytes.byteLength ||
            length > contentBytes.byteLength - contentByteOffset
        ) {
            throw new RangeError(`Invalid term content metadata source span: ${contentByteOffset}+${length}`);
        }
        const lastOffset = Math.max(0, length - 4);
        const index = this._allocateTermEntryContentMetaIndex();
        hash1Table[index] = hash1;
        hash2Table[index] = hash2;
        stateTable[index] = TERM_CONTENT_META_SLOT_PUBLISHED;
        slotTable[slot] = index + 1;
        this._termEntryContentMetaIdTable[index] = 0;
        this._termEntryContentMetaOffsetTable[index] = offset;
        this._termEntryContentMetaLengthTable[index] = length;
        this._termEntryContentMetaDictNameIdTable[index] = dictNameId;
        this._termEntryContentMetaSignaturePresentTable[index] = 1;
        this._termEntryContentMetaSignature1Table[index] = this._readTermContentSignature(contentBytes, contentByteOffset);
        this._termEntryContentMetaSignature2Table[index] = this._readTermContentSignature(contentBytes, contentByteOffset + Math.floor(lastOffset / 2));
        this._termEntryContentMetaSignature3Table[index] = this._readTermContentSignature(contentBytes, contentByteOffset + lastOffset);
        ++this._termEntryContentMetaHashPairCount;
    }

    /**
     * Records a parser-verified distinct value which shares a hash pair with
     * another pending value. The returned identity lets import rollback remove
     * only the collision owned by that import.
     * @param {number} hash1
     * @param {number} hash2
     * @param {number} offset
     * @param {number} length
     * @param {string} dictName
     * @param {Uint8Array} contentBytes
     * @param {number} contentByteOffset
     * @returns {{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}}
     * @throws {RangeError} If the persisted metadata or source span is invalid.
     */
    _appendStagedTermEntryContentMetaCollision(hash1, hash2, offset, length, dictName, contentBytes, contentByteOffset) {
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new RangeError(`Invalid term content metadata offset: ${offset}`);
        }
        if (!Number.isSafeInteger(length) || length < 0 || length >= TERM_CONTENT_META_U32_NULL) {
            throw new RangeError(`Invalid term content metadata length: ${length}`);
        }
        if (
            !Number.isSafeInteger(contentByteOffset) ||
            contentByteOffset < 0 ||
            contentByteOffset > contentBytes.byteLength ||
            length > contentBytes.byteLength - contentByteOffset
        ) {
            throw new RangeError(`Invalid term content metadata source span: ${contentByteOffset}+${length}`);
        }
        const meta = {id: 0, offset, length, dictName};
        this._setTermContentSignatures(meta, contentBytes.subarray(contentByteOffset, contentByteOffset + length));
        const key = `${hash1 >>> 0}:${hash2 >>> 0}`;
        let collisions = this._termEntryContentMetaCollisionsByHashPair.get(key);
        if (typeof collisions === 'undefined') {
            collisions = [];
            this._termEntryContentMetaCollisionsByHashPair.set(key, collisions);
        }
        collisions.push(meta);
        return {key, meta};
    }

    /**
     * @param {string|null} contentHash
     * @param {number} offset
     * @param {number} length
     * @param {string|null|undefined} dictName
     * @param {number} [id]
     * @param {number} [hash1]
     * @param {number} [hash2]
     * @param {Uint8Array|null} [contentBytes]
     * @returns {{id: number, offset: number, length: number, dictName: string, hash2?: number, signature1?: number, signature2?: number, signature3?: number}}
     */
    _cacheTermEntryContentMeta(contentHash, offset, length, dictName, id = 0, hash1 = -1, hash2 = -1, contentBytes = null) {
        const meta = {id, offset, length, dictName: dictName ?? 'raw'};
        if (contentBytes instanceof Uint8Array) {
            this._setTermContentSignatures(meta, contentBytes);
        }
        if (typeof contentHash === 'string' && contentHash.length > 0) {
            this._termEntryContentMetaByHash.set(contentHash, meta);
            if (hash1 < 0 || hash2 < 0) {
                const parsedHashPair = parseContentHashHexPair(contentHash);
                if (parsedHashPair !== null) {
                    [hash1, hash2] = parsedHashPair;
                }
            }
        }
        if (hash1 >= 0 && hash2 >= 0) {
            const existing = this._getTermEntryContentMetaByHashPair(hash1, hash2);
            if (typeof existing === 'undefined') {
                this._setTermEntryContentMetaByHashPair(hash1, hash2, meta);
            } else if (existing.offset !== offset) {
                if (
                    typeof existing.signature1 === 'number' &&
                    typeof meta.signature1 === 'number' &&
                    (
                        existing.signature1 !== meta.signature1 ||
                        existing.signature2 !== meta.signature2 ||
                        existing.signature3 !== meta.signature3
                    )
                ) {
                    const key = `${hash1 >>> 0}:${hash2 >>> 0}`;
                    let collisions = this._termEntryContentMetaCollisionsByHashPair.get(key);
                    if (typeof collisions === 'undefined') {
                        collisions = [];
                        this._termEntryContentMetaCollisionsByHashPair.set(key, collisions);
                    }
                    collisions.push(meta);
                } else {
                    this._setTermEntryContentMetaByHashPair(hash1, hash2, meta);
                }
            }
        }
        return meta;
    }

    /**
     * @param {{contentKey: string, contentHash: string, contentBytes: Uint8Array, contentDictName: string|null}[]} rows
     * @throws {Error}
     */
    async _insertTermEntryContentBatch(rows) {
        if (rows.length === 0) { return; }
        const spans = await this._termContentStore.appendBatch(rows.map((row) => row.contentBytes));
        this._insertTermEntryContentBatchWithSpans(rows, spans, 0, rows.length);
    }

    /**
     * @param {{contentHash: string, contentDictName: string|null}[]} rows
     * @param {{offset: number, length: number}[]} spans
     * @param {number} start
     * @param {number} count
     * @throws {Error}
     */
    _insertTermEntryContentBatchWithSpans(rows, spans, start, count) {
        if (count <= 0) { return; }
        /** @type {string[]} */
        const valueRows = [];
        /** @type {import('@sqlite.org/sqlite-wasm').Bindable[]} */
        const bind = [];
        for (let i = start, ii = start + count; i < ii; ++i) {
            const row = rows[i];
            const span = spans[i];
            valueRows.push('(?, NULL, ?, \'\', \'\', \'\', \'[]\', ?, ?)');
            bind.push(row.contentHash, row.contentDictName, span.offset, span.length);
        }
        const sql = `
            INSERT INTO termEntryContent(contentHash, contentZstd, contentDictName, rules, definitionTags, termTags, glossaryJson, contentOffset, contentLength)
            VALUES ${valueRows.join(',')}
        `;
        const stmt = this._getCachedStatement(sql);
        stmt.reset(true);
        stmt.bind(bind);
        stmt.step();

        const db = this._requireDb();
        const lastInsertRowId = this._asNumber(db.selectValue('SELECT last_insert_rowid()'), -1);
        if (lastInsertRowId <= 0) {
            throw new Error('Failed to insert batched term entry content');
        }
        const firstId = lastInsertRowId - count + 1;
        for (let i = start, ii = start + count; i < ii; ++i) {
            const id = firstId + (i - start);
            this._termEntryContentIdByHash.set(rows[i].contentHash, id);
            this._termEntryContentIdByKey.set(rows[i].contentHash, id);
            this._cacheTermEntryContentMeta(rows[i].contentHash, spans[i].offset, spans[i].length, rows[i].contentDictName, id);
        }
    }

    /**
     * @param {import('dictionary-database').ObjectStoreData<'terms'>[]} items
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async _bulkAddTermsWithoutContentDedup(items, start, count) {
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        const batchSize = this._getTermBulkAddBatchSizeForCount(count);
        let contentAppendMs = 0;
        let termRecordBuildMs = 0;
        let termRecordEncodeMs = 0;
        let termRecordWriteMs = 0;
        let termsVtabInsertMs = 0;
        let termRecordInternMs = 0;
        let termRecordPackLengthsMs = 0;
        let termRecordHeapCopyMs = 0;
        let termRecordFieldEncodeMs = 0;
        let minAssignedContentOffset = Number.POSITIVE_INFINITY;
        let maxAssignedContentEnd = -1;
        let maxObservedStoreLengthBeforeAppend = -1;
        let maxObservedStoreLengthAfterAppend = -1;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(this._requireDb());
        }
        try {
            for (let i = start, ii = start + count; i < ii; i += batchSize) {
                const chunkCount = Math.min(batchSize, ii - i);
                /** @type {Uint8Array[]} */
                const contentChunks = new Array(chunkCount);
                /** @type {number[]} */
                const contentOffsets = new Array(chunkCount);
                /** @type {number[]} */
                const contentLengths = new Array(chunkCount);
                for (let j = 0; j < chunkCount; ++j) {
                    const row = /** @type {import('dictionary-database').DatabaseTermEntry} */ (items[i + j]);
                    const precomputedContentBytes = row.termEntryContentBytes instanceof Uint8Array ? row.termEntryContentBytes : this._getRawTermContentBytesIfAvailable(row);
                    if (precomputedContentBytes instanceof Uint8Array) {
                        contentChunks[j] = precomputedContentBytes;
                        continue;
                    }
                    const rules = row.rules ?? '';
                    const definitionTags = row.definitionTags ?? row.tags ?? '';
                    const termTags = row.termTags ?? '';
                    const contentJson = row.termEntryContentJson ?? this._serializeTermEntryContent(rules, definitionTags, termTags, row.glossary);
                    contentChunks[j] = this._textEncoder.encode(contentJson);
                }
                let chunksToAppend = contentChunks;
                const tContentAppendStart = safePerformance.now();
                if (this._importDebugLogging) {
                    const debugStateBeforeAppend = this._termContentStore.getDebugState();
                    maxObservedStoreLengthBeforeAppend = Math.max(
                        maxObservedStoreLengthBeforeAppend,
                        this._asNumber(debugStateBeforeAppend?.totalLength, -1),
                    );
                }
                if (this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES) {
                    const {packedChunks, sourceChunkIndices, sourceChunkLocalOffsets} = packContentChunksIntoSlabs(
                        contentChunks,
                        this._rawTermContentPackTargetBytes,
                    );
                    chunksToAppend = packedChunks;
                    /** @type {number[]} */
                    const packedOffsets = new Array(packedChunks.length);
                    /** @type {number[]} */
                    const packedLengths = new Array(packedChunks.length);
                    await this._termContentStore.appendBatchToArrays(packedChunks, packedOffsets, packedLengths);
                    for (let j = 0; j < chunkCount; ++j) {
                        const packedIndex = sourceChunkIndices[j];
                        contentOffsets[j] = packedOffsets[packedIndex] + sourceChunkLocalOffsets[j];
                        contentLengths[j] = contentChunks[j].byteLength;
                    }
                } else {
                    await this._termContentStore.appendBatchToArrays(contentChunks, contentOffsets, contentLengths);
                }
                if (this._importDebugLogging) {
                    const debugStateAfterAppend = this._termContentStore.getDebugState();
                    maxObservedStoreLengthAfterAppend = Math.max(
                        maxObservedStoreLengthAfterAppend,
                        this._asNumber(debugStateAfterAppend?.totalLength, -1),
                    );
                }
                for (let j = 0; j < chunkCount; ++j) {
                    const offset = contentOffsets[j];
                    const length = contentLengths[j];
                    if (offset >= 0 && length > 0) {
                        if (offset < minAssignedContentOffset) {
                            minAssignedContentOffset = offset;
                        }
                        const end = offset + length;
                        if (end > maxAssignedContentEnd) {
                            maxAssignedContentEnd = end;
                        }
                    }
                }
                contentAppendMs += safePerformance.now() - tContentAppendStart;
                const explicitContentDictName = chunkCount > 0 ? (items[i].termEntryContentDictName ?? null) : null;
                let contentDictName = 'raw';
                if (
                    this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES &&
                    typeof explicitContentDictName === 'string' &&
                    explicitContentDictName.length > 0
                ) {
                    contentDictName = explicitContentDictName;
                } else if (
                    this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES &&
                    chunksToAppend.every((contentBytes) => isRawTermContentBinary(contentBytes))
                ) {
                    contentDictName = RAW_TERM_CONTENT_DICT_NAME;
                }
                const metrics = await this._termRecordStore.appendBatchFromImportTermEntriesResolvedContent(items, i, chunkCount, contentOffsets, contentLengths, contentDictName);
                termRecordBuildMs += metrics.buildRecordsMs;
                termRecordEncodeMs += metrics.encodeMs;
                termRecordWriteMs += metrics.appendWriteMs;
                termRecordInternMs += metrics.internMs ?? 0;
                termRecordPackLengthsMs += metrics.packLengthsMs ?? 0;
                termRecordHeapCopyMs += metrics.heapCopyMs ?? 0;
                termRecordFieldEncodeMs += metrics.recordFieldEncodeMs ?? 0;
                const deferVirtualTableWrite = this._deferTermsVirtualTableSync || this._isBulkImportInProgress();
                if (deferVirtualTableWrite) {
                    this._termsVirtualTableDirty = true;
                } else {
                    const tTermsVtabInsertStart = safePerformance.now();
                    await this._insertTermRowsIntoVirtualTable(chunkCount);
                    termsVtabInsertMs += safePerformance.now() - tTermsVtabInsertStart;
                }
            }
            if (useLocalTransaction) {
                this._requireDb().exec('COMMIT');
            }
            this._lastBulkAddTermsMetrics = {
                contentAppendMs,
                termRecordBuildMs,
                termRecordEncodeMs,
                termRecordWriteMs,
                termsVtabInsertMs,
                termRecordInternMs,
                termRecordPackLengthsMs,
                termRecordHeapCopyMs,
                termRecordFieldEncodeMs,
            };
            if (this._importDebugLogging) {
                log.log(
                    `[manabitan-db-import] bulkAdd terms no-dedup contentAppend=${contentAppendMs.toFixed(1)}ms ` +
                    `termRecordBuild=${termRecordBuildMs.toFixed(1)}ms ` +
                    `termRecordEncode=${termRecordEncodeMs.toFixed(1)}ms ` +
                    `termRecordWrite=${termRecordWriteMs.toFixed(1)}ms ` +
                    `termsVtabInsert=${termsVtabInsertMs.toFixed(1)}ms ` +
                    `assignedMinOffset=${Number.isFinite(minAssignedContentOffset) ? minAssignedContentOffset : -1} ` +
                    `assignedMaxEnd=${maxAssignedContentEnd} ` +
                    `storeLengthBeforeAppendMax=${maxObservedStoreLengthBeforeAppend} ` +
                    `storeLengthAfterAppendMax=${maxObservedStoreLengthAfterAppend}`,
                );
            }
        } catch (e) {
            if (useLocalTransaction) {
                try { this._requireDb().exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {{dictionary: string, rowCount: number, dictionaryTotalRows?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[], scoreList: number[], sequenceList: (number|undefined)[], contentBytesList: Uint8Array[], contentDictNameList: ((string|null)[]|null), uniformContentDictName?: string|null, fixedContentOffsetBase?: number, fixedContentLength?: number, termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null}} chunk
     * @returns {Promise<void>}
     */
    async _bulkAddArtifactTermsChunkWithoutContentDedup(chunk) {
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        const count = chunk.rowCount;
        if (count <= 0) {
            this._lastBulkAddTermsMetrics = {
                contentAppendMs: 0,
                termRecordBuildMs: 0,
                termRecordEncodeMs: 0,
                termRecordWriteMs: 0,
                termsVtabInsertMs: 0,
                termRecordInternMs: 0,
                termRecordPackLengthsMs: 0,
                termRecordHeapCopyMs: 0,
                termRecordFieldEncodeMs: 0,
                termRecordValidationMs: 0,
                termLookupIndexEncodeMs: 0,
            };
            return;
        }
        let contentAppendMs = 0;
        let termRecordBuildMs = 0;
        let termRecordEncodeMs = 0;
        let termRecordWriteMs = 0;
        let termsVtabInsertMs = 0;
        let termRecordInternMs = 0;
        let termRecordPackLengthsMs = 0;
        let termRecordHeapCopyMs = 0;
        let termRecordFieldEncodeMs = 0;
        let termRecordValidationMs = 0;
        let termLookupIndexEncodeMs = 0;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(this._requireDb());
        }
        try {
            /** @type {number[]|Float64Array} */
            let contentOffsets = new Array(count);
            /** @type {number[]|Uint32Array} */
            let contentLengths = new Array(count);
            /** @type {string | null} */
            let uniformContentDictName = null;
            /** @type {(string|null)[] | null} */
            let contentDictNames = null;
            const contentChunks = chunk.contentBytesList;
            const tContentAppendStart = safePerformance.now();
            if (this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES) {
                contentOffsets = new Float64Array(count);
                contentLengths = new Uint32Array(count);
                const firstContentLength = contentChunks[0]?.byteLength ?? 0;
                let useFixedSizePacking = (
                    firstContentLength > 0 &&
                    (chunk.dictionaryTotalRows ?? 0) >= this._artifactFixedPackMinTotalRows
                );
                for (let i = 1; i < count && useFixedSizePacking; ++i) {
                    if (contentChunks[i].byteLength !== firstContentLength) {
                        useFixedSizePacking = false;
                    }
                }
                if (useFixedSizePacking) {
                    const {packedChunks, packedRowStarts, packedRowCounts} = packFixedSizeContentChunksIntoSlabs(
                        contentChunks,
                        this._rawTermContentPackTargetBytes,
                        firstContentLength,
                    );
                    /** @type {number[]} */
                    const packedOffsets = new Array(packedChunks.length);
                    /** @type {number[]} */
                    const packedLengths = new Array(packedChunks.length);
                    await this._termContentStore.appendBatchToArrays(packedChunks, packedOffsets, packedLengths);
                    if (
                        packedChunks.length === 1 &&
                        (chunk.dictionaryTotalRows ?? 0) >= 1_000_000
                    ) {
                        chunk.fixedContentOffsetBase = packedOffsets[0] ?? 0;
                        chunk.fixedContentLength = firstContentLength;
                    } else {
                        contentLengths.fill(firstContentLength);
                        for (let packedIndex = 0; packedIndex < packedChunks.length; ++packedIndex) {
                            const baseOffset = packedOffsets[packedIndex];
                            const rowStart = packedRowStarts[packedIndex];
                            const rowCount = packedRowCounts[packedIndex];
                            for (let localIndex = 0; localIndex < rowCount; ++localIndex) {
                                const rowIndex = rowStart + localIndex;
                                contentOffsets[rowIndex] = baseOffset + (localIndex * firstContentLength);
                            }
                        }
                    }
                } else {
                    const {packedChunks, sourceChunkIndices, sourceChunkLocalOffsets} = packContentChunksIntoSlabs(
                        contentChunks,
                        this._rawTermContentPackTargetBytes,
                    );
                    /** @type {number[]} */
                    const packedOffsets = new Array(packedChunks.length);
                    /** @type {number[]} */
                    const packedLengths = new Array(packedChunks.length);
                    await this._termContentStore.appendBatchToArrays(packedChunks, packedOffsets, packedLengths);
                    for (let i = 0; i < count; ++i) {
                        const packedIndex = sourceChunkIndices[i];
                        contentOffsets[i] = packedOffsets[packedIndex] + sourceChunkLocalOffsets[i];
                        contentLengths[i] = contentChunks[i].byteLength;
                    }
                }
            } else {
                await this._termContentStore.appendBatchToArrays(contentChunks, contentOffsets, contentLengths);
            }
            if (typeof chunk.uniformContentDictName !== 'undefined') {
                uniformContentDictName = chunk.uniformContentDictName ?? 'raw';
            } else {
                for (let i = 0; i < count; ++i) {
                    const explicitContentDictName = Array.isArray(chunk.contentDictNameList) ? chunk.contentDictNameList[i] : null;
                    /** @type {string|null} */
                    let resolvedContentDictName;
                    if (
                        this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES &&
                        typeof explicitContentDictName === 'string' &&
                        explicitContentDictName.length > 0
                    ) {
                        resolvedContentDictName = explicitContentDictName;
                    } else if (
                        this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES &&
                        isRawTermContentBinary(contentChunks[i])
                    ) {
                        resolvedContentDictName = RAW_TERM_CONTENT_DICT_NAME;
                    } else {
                        resolvedContentDictName = 'raw';
                    }
                    if (i === 0) {
                        uniformContentDictName = resolvedContentDictName;
                        continue;
                    }
                    if (contentDictNames === null && resolvedContentDictName !== uniformContentDictName) {
                        contentDictNames = new Array(count);
                        contentDictNames.fill(uniformContentDictName, 0, i);
                    }
                    if (contentDictNames !== null) {
                        contentDictNames[i] = resolvedContentDictName;
                    }
                }
            }
            contentAppendMs += safePerformance.now() - tContentAppendStart;
            const metrics = await this._termRecordStore.appendBatchFromArtifactChunkResolvedContent(
                chunk,
                contentOffsets,
                contentLengths,
                contentDictNames ?? uniformContentDictName ?? 'raw',
            );
            termRecordBuildMs += metrics.buildRecordsMs;
            termRecordEncodeMs += metrics.encodeMs;
            termRecordWriteMs += metrics.appendWriteMs;
            termRecordInternMs += metrics.internMs ?? 0;
            termRecordPackLengthsMs += metrics.packLengthsMs ?? 0;
            termRecordHeapCopyMs += metrics.heapCopyMs ?? 0;
            termRecordFieldEncodeMs += metrics.recordFieldEncodeMs ?? 0;
            termRecordValidationMs += metrics.validationMs ?? 0;
            termLookupIndexEncodeMs += metrics.lookupIndexEncodeMs ?? 0;
            const deferVirtualTableWrite = this._deferTermsVirtualTableSync || this._isBulkImportInProgress();
            if (deferVirtualTableWrite) {
                this._termsVirtualTableDirty = true;
            } else {
                const tTermsVtabInsertStart = safePerformance.now();
                await this._insertTermRowsIntoVirtualTable(count);
                termsVtabInsertMs += safePerformance.now() - tTermsVtabInsertStart;
            }
            if (useLocalTransaction) {
                this._requireDb().exec('COMMIT');
            }
            this._lastBulkAddTermsMetrics = {
                contentAppendMs,
                termRecordBuildMs,
                termRecordEncodeMs,
                termRecordWriteMs,
                termsVtabInsertMs,
                termRecordInternMs,
                termRecordPackLengthsMs,
                termRecordHeapCopyMs,
                termRecordFieldEncodeMs,
                termRecordValidationMs,
                termLookupIndexEncodeMs,
            };
        } catch (e) {
            if (useLocalTransaction) {
                try { this._requireDb().exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {ArtifactTermContentChunk & {dictionary: string, dictionaryTotalRows?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null}} chunk
     * @returns {Promise<void>}
     */
    async _bulkAddArtifactTermsChunkWithContentDedup(chunk) {
        const useLocalTransaction = !this._bulkImportTransactionOpen;
        const count = chunk.rowCount;
        if (count <= 0) {
            this._lastBulkAddTermsMetrics = createTermImportMetrics();
            return;
        }
        const hasContentSlab = chunk.contentBytesBuffer instanceof Uint8Array && chunk.contentMetaList instanceof Uint32Array;
        if (
            hasContentSlab ?
                chunk.contentMetaList.length < count * 4 :
                (chunk.contentHash1List.length < count || chunk.contentHash2List.length < count)
        ) {
            throw new Error('Artifact chunk content hash arrays are smaller than row count');
        }
        const importMetrics = createTermImportMetrics();
        /** @type {{indexes: Int32Array, active: boolean, collisionEntries?: Array<{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}>}|null} */
        let stagedContentMetadata = null;
        /** @type {{plan: ArtifactTermContentDedupPlan, start: number|null, indexes: number[], count: number, previousResolvedDictNames: string[]|null, previousResolvedUniformDictName: string|undefined}|null} */
        let dedupPlanRollbackState = null;

        if (useLocalTransaction) {
            await this._beginImmediateTransaction(this._requireDb());
        }
        try {
            const tContentAppendStart = safePerformance.now();
            const dedup = await this._resolveArtifactTermContentDedup(chunk, true);
            const {
                contentOffsets,
                contentLengths,
                pendingContentBytes,
                pendingContentHash1s,
                pendingContentHash2s,
                pendingContentDictNames,
                pendingRowToUniqueIndex,
                pendingContentCount,
                pendingContentSpans,
                uniformContentDictName,
                pendingHitCount,
                persistedHitCount,
                exactFallbackCount,
                contentDedupPlan,
                pendingPlanUniqueIndexes,
                pendingPlanUniqueStart,
                stagedContentMetadata: resolvedStagedContentMetadata,
            } = dedup;
            const useResolvedContentReferences = (
                chunk.useResolvedContentReferences === true &&
                contentDedupPlan !== null &&
                chunk.contentUniqueIndexList instanceof Uint32Array
            );
            stagedContentMetadata = resolvedStagedContentMetadata ?? null;
            let {resolvedContentDictNames} = dedup;
            importMetrics.dedupPendingHitCount += pendingHitCount;
            importMetrics.dedupPersistedHitCount += persistedHitCount;
            importMetrics.dedupUniqueCount += pendingContentCount;
            importMetrics.dedupExactFallbackCount += exactFallbackCount;
            importMetrics.dedupScanMs += safePerformance.now() - tContentAppendStart;
            if (contentDedupPlan !== null && pendingContentCount > 0) {
                dedupPlanRollbackState = {
                    plan: contentDedupPlan,
                    start: pendingPlanUniqueStart,
                    indexes: pendingPlanUniqueIndexes,
                    count: pendingPlanUniqueStart === null ?
                        pendingPlanUniqueIndexes.length :
                        pendingContentCount,
                    previousResolvedDictNames: contentDedupPlan.resolvedDictNames,
                    previousResolvedUniformDictName: contentDedupPlan.resolvedUniformDictName,
                };
            }
            const tContentStoreStart = safePerformance.now();
            let preparedLookupIndexes = null;
            let recordAppended = false;
            if (pendingContentCount > 0) {
                const earlyContentPersistence = useLocalTransaction ?
                    null :
                    this._tryBeginPersistArtifactTermContent(
                        chunk.dictionary,
                        pendingContentSpans,
                        chunk.releaseBorrowedContent,
                    );
                if (earlyContentPersistence?.initialSelection === true) {
                    importMetrics.contentInitialReservationCount += 1;
                }
                const pendingContentPersistence = earlyContentPersistence === null ?
                    this._persistArtifactTermContent(
                        chunk.dictionary,
                        pendingContentBytes,
                        pendingContentDictNames,
                        uniformContentDictName,
                        pendingContentSpans,
                    ) :
                    null;
                /** @type {Promise<void>|null} */
                let pendingRecordAppend = null;
                try {
                    if (stagedContentMetadata === null) {
                        const tContentMetadataPrepareStart = safePerformance.now();
                        this._ensureTermEntryContentMetaHashPairCapacity(
                            this._getArtifactTermContentMetaCapacityHint(chunk, pendingContentCount),
                        );
                        stagedContentMetadata = this._stageArtifactTermContentMetadata(
                            pendingContentHash1s,
                            pendingContentHash2s,
                            pendingContentBytes,
                            pendingContentSpans,
                        );
                        const contentMetadataStageMs = safePerformance.now() - tContentMetadataPrepareStart;
                        importMetrics.contentMetadataStageMs += contentMetadataStageMs;
                        importMetrics.contentMetadataMs += contentMetadataStageMs;
                    }
                    const workerPreparedLookupIndexes = chunk.preparedLookupIndexes;
                    if (
                        hasCompletePreparedTermLookupIndexes(workerPreparedLookupIndexes, count)
                    ) {
                        preparedLookupIndexes = workerPreparedLookupIndexes;
                        importMetrics.termLookupIndexEncodeMs += Math.max(0, chunk.preparedLookupIndexEncodeMs ?? 0);
                    } else {
                        const preparedLookupResult = typeof this._termRecordStore.prepareArtifactChunkLookupIndexes === 'function' ?
                            this._termRecordStore.prepareArtifactChunkLookupIndexes(chunk) :
                            null;
                        if (preparedLookupResult !== null) {
                            preparedLookupIndexes = preparedLookupResult.indexes;
                            importMetrics.termLookupIndexEncodeMs += preparedLookupResult.encodeMs;
                        }
                    }
                    /** @type {{pendingOffsets: number[]|Float64Array, pendingLengths: number[]|Uint32Array, pendingResolvedDictNames: string|string[], blockProfile?: {packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null, [VALIDATED_TERM_CONTENT_METADATA]?: boolean}} */
                    const persistenceResult = earlyContentPersistence === null ?
                        await pendingContentPersistence :
                        await earlyContentPersistence.storage;
                    const {
                        pendingOffsets,
                        pendingLengths,
                        pendingResolvedDictNames,
                    } = persistenceResult;
                    if (earlyContentPersistence === null) {
                        this._addTermContentBlockProfile(importMetrics, persistenceResult.blockProfile ?? null);
                        importMetrics.contentStoreMs += safePerformance.now() - tContentStoreStart;
                    }
                    const tContentMetadataStart = safePerformance.now();
                    if (contentDedupPlan !== null) {
                        const {
                            resolvedFlags,
                            resolvedOffsets,
                            resolvedLengths,
                        } = contentDedupPlan;
                        const planUniqueCount = pendingPlanUniqueStart === null ?
                            pendingPlanUniqueIndexes.length :
                            pendingOffsets.length;
                        for (let i = 0; i < planUniqueCount; ++i) {
                            const uniqueIndex = pendingPlanUniqueStart === null ?
                                pendingPlanUniqueIndexes[i] :
                                pendingPlanUniqueStart + i;
                            resolvedOffsets[uniqueIndex] = pendingOffsets[i];
                            resolvedLengths[uniqueIndex] = pendingLengths[i];
                            setResolvedTermContentPlanDictName(
                                contentDedupPlan,
                                uniqueIndex,
                                Array.isArray(pendingResolvedDictNames) ?
                                    pendingResolvedDictNames[i] :
                                    pendingResolvedDictNames,
                            );
                            resolvedFlags[uniqueIndex] = 1;
                        }
                    }
                    resolvedContentDictNames = this._publishArtifactTermContentMetadata({
                        count,
                        contentOffsets,
                        contentLengths,
                        resolvedContentDictNames,
                        pendingRowToUniqueIndex,
                        pendingContentBytes,
                        pendingContentHash1s,
                        pendingContentHash2s,
                        pendingOffsets,
                        pendingLengths,
                        pendingResolvedDictNames,
                        pendingContentSpans,
                        contentDedupPlan,
                        contentUniqueIndexList: chunk.contentUniqueIndexList,
                        stagedContentMetadata,
                        importMetrics,
                        metadataValidated: persistenceResult[VALIDATED_TERM_CONTENT_METADATA] === true,
                        useResolvedContentReferences,
                    });
                    const contentMetadataPublishMs = safePerformance.now() - tContentMetadataStart;
                    importMetrics.contentMetadataPublishMs += contentMetadataPublishMs;
                    importMetrics.contentMetadataMs += contentMetadataPublishMs;
                    if (earlyContentPersistence !== null) {
                        const metadataPublishedAt = safePerformance.now();
                        let contentCompletedAt = metadataPublishedAt;
                        const measuredContentCompletion = earlyContentPersistence.completion.then((blockProfile) => {
                            contentCompletedAt = safePerformance.now();
                            return blockProfile;
                        });
                        const recordChunk = this._createResolvedArtifactTermRecordChunk(
                            chunk,
                            preparedLookupIndexes,
                            contentDedupPlan,
                            useResolvedContentReferences,
                        );
                        resolvedContentDictNames = this._compactUniformContentDictNames(resolvedContentDictNames);
                        pendingRecordAppend = this._appendResolvedArtifactTermRecords(
                            recordChunk,
                            contentOffsets,
                            contentLengths,
                            resolvedContentDictNames,
                            importMetrics,
                        );
                        const concurrentResults = await Promise.allSettled([
                            measuredContentCompletion,
                            pendingRecordAppend,
                        ]);
                        const concurrentErrors = concurrentResults
                            .filter((result) => result.status === 'rejected')
                            .map((result) => toError(result.reason));
                        if (concurrentErrors.length === 1) {
                            throw concurrentErrors[0];
                        }
                        if (concurrentErrors.length > 1) {
                            throw new AggregateError(
                                concurrentErrors,
                                'Term content and record persistence both failed',
                            );
                        }
                        this._addTermContentBlockProfile(
                            importMetrics,
                            concurrentResults[0].status === 'fulfilled' ? concurrentResults[0].value : null,
                        );
                        importMetrics.contentStoreMs += contentCompletedAt - tContentStoreStart;
                        importMetrics.contentAppendMs +=
                            Math.max(metadataPublishedAt, contentCompletedAt) - tContentAppendStart;
                        recordAppended = true;
                    }
                } catch (error) {
                    const pendingOperations = [];
                    if (pendingContentPersistence !== null) {
                        pendingOperations.push(pendingContentPersistence);
                    }
                    if (earlyContentPersistence !== null) {
                        pendingOperations.push(earlyContentPersistence.completion);
                    }
                    if (pendingRecordAppend !== null) {
                        pendingOperations.push(pendingRecordAppend);
                    }
                    await Promise.allSettled(pendingOperations);
                    throw error;
                }
            } else {
                importMetrics.contentStoreMs += safePerformance.now() - tContentStoreStart;
            }
            if (!recordAppended) {
                resolvedContentDictNames = this._compactUniformContentDictNames(resolvedContentDictNames);
                importMetrics.contentAppendMs += safePerformance.now() - tContentAppendStart;
                const recordChunk = this._createResolvedArtifactTermRecordChunk(
                    chunk,
                    preparedLookupIndexes,
                    contentDedupPlan,
                    useResolvedContentReferences,
                );
                await this._appendResolvedArtifactTermRecords(
                    recordChunk,
                    contentOffsets,
                    contentLengths,
                    resolvedContentDictNames,
                    importMetrics,
                );
            }
            if (useLocalTransaction) {
                this._requireDb().exec('COMMIT');
            }
            stagedContentMetadata = null;
            dedupPlanRollbackState = null;
            this._lastBulkAddTermsMetrics = importMetrics;
        } catch (e) {
            this._rollbackStagedArtifactTermContentMetadata(stagedContentMetadata);
            this._rollbackArtifactTermContentDedupPlan(dedupPlanRollbackState);
            if (useLocalTransaction) {
                try { this._requireDb().exec('ROLLBACK'); } catch (_) { /* NOP */ }
            }
            throw e;
        }
    }

    /**
     * @param {number} tableSize
     * @returns {{hash1Table: Uint32Array, hash2Table: Uint32Array, indexTable: Uint32Array}}
     */
    _acquireArtifactTermContentDedupScratch(tableSize) {
        let scratch = this._artifactTermContentDedupScratchPool.pop();
        if (typeof scratch === 'undefined' || scratch.indexTable.length < tableSize) {
            scratch = {
                hash1Table: new Uint32Array(tableSize),
                hash2Table: new Uint32Array(tableSize),
                indexTable: new Uint32Array(tableSize),
            };
        } else {
            scratch.indexTable.fill(0, 0, tableSize);
        }
        return scratch;
    }

    /**
     * @param {{hash1Table: Uint32Array, hash2Table: Uint32Array, indexTable: Uint32Array}} scratch
     */
    _releaseArtifactTermContentDedupScratch(scratch) {
        if (this._artifactTermContentDedupScratchPool.length < 2) {
            this._artifactTermContentDedupScratchPool.push(scratch);
        }
    }

    /**
     * Resolves intra-chunk duplicates and content already persisted by earlier chunks.
     * @param {ArtifactTermContentChunk} chunk
     * @param {boolean} [reserveMetadata]
     * @returns {Promise<{contentOffsets: Float64Array, contentLengths: Uint32Array, resolvedContentDictNames: string|(string|null)[], pendingContentBytes: Uint8Array[], pendingContentHash1s: number[], pendingContentHash2s: number[], pendingContentDictNames: (string|null)[]|null, pendingRowToUniqueIndex: Int32Array|null, pendingContentCount: number, pendingContentSpans: {buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null, uniformContentDictName: string|null, pendingHitCount: number, persistedHitCount: number, exactFallbackCount: number, contentDedupPlan: ArtifactTermContentDedupPlan|null, pendingPlanUniqueIndexes: number[], pendingPlanUniqueStart: number|null, stagedContentMetadata?: {indexes: Int32Array, active: boolean, collisionEntries?: Array<{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}>}|undefined}>}
     */
    async _resolveArtifactTermContentDedup(chunk, reserveMetadata = false) {
        const count = chunk.rowCount;
        const contentBytesBuffer = chunk.contentBytesBuffer instanceof Uint8Array ? chunk.contentBytesBuffer : null;
        const contentMetaList = contentBytesBuffer !== null && chunk.contentMetaList instanceof Uint32Array ? chunk.contentMetaList : null;
        const useContentSlab = contentMetaList !== null;
        const contentBytesBaseOffset = useContentSlab ? chunk.contentBytesBaseOffset : 0;
        if (
            useContentSlab &&
            (
                !Number.isSafeInteger(contentBytesBaseOffset) ||
                contentBytesBaseOffset < 0 ||
                contentMetaList.length < count * 4
            )
        ) {
            throw new RangeError('Artifact term content slab metadata is invalid');
        }
        const explicitContentDictNames = Array.isArray(chunk.contentDictNameList) ? chunk.contentDictNameList : null;
        const uniformContentDictName = typeof chunk.uniformContentDictName !== 'undefined' ? (chunk.uniformContentDictName ?? null) : null;
        const uniqueIndexList = chunk.contentUniqueIndexList instanceof Uint32Array &&
            chunk.contentUniqueIndexList.length >= count ?
            chunk.contentUniqueIndexList :
            null;
        const candidateDedupPlan = chunk.contentDedupPlan;
        /** @type {ArtifactTermContentDedupPlan|null} */
        const contentDedupPlan = (
            uniqueIndexList !== null &&
            typeof candidateDedupPlan === 'object' &&
            candidateDedupPlan !== null &&
            candidateDedupPlan.resolvedFlags instanceof Uint8Array &&
            candidateDedupPlan.resolvedOffsets instanceof Float64Array &&
            candidateDedupPlan.resolvedLengths instanceof Uint32Array &&
            (candidateDedupPlan.resolvedDictNames === null || Array.isArray(candidateDedupPlan.resolvedDictNames)) &&
            (
                typeof candidateDedupPlan.resolvedUniformDictName === 'undefined' ||
                typeof candidateDedupPlan.resolvedUniformDictName === 'string'
            ) &&
            candidateDedupPlan.pendingEpochs instanceof Uint32Array &&
            candidateDedupPlan.pendingIndexes instanceof Uint32Array
        ) ? /** @type {ArtifactTermContentDedupPlan} */ (candidateDedupPlan) : null;
        const useResolvedContentReferences = chunk.useResolvedContentReferences === true && contentDedupPlan !== null;
        const uniqueSignatures = (
            contentDedupPlan?.uniqueSignatures instanceof Uint32Array &&
            contentDedupPlan.uniqueSignatures.length >= contentDedupPlan.resolvedFlags.length * 3
        ) ? contentDedupPlan.uniqueSignatures : null;
        const contentOffsets = new Float64Array(useResolvedContentReferences ? 0 : count);
        const contentLengths = new Uint32Array(useResolvedContentReferences ? 0 : count);
        let pendingPlanEpoch = 0;
        let persistedLookupRequired = true;
        if (contentDedupPlan !== null) {
            pendingPlanEpoch = contentDedupPlan.nextEpoch >>> 0;
            if (pendingPlanEpoch === 0) {
                contentDedupPlan.pendingEpochs.fill(0);
                pendingPlanEpoch = 1;
            }
            contentDedupPlan.nextEpoch = (pendingPlanEpoch + 1) >>> 0;
            if (typeof contentDedupPlan.persistedLookupRequired !== 'boolean') {
                contentDedupPlan.persistedLookupRequired = this._termEntryContentMetaHashPairCount > 0;
            }
            persistedLookupRequired = contentDedupPlan.persistedLookupRequired;
        }
        /** @type {number[]} */
        const pendingPlanUniqueIndexes = [];
        /** @type {string|(string|null)[]} */
        let resolvedContentDictNames = explicitContentDictNames !== null ? new Array(count) : (uniformContentDictName ?? 'raw');
        /** @type {Uint8Array[]} */
        const pendingContentBytes = [];
        /** @type {number[]} */
        const pendingContentHash1s = [];
        /** @type {number[]} */
        const pendingContentHash2s = [];
        /** @type {(string|null)[]|null} */
        const pendingContentDictNames = (
            explicitContentDictNames === null &&
            typeof uniformContentDictName === 'string' &&
            uniformContentDictName.length > 0
        ) ? null : [];
        const ensureResolvedContentDictNamesArray = (fillUntil) => {
            if (Array.isArray(resolvedContentDictNames)) { return resolvedContentDictNames; }
            const values = new Array(count);
            if (fillUntil > 0) { values.fill(resolvedContentDictNames, 0, fillUntil); }
            resolvedContentDictNames = values;
            return values;
        };
        if (
            contentDedupPlan !== null &&
            uniqueIndexList !== null &&
            !persistedLookupRequired &&
            !useResolvedContentReferences
        ) {
            const useContentSpans = useContentSlab;
            const pendingSpanOffsets = useContentSpans ?
                getOrCreateTermContentPlanScratch(contentDedupPlan, 'pendingSpanOffsetsScratch', count) :
                null;
            const pendingSpanLengths = useContentSpans ?
                getOrCreateTermContentPlanScratch(contentDedupPlan, 'pendingSpanLengthsScratch', count) :
                null;
            const firstPendingUniqueIndex = Number.isSafeInteger(contentDedupPlan.nextUnresolvedUniqueIndex) ?
                contentDedupPlan.nextUnresolvedUniqueIndex :
                0;
            let nextPendingUniqueIndex = firstPendingUniqueIndex;
            const maximumPendingContentCount = Math.min(
                count,
                Math.max(0, contentDedupPlan.resolvedFlags.length - firstPendingUniqueIndex),
            );
            /** @type {Int32Array|null} */
            let stagedIndexes = null;
            if (reserveMetadata) {
                this._ensureTermEntryContentMetaHashPairCapacity(
                    this._getArtifactTermContentMetaCapacityHint(chunk, maximumPendingContentCount),
                );
                stagedIndexes = new Int32Array(maximumPendingContentCount);
                stagedIndexes.fill(-1);
            }
            let pendingHitCount = 0;
            try {
                for (let i = 0; i < count; ++i) {
                    const uniqueIndex = uniqueIndexList[i];
                    if (uniqueIndex >= contentDedupPlan.resolvedFlags.length) {
                        throw new RangeError(`Artifact term content unique index is invalid at row ${i}`);
                    }
                    if (uniqueIndex < firstPendingUniqueIndex) {
                        if (contentDedupPlan.resolvedFlags[uniqueIndex] !== 1) {
                            throw new Error(`Artifact term content unique index ${uniqueIndex} was not resolved`);
                        }
                        contentOffsets[i] = contentDedupPlan.resolvedOffsets[uniqueIndex];
                        contentLengths[i] = contentDedupPlan.resolvedLengths[uniqueIndex];
                        const existingDictName = getResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex);
                        if (Array.isArray(resolvedContentDictNames)) {
                            resolvedContentDictNames[i] = existingDictName;
                        } else if (existingDictName !== resolvedContentDictNames) {
                            ensureResolvedContentDictNamesArray(i)[i] = existingDictName;
                        }
                        ++pendingHitCount;
                        continue;
                    }
                    if (uniqueIndex > nextPendingUniqueIndex) {
                        throw new Error(`Artifact term content unique index ${uniqueIndex} is not contiguous`);
                    }
                    const pendingIndex = uniqueIndex - firstPendingUniqueIndex;
                    if (uniqueIndex === nextPendingUniqueIndex) {
                        const contentMetaOffset = i * 4;
                        const contentOffset = useContentSlab ?
                            contentBytesBaseOffset + contentMetaList[contentMetaOffset] :
                            0;
                        const contentLength = useContentSlab ?
                            contentMetaList[contentMetaOffset + 1] :
                            chunk.contentBytesList[i]?.byteLength;
                        if (
                            useContentSlab &&
                            (
                                contentOffset < contentBytesBaseOffset ||
                                contentOffset + contentLength > contentBytesBuffer.byteLength
                            )
                        ) {
                            throw new TypeError(`Artifact term content bytes are invalid at row ${i}`);
                        }
                        const contentBytes = useContentSlab ? contentBytesBuffer : chunk.contentBytesList[i];
                        if (!(contentBytes instanceof Uint8Array)) {
                            throw new TypeError(`Artifact term content bytes are invalid at row ${i}`);
                        }
                        if (useContentSpans) {
                            if (contentOffset > 0xffffffff) {
                                throw new RangeError(`Artifact term content offset exceeds Uint32 at row ${i}`);
                            }
                            pendingSpanOffsets[pendingIndex] = contentOffset;
                            pendingSpanLengths[pendingIndex] = contentLength;
                        } else {
                            pendingContentBytes.push(contentBytes);
                        }
                        const hash1 = (useContentSlab ? contentMetaList[contentMetaOffset + 2] : chunk.contentHash1List[i]) >>> 0;
                        const hash2 = (useContentSlab ? contentMetaList[contentMetaOffset + 3] : chunk.contentHash2List[i]) >>> 0;
                        pendingContentHash1s.push(hash1);
                        pendingContentHash2s.push(hash2);
                        if (stagedIndexes !== null) {
                            const signatureOffset = uniqueIndex * 3;
                            stagedIndexes[pendingIndex] = this._reserveArtifactTermContentMetadata(
                                hash1,
                                hash2,
                                contentBytes,
                                contentOffset,
                                contentLength,
                                uniqueSignatures?.[signatureOffset],
                                uniqueSignatures?.[signatureOffset + 1],
                                uniqueSignatures?.[signatureOffset + 2],
                            );
                        }
                        if (pendingContentDictNames !== null) {
                            pendingContentDictNames.push(
                                explicitContentDictNames !== null ?
                                    (explicitContentDictNames[i] ?? null) :
                                    uniformContentDictName,
                            );
                        }
                        ++nextPendingUniqueIndex;
                    } else {
                        ++pendingHitCount;
                    }
                }
            } catch (error) {
                if (stagedIndexes !== null) {
                    this._rollbackStagedArtifactTermContentMetadata({indexes: stagedIndexes, active: true});
                }
                throw error;
            }
            contentDedupPlan.nextUnresolvedUniqueIndex = nextPendingUniqueIndex;
            const pendingContentCount = nextPendingUniqueIndex - firstPendingUniqueIndex;
            const pendingContentSpans = useContentSpans ?
                {
                    buffer: contentBytesBuffer,
                    offsets: pendingSpanOffsets.subarray(0, pendingContentCount),
                    lengths: pendingSpanLengths.subarray(0, pendingContentCount),
                } :
                null;
            return {
                contentOffsets,
                contentLengths,
                resolvedContentDictNames,
                pendingContentBytes,
                pendingContentHash1s,
                pendingContentHash2s,
                pendingContentDictNames,
                pendingRowToUniqueIndex: null,
                pendingContentCount,
                pendingContentSpans,
                uniformContentDictName,
                pendingHitCount,
                persistedHitCount: 0,
                exactFallbackCount: 0,
                contentDedupPlan,
                pendingPlanUniqueIndexes,
                pendingPlanUniqueStart: firstPendingUniqueIndex,
                stagedContentMetadata: stagedIndexes === null ?
                    void 0 :
                    {
                        indexes: stagedIndexes.subarray(0, pendingContentCount),
                        active: true,
                    },
            };
        }
        const uniqueRowIndexes = contentDedupPlan?.uniqueRowIndexes;
        const contentRowStart = chunk.contentRowStart;
        if (
            contentDedupPlan !== null &&
            uniqueIndexList !== null &&
            (persistedLookupRequired || useResolvedContentReferences) &&
            useContentSlab &&
            uniqueRowIndexes instanceof Uint32Array &&
            uniqueRowIndexes.length === contentDedupPlan.resolvedFlags.length &&
            typeof contentRowStart === 'number' &&
            Number.isSafeInteger(contentRowStart) &&
            contentRowStart >= 0
        ) {
            const contentRowEnd = contentRowStart + count;
            if (!Number.isSafeInteger(contentRowEnd)) {
                throw new RangeError('Artifact term content row range exceeds safe integer bounds');
            }
            const firstUniqueIndex = lowerBoundUint32(uniqueRowIndexes, contentRowStart);
            const lastUniqueIndex = lowerBoundUint32(uniqueRowIndexes, contentRowEnd);
            const pendingSpanOffsets = getOrCreateTermContentPlanScratch(
                contentDedupPlan,
                'pendingSpanOffsetsScratch',
                lastUniqueIndex - firstUniqueIndex,
            );
            const pendingSpanLengths = getOrCreateTermContentPlanScratch(
                contentDedupPlan,
                'pendingSpanLengthsScratch',
                lastUniqueIndex - firstUniqueIndex,
            );
            /** @type {Int32Array|null} */
            let stagedIndexes = null;
            if (reserveMetadata) {
                const maximumPendingContentCount = lastUniqueIndex - firstUniqueIndex;
                this._ensureTermEntryContentMetaHashPairCapacity(
                    this._getArtifactTermContentMetaCapacityHint(chunk, maximumPendingContentCount),
                );
                stagedIndexes = new Int32Array(maximumPendingContentCount);
                stagedIndexes.fill(-1);
            }
            let pendingContentCount = 0;
            let persistedHitCount = 0;
            let exactFallbackCount = 0;
            let alreadyResolvedUniqueCount = 0;
            try {
                for (let uniqueIndex = firstUniqueIndex; uniqueIndex < lastUniqueIndex; ++uniqueIndex) {
                    const globalRowIndex = uniqueRowIndexes[uniqueIndex];
                    const rowIndex = globalRowIndex - contentRowStart;
                    if (
                        rowIndex < 0 ||
                        rowIndex >= count ||
                        uniqueIndexList[rowIndex] !== uniqueIndex
                    ) {
                        throw new Error(`Artifact term content canonical row is invalid for unique index ${uniqueIndex}`);
                    }
                    if (contentDedupPlan.resolvedFlags[uniqueIndex] === 1) {
                        ++alreadyResolvedUniqueCount;
                        continue;
                    }
                    const contentMetaOffset = rowIndex * 4;
                    const contentOffset = contentBytesBaseOffset + contentMetaList[contentMetaOffset];
                    const contentLength = contentMetaList[contentMetaOffset + 1];
                    const hash1 = contentMetaList[contentMetaOffset + 2] >>> 0;
                    const hash2 = contentMetaList[contentMetaOffset + 3] >>> 0;
                    if (
                        contentOffset < contentBytesBaseOffset ||
                        contentOffset + contentLength > contentBytesBuffer.byteLength
                    ) {
                        throw new TypeError(`Artifact term content bytes are invalid at row ${rowIndex}`);
                    }
                    const existingIndex = persistedLookupRequired ?
                        this._findTermEntryContentMetaHashPairIndex(hash1, hash2) :
                        -1;
                    if (
                        existingIndex >= 0 &&
                        this._termEntryContentMetaLengthTable[existingIndex] === contentLength &&
                        this._termEntryContentMetaSignaturePresentTable[existingIndex] === 1
                    ) {
                        const lastOffset = Math.max(0, contentLength - 4);
                        if (
                            this._termEntryContentMetaSignature1Table[existingIndex] === this._readTermContentSignature(contentBytesBuffer, contentOffset) &&
                            this._termEntryContentMetaSignature2Table[existingIndex] === this._readTermContentSignature(contentBytesBuffer, contentOffset + Math.floor(lastOffset / 2)) &&
                            this._termEntryContentMetaSignature3Table[existingIndex] === this._readTermContentSignature(contentBytesBuffer, contentOffset + lastOffset)
                        ) {
                            const existingDictName = this._termEntryContentMetaDictNames[
                                this._termEntryContentMetaDictNameIdTable[existingIndex]
                            ] ?? 'raw';
                            contentDedupPlan.resolvedOffsets[uniqueIndex] = this._termEntryContentMetaOffsetTable[existingIndex];
                            contentDedupPlan.resolvedLengths[uniqueIndex] = contentLength;
                            setResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex, existingDictName);
                            contentDedupPlan.resolvedFlags[uniqueIndex] = 1;
                            ++persistedHitCount;
                            continue;
                        }
                    }
                    let existingMeta = existingIndex < 0 ? void 0 : this._readTermEntryContentMetaHashPairIndex(existingIndex);
                    if (typeof existingMeta !== 'undefined') {
                        ++exactFallbackCount;
                        const contentBytes = contentBytesBuffer.subarray(contentOffset, contentOffset + contentLength);
                        const matchingMeta = this._findMatchingTermEntryContentMeta(hash1, hash2, contentBytes, existingMeta);
                        existingMeta = matchingMeta instanceof Promise ? await matchingMeta : matchingMeta;
                    }
                    if (typeof existingMeta !== 'undefined') {
                        contentDedupPlan.resolvedOffsets[uniqueIndex] = existingMeta.offset;
                        contentDedupPlan.resolvedLengths[uniqueIndex] = existingMeta.length;
                        setResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex, existingMeta.dictName);
                        contentDedupPlan.resolvedFlags[uniqueIndex] = 1;
                        ++persistedHitCount;
                        continue;
                    }
                    if (contentOffset > 0xffffffff) {
                        throw new RangeError(`Artifact term content offset exceeds Uint32 at row ${rowIndex}`);
                    }
                    pendingSpanOffsets[pendingContentCount] = contentOffset;
                    pendingSpanLengths[pendingContentCount] = contentLength;
                    pendingContentHash1s.push(hash1);
                    pendingContentHash2s.push(hash2);
                    if (stagedIndexes !== null) {
                        const signatureOffset = uniqueIndex * 3;
                        stagedIndexes[pendingContentCount] = this._reserveArtifactTermContentMetadata(
                            hash1,
                            hash2,
                            contentBytesBuffer,
                            contentOffset,
                            contentLength,
                            uniqueSignatures?.[signatureOffset],
                            uniqueSignatures?.[signatureOffset + 1],
                            uniqueSignatures?.[signatureOffset + 2],
                        );
                    }
                    if (pendingContentDictNames !== null) {
                        pendingContentDictNames.push(
                            explicitContentDictNames !== null ?
                                (explicitContentDictNames[rowIndex] ?? null) :
                                uniformContentDictName,
                        );
                    }
                    contentDedupPlan.pendingEpochs[uniqueIndex] = pendingPlanEpoch;
                    contentDedupPlan.pendingIndexes[uniqueIndex] = pendingContentCount;
                    pendingPlanUniqueIndexes.push(uniqueIndex);
                    ++pendingContentCount;
                }
            } catch (error) {
                if (stagedIndexes !== null) {
                    this._rollbackStagedArtifactTermContentMetadata({indexes: stagedIndexes, active: true});
                }
                throw error;
            }
            let pendingHitCount = count - (lastUniqueIndex - firstUniqueIndex) + alreadyResolvedUniqueCount;
            // Pending rows force a later whole-chunk projection after their
            // persisted offsets arrive, so projecting resolved hits now would
            // only traverse the same rows twice.
            if (pendingContentCount === 0 && !useResolvedContentReferences) {
                for (let rowIndex = 0; rowIndex < count; ++rowIndex) {
                    const uniqueIndex = uniqueIndexList[rowIndex];
                    if (uniqueIndex >= contentDedupPlan.resolvedFlags.length) {
                        throw new RangeError(`Artifact term content unique index is invalid at row ${rowIndex}`);
                    }
                    if (contentDedupPlan.resolvedFlags[uniqueIndex] !== 1) { continue; }
                    contentOffsets[rowIndex] = contentDedupPlan.resolvedOffsets[uniqueIndex];
                    contentLengths[rowIndex] = contentDedupPlan.resolvedLengths[uniqueIndex];
                    const existingDictName = getResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex);
                    if (Array.isArray(resolvedContentDictNames)) {
                        resolvedContentDictNames[rowIndex] = existingDictName;
                    } else if (existingDictName !== resolvedContentDictNames) {
                        ensureResolvedContentDictNamesArray(rowIndex)[rowIndex] = existingDictName;
                    }
                }
            }
            if (useResolvedContentReferences && pendingContentCount === 0) {
                resolvedContentDictNames = resolveArtifactTermContentPlanDictNames(
                    contentDedupPlan,
                    uniqueIndexList,
                    count,
                );
            }
            if (pendingHitCount < 0) { pendingHitCount = 0; }
            return {
                contentOffsets,
                contentLengths,
                resolvedContentDictNames,
                pendingContentBytes,
                pendingContentHash1s,
                pendingContentHash2s,
                pendingContentDictNames,
                pendingRowToUniqueIndex: null,
                pendingContentCount,
                pendingContentSpans: {
                    buffer: contentBytesBuffer,
                    offsets: pendingSpanOffsets.subarray(0, pendingContentCount),
                    lengths: pendingSpanLengths.subarray(0, pendingContentCount),
                },
                uniformContentDictName,
                pendingHitCount,
                persistedHitCount,
                exactFallbackCount,
                contentDedupPlan,
                pendingPlanUniqueIndexes,
                pendingPlanUniqueStart: null,
                stagedContentMetadata: stagedIndexes === null ?
                    void 0 :
                    {
                        indexes: stagedIndexes.subarray(0, pendingContentCount),
                        active: true,
                    },
            };
        }
        let tableSize = 1;
        while (tableSize < count * 2) { tableSize *= 2; }
        const tableMask = tableSize - 1;
        const scratch = contentDedupPlan === null ?
            this._acquireArtifactTermContentDedupScratch(tableSize) :
            null;
        const pendingHash1Table = scratch?.hash1Table ?? null;
        const pendingHash2Table = scratch?.hash2Table ?? null;
        const pendingIndexTable = scratch?.indexTable ?? null;
        /** @type {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null} */
        let pendingContentSpans = null;
        const usePendingContentSpans = useContentSlab && contentDedupPlan !== null;
        const pendingSpanOffsets = usePendingContentSpans ?
            getOrCreateTermContentPlanScratch(contentDedupPlan, 'pendingSpanOffsetsScratch', count) :
            null;
        const pendingSpanLengths = usePendingContentSpans ?
            getOrCreateTermContentPlanScratch(contentDedupPlan, 'pendingSpanLengthsScratch', count) :
            null;
        let pendingContentCount = 0;
        const pendingRowToUniqueIndex = new Int32Array(count);
        pendingRowToUniqueIndex.fill(-1);
        let pendingHitCount = 0;
        let persistedHitCount = 0;
        let exactFallbackCount = 0;

        const getPendingHashSlot = (hash1, hash2) => {
            let value = (hash1 ^ Math.imul(hash2, 0x9e3779b1)) >>> 0;
            value ^= value >>> 16;
            return value & tableMask;
        };
        let pendingInsertSlot = -1;
        const findPendingContentIndex = (hash1, hash2, contentBytes, contentOffset, contentLength) => {
            if (contentDedupPlan !== null && uniqueIndexList !== null) {
                const uniqueIndex = uniqueIndexList[currentRowIndex];
                return contentDedupPlan.pendingEpochs[uniqueIndex] === pendingPlanEpoch ?
                    contentDedupPlan.pendingIndexes[uniqueIndex] :
                    -1;
            }
            let slot = getPendingHashSlot(hash1, hash2);
            while (true) {
                const storedIndex = /** @type {Uint32Array} */ (pendingIndexTable)[slot];
                if (storedIndex === 0) {
                    pendingInsertSlot = slot;
                    return -1;
                }
                if (
                    /** @type {Uint32Array} */ (pendingHash1Table)[slot] === hash1 &&
                    /** @type {Uint32Array} */ (pendingHash2Table)[slot] === hash2
                ) {
                    const pendingIndex = storedIndex - 1;
                    const matches = useContentSlab ?
                        this._termContentBytesEqualSpan(pendingContentBytes[pendingIndex], contentBytesBuffer, contentOffset, contentLength) :
                        this._termContentBytesEqual(pendingContentBytes[pendingIndex], contentBytes);
                    if (matches) {
                        return pendingIndex;
                    }
                }
                slot = (slot + 1) & tableMask;
            }
        };
        const insertPendingContentIndex = (hash1, hash2) => {
            if (contentDedupPlan !== null && uniqueIndexList !== null) {
                const pendingIndex = pendingContentCount;
                const uniqueIndex = uniqueIndexList[currentRowIndex];
                contentDedupPlan.pendingEpochs[uniqueIndex] = pendingPlanEpoch;
                contentDedupPlan.pendingIndexes[uniqueIndex] = pendingIndex;
                pendingPlanUniqueIndexes.push(uniqueIndex);
                return pendingIndex;
            }
            const slot = pendingInsertSlot;
            if (slot < 0 || /** @type {Uint32Array} */ (pendingIndexTable)[slot] !== 0) {
                throw new Error('Invalid pending term content insertion slot');
            }
            const pendingIndex = pendingContentCount;
            /** @type {Uint32Array} */ (pendingHash1Table)[slot] = hash1;
            /** @type {Uint32Array} */ (pendingHash2Table)[slot] = hash2;
            /** @type {Uint32Array} */ (pendingIndexTable)[slot] = pendingIndex + 1;
            return pendingIndex;
        };
        let currentRowIndex = 0;
        try {
            for (let i = 0; i < count; ++i) {
                currentRowIndex = i;
                const contentMetaOffset = i * 4;
                const hash1 = (useContentSlab ? contentMetaList[contentMetaOffset + 2] : chunk.contentHash1List[i]) >>> 0;
                const hash2 = (useContentSlab ? contentMetaList[contentMetaOffset + 3] : chunk.contentHash2List[i]) >>> 0;
                const contentOffset = useContentSlab ? contentBytesBaseOffset + contentMetaList[contentMetaOffset] : 0;
                const contentLength = useContentSlab ? contentMetaList[contentMetaOffset + 1] : chunk.contentBytesList[i]?.byteLength;
                let contentBytes = useContentSlab ? null : chunk.contentBytesList[i];
                if (
                    useContentSlab ?
                        (contentOffset < contentBytesBaseOffset || contentOffset + contentLength > contentBytesBuffer.byteLength) :
                        !(contentBytes instanceof Uint8Array)
                ) {
                    throw new TypeError(`Artifact term content bytes are invalid at row ${i}`);
                }
                if (contentDedupPlan !== null && uniqueIndexList !== null) {
                    const uniqueIndex = uniqueIndexList[i];
                    if (uniqueIndex >= contentDedupPlan.resolvedFlags.length) {
                        throw new RangeError(`Artifact term content unique index is invalid at row ${i}`);
                    }
                    if (contentDedupPlan.resolvedFlags[uniqueIndex] === 1) {
                        contentOffsets[i] = contentDedupPlan.resolvedOffsets[uniqueIndex];
                        contentLengths[i] = contentDedupPlan.resolvedLengths[uniqueIndex];
                        const existingDictName = getResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex);
                        if (Array.isArray(resolvedContentDictNames)) {
                            resolvedContentDictNames[i] = existingDictName;
                        } else if (existingDictName !== resolvedContentDictNames) {
                            ensureResolvedContentDictNamesArray(i)[i] = existingDictName;
                        }
                        ++pendingHitCount;
                        continue;
                    }
                }
                const existingPendingIndex = findPendingContentIndex(hash1, hash2, contentBytes, contentOffset, contentLength);
                if (existingPendingIndex >= 0) {
                    ++pendingHitCount;
                    pendingRowToUniqueIndex[i] = existingPendingIndex;
                    continue;
                }
                const existingIndex = persistedLookupRequired ?
                    this._findTermEntryContentMetaHashPairIndex(hash1, hash2) :
                    -1;
                if (
                    existingIndex >= 0 &&
                    this._termEntryContentMetaLengthTable[existingIndex] === contentLength &&
                    this._termEntryContentMetaSignaturePresentTable[existingIndex] === 1
                ) {
                    const lastOffset = Math.max(0, contentLength - 4);
                    const useDirectSlabSignature = useContentSlab && contentLength >= 4;
                    if (!useDirectSlabSignature && contentBytes === null) {
                        contentBytes = contentBytesBuffer.subarray(contentOffset, contentOffset + contentLength);
                    }
                    const signatureBytes = useDirectSlabSignature ? contentBytesBuffer : contentBytes;
                    const signatureBaseOffset = useDirectSlabSignature ? contentOffset : 0;
                    if (
                        this._termEntryContentMetaSignature1Table[existingIndex] === this._readTermContentSignature(signatureBytes, signatureBaseOffset) &&
                        this._termEntryContentMetaSignature2Table[existingIndex] === this._readTermContentSignature(signatureBytes, signatureBaseOffset + Math.floor(lastOffset / 2)) &&
                        this._termEntryContentMetaSignature3Table[existingIndex] === this._readTermContentSignature(signatureBytes, signatureBaseOffset + lastOffset)
                    ) {
                        contentOffsets[i] = this._termEntryContentMetaOffsetTable[existingIndex];
                        contentLengths[i] = contentLength;
                        const existingDictName = this._termEntryContentMetaDictNames[
                            this._termEntryContentMetaDictNameIdTable[existingIndex]
                        ] ?? 'raw';
                        if (Array.isArray(resolvedContentDictNames)) {
                            resolvedContentDictNames[i] = existingDictName;
                        } else if (existingDictName !== resolvedContentDictNames) {
                            ensureResolvedContentDictNamesArray(i)[i] = existingDictName;
                        }
                        ++persistedHitCount;
                        if (contentDedupPlan !== null && uniqueIndexList !== null) {
                            const uniqueIndex = uniqueIndexList[i];
                            contentDedupPlan.resolvedOffsets[uniqueIndex] = contentOffsets[i];
                            contentDedupPlan.resolvedLengths[uniqueIndex] = contentLengths[i];
                            setResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex, existingDictName);
                            contentDedupPlan.resolvedFlags[uniqueIndex] = 1;
                        }
                        continue;
                    }
                }
                let existingMeta = existingIndex < 0 ? void 0 : this._readTermEntryContentMetaHashPairIndex(existingIndex);
                if (typeof existingMeta !== 'undefined') {
                    ++exactFallbackCount;
                    if (contentBytes === null) {
                        contentBytes = contentBytesBuffer.subarray(contentOffset, contentOffset + contentLength);
                    }
                    existingMeta = this._findMatchingTermEntryContentMeta(hash1, hash2, contentBytes, existingMeta);
                    if (existingMeta instanceof Promise) { existingMeta = await existingMeta; }
                }
                if (typeof existingMeta !== 'undefined') {
                    ++persistedHitCount;
                    contentOffsets[i] = existingMeta.offset;
                    contentLengths[i] = existingMeta.length;
                    if (Array.isArray(resolvedContentDictNames)) {
                        resolvedContentDictNames[i] = existingMeta.dictName;
                    } else if (existingMeta.dictName !== resolvedContentDictNames) {
                        ensureResolvedContentDictNamesArray(i)[i] = existingMeta.dictName;
                    }
                    if (contentDedupPlan !== null && uniqueIndexList !== null) {
                        const uniqueIndex = uniqueIndexList[i];
                        contentDedupPlan.resolvedOffsets[uniqueIndex] = existingMeta.offset;
                        contentDedupPlan.resolvedLengths[uniqueIndex] = existingMeta.length;
                        setResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex, existingMeta.dictName);
                        contentDedupPlan.resolvedFlags[uniqueIndex] = 1;
                    }
                    continue;
                }
                const pendingIndex = insertPendingContentIndex(hash1, hash2);
                if (usePendingContentSpans) {
                    if (contentOffset > 0xffffffff) {
                        throw new RangeError(`Artifact term content offset exceeds Uint32 at row ${i}`);
                    }
                    pendingSpanOffsets[pendingIndex] = contentOffset;
                    pendingSpanLengths[pendingIndex] = contentLength;
                } else if (contentBytes === null) {
                    contentBytes = contentBytesBuffer.subarray(contentOffset, contentOffset + contentLength);
                }
                if (!usePendingContentSpans) {
                    pendingContentBytes.push(contentBytes);
                }
                pendingContentHash1s.push(hash1);
                pendingContentHash2s.push(hash2);
                if (pendingContentDictNames !== null) {
                    pendingContentDictNames.push(explicitContentDictNames !== null ? (explicitContentDictNames[i] ?? null) : uniformContentDictName);
                }
                pendingRowToUniqueIndex[i] = pendingIndex;
                ++pendingContentCount;
            }
        } finally {
            if (scratch !== null) {
                this._releaseArtifactTermContentDedupScratch(scratch);
            }
        }
        if (usePendingContentSpans) {
            pendingContentSpans = {
                buffer: contentBytesBuffer,
                offsets: pendingSpanOffsets.subarray(0, pendingContentCount),
                lengths: pendingSpanLengths.subarray(0, pendingContentCount),
            };
        }
        return {
            contentOffsets,
            contentLengths,
            resolvedContentDictNames,
            pendingContentBytes,
            pendingContentHash1s,
            pendingContentHash2s,
            pendingContentDictNames,
            pendingRowToUniqueIndex,
            pendingContentCount,
            pendingContentSpans,
            uniformContentDictName,
            pendingHitCount,
            persistedHitCount,
            exactFallbackCount,
            contentDedupPlan,
            pendingPlanUniqueIndexes,
            pendingPlanUniqueStart: null,
        };
    }

    /**
     * @param {Record<string, number>} importMetrics
     * @param {{packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss?: boolean}|null} blockProfile
     */
    _addTermContentBlockProfile(importMetrics, blockProfile) {
        if (blockProfile === null) { return; }
        importMetrics.contentPackMs += blockProfile.packMs;
        importMetrics.contentCompressMs += blockProfile.compressMs;
        importMetrics.contentEnvelopeMs += blockProfile.envelopeMs;
        importMetrics.contentReferenceMs += blockProfile.referenceMs;
        importMetrics.contentOpfsAppendMs += blockProfile.opfsAppendMs;
        if (blockProfile.initialSelectionSavingsMiss === true) {
            importMetrics.contentInitialReservationSavingsMissCount += 1;
        }
    }

    /**
     * Starts the reservation-capable block path for an already-enabled JMdict
     * import. A null result means the caller must use normal persistence.
     * @param {string} dictionary
     * @param {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null} pendingContentSpans
     * @param {(() => void)|undefined} releaseBorrowedContent
     * @returns {{storage: Promise<{pendingOffsets: Float64Array, pendingLengths: Uint32Array, pendingResolvedDictNames: string}>, completion: Promise<{packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number, initialSelectionSavingsMiss: boolean}>, initialSelection: boolean}|null}
     */
    _tryBeginPersistArtifactTermContent(dictionary, pendingContentSpans, releaseBorrowedContent) {
        if (
            !this._termContentZstdInitialized ||
            pendingContentSpans === null ||
            this._termContentBlockImportSession === null
        ) {
            return null;
        }
        const compressionDictName = resolveTermContentZstdDictName(dictionary);
        const operation = this._termContentBlockImportSession.tryBeginAppendSpans(
            dictionary,
            pendingContentSpans.buffer,
            pendingContentSpans.offsets,
            pendingContentSpans.lengths,
            compressionDictName,
        );
        if (operation === null) { return null; }
        if (typeof releaseBorrowedContent === 'function') {
            void operation.sourceConsumed.then(releaseBorrowedContent, () => {});
        }
        const storage = operation.storage.then((blockStorage) => ({
            pendingOffsets: blockStorage.contentOffsets,
            pendingLengths: blockStorage.contentLengths,
            pendingResolvedDictNames: blockStorage.contentDictName,
            [VALIDATED_TERM_CONTENT_METADATA]: true,
        }));
        const completion = operation.completion.then((blockStorage) => ({
            packMs: blockStorage.packMs,
            compressMs: blockStorage.compressMs,
            envelopeMs: blockStorage.envelopeMs,
            referenceMs: blockStorage.referenceMs,
            opfsAppendMs: blockStorage.opfsAppendMs,
            initialSelectionSavingsMiss: blockStorage.initialSelectionSavingsMiss,
        }));
        void storage.catch(() => {});
        void completion.catch(() => {});
        return {storage, completion, initialSelection: operation.initialSelection};
    }

    /**
     * Persists the unique content selected by the dedup phase.
     * @param {string} dictionary
     * @param {Uint8Array[]} pendingContentBytes
     * @param {(string|null)[]|null} pendingContentDictNames
     * @param {string|null} uniformContentDictName
     * @param {{buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null} pendingContentSpans
     * @returns {Promise<{pendingOffsets: number[]|Float64Array, pendingLengths: number[]|Uint32Array, pendingResolvedDictNames: string|string[], blockProfile: {packMs: number, compressMs: number, envelopeMs: number, referenceMs: number, opfsAppendMs: number}|null}>}
     */
    async _persistArtifactTermContent(dictionary, pendingContentBytes, pendingContentDictNames, uniformContentDictName, pendingContentSpans) {
        const compressionDictName = resolveTermContentZstdDictName(dictionary);
        const ownsBlockSession = this._termContentBlockImportSession === null;
        const blockSession = this._termContentBlockImportSession ?? this._termContentBlockStore.beginImportSession();
        let blockStorage = null;
        try {
            if (this._termContentZstdInitialized) {
                blockStorage = pendingContentSpans === null ?
                    await blockSession.append(dictionary, pendingContentBytes, compressionDictName) :
                    await blockSession.appendSpans(
                        dictionary,
                        pendingContentSpans.buffer,
                        pendingContentSpans.offsets,
                        pendingContentSpans.lengths,
                        compressionDictName,
                    );
            }
        } finally {
            if (ownsBlockSession) { blockSession.close(); }
        }
        if (blockStorage !== null) {
            return {
                pendingOffsets: blockStorage.contentOffsets,
                pendingLengths: blockStorage.contentLengths,
                pendingResolvedDictNames: blockStorage.contentDictName,
                [VALIDATED_TERM_CONTENT_METADATA]: true,
                blockProfile: {
                    packMs: blockStorage.packMs,
                    compressMs: blockStorage.compressMs,
                    envelopeMs: blockStorage.envelopeMs,
                    referenceMs: blockStorage.referenceMs,
                    opfsAppendMs: blockStorage.opfsAppendMs,
                },
            };
        }

        if (pendingContentSpans !== null) {
            pendingContentBytes = new Array(pendingContentSpans.lengths.length);
            for (let i = 0; i < pendingContentBytes.length; ++i) {
                const offset = pendingContentSpans.offsets[i];
                pendingContentBytes[i] = pendingContentSpans.buffer.subarray(
                    offset,
                    offset + pendingContentSpans.lengths[i],
                );
            }
        }
        const storageChunks = this._createTermContentStorageChunks(
            pendingContentBytes,
            compressionDictName,
            pendingContentDictNames ?? [],
            pendingContentDictNames === null ? uniformContentDictName : null,
        );
        /** @type {number[]} */
        const storedOffsets = [];
        /** @type {number[]} */
        const storedLengths = [];
        await this._termContentStore.appendBatchToArrays(storageChunks.storedChunks, storedOffsets, storedLengths);
        const pendingOffsets = new Array(pendingContentBytes.length);
        const pendingLengths = new Array(pendingContentBytes.length);
        /** @type {string|string[]} */
        const pendingResolvedDictNames = pendingContentDictNames === null ?
            (uniformContentDictName ?? 'raw') :
            new Array(pendingContentBytes.length);
        for (let i = 0; i < pendingContentBytes.length; ++i) {
            const storedChunkIndex = storageChunks.entryToStoredChunkIndexes[i];
            pendingOffsets[i] = storedOffsets[storedChunkIndex] + (storageChunks.entryToStoredChunkOffsets[i] ?? 0);
            pendingLengths[i] = pendingContentBytes[i].byteLength;
            if (Array.isArray(pendingResolvedDictNames)) {
                pendingResolvedDictNames[i] = storageChunks.contentDictNames[i] ?? 'raw';
            }
        }
        return {pendingOffsets, pendingLengths, pendingResolvedDictNames, blockProfile: null};
    }

    /**
     * Publishes persisted offsets to rows and to the in-memory dedup index.
     * @param {{count: number, contentOffsets: Float64Array, contentLengths: Uint32Array, resolvedContentDictNames: string|(string|null)[], pendingRowToUniqueIndex: Int32Array|null, pendingContentBytes: Uint8Array[], pendingContentHash1s: number[], pendingContentHash2s: number[], pendingOffsets: number[]|Float64Array, pendingLengths: number[]|Uint32Array, pendingResolvedDictNames: string|string[], pendingContentSpans: {buffer: Uint8Array, offsets: Uint32Array, lengths: Uint32Array}|null, contentDedupPlan?: ArtifactTermContentDedupPlan|null, contentUniqueIndexList?: Uint32Array, stagedContentMetadata?: {indexes: Int32Array, active: boolean, collisionEntries?: Array<{key: string, meta: {id: number, offset: number, length: number, dictName: string, signature1?: number, signature2?: number, signature3?: number}}>}|null, importMetrics?: Record<string, number>, metadataValidated?: boolean, useResolvedContentReferences?: boolean}} state
     * @returns {string|(string|null)[]}
     * @throws {Error} If dedup projections or persisted metadata are invalid.
     */
    _publishArtifactTermContentMetadata(state) {
        const {
            count,
            contentOffsets,
            contentLengths,
            pendingRowToUniqueIndex,
            pendingContentBytes,
            pendingContentHash1s,
            pendingContentHash2s,
            pendingOffsets,
            pendingLengths,
            pendingResolvedDictNames,
            pendingContentSpans,
            contentDedupPlan = null,
            contentUniqueIndexList,
            stagedContentMetadata = null,
            importMetrics = null,
            metadataValidated = false,
            useResolvedContentReferences = false,
        } = state;
        let {resolvedContentDictNames} = state;
        const ensureResolvedContentDictNamesArray = (fillUntil) => {
            if (Array.isArray(resolvedContentDictNames)) { return resolvedContentDictNames; }
            const values = new Array(count);
            if (fillUntil > 0) { values.fill(resolvedContentDictNames, 0, fillUntil); }
            resolvedContentDictNames = values;
            return values;
        };
        const projectionStart = importMetrics === null ? 0 : safePerformance.now();
        if (pendingRowToUniqueIndex === null) {
            if (
                contentDedupPlan === null ||
                !(contentUniqueIndexList instanceof Uint32Array) ||
                contentUniqueIndexList.length < count
            ) {
                throw new Error('Artifact term content dedupe plan projection is unavailable');
            }
            if (useResolvedContentReferences) {
                resolvedContentDictNames = resolveArtifactTermContentPlanDictNames(
                    contentDedupPlan,
                    contentUniqueIndexList,
                    count,
                );
            } else {
                for (let i = 0; i < count; ++i) {
                    const uniqueIndex = contentUniqueIndexList[i];
                    if (contentDedupPlan.resolvedFlags[uniqueIndex] !== 1) {
                        throw new Error(`Artifact term content unique index ${uniqueIndex} was not published`);
                    }
                    contentOffsets[i] = contentDedupPlan.resolvedOffsets[uniqueIndex];
                    contentLengths[i] = contentDedupPlan.resolvedLengths[uniqueIndex];
                    const resolvedContentDictName = getResolvedTermContentPlanDictName(contentDedupPlan, uniqueIndex);
                    if (Array.isArray(resolvedContentDictNames)) {
                        resolvedContentDictNames[i] = resolvedContentDictName;
                    } else if (resolvedContentDictName !== resolvedContentDictNames) {
                        ensureResolvedContentDictNamesArray(i)[i] = resolvedContentDictName;
                    }
                }
            }
        } else {
            for (let i = 0; i < count; ++i) {
                const pendingIndex = pendingRowToUniqueIndex[i];
                if (pendingIndex < 0) { continue; }
                contentOffsets[i] = pendingOffsets[pendingIndex];
                contentLengths[i] = pendingLengths[pendingIndex];
                const resolvedContentDictName = Array.isArray(pendingResolvedDictNames) ?
                    pendingResolvedDictNames[pendingIndex] :
                    pendingResolvedDictNames;
                if (Array.isArray(resolvedContentDictNames)) {
                    resolvedContentDictNames[i] = resolvedContentDictName;
                } else if (resolvedContentDictName !== resolvedContentDictNames) {
                    ensureResolvedContentDictNamesArray(i)[i] = resolvedContentDictName;
                }
            }
        }
        if (importMetrics !== null) {
            importMetrics.contentMetadataProjectionMs += safePerformance.now() - projectionStart;
        }
        const indexPublishStart = importMetrics === null ? 0 : safePerformance.now();
        const uniformPendingDictName = Array.isArray(pendingResolvedDictNames) ? null : pendingResolvedDictNames;
        const uniformPendingDictNameId = uniformPendingDictName === null ?
            -1 :
            this._internTermEntryContentMetaDictName(uniformPendingDictName);
        for (let i = 0; i < pendingOffsets.length; ++i) {
            const dictName = uniformPendingDictName ?? pendingResolvedDictNames[i];
            const dictNameId = uniformPendingDictNameId >= 0 ?
                uniformPendingDictNameId :
                this._internTermEntryContentMetaDictName(dictName);
            const contentBytes = pendingContentSpans === null ?
                pendingContentBytes[i] :
                pendingContentSpans.buffer;
            const contentByteOffset = pendingContentSpans === null ?
                0 :
                pendingContentSpans.offsets[i];
            const reservedIndex = stagedContentMetadata?.indexes[i] ?? -1;
            const stagedIndex = stagedContentMetadata === null ?
                -1 :
                this._resolveStagedArtifactTermContentIndex(
                    stagedContentMetadata,
                    i,
                    pendingContentHash1s[i],
                    pendingContentHash2s[i],
                );
            if (
                stagedIndex >= 0 &&
                this._termEntryContentMetaStateTable[stagedIndex] === TERM_CONTENT_META_SLOT_PENDING
            ) {
                const offset = pendingOffsets[i];
                const length = pendingLengths[i];
                if (!metadataValidated && (!Number.isSafeInteger(offset) || offset < 0)) {
                    throw new RangeError(`Invalid term content metadata offset: ${offset}`);
                }
                if (
                    (!metadataValidated && (
                        !Number.isSafeInteger(length) ||
                        length < 0 ||
                        length >= TERM_CONTENT_META_U32_NULL
                    )) ||
                    this._termEntryContentMetaLengthTable[stagedIndex] !== length
                ) {
                    throw new RangeError(`Invalid staged term content metadata length: ${length}`);
                }
                this._termEntryContentMetaIdTable[stagedIndex] = 0;
                this._termEntryContentMetaOffsetTable[stagedIndex] = offset;
                this._termEntryContentMetaDictNameIdTable[stagedIndex] = dictNameId;
                this._termEntryContentMetaStateTable[stagedIndex] = TERM_CONTENT_META_SLOT_PUBLISHED;
                --this._termEntryContentMetaHashPairPendingCount;
                ++this._termEntryContentMetaHashPairCount;
                continue;
            }
            if (stagedContentMetadata !== null && reservedIndex < 0) {
                const collisionEntry = this._appendStagedTermEntryContentMetaCollision(
                    pendingContentHash1s[i],
                    pendingContentHash2s[i],
                    pendingOffsets[i],
                    pendingLengths[i],
                    dictName,
                    contentBytes,
                    contentByteOffset,
                );
                (stagedContentMetadata.collisionEntries ??= []).push(collisionEntry);
                continue;
            }
            this._insertTermEntryContentMetaByHashPairFast(
                pendingContentHash1s[i],
                pendingContentHash2s[i],
                pendingOffsets[i],
                pendingLengths[i],
                dictName,
                dictNameId,
                contentBytes,
                contentByteOffset,
            );
        }
        if (importMetrics !== null) {
            importMetrics.contentMetadataIndexPublishMs += safePerformance.now() - indexPublishStart;
        }
        return resolvedContentDictNames;
    }

    /**
     * @param {string|(string|null)[]} contentDictNames
     * @returns {string|(string|null)[]}
     */
    _compactUniformContentDictNames(contentDictNames) {
        if (!Array.isArray(contentDictNames) || contentDictNames.length === 0) { return contentDictNames; }
        const first = contentDictNames[0];
        if (typeof first !== 'string') { return contentDictNames; }
        for (let i = 1; i < contentDictNames.length; ++i) {
            if (contentDictNames[i] !== first) { return contentDictNames; }
        }
        return first;
    }

    /**
     * Keeps parser-owned row-to-unique references intact so record encoding can
     * consume resolved offsets without a separate row-level projection.
     * @param {import('core').SafeAny} chunk
     * @param {Map<string, import('./term-lookup-index-preparation.js').PreparedTermLookupIndex>|null} preparedLookupIndexes
     * @param {ArtifactTermContentDedupPlan|null} contentDedupPlan
     * @param {boolean} useResolvedContentReferences
     * @returns {import('core').SafeAny}
     */
    _createResolvedArtifactTermRecordChunk(
        chunk,
        preparedLookupIndexes,
        contentDedupPlan,
        useResolvedContentReferences,
    ) {
        /** @type {import('core').SafeAny} */
        const additions = {};
        if (preparedLookupIndexes !== null) {
            additions.preparedLookupIndexes = preparedLookupIndexes;
        }
        if (
            useResolvedContentReferences &&
            contentDedupPlan !== null &&
            chunk.contentUniqueIndexList instanceof Uint32Array
        ) {
            additions.resolvedContentReferences = {
                uniqueIndexList: chunk.contentUniqueIndexList,
                offsets: contentDedupPlan.resolvedOffsets,
                lengths: contentDedupPlan.resolvedLengths,
            };
        }
        return Object.keys(additions).length === 0 ? chunk : {...chunk, ...additions};
    }

    /**
     * @param {import('core').SafeAny} chunk
     * @param {Float64Array} contentOffsets
     * @param {Uint32Array} contentLengths
     * @param {string|(string|null)[]} resolvedContentDictNames
     * @param {Record<string, number>} importMetrics
     * @returns {Promise<void>}
     */
    async _appendResolvedArtifactTermRecords(chunk, contentOffsets, contentLengths, resolvedContentDictNames, importMetrics) {
        const metrics = await this._termRecordStore.appendBatchFromArtifactChunkResolvedContent(
            chunk,
            contentOffsets,
            contentLengths,
            resolvedContentDictNames,
        );
        importMetrics.termRecordBuildMs += metrics.buildRecordsMs;
        importMetrics.termRecordEncodeMs += metrics.encodeMs;
        importMetrics.termRecordWriteMs += metrics.appendWriteMs;
        importMetrics.termRecordInternMs += metrics.internMs ?? 0;
        importMetrics.termRecordPackLengthsMs += metrics.packLengthsMs ?? 0;
        importMetrics.termRecordHeapCopyMs += metrics.heapCopyMs ?? 0;
        importMetrics.termRecordFieldEncodeMs += metrics.recordFieldEncodeMs ?? 0;
        importMetrics.termRecordValidationMs += metrics.validationMs ?? 0;
        importMetrics.termLookupIndexEncodeMs += metrics.lookupIndexEncodeMs ?? 0;
        if (this._deferTermsVirtualTableSync || this._isBulkImportInProgress()) {
            this._termsVirtualTableDirty = true;
            return;
        }
        const tTermsVtabInsertStart = safePerformance.now();
        await this._insertTermRowsIntoVirtualTable(chunk.rowCount);
        importMetrics.termsVtabInsertMs += safePerformance.now() - tTermsVtabInsertStart;
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').PreparedStatement} insertContentStmt
     * @param {string} contentHash
     * @param {Uint8Array} contentZstd
     * @param {string|null} contentDictName
     * @param {string} contentKey
     * @returns {Promise<number>}
     * @throws {Error}
     */
    async _resolveOrCreateTermEntryContentId(insertContentStmt, contentHash, contentZstd, contentDictName, contentKey) {
        const cachedId = this._termEntryContentIdByKey.get(contentKey);
        if (typeof cachedId === 'number') {
            return cachedId;
        }
        const cachedHashId = this._termEntryContentIdByHash.get(contentHash);
        if (typeof cachedHashId === 'number') {
            this._termEntryContentIdByKey.set(contentKey, cachedHashId);
            if (!this._termEntryContentMetaByHash.has(contentHash)) {
                const stmt = this._getCachedStatement('SELECT contentOffset, contentLength, contentDictName FROM termEntryContent WHERE id = $id LIMIT 1');
                stmt.reset(true);
                stmt.bind({$id: cachedHashId});
                if (stmt.step()) {
                    const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
                    const offset = this._asNumber(row.contentOffset, -1);
                    const length = this._asNumber(row.contentLength, -1);
                    const dictName = this._asNullableString(row.contentDictName) ?? 'raw';
                    if (offset >= 0 && length > 0) {
                        this._cacheTermEntryContentMeta(contentHash, offset, length, dictName, cachedHashId);
                    }
                }
            }
            if (this._termEntryContentMetaByHash.has(contentHash)) {
                return cachedHashId;
            }
        }

        insertContentStmt.reset(true);
        const [span] = await this._termContentStore.appendBatch([contentZstd]);
        insertContentStmt.bind({
            $contentHash: contentHash,
            $contentDictName: contentDictName,
            $contentOffset: span.offset,
            $contentLength: span.length,
        });
        insertContentStmt.step();

        const db = this._requireDb();
        const id = this._asNumber(db.selectValue('SELECT last_insert_rowid()'), -1);
        if (id <= 0) {
            throw new Error('Failed to insert term entry content');
        }
        this._termEntryContentIdByHash.set(contentHash, id);
        this._termEntryContentIdByKey.set(contentKey, id);
        this._cacheTermEntryContentMeta(contentHash, span.offset, span.length, contentDictName, id);
        return id;
    }

    /** */
    _loadTermEntryContentHashIndex() {
        if (this._termEntryContentIdByHash.size > 0) { return; }
        const stmt = this._getCachedStatement('SELECT id, contentHash, contentOffset, contentLength, contentDictName FROM termEntryContent');
        stmt.reset(true);
        while (stmt.step()) {
            const row = /** @type {import('core').SafeAny[]} */ (stmt.get([]));
            const id = this._asNumber(row[0], -1);
            if (id <= 0) { continue; }
            const contentHash = this._asString(row[1]);
            if (contentHash.length === 0) { continue; }
            const offset = this._asNumber(row[2], -1);
            const length = this._asNumber(row[3], -1);
            const dictName = this._asNullableString(row[4]) ?? 'raw';
            if (offset >= 0 && length > 0) {
                if (!this._termEntryContentIdByHash.has(contentHash)) {
                    this._termEntryContentIdByHash.set(contentHash, id);
                }
                this._cacheTermEntryContentMeta(contentHash, offset, length, dictName, id);
            }
        }
    }

    /** */
    _pruneOrphanTermEntryContent() {
        const db = this._requireDb();
        db.exec(`
            DELETE FROM termEntryContent
            WHERE id NOT IN (
                SELECT DISTINCT entryContentId
                FROM terms
                WHERE entryContentId IS NOT NULL
            )
        `);
    }

    // Parent-Worker API

    /**
     * @param {MessagePort} port
     */
    async connectToDatabaseWorker(port) {
        if (this._worker !== null) {
            this._worker.postMessage({action: 'connectToDatabaseWorker'}, [port]);
            return;
        }

        port.onmessage = (/** @type {MessageEvent<import('dictionary-database').ApiMessageAny>} */ event) => {
            const {action, params} = event.data;
            return invokeApiMapHandler(this._apiMap, action, params, [port], () => {});
        };
        port.onmessageerror = (event) => {
            const error = new ExtensionError('DictionaryDatabase: Error receiving message from main thread');
            error.data = event;
            log.error(error);
        };
    }

    /** @type {import('dictionary-database').ApiHandler<'drawMedia'>} */
    _onDrawMedia(params, port) {
        void this.drawMedia(params.requests, port);
    }

    // Private

    /**
     * @returns {Promise<void>}
     */
    async _openConnection() {
        this._sqlite3 = await getSqlite3();
        try {
            this._db = await openOpfsDatabase('DictionaryDatabase._openConnection');
        } catch (error) {
            const diagnostics = getLastOpenStorageDiagnostics();
            const message = (error instanceof Error) ? error.message : String(error);
            throw new Error(`Dictionary database open failed: ${message}. diagnostics=${JSON.stringify(diagnostics)}`);
        }
        this._usesFallbackStorage = didLastOpenUseFallbackStorage();
        this._openStorageDiagnostics = getLastOpenStorageDiagnostics();
        await this._termContentStore.prepare();
        await this._termRecordStore.prepare();
        this._termContentBlockStore.clearCache();
        this._clearTermsVtabCursorState();
        this._termsVtabModuleRegistered = false;

        this._applyRuntimePragmas();

        await this._initializeSchema();
        await this._runSchemaMigrations();
        await this._recoverInterruptedImportSession();
        this._restoreTermRecordDictionaryHealth();
    }

    /** */
    async _recoverInterruptedImportSession() {
        const db = this._requireDb();
        let record = null;
        try {
            record = await this._importJournal.read();
        } catch (error) {
            this._importJournalRecoveryPending = true;
            reportDiagnostics('dictionary-import-journal-invalid', {error: toError(error).message});
            throw new Error(`Cannot safely recover invalid dictionary import journal: ${toError(error).message}`);
        }
        if (record !== null) {
            const published = this._asNumber(db.selectValue(
                'SELECT 1 FROM dictionaryImportPublications WHERE sessionId = $sessionId LIMIT 1',
                {$sessionId: record.sessionId},
            ), 0) === 1;
            if (!published) {
                const rollbackResults = await Promise.allSettled([
                    this._termContentStore.rollbackImportSession(record.contentCheckpoint),
                    this._termRecordStore.rollbackImportSession(record.recordCheckpoint),
                ]);
                const rollbackErrors = rollbackResults
                    .filter((result) => result.status === 'rejected')
                    .map((result) => toError(result.reason));
                if (rollbackErrors.length === 1) {
                    this._importJournalRecoveryPending = true;
                    throw rollbackErrors[0];
                }
                if (rollbackErrors.length > 1) {
                    this._importJournalRecoveryPending = true;
                    throw new AggregateError(
                        rollbackErrors,
                        'Failed to recover interrupted dictionary import storage',
                    );
                }
            }
            try {
                await this._importJournal.clear();
                this._bulkImportJournalRecord = null;
            } catch (error) {
                this._importJournalRecoveryPending = true;
                reportDiagnostics('dictionary-import-journal-clear-failed', {
                    sessionId: record.sessionId,
                    published,
                    error: toError(error).message,
                });
                return;
            }
            reportDiagnostics('dictionary-import-session-recovered', {
                sessionId: record.sessionId,
                action: published ? 'kept-published-data' : 'rolled-back-unpublished-data',
            });
            this._deleteImportPublicationMarkerBestEffort(record.sessionId);
        }
        this._importJournalRecoveryPending = false;
    }

    /**
     * Releases resources acquired before prepare() failed so callers can retry
     * opening without constructing a replacement DictionaryDatabase.
     * @param {boolean} preserveBulkImportLifecycle
     * @returns {Promise<Error[]>}
     */
    async _cleanupAfterPrepareFailure(preserveBulkImportLifecycle = false) {
        /** @type {Error[]} */
        const errors = [];
        const sessionResults = await Promise.allSettled([
            this._termContentStore.endImportSession(),
            this._termRecordStore.endImportSession(),
        ]);
        for (const result of sessionResults) {
            if (result.status === 'rejected') {
                errors.push(toError(result.reason));
            }
        }
        this._releaseRuntimeConnection(errors);
        if (!preserveBulkImportLifecycle) {
            this._endBulkImportLifecycle();
        }
        this._bulkImportTransactionOpen = false;
        this._bulkImportJournalRecord = null;
        this._deferTermsVirtualTableSync = false;
        this._termsVirtualTableDirty = false;
        return errors;
    }

    /**
     * Publication markers are recovery hints, not live database state. Failing
     * to remove one must not prevent the extension backend from starting.
     * @param {string} sessionId
     */
    _deleteImportPublicationMarkerBestEffort(sessionId) {
        try {
            this._requireDb().exec({
                sql: 'DELETE FROM dictionaryImportPublications WHERE sessionId = ?',
                bind: [sessionId],
            });
        } catch (error) {
            reportDiagnostics('dictionary-import-publication-cleanup-failed', {
                sessionId,
                error: toError(error).message,
            });
        }
    }

    /** */
    async _initializeSchema() {
        const db = this._requireDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS dictionaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                version INTEGER NOT NULL,
                summaryJson TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS termEntryContent (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contentHash TEXT NOT NULL,
                contentZstd BLOB,
                contentOffset INTEGER,
                contentLength INTEGER,
                contentDictName TEXT,
                rules TEXT NOT NULL,
                definitionTags TEXT NOT NULL,
                termTags TEXT NOT NULL,
                glossaryJson TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS termMeta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary TEXT NOT NULL,
                expression TEXT NOT NULL,
                mode TEXT NOT NULL,
                dataJson TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS kanji (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary TEXT NOT NULL,
                character TEXT NOT NULL,
                onyomi TEXT,
                kunyomi TEXT,
                tags TEXT,
                meaningsJson TEXT NOT NULL,
                statsJson TEXT
            );

            CREATE TABLE IF NOT EXISTS kanjiMeta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary TEXT NOT NULL,
                character TEXT NOT NULL,
                mode TEXT NOT NULL,
                dataJson TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tagMeta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary TEXT NOT NULL,
                name TEXT NOT NULL,
                category TEXT,
                ord INTEGER,
                notes TEXT,
                score INTEGER
            );

            CREATE TABLE IF NOT EXISTS media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                dictionary TEXT NOT NULL,
                path TEXT NOT NULL,
                mediaType TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                content BLOB NOT NULL,
                contentOffset INTEGER NOT NULL DEFAULT 0,
                contentLength INTEGER NOT NULL DEFAULT 0,
                contentCompressionMethod INTEGER NOT NULL DEFAULT 0,
                contentUncompressedLength INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS sharedGlossaryArtifacts (
                dictionary TEXT PRIMARY KEY,
                contentOffset INTEGER NOT NULL,
                contentLength INTEGER NOT NULL,
                contentDictName TEXT NOT NULL,
                uncompressedLength INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dictionaryImportPublications (
                sessionId TEXT PRIMARY KEY,
                publishedAt INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dictionaryStorageHealth (
                title TEXT PRIMARY KEY,
                reason TEXT NOT NULL
            );
        `);
        await this._ensureTermsVirtualTable();
        await this._migrateTermsContentSchema();
        await this._migrateMediaSchema();
        if (!this._enableSqliteSecondaryIndexes) {
            for (const dropIndexSql of this._createDropIndexesSql()) {
                db.exec(dropIndexSql);
            }
        }
        for (const createIndexSql of this._createIndexesSql()) {
            db.exec(createIndexSql);
        }
    }

    /** */
    async _runSchemaMigrations() {
        const db = this._requireDb();
        const installedSchemaVersion = Math.max(0, this._asNumber(db.selectValue('PRAGMA user_version'), 0));
        if (installedSchemaVersion > CURRENT_DICTIONARY_SCHEMA_VERSION) {
            reportDiagnostics('dictionary-schema-migration-skipped', {
                reason: 'newer-installed-version',
                installedSchemaVersion,
                currentSchemaVersion: CURRENT_DICTIONARY_SCHEMA_VERSION,
            });
            return;
        }
        let currentSchemaVersion = installedSchemaVersion;
        let migrationCount = 0;
        while (currentSchemaVersion < CURRENT_DICTIONARY_SCHEMA_VERSION) {
            const nextVersion = currentSchemaVersion + 1;
            const migrationStart = safePerformance.now();
            const migrationSummary = await this._runSchemaMigrationToVersion(nextVersion);
            db.exec(`PRAGMA user_version = ${nextVersion}`);
            ++migrationCount;
            reportDiagnostics('dictionary-schema-migration-applied', {
                fromVersion: currentSchemaVersion,
                toVersion: nextVersion,
                elapsedMs: Math.max(0, safePerformance.now() - migrationStart),
                summary: migrationSummary,
            });
            currentSchemaVersion = nextVersion;
        }
        reportDiagnostics('dictionary-schema-migration-summary', {
            installedSchemaVersion,
            currentSchemaVersion,
            migrationCount,
        });
    }

    /**
     * @param {number} version
     * @returns {Promise<Record<string, number|string|boolean|null>>}
     */
    async _runSchemaMigrationToVersion(version) {
        switch (version) {
            case 1:
                return await this._wipeDictionaryDataForSchemaMigration('wipe-unversioned-dictionary-data');
            case 2:
                return await this._migrateSchemaVersion2();
            case 3:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-raw-v3');
            case 4:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-raw-v4');
            case 5:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-opfs-sahpool');
            case 6:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-lazy-reverse-index');
            case 7:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-lazy-sorted-indexes');
            case 8:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-generation-bound-term-indexes');
            case 9:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-xxh32-term-storage-integrity');
            case 10:
                return await this._wipeDictionaryDataForSchemaMigration('reset-dictionary-data-for-authoritative-term-containers');
            default:
                throw new Error(`Unhandled dictionary schema migration target version: ${version}`);
        }
    }

    /**
     * Migration v1: reset all imported dictionary data when legacy installs had no schema version.
     * @param {string} migration
     * @returns {Promise<Record<string, number|string|boolean|null>>}
     */
    async _wipeDictionaryDataForSchemaMigration(migration) {
        const db = this._requireDb();
        const dictionariesBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM dictionaries'), 0);
        const termMetaBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM termMeta'), 0);
        const kanjiBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM kanji'), 0);
        const kanjiMetaBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM kanjiMeta'), 0);
        const tagMetaBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM tagMeta'), 0);
        const mediaBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM media'), 0);
        const termContentBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM termEntryContent'), 0);
        const sharedGlossaryArtifactsBefore = this._asNumber(db.selectValue('SELECT COUNT(*) FROM sharedGlossaryArtifacts'), 0);
        const termRecordsBefore = this._termRecordStore.size;

        const resetErrors = await this._collectPersistentStoreResetErrors(false);
        if (resetErrors.length === 1) {
            throw resetErrors[0];
        }
        if (resetErrors.length > 1) {
            throw new AggregateError(resetErrors, 'Failed to reset dictionary storage for schema migration');
        }
        await this._beginImmediateTransaction(db);
        try {
            db.exec('DELETE FROM media');
            db.exec('DELETE FROM tagMeta');
            db.exec('DELETE FROM kanjiMeta');
            db.exec('DELETE FROM kanji');
            db.exec('DELETE FROM termMeta');
            db.exec('DELETE FROM termEntryContent');
            db.exec('DELETE FROM sharedGlossaryArtifacts');
            db.exec('DELETE FROM dictionaryStorageHealth');
            db.exec('DELETE FROM dictionaries');
            db.exec('COMMIT');
        } catch (e) {
            try { db.exec('ROLLBACK'); } catch (_) { /* NOP */ }
            throw e;
        }

        this._termEntryContentCache.clear();
        this._termEntryContentIdByHash.clear();
        this._clearTermEntryContentMetaCaches();
        this._termExactPresenceCache.clear();
        this._termPrefixNegativeCache.clear();
        this._clearDirectTermIndexCaches();
        this._termEntryContentIdByKey.clear();
        this._clearSharedGlossaryArtifactCaches();
        this._termsVirtualTableDirty = false;
        this._deferTermsVirtualTableSync = false;

        return {
            migration,
            dictionariesBefore,
            termRecordsBefore,
            termContentBefore,
            termMetaBefore,
            kanjiBefore,
            kanjiMetaBefore,
            tagMetaBefore,
            mediaBefore,
            sharedGlossaryArtifactsBefore,
        };
    }

    /**
     * Migration v2: reserved scaffold for future schema changes.
     * @returns {Promise<Record<string, number|string|boolean|null>>}
     */
    async _migrateSchemaVersion2() {
        await Promise.resolve();
        return {
            migration: 'schema-v2-noop',
        };
    }

    /**
     * @returns {string[]}
     */
    _createIndexesSql() {
        if (!this._enableSqliteSecondaryIndexes) {
            return [];
        }
        return [
            'CREATE INDEX IF NOT EXISTS idx_dictionaries_title ON dictionaries(title)',
            'CREATE INDEX IF NOT EXISTS idx_dictionaries_version ON dictionaries(version)',
            'CREATE INDEX IF NOT EXISTS idx_term_entry_content_hash ON termEntryContent(contentHash)',
            'CREATE INDEX IF NOT EXISTS idx_term_meta_expression_dictionary ON termMeta(expression, dictionary)',
            'CREATE INDEX IF NOT EXISTS idx_kanji_character_dictionary ON kanji(character, dictionary)',
            'CREATE INDEX IF NOT EXISTS idx_kanji_meta_character_dictionary ON kanjiMeta(character, dictionary)',
            'CREATE INDEX IF NOT EXISTS idx_tag_meta_dictionary_name ON tagMeta(dictionary, name)',
            'CREATE INDEX IF NOT EXISTS idx_media_dictionary_path ON media(dictionary, path)',
        ];
    }

    /**
     * @returns {string[]}
     */
    _createDropIndexesSql() {
        return [
            'DROP INDEX IF EXISTS idx_dictionaries_title',
            'DROP INDEX IF EXISTS idx_dictionaries_version',
            'DROP INDEX IF EXISTS idx_term_entry_content_hash',
            'DROP INDEX IF EXISTS idx_term_meta_expression_dictionary',
            'DROP INDEX IF EXISTS idx_kanji_character_dictionary',
            'DROP INDEX IF EXISTS idx_kanji_meta_character_dictionary',
            'DROP INDEX IF EXISTS idx_tag_meta_dictionary_name',
            'DROP INDEX IF EXISTS idx_media_dictionary_path',
            // Legacy index names from pre-optimization schema revisions.
            'DROP INDEX IF EXISTS idx_terms_expression',
            'DROP INDEX IF EXISTS idx_terms_reading',
            'DROP INDEX IF EXISTS idx_terms_sequence',
            'DROP INDEX IF EXISTS idx_terms_expression_reverse',
            'DROP INDEX IF EXISTS idx_terms_reading_reverse',
            'DROP INDEX IF EXISTS idx_term_meta_dictionary',
            'DROP INDEX IF EXISTS idx_term_meta_expression',
            'DROP INDEX IF EXISTS idx_kanji_dictionary',
            'DROP INDEX IF EXISTS idx_kanji_character',
            'DROP INDEX IF EXISTS idx_kanji_meta_dictionary',
            'DROP INDEX IF EXISTS idx_kanji_meta_character',
            'DROP INDEX IF EXISTS idx_tag_meta_dictionary',
            'DROP INDEX IF EXISTS idx_tag_meta_name',
            'DROP INDEX IF EXISTS idx_media_dictionary',
            'DROP INDEX IF EXISTS idx_media_path',
        ];
    }

    /**
     * Ensures terms are represented by a SQLite virtual table while record payload metadata remains external.
     */
    async _ensureTermsVirtualTable() {
        const db = this._requireDb();
        this._registerTermsVirtualTableModule();
        const termsEntry = db.selectObject('SELECT type, sql FROM sqlite_master WHERE name = \'terms\'');
        const termsType = typeof termsEntry === 'undefined' ? '' : this._asString(termsEntry.type);
        const termsSql = typeof termsEntry === 'undefined' ? '' : this._asString(termsEntry.sql).toUpperCase();
        const isVirtualTerms = termsSql.startsWith('CREATE VIRTUAL TABLE');
        if (termsType === 'table' && !isVirtualTerms) {
            await this._migrateLegacyTermsTableToExternalStore();
            db.exec('DROP TABLE terms');
        } else if (isVirtualTerms && !termsSql.includes('MANABITAN_TERMS')) {
            db.exec('DROP TABLE terms');
        }
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS terms USING manabitan_terms(
                dictionary,
                expression,
                reading,
                expressionReverse,
                readingReverse,
                entryContentId,
                entryContentOffset,
                entryContentLength,
                entryContentDictName,
                definitionTags,
                termTags,
                rules,
                score,
                glossaryJson,
                sequence
            )
        `);
        this._termsVirtualTableDirty = false;
    }

    /**
     * Ensures the SQLite vtable projection matches the external term record store.
     * @returns {Promise<void>}
     */
    async _syncTermsVirtualTableFromRecordStore() {
        this._termsVirtualTableDirty = false;
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<void>}
     */
    async _appendTermRecordsFromTermsTableByDictionary(dictionaryName) {
        const db = this._requireDb();
        const termsTableInfo = db.selectObjects('PRAGMA table_info(terms)');
        const termsColumns = new Set(termsTableInfo.map((row) => this._asString(row.name)));
        const hasEntryContentOffset = termsColumns.has('entryContentOffset');
        const hasEntryContentLength = termsColumns.has('entryContentLength');
        const hasEntryContentDictName = termsColumns.has('entryContentDictName');
        const hasEntryContentId = termsColumns.has('entryContentId');
        const entryContentOffsetExpr = hasEntryContentOffset ? 't.entryContentOffset' : (hasEntryContentId ? 'c.contentOffset' : '-1');
        const entryContentLengthExpr = hasEntryContentLength ? 't.entryContentLength' : (hasEntryContentId ? 'c.contentLength' : '-1');
        const entryContentDictNameExpr = hasEntryContentDictName ? 't.entryContentDictName' : (hasEntryContentId ? 'c.contentDictName' : '\'raw\'');
        const stmt = this._getCachedStatement(`
            SELECT
                t.dictionary AS dictionary,
                t.expression AS expression,
                t.reading AS reading,
                t.expressionReverse AS expressionReverse,
                t.readingReverse AS readingReverse,
                ${entryContentOffsetExpr} AS entryContentOffset,
                ${entryContentLengthExpr} AS entryContentLength,
                COALESCE(${entryContentDictNameExpr}, 'raw') AS entryContentDictName,
                t.score AS score,
                t.sequence AS sequence
            FROM terms t
            ${hasEntryContentId ? 'LEFT JOIN termEntryContent c ON c.id = t.entryContentId' : ''}
            WHERE t.dictionary = $dictionary
        `);
        stmt.reset(true);
        stmt.bind({$dictionary: dictionaryName});
        /** @type {{dictionary: string, expression: string, reading: string, expressionReverse: string|null, readingReverse: string|null, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, score: number, sequence: number|null}[]} */
        let batch = [];
        while (stmt.step()) {
            const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
            batch.push({
                dictionary: this._asString(row.dictionary),
                expression: this._asString(row.expression),
                reading: this._asString(row.reading),
                expressionReverse: this._asNullableString(row.expressionReverse) ?? null,
                readingReverse: this._asNullableString(row.readingReverse) ?? null,
                entryContentOffset: this._asNumber(row.entryContentOffset, -1),
                entryContentLength: this._asNumber(row.entryContentLength, -1),
                entryContentDictName: this._asNullableString(row.entryContentDictName),
                score: this._asNumber(row.score, 0),
                sequence: this._asNullableNumber(row.sequence) ?? null,
            });
            if (batch.length >= 4096) {
                await this._termRecordStore.appendBatch(batch);
                batch = [];
            }
        }
        if (batch.length > 0) {
            await this._termRecordStore.appendBatch(batch);
        }
    }

    /** */
    async _migrateLegacyTermsTableToExternalStore() {
        if (!this._termRecordStore.isEmpty()) {
            return;
        }
        const db = this._requireDb();
        const termsTableInfo = db.selectObjects('PRAGMA table_info(terms)');
        const termsColumns = new Set(termsTableInfo.map((row) => this._asString(row.name)));
        const hasEntryContentOffset = termsColumns.has('entryContentOffset');
        const hasEntryContentLength = termsColumns.has('entryContentLength');
        const hasEntryContentDictName = termsColumns.has('entryContentDictName');
        const hasEntryContentId = termsColumns.has('entryContentId');
        const entryContentOffsetExpr = hasEntryContentOffset ? 't.entryContentOffset' : (hasEntryContentId ? 'c.contentOffset' : '-1');
        const entryContentLengthExpr = hasEntryContentLength ? 't.entryContentLength' : (hasEntryContentId ? 'c.contentLength' : '-1');
        const entryContentDictNameExpr = hasEntryContentDictName ? 't.entryContentDictName' : (hasEntryContentId ? 'c.contentDictName' : '\'raw\'');
        const stmt = this._getCachedStatement(`
            SELECT
                t.dictionary AS dictionary,
                t.expression AS expression,
                t.reading AS reading,
                t.expressionReverse AS expressionReverse,
                t.readingReverse AS readingReverse,
                ${entryContentOffsetExpr} AS entryContentOffset,
                ${entryContentLengthExpr} AS entryContentLength,
                COALESCE(${entryContentDictNameExpr}, 'raw') AS entryContentDictName,
                t.score AS score,
                t.sequence AS sequence
            FROM terms t
            ${hasEntryContentId ? 'LEFT JOIN termEntryContent c ON c.id = t.entryContentId' : ''}
        `);
        stmt.reset(true);
        /** @type {{dictionary: string, expression: string, reading: string, expressionReverse: string|null, readingReverse: string|null, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, score: number, sequence: number|null}[]} */
        let batch = [];
        while (stmt.step()) {
            const row = /** @type {import('core').SafeAny} */ (stmt.get({}));
            batch.push({
                dictionary: this._asString(row.dictionary),
                expression: this._asString(row.expression),
                reading: this._asString(row.reading),
                expressionReverse: this._asNullableString(row.expressionReverse) ?? null,
                readingReverse: this._asNullableString(row.readingReverse) ?? null,
                entryContentOffset: this._asNumber(row.entryContentOffset, -1),
                entryContentLength: this._asNumber(row.entryContentLength, -1),
                entryContentDictName: this._asNullableString(row.entryContentDictName),
                score: this._asNumber(row.score, 0),
                sequence: this._asNullableNumber(row.sequence) ?? null,
            });
            if (batch.length >= 4096) {
                await this._termRecordStore.appendBatch(batch);
                batch = [];
            }
        }
        if (batch.length > 0) {
            await this._termRecordStore.appendBatch(batch);
        }
    }

    /** */
    async _migrateTermsContentSchema() {
        const db = this._requireDb();
        const contentTableInfo = db.selectObjects('PRAGMA table_info(termEntryContent)');
        const hasContentZstd = contentTableInfo.some((row) => this._asString(row.name) === 'contentZstd');
        const hasContentOffset = contentTableInfo.some((row) => this._asString(row.name) === 'contentOffset');
        const hasContentLength = contentTableInfo.some((row) => this._asString(row.name) === 'contentLength');
        const hasContentDictName = contentTableInfo.some((row) => this._asString(row.name) === 'contentDictName');
        if (!hasContentZstd) {
            db.exec('ALTER TABLE termEntryContent ADD COLUMN contentZstd BLOB');
        }
        if (!hasContentDictName) {
            db.exec('ALTER TABLE termEntryContent ADD COLUMN contentDictName TEXT');
        }
        if (!hasContentOffset) {
            db.exec('ALTER TABLE termEntryContent ADD COLUMN contentOffset INTEGER');
        }
        if (!hasContentLength) {
            db.exec('ALTER TABLE termEntryContent ADD COLUMN contentLength INTEGER');
        }

        const termsEntry = db.selectObject('SELECT type, sql FROM sqlite_master WHERE name = \'terms\'');
        const termsSql = typeof termsEntry === 'undefined' ? '' : this._asString(termsEntry.sql).toUpperCase();
        const isVirtualTerms = termsSql.startsWith('CREATE VIRTUAL TABLE');
        if (typeof termsEntry === 'undefined' || this._asString(termsEntry.type) !== 'table' || isVirtualTerms) {
            return;
        }

        const tableInfo = db.selectObjects('PRAGMA table_info(terms)');
        const hasEntryContentId = tableInfo.some((row) => this._asString(row.name) === 'entryContentId');
        const hasEntryContentOffset = tableInfo.some((row) => this._asString(row.name) === 'entryContentOffset');
        const hasEntryContentLength = tableInfo.some((row) => this._asString(row.name) === 'entryContentLength');
        const hasEntryContentDictName = tableInfo.some((row) => this._asString(row.name) === 'entryContentDictName');
        if (!hasEntryContentId) { db.exec('ALTER TABLE terms ADD COLUMN entryContentId INTEGER'); }
        if (!hasEntryContentOffset) { db.exec('ALTER TABLE terms ADD COLUMN entryContentOffset INTEGER'); }
        if (!hasEntryContentLength) { db.exec('ALTER TABLE terms ADD COLUMN entryContentLength INTEGER'); }
        if (!hasEntryContentDictName) { db.exec('ALTER TABLE terms ADD COLUMN entryContentDictName TEXT'); }

        db.exec(`
            INSERT INTO termEntryContent(contentHash, rules, definitionTags, termTags, glossaryJson)
            SELECT
                '',
                COALESCE(t.rules, ''),
                COALESCE(t.definitionTags, ''),
                COALESCE(t.termTags, ''),
                COALESCE(t.glossaryJson, '[]')
            FROM terms t
            WHERE t.entryContentId IS NULL
        `);

        const contentRows = db.selectObjects('SELECT id, rules, definitionTags, termTags, glossaryJson FROM termEntryContent WHERE contentHash = \'\'');
        for (const row of contentRows) {
            const id = this._asNumber(row.id, -1);
            if (id <= 0) { continue; }
            const rules = this._asString(row.rules);
            const definitionTags = this._asString(row.definitionTags);
            const termTags = this._asString(row.termTags);
            const glossaryJson = this._asString(row.glossaryJson);
            const contentHash = this._hashEntryContent(this._serializeTermEntryContent(
                rules,
                definitionTags,
                termTags,
                this._safeParseJson(glossaryJson, []),
            ));
            db.exec({
                sql: 'UPDATE termEntryContent SET contentHash = $contentHash WHERE id = $id',
                bind: {$contentHash: contentHash, $id: id},
            });
        }

        db.exec(`
            UPDATE terms
            SET entryContentId = (
                SELECT c.id
                FROM termEntryContent c
                WHERE
                    c.rules = COALESCE(terms.rules, '') AND
                    c.definitionTags = COALESCE(terms.definitionTags, '') AND
                    c.termTags = COALESCE(terms.termTags, '') AND
                    c.glossaryJson = COALESCE(terms.glossaryJson, '[]')
                LIMIT 1
            )
            WHERE entryContentId IS NULL
        `);

        db.exec(`
            UPDATE terms
            SET
                entryContentOffset = (
                    SELECT c.contentOffset
                    FROM termEntryContent c
                    WHERE c.id = terms.entryContentId
                    LIMIT 1
                ),
                entryContentLength = (
                    SELECT c.contentLength
                    FROM termEntryContent c
                    WHERE c.id = terms.entryContentId
                    LIMIT 1
                ),
                entryContentDictName = (
                    SELECT c.contentDictName
                    FROM termEntryContent c
                    WHERE c.id = terms.entryContentId
                    LIMIT 1
                )
            WHERE
                entryContentId IS NOT NULL AND
                (entryContentOffset IS NULL OR entryContentOffset < 0 OR entryContentLength IS NULL OR entryContentLength <= 0)
        `);

        const externalizeRows = db.selectObjects(`
            SELECT id, contentZstd
            FROM termEntryContent
            WHERE
                contentZstd IS NOT NULL AND
                length(contentZstd) > 0 AND
                (contentOffset IS NULL OR contentOffset < 0 OR contentLength IS NULL OR contentLength <= 0)
        `);
        if (externalizeRows.length > 0) {
            const chunks = [];
            for (const row of externalizeRows) {
                const contentZstd = this._toUint8Array(row.contentZstd);
                if (contentZstd === null || contentZstd.byteLength <= 0) { continue; }
                chunks.push(contentZstd);
            }
            if (chunks.length > 0) {
                const spans = await this._termContentStore.appendBatch(chunks);
                let spanIndex = 0;
                for (const row of externalizeRows) {
                    const id = this._asNumber(row.id, -1);
                    const contentZstd = this._toUint8Array(row.contentZstd);
                    if (id <= 0 || contentZstd === null || contentZstd.byteLength <= 0) { continue; }
                    const span = spans[spanIndex++];
                    db.exec({
                        sql: `
                            UPDATE termEntryContent
                            SET contentOffset = $contentOffset, contentLength = $contentLength, contentZstd = NULL
                            WHERE id = $id
                        `,
                        bind: {$contentOffset: span.offset, $contentLength: span.length, $id: id},
                    });
                }
            }
        }
    }

    /** */
    async _migrateMediaSchema() {
        const db = this._requireDb();
        const mediaTableInfo = db.selectObjects('PRAGMA table_info(media)');
        const hasContentOffset = mediaTableInfo.some((row) => this._asString(row.name) === 'contentOffset');
        const hasContentLength = mediaTableInfo.some((row) => this._asString(row.name) === 'contentLength');
        const hasContentCompressionMethod = mediaTableInfo.some((row) => this._asString(row.name) === 'contentCompressionMethod');
        const hasContentUncompressedLength = mediaTableInfo.some((row) => this._asString(row.name) === 'contentUncompressedLength');
        if (!hasContentOffset) {
            db.exec('ALTER TABLE media ADD COLUMN contentOffset INTEGER NOT NULL DEFAULT 0');
        }
        if (!hasContentLength) {
            db.exec('ALTER TABLE media ADD COLUMN contentLength INTEGER NOT NULL DEFAULT 0');
        }
        if (!hasContentCompressionMethod) {
            db.exec('ALTER TABLE media ADD COLUMN contentCompressionMethod INTEGER NOT NULL DEFAULT 0');
        }
        if (!hasContentUncompressedLength) {
            db.exec('ALTER TABLE media ADD COLUMN contentUncompressedLength INTEGER NOT NULL DEFAULT 0');
        }
    }

    /**
     * Best effort cleanup for old IndexedDB storage from pre-sqlite builds.
     */
    async _deleteLegacyIndexedDb() {
        if (typeof indexedDB === 'undefined') {
            return;
        }
        await new Promise((resolve) => {
            try {
                const request = indexedDB.deleteDatabase('dict');
                request.onsuccess = () => resolve(void 0);
                request.onerror = () => resolve(void 0);
                request.onblocked = () => resolve(void 0);
            } catch (_) {
                resolve(void 0);
            }
        });
    }

    /**
     * @returns {import('@sqlite.org/sqlite-wasm').Database}
     * @throws {Error}
     */
    _requireDb() {
        if (this._db === null) {
            throw new Error(this._isOpening ? 'Database not ready' : 'Database not open');
        }
        return this._db;
    }

    /**
     * @returns {import('@sqlite.org/sqlite-wasm').Sqlite3Static}
     * @throws {Error}
     */
    _requireSqlite3() {
        if (this._sqlite3 === null) {
            throw new Error('sqlite3 module is not initialized');
        }
        return this._sqlite3;
    }

    /**
     * @template {import('dictionary-database').ObjectStoreName} T
     * @param {T} objectStoreName
     * @returns {InsertStatement}
     * @throws {Error}
     */
    _getInsertStatement(objectStoreName) {
        switch (objectStoreName) {
            case 'dictionaries':
                return {
                    sql: 'INSERT INTO dictionaries(title, version, summaryJson) VALUES($title, $version, $summaryJson)',
                    bind: (item) => {
                        const summary = /** @type {import('dictionary-importer').Summary} */ (item);
                        return {
                            $title: summary.title,
                            $version: summary.version,
                            $summaryJson: JSON.stringify(summary),
                        };
                    },
                };
            case 'terms':
                throw new Error('terms uses external virtual storage; use bulkAdd');
            case 'termMeta':
                return {
                    sql: 'INSERT INTO termMeta(dictionary, expression, mode, dataJson) VALUES($dictionary, $expression, $mode, $dataJson)',
                    bind: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseTermMeta} */ (item);
                        return {
                            $dictionary: row.dictionary,
                            $expression: row.expression,
                            $mode: row.mode,
                            $dataJson: JSON.stringify(row.data),
                        };
                    },
                };
            case 'kanji':
                return {
                    sql: 'INSERT INTO kanji(dictionary, character, onyomi, kunyomi, tags, meaningsJson, statsJson) VALUES($dictionary, $character, $onyomi, $kunyomi, $tags, $meaningsJson, $statsJson)',
                    bind: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseKanjiEntry} */ (item);
                        return {
                            $dictionary: row.dictionary,
                            $character: row.character,
                            $onyomi: row.onyomi,
                            $kunyomi: row.kunyomi,
                            $tags: row.tags,
                            $meaningsJson: JSON.stringify(row.meanings),
                            $statsJson: row.stats ? JSON.stringify(row.stats) : null,
                        };
                    },
                };
            case 'kanjiMeta':
                return {
                    sql: 'INSERT INTO kanjiMeta(dictionary, character, mode, dataJson) VALUES($dictionary, $character, $mode, $dataJson)',
                    bind: (item) => {
                        const row = /** @type {import('dictionary-database').DatabaseKanjiMeta} */ (item);
                        return {
                            $dictionary: row.dictionary,
                            $character: row.character,
                            $mode: row.mode,
                            $dataJson: JSON.stringify(row.data),
                        };
                    },
                };
            case 'tagMeta':
                return {
                    sql: 'INSERT INTO tagMeta(dictionary, name, category, ord, notes, score) VALUES($dictionary, $name, $category, $ord, $notes, $score)',
                    bind: (item) => {
                        const row = /** @type {import('dictionary-database').Tag} */ (item);
                        return {
                            $dictionary: row.dictionary,
                            $name: row.name,
                            $category: row.category,
                            $ord: row.order,
                            $notes: row.notes,
                            $score: row.score,
                        };
                    },
                };
            case 'media':
                return {
                    sql: 'INSERT INTO media(dictionary, path, mediaType, width, height, content, contentOffset, contentLength, contentCompressionMethod, contentUncompressedLength) VALUES($dictionary, $path, $mediaType, $width, $height, $content, $contentOffset, $contentLength, $contentCompressionMethod, $contentUncompressedLength)',
                    /**
                     * @param {import('dictionary-database').MediaDataArrayBufferContent} row
                     * @returns {{$dictionary: string, $path: string, $mediaType: string, $width: number, $height: number, $content: ArrayBuffer, $contentOffset: number, $contentLength: number, $contentCompressionMethod: number, $contentUncompressedLength: number}}
                     */
                    bind: (row) => {
                        const source = /** @type {{dictionary: string, path: string, mediaType: string, width: number, height: number, content: ArrayBuffer, contentOffset?: unknown, contentLength?: unknown, contentCompressionMethod?: unknown, contentUncompressedLength?: unknown}} */ (row);
                        const contentOffset = typeof source.contentOffset === 'number' ? source.contentOffset : 0;
                        const contentLength = typeof source.contentLength === 'number' ? source.contentLength : 0;
                        const contentCompressionMethod = typeof source.contentCompressionMethod === 'number' ? source.contentCompressionMethod : ZIP_COMPRESSION_METHOD_STORE;
                        const contentUncompressedLength = typeof source.contentUncompressedLength === 'number' ? source.contentUncompressedLength : contentLength;
                        return {
                            $dictionary: source.dictionary,
                            $path: source.path,
                            $mediaType: source.mediaType,
                            $width: source.width,
                            $height: source.height,
                            $content: source.content,
                            $contentOffset: contentOffset,
                            $contentLength: contentLength,
                            $contentCompressionMethod: contentCompressionMethod,
                            $contentUncompressedLength: contentUncompressedLength,
                        };
                    },
                };
            default:
                throw new Error(`Unsupported object store: ${objectStoreName}`);
        }
    }

    /** */
    _clearTermsVtabCursorState() {
        this._termsVtabCursorState.clear();
    }

    /**
     * @throws {Error}
     */
    _registerTermsVirtualTableModule() {
        if (this._termsVtabModuleRegistered) {
            return;
        }
        const sqlite3 = this._requireSqlite3();
        const db = this._requireDb();
        const dbPointer = db.pointer;
        if (typeof dbPointer !== 'number') {
            throw new Error('sqlite database pointer is unavailable');
        }
        if (typeof sqlite3.vtab === 'undefined') {
            throw new Error('sqlite vtab API is unavailable');
        }
        const {capi, vtab} = sqlite3;
        const termsVtabIdxDictionaryEq = 1 << 0;
        const termsVtabIdxExpressionEq = 1 << 1;
        const termsVtabIdxReadingEq = 1 << 2;
        const termsVtabIdxSequenceEq = 1 << 3;
        const termsVtabIdxRowIdEq = 1 << 4;
        const termRecordStore = this._termRecordStore;
        const termsVtabCursorState = this._termsVtabCursorState;
        const asNumber = this._asNumber.bind(this);
        const asString = this._asString.bind(this);
        const getTermRecordStorageName = this._getTermRecordStorageName.bind(this);
        const getDictionaryNameForTermRecordStorage = this._getDictionaryNameForTermRecordStorage.bind(this);
        const eqOp = typeof capi.SQLITE_INDEX_CONSTRAINT_EQ === 'number' ? capi.SQLITE_INDEX_CONSTRAINT_EQ : 2;
        const toPtr = (value) => this._asNumber(value, 0);
        const schema = `
            CREATE TABLE x(
                dictionary TEXT,
                expression TEXT,
                reading TEXT,
                expressionReverse TEXT,
                readingReverse TEXT,
                entryContentId INTEGER,
                entryContentOffset INTEGER,
                entryContentLength INTEGER,
                entryContentDictName TEXT,
                definitionTags TEXT,
                termTags TEXT,
                rules TEXT,
                score INTEGER,
                glossaryJson TEXT,
                sequence INTEGER
            )
        `;

        // sqlite wasm vtab helpers expose dynamic struct wrappers that are not strongly typed in our jsdoc surface.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const module = vtab.setupModule({
            catchExceptions: true,
            methods: {
                xCreate(pDb, _pAux, _argc, _argv, ppVtab) {
                    const rc = capi.sqlite3_declare_vtab(toPtr(pDb), schema);
                    if (rc !== 0) { return rc; }
                    vtab.xVtab.create(toPtr(ppVtab));
                    return 0;
                },
                xConnect(pDb, pAux, argc, argv, ppVtab) {
                    const rc = capi.sqlite3_declare_vtab(toPtr(pDb), schema);
                    if (rc !== 0) { return rc; }
                    vtab.xVtab.create(toPtr(ppVtab));
                    return 0;
                },
                xBestIndex(_pVtab, pIdxInfo) {
                    const idxInfo = vtab.xIndexInfo(toPtr(pIdxInfo));
                    let argvIndex = 1;
                    let idxNum = 0;
                    for (let i = 0; i < idxInfo.$nConstraint; ++i) {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const constraint = idxInfo.nthConstraint(i);
                        if (!constraint || constraint.$usable === 0 || constraint.$op !== eqOp) { continue; }
                        const column = toPtr(constraint.$iColumn);
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        const usage = idxInfo.nthConstraintUsage(i);
                        if (!usage) { continue; }
                        switch (column) {
                            case -1:
                                idxNum |= termsVtabIdxRowIdEq;
                                break;
                            case 0:
                                idxNum |= termsVtabIdxDictionaryEq;
                                break;
                            case 1:
                                idxNum |= termsVtabIdxExpressionEq;
                                break;
                            case 2:
                                idxNum |= termsVtabIdxReadingEq;
                                break;
                            case 14:
                                idxNum |= termsVtabIdxSequenceEq;
                                break;
                            default:
                                continue;
                        }
                        usage.$argvIndex = argvIndex++;
                        usage.$omit = 1;
                    }
                    idxInfo.$idxNum = idxNum;
                    idxInfo.$estimatedRows = idxNum === 0 ? Math.max(1, termRecordStore.size) : 32;
                    idxInfo.$estimatedCost = idxNum === 0 ? Math.max(1, termRecordStore.size) : 32;
                    return 0;
                },
                xDisconnect(pVtab) {
                    vtab.xVtab.dispose(toPtr(pVtab));
                    return 0;
                },
                xDestroy(pVtab) {
                    vtab.xVtab.dispose(toPtr(pVtab));
                    return 0;
                },
                xOpen(_pVtab, ppCursor) {
                    const cursor = vtab.xCursor.create(toPtr(ppCursor));
                    termsVtabCursorState.set(cursor.pointer, {ids: [], index: 0});
                    return 0;
                },
                xClose(pCursor) {
                    const cursorPtr = toPtr(pCursor);
                    termsVtabCursorState.delete(cursorPtr);
                    vtab.xCursor.dispose(cursorPtr);
                    return 0;
                },
                xFilter(pCursor, idxNum, _idxStr, argc, argv) {
                    const cursorPtr = toPtr(pCursor);
                    const state = termsVtabCursorState.get(cursorPtr);
                    if (typeof state === 'undefined') { return 0; }
                    const args = capi.sqlite3_values_to_js(toPtr(argc), toPtr(argv));
                    let argIndex = 0;
                    let rowId = null;
                    let dictionary = null;
                    let expression = null;
                    let reading = null;
                    let sequence = null;
                    const idxBits = toPtr(idxNum);
                    if ((idxBits & termsVtabIdxRowIdEq) !== 0) { rowId = asNumber(args[argIndex++], -1); }
                    if ((idxBits & termsVtabIdxDictionaryEq) !== 0) {
                        dictionary = getTermRecordStorageName(asString(args[argIndex++]));
                    }
                    if ((idxBits & termsVtabIdxExpressionEq) !== 0) { expression = asString(args[argIndex++]); }
                    if ((idxBits & termsVtabIdxReadingEq) !== 0) { reading = asString(args[argIndex++]); }
                    if ((idxBits & termsVtabIdxSequenceEq) !== 0) { sequence = asNumber(args[argIndex++], -1); }

                    const baseIds = (typeof rowId === 'number' && rowId > 0) ? [rowId] : termRecordStore.getAllIds();
                    const ids = [];
                    for (const id of baseIds) {
                        if (id <= 0) { continue; }
                        const record = termRecordStore.getById(id);
                        if (typeof record === 'undefined') { continue; }
                        if (dictionary !== null && record.dictionary !== dictionary) { continue; }
                        if (expression !== null && record.expression !== expression) { continue; }
                        if (reading !== null && record.reading !== reading) { continue; }
                        if (sequence !== null && (record.sequence ?? -1) !== sequence) { continue; }
                        ids.push(id);
                    }
                    state.ids = ids;
                    state.index = 0;
                    return 0;
                },
                xNext(pCursor) {
                    const state = termsVtabCursorState.get(toPtr(pCursor));
                    if (typeof state !== 'undefined') {
                        ++state.index;
                    }
                    return 0;
                },
                xEof(pCursor) {
                    const state = termsVtabCursorState.get(toPtr(pCursor));
                    return (typeof state === 'undefined' || state.index >= state.ids.length) ? 1 : 0;
                },
                xColumn(pCursor, pContext, column) {
                    const state = termsVtabCursorState.get(toPtr(pCursor));
                    if (typeof state === 'undefined' || state.index >= state.ids.length) {
                        capi.sqlite3_result_null(toPtr(pContext));
                        return 0;
                    }
                    const id = state.ids[state.index];
                    const record = termRecordStore.getById(id);
                    if (typeof record === 'undefined') {
                        capi.sqlite3_result_null(toPtr(pContext));
                        return 0;
                    }
                    let value = null;
                    switch (toPtr(column)) {
                        case 0: value = getDictionaryNameForTermRecordStorage(record.dictionary); break;
                        case 1: value = record.expression; break;
                        case 2: value = record.reading; break;
                        case 3: value = record.expressionReverse; break;
                        case 4: value = record.readingReverse; break;
                        case 5: value = null; break;
                        case 6: value = record.entryContentOffset; break;
                        case 7: value = record.entryContentLength; break;
                        case 8: value = record.entryContentDictName; break;
                        case 9: value = ''; break;
                        case 10: value = ''; break;
                        case 11: value = ''; break;
                        case 12: value = record.score; break;
                        case 13: value = '[]'; break;
                        case 14: value = record.sequence; break;
                        default: value = null; break;
                    }
                    capi.sqlite3_result_js(toPtr(pContext), value);
                    return 0;
                },
                xRowid(pCursor, ppRowId) {
                    const state = termsVtabCursorState.get(toPtr(pCursor));
                    const id = (typeof state === 'undefined' || state.index >= state.ids.length) ? 0 : state.ids[state.index];
                    vtab.xRowid(toPtr(ppRowId), id);
                    return 0;
                },
                xUpdate() {
                    return capi.SQLITE_READONLY;
                },
            },
        });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const typedModule = /** @type {import('@sqlite.org/sqlite-wasm').sqlite3_module} */ (module);
        this._termsVtabModule = typedModule;
        const rc = capi.sqlite3_create_module(dbPointer, 'manabitan_terms', typedModule, 0);
        if (rc !== 0) {
            throw new Error(`Failed to register manabitan_terms module: rc=${rc}`);
        }
        this._termsVtabModuleRegistered = true;
    }

    /**
     * @param {string} whereClause
     * @returns {string}
     */
    _createTermSelectSql(whereClause) {
        return `
            SELECT
                t.*
            FROM terms t
            WHERE ${whereClause}
        `;
    }

    /**
     * @param {Iterable<number>} ids
     * @returns {Promise<Map<number, import('dictionary-database').DatabaseTermEntryWithId>>}
     */
    async _fetchTermRowsByIds(ids) {
        await this._termContentStore.ensureLoadedForRead();
        /** @type {Map<number, import('dictionary-database').DatabaseTermEntryWithId>} */
        const rowsById = new Map();
        /** @type {number[]} */
        const uncachedIds = [];
        for (const id of ids) {
            const cached = this._getCachedTermRow(id);
            if (typeof cached !== 'undefined') {
                rowsById.set(id, cached);
            } else {
                uncachedIds.push(id);
            }
        }
        if (uncachedIds.length === 0) {
            return rowsById;
        }
        const getByIdsAsync = /** @type {unknown} */ (Reflect.get(this._termRecordStore, 'getByIdsAsync'));
        const recordsById = typeof getByIdsAsync === 'function' ?
            await /** @type {(ids: Iterable<number>) => Promise<Map<number, import('./term-record-opfs-store.js').TermRecord>>} */ (getByIdsAsync).call(this._termRecordStore, uncachedIds) :
            this._termRecordStore.getByIds(uncachedIds);
        const warmSlices = /** @type {unknown} */ (Reflect.get(this._termContentStore, 'warmSlices'));
        if (typeof warmSlices === 'function') {
            await /** @type {(spans: Iterable<{offset: number, length: number}>) => Promise<void>} */ (warmSlices).call(
                this._termContentStore,
                this._iterateTermRecordContentSpans(recordsById.values()),
            );
        }
        const entryGroups = this._groupTermRecordEntriesByContentCacheKey(recordsById);
        const concurrency = Math.min(8, Math.max(1, entryGroups.length));
        let nextIndex = 0;
        const deserializeNext = async () => {
            while (true) {
                const entryIndex = nextIndex++;
                if (entryIndex >= entryGroups.length) { return; }
                for (const [id, record] of entryGroups[entryIndex]) {
                    const row = await this._deserializeTermRow({
                        id,
                        dictionary: this._getDictionaryNameForTermRecordStorage(record.dictionary),
                        expression: record.expression,
                        reading: record.reading,
                        expressionReverse: record.expressionReverse,
                        readingReverse: record.readingReverse,
                        entryContentId: null,
                        entryContentOffset: record.entryContentOffset,
                        entryContentLength: record.entryContentLength,
                        entryContentDictName: record.entryContentDictName,
                        definitionTags: '',
                        termTags: '',
                        rules: '',
                        score: record.score,
                        glossaryJson: '[]',
                        sequence: record.sequence,
                    });
                    rowsById.set(id, row);
                    this._setCachedTermRow(id, row);
                }
            }
        };
        await Promise.all(Array.from({length: concurrency}, () => deserializeNext()));
        return rowsById;
    }

    /**
     * @param {Iterable<import('./term-record-opfs-store.js').TermRecord>} records
     * @yields {{offset: number, length: number}}
     * @returns {IterableIterator<{offset: number, length: number}>}
     */
    *_iterateTermRecordContentSpans(records) {
        for (const {entryContentOffset: offset, entryContentLength: length} of records) {
            yield {offset, length};
        }
    }

    /**
     * @param {Iterable<[number, import('./term-record-opfs-store.js').TermRecord]>} entries
     * @returns {Array<Array<[number, import('./term-record-opfs-store.js').TermRecord]>>}
     */
    _groupTermRecordEntriesByContentCacheKey(entries) {
        /** @type {Array<Array<[number, import('./term-record-opfs-store.js').TermRecord]>>} */
        const groups = [];
        /** @type {Map<string, Array<[number, import('./term-record-opfs-store.js').TermRecord]>>} */
        const groupByKey = new Map();
        for (const entry of entries) {
            const [, record] = entry;
            const cacheKey = (
                record.entryContentOffset >= 0 &&
                record.entryContentLength > 0
            ) ?
                `span:${record.entryContentOffset}:${record.entryContentLength}:${record.entryContentDictName}` :
                '';
            if (cacheKey.length === 0) {
                groups.push([entry]);
                continue;
            }
            let group = groupByKey.get(cacheKey);
            if (typeof group === 'undefined') {
                group = [];
                groupByKey.set(cacheKey, group);
                groups.push(group);
            }
            group.push(entry);
        }
        return groups;
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {Promise<import('dictionary-database').DatabaseTermEntryWithId>}
     */
    async _deserializeTermRow(row) {
        const entryContentId = this._asNullableNumber(row.entryContentId);
        const contentOffset = this._asNumber(row.entryContentOffset, -1);
        const contentLength = this._asNumber(row.entryContentLength, -1);
        const contentDictName = this._asNullableString(row.entryContentDictName) ?? '';
        const hasExternalContentSpan = contentOffset >= 0 && contentLength > 0;
        const cacheKey = hasExternalContentSpan ?
            `span:${contentOffset}:${contentLength}:${contentDictName}` :
            (typeof entryContentId === 'number' && entryContentId > 0 ? `id:${entryContentId}` : '');
        /** @type {string|null} */
        let definitionTags;
        /** @type {string|undefined} */
        let termTags;
        /** @type {string} */
        let rules;
        /** @type {import('dictionary-data').TermGlossary[]} */
        let glossary;
        /** @type {(() => import('dictionary-data').TermGlossary[])|null} */
        let glossaryResolver = null;

        if (cacheKey.length > 0) {
            let cached = this._getCachedTermEntryContent(cacheKey);
            if (typeof cached === 'undefined') {
                /** @type {Uint8Array|null} */
                let contentBytes = null;
                const dictionaryName = this._asString(row.dictionary);
                if (hasExternalContentSpan) {
                    const readResult = await this._readTermEntryContentBytesDetailed(contentOffset, contentLength, contentDictName);
                    if (readResult.status !== 'ok') {
                        reportDiagnostics('term-content-lookup-read-failed', {
                            dictionaryName,
                            status: readResult.status,
                            reason: readResult.reason,
                            contentOffset,
                            contentLength,
                            contentDictName,
                        });
                        if (readResult.status === 'corrupt' && dictionaryName.length > 0) {
                            this._termRecordStore.markDictionaryReimportRequired(
                                this._getTermRecordStorageName(dictionaryName),
                                readResult.reason,
                            );
                        }
                        throw new Error(
                            readResult.status === 'corrupt' ?
                                `Dictionary content is damaged and must be re-imported: ${dictionaryName}` :
                                `Dictionary content is temporarily unavailable: ${dictionaryName}`,
                        );
                    }
                    contentBytes = readResult.bytes;
                }
                if (contentBytes !== null && contentBytes.length > 0) {
                    try {
                        const rawSharedGlossaryHeader = (
                            contentDictName === RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME ||
                            contentDictName === RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME ||
                            isRawTermContentSharedGlossaryBinary(contentBytes)
                        ) ?
                            decodeRawTermContentSharedGlossaryHeader(contentBytes, this._textDecoder) :
                            null;
                        if (rawSharedGlossaryHeader !== null) {
                            definitionTags = this._asNullableString(rawSharedGlossaryHeader.definitionTags) ?? null;
                            termTags = this._asNullableString(rawSharedGlossaryHeader.termTags);
                            rules = this._asString(rawSharedGlossaryHeader.rules);
                            let rawGlossaryJsonBytes;
                            if (contentDictName === RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME) {
                                rawGlossaryJsonBytes = await this._readCompressedSharedGlossarySlice(
                                    this._asString(row.dictionary),
                                    rawSharedGlossaryHeader.glossaryOffset,
                                    rawSharedGlossaryHeader.glossaryLength,
                                );
                            } else {
                                const glossaryReadResult = await this._readTermEntryContentBytesDetailed(
                                    rawSharedGlossaryHeader.glossaryOffset,
                                    rawSharedGlossaryHeader.glossaryLength,
                                    'raw',
                                );
                                if (glossaryReadResult.status !== 'ok') {
                                    throw new TermContentLookupReadError(glossaryReadResult.status, glossaryReadResult.reason);
                                }
                                rawGlossaryJsonBytes = glossaryReadResult.bytes;
                            }
                            const glossaryJson = this._textDecoder.decode(rawGlossaryJsonBytes);
                            glossary = parseJson(glossaryJson);
                            if (!Array.isArray(glossary)) {
                                throw new Error('Shared glossary payload is not an array');
                            }
                            cached = {
                                definitionTags,
                                termTags,
                                rules,
                                glossaryJson,
                                glossary: Array.isArray(glossary) ? glossary : [],
                            };
                        } else {
                            const rawContentHeader = (
                                contentDictName === RAW_TERM_CONTENT_DICT_NAME ||
                                isRawTermContentBinary(contentBytes)
                            ) ?
                                decodeRawTermContentHeader(contentBytes, this._textDecoder) :
                                (
                                    (
                                        contentDictName === RAW_TERM_CONTENT_TOKEN_DICT_NAME ||
                                        isRawTermContentTokenBinary(contentBytes)
                                    ) ?
                                        decodeRawTermContentTokenHeader(contentBytes, this._textDecoder) :
                                        null
                                );
                            if (rawContentHeader !== null) {
                                definitionTags = this._asNullableString(rawContentHeader.definitionTags) ?? null;
                                termTags = this._asNullableString(rawContentHeader.termTags);
                                rules = this._asString(rawContentHeader.rules);
                                const rawGlossaryJsonBytes = getRawTermContentGlossaryJsonBytes(
                                    contentBytes,
                                    rawContentHeader.glossaryJsonOffset,
                                    rawContentHeader.glossaryJsonLength,
                                );
                                const glossaryJson = this._textDecoder.decode(rawGlossaryJsonBytes);
                                glossary = parseJson(glossaryJson);
                                if (!Array.isArray(glossary)) {
                                    throw new Error('Term glossary payload is not an array');
                                }
                                cached = {
                                    definitionTags,
                                    termTags,
                                    rules,
                                    glossaryJson,
                                    glossary: Array.isArray(glossary) ? glossary : [],
                                };
                            } else {
                                // Block references describe their container compression; the
                                // extracted entry is the original raw payload and must not be
                                // decompressed a second time.
                                const isBlockContent = typeof getRawTermContentBlockCompressionDictName(contentDictName) !== 'undefined';
                                const contentJson = (contentDictName === 'raw' || isBlockContent) ?
                                    this._textDecoder.decode(contentBytes) :
                                    this._textDecoder.decode(decompressTermContentZstd(contentBytes, contentDictName.length > 0 ? contentDictName : null));
                                const parsedHeader = this._parseSerializedTermEntryContentHeader(contentJson);
                                if (parsedHeader !== null) {
                                    definitionTags = parsedHeader.definitionTags;
                                    termTags = parsedHeader.termTags;
                                    rules = parsedHeader.rules;
                                    glossary = parseJson(parsedHeader.glossaryJson);
                                    if (!Array.isArray(glossary)) {
                                        throw new Error('Serialized term glossary payload is not an array');
                                    }
                                    cached = {
                                        definitionTags,
                                        termTags,
                                        rules,
                                        glossaryJson: parsedHeader.glossaryJson,
                                        glossary: Array.isArray(glossary) ? glossary : [],
                                    };
                                } else {
                                    const parsedContent = /** @type {unknown} */ (parseJson(contentJson));
                                    if (parsedContent === null || typeof parsedContent !== 'object' || Array.isArray(parsedContent)) {
                                        throw new Error('Serialized term content payload is not an object');
                                    }
                                    const content = /** @type {{rules?: string, definitionTags?: string, termTags?: string, glossary?: import('dictionary-data').TermGlossary[]}} */ (parsedContent);
                                    if (!Array.isArray(content.glossary)) {
                                        throw new Error('Serialized term content glossary is not an array');
                                    }
                                    definitionTags = this._asNullableString(content.definitionTags) ?? null;
                                    termTags = this._asNullableString(content.termTags);
                                    rules = this._asString(content.rules);
                                    glossary = Array.isArray(content.glossary) ? content.glossary : [];
                                    cached = {
                                        definitionTags,
                                        termTags,
                                        rules,
                                        glossaryJson: JSON.stringify(glossary),
                                        glossary,
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        if (e instanceof TermContentLookupReadError) {
                            reportDiagnostics('term-content-lookup-read-failed', {
                                dictionaryName,
                                status: e.status,
                                reason: e.message,
                                contentOffset,
                                contentLength,
                                contentDictName,
                                phase: 'shared-glossary',
                            });
                            if (e.status === 'corrupt' && dictionaryName.length > 0) {
                                this._termRecordStore.markDictionaryReimportRequired(
                                    this._getTermRecordStorageName(dictionaryName),
                                    e.message,
                                );
                            }
                            throw new Error(
                                e.status === 'corrupt' ?
                                    `Dictionary content is damaged and must be re-imported: ${dictionaryName}` :
                                    `Dictionary content is temporarily unavailable: ${dictionaryName}`,
                                {cause: e},
                            );
                        }
                        logTermContentZstdError(e);
                        const reason = `Dictionary term content is malformed: ${toError(e).message}`;
                        reportDiagnostics('term-content-lookup-corrupt', {
                            dictionaryName,
                            reason,
                            contentOffset,
                            contentLength,
                            contentDictName,
                        });
                        if (dictionaryName.length > 0) {
                            this._termRecordStore.markDictionaryReimportRequired(
                                this._getTermRecordStorageName(dictionaryName),
                                reason,
                            );
                        }
                        throw new Error(reason, {cause: e});
                    }
                } else {
                    definitionTags = null;
                    termTags = '';
                    rules = '';
                    glossary = [];
                    cached = {
                        definitionTags,
                        termTags,
                        rules,
                        glossaryJson: '[]',
                        glossary,
                    };
                }
                this._setCachedTermEntryContent(cacheKey, cached);
            }
            definitionTags = cached.definitionTags;
            termTags = cached.termTags;
            rules = cached.rules;
            if (Array.isArray(cached.glossary)) {
                glossary = cached.glossary;
            } else {
                glossary = [];
                glossaryResolver = () => this._resolveCachedTermEntryGlossary(cached);
            }
        } else {
            definitionTags = this._asNullableString(row.definitionTags) ?? null;
            termTags = this._asNullableString(row.termTags);
            rules = this._asString(row.rules);
            glossary = this._safeParseJson(this._asString(row.glossaryJson), []);
        }
        const termEntry = {
            id: this._asNumber(row.id, -1),
            expression: this._asString(row.expression),
            reading: this._asString(row.reading),
            expressionReverse: this._asNullableString(row.expressionReverse),
            readingReverse: this._asNullableString(row.readingReverse),
            definitionTags,
            rules,
            score: this._asNumber(row.score, 0),
            glossary,
            sequence: this._asNullableNumber(row.sequence),
            termTags,
            dictionary: this._asString(row.dictionary),
        };
        if (glossaryResolver !== null) {
            Object.defineProperty(termEntry, 'glossary', {
                enumerable: true,
                configurable: true,
                get: () => {
                    const resolvedGlossary = glossaryResolver();
                    Object.defineProperty(termEntry, 'glossary', {
                        enumerable: true,
                        configurable: true,
                        writable: true,
                        value: resolvedGlossary,
                    });
                    return resolvedGlossary;
                },
                set: (value) => {
                    Object.defineProperty(termEntry, 'glossary', {
                        enumerable: true,
                        configurable: true,
                        writable: true,
                        value: Array.isArray(value) ? value : [],
                    });
                },
            });
        }
        return termEntry;
    }

    /**
     * @param {string} cacheKey
     * @returns {{definitionTags: string|null, termTags: string|undefined, rules: string, glossaryJson?: string, glossary?: import('dictionary-data').TermGlossary[]}|undefined}
     */
    _getCachedTermEntryContent(cacheKey) {
        const cached = this._termEntryContentCache.get(cacheKey);
        return typeof cached === 'undefined' ? void 0 : cached;
    }

    /**
     * @param {string} cacheKey
     * @param {{definitionTags: string|null, termTags: string|undefined, rules: string, glossaryJson?: string, glossary?: import('dictionary-data').TermGlossary[]}} value
     */
    _setCachedTermEntryContent(cacheKey, value) {
        this._termEntryContentCache.set(cacheKey, value);
    }

    /**
     * @param {number} id
     * @returns {import('dictionary-database').DatabaseTermEntryWithId|undefined}
     */
    _getCachedTermRow(id) {
        const cached = this._termRowCache.get(id);
        if (typeof cached === 'undefined') {
            return void 0;
        }
        this._termRowCache.delete(id);
        this._termRowCache.set(id, cached);
        return cached;
    }

    /**
     * @param {number} id
     * @param {import('dictionary-database').DatabaseTermEntryWithId} value
     */
    _setCachedTermRow(id, value) {
        if (this._termRowCache.has(id)) {
            this._termRowCache.delete(id);
        }
        this._termRowCache.set(id, value);
        while (this._termRowCache.size > TERM_ROW_CACHE_MAX_ENTRIES) {
            const oldestKey = this._termRowCache.keys().next().value;
            if (typeof oldestKey !== 'number') { break; }
            this._termRowCache.delete(oldestKey);
        }
    }

    /**
     * @param {string} cacheKey
     * @param {boolean} present
     */
    _setTermExactPresenceCached(cacheKey, present) {
        if (this._termExactPresenceCache.has(cacheKey)) {
            this._termExactPresenceCache.delete(cacheKey);
        }
        this._termExactPresenceCache.set(cacheKey, present);
        while (this._termExactPresenceCache.size > this._termExactPresenceCacheMaxEntries) {
            const oldestKey = this._termExactPresenceCache.keys().next().value;
            if (typeof oldestKey !== 'string') { break; }
            this._termExactPresenceCache.delete(oldestKey);
        }
    }

    /**
     * @param {{glossaryJson?: string, glossary?: import('dictionary-data').TermGlossary[], definitionTags: string|null, termTags: string|undefined, rules: string}} cached
     * @returns {import('dictionary-data').TermGlossary[]}
     */
    _resolveCachedTermEntryGlossary(cached) {
        if (Array.isArray(cached.glossary)) {
            return cached.glossary;
        }
        const parsedGlossary = this._safeParseJson(typeof cached.glossaryJson === 'string' ? cached.glossaryJson : '[]', []);
        cached.glossary = Array.isArray(parsedGlossary) ? parsedGlossary : [];
        return cached.glossary;
    }

    /**
     * @param {string} value
     * @param {number} startIndex
     * @returns {{token: string, endIndex: number}|null}
     */
    _readJsonStringToken(value, startIndex) {
        if (startIndex < 0 || startIndex >= value.length || value[startIndex] !== '"') {
            return null;
        }
        let i = startIndex + 1;
        const ii = value.length;
        while (i < ii) {
            const c = value[i];
            if (c === '\\') {
                i += 2;
                continue;
            }
            if (c === '"') {
                return {
                    token: value.slice(startIndex, i + 1),
                    endIndex: i + 1,
                };
            }
            ++i;
        }
        return null;
    }

    /**
     * @param {string} contentJson
     * @returns {{rules: string, definitionTags: string|null, termTags: string|undefined, glossaryJson: string}|null}
     */
    _parseSerializedTermEntryContentHeader(contentJson) {
        const prefixRules = '{"rules":';
        const prefixDefinitionTags = ',"definitionTags":';
        const prefixTermTags = ',"termTags":';
        const prefixGlossary = ',"glossary":';
        if (!contentJson.startsWith(prefixRules) || !contentJson.endsWith('}')) {
            return null;
        }

        let index = prefixRules.length;
        const rulesToken = this._readJsonStringToken(contentJson, index);
        if (rulesToken === null) { return null; }
        index = rulesToken.endIndex;
        if (!contentJson.startsWith(prefixDefinitionTags, index)) { return null; }
        index += prefixDefinitionTags.length;

        const definitionTagsToken = this._readJsonStringToken(contentJson, index);
        if (definitionTagsToken === null) { return null; }
        index = definitionTagsToken.endIndex;
        if (!contentJson.startsWith(prefixTermTags, index)) { return null; }
        index += prefixTermTags.length;

        const termTagsToken = this._readJsonStringToken(contentJson, index);
        if (termTagsToken === null) { return null; }
        index = termTagsToken.endIndex;
        if (!contentJson.startsWith(prefixGlossary, index)) { return null; }
        index += prefixGlossary.length;
        if (index > contentJson.length - 1) { return null; }

        const glossaryJson = contentJson.slice(index, -1);
        return {
            rules: /** @type {string} */ (this._safeParseJson(rulesToken.token, '')),
            definitionTags: this._asNullableString(this._safeParseJson(definitionTagsToken.token, '')) ?? null,
            termTags: this._asNullableString(this._safeParseJson(termTagsToken.token, '')),
            glossaryJson,
        };
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {import('dictionary-database').DatabaseTermMeta}
     * @throws {Error}
     */
    _deserializeTermMetaRow(row) {
        const expression = this._asString(row.expression);
        const dictionary = this._asString(row.dictionary);
        const mode = this._asString(row.mode);
        const data = /** @type {unknown} */ (this._safeParseJson(this._asString(row.dataJson), null));
        switch (mode) {
            case 'freq':
                return {
                    expression,
                    mode: 'freq',
                    data: /** @type {import('dictionary-data').GenericFrequencyData | import('dictionary-data').TermMetaFrequencyDataWithReading} */ (data),
                    dictionary,
                };
            case 'pitch':
                return {
                    expression,
                    mode: 'pitch',
                    data: /** @type {import('dictionary-data').TermMetaPitchData} */ (data),
                    dictionary,
                };
            case 'ipa':
                return {
                    expression,
                    mode: 'ipa',
                    data: /** @type {import('dictionary-data').TermMetaPhoneticData} */ (data),
                    dictionary,
                };
            default:
                throw new Error(`Unknown mode: ${mode}`);
        }
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {import('dictionary-database').DatabaseKanjiEntry}
     */
    _deserializeKanjiRow(row) {
        return {
            character: this._asString(row.character),
            onyomi: this._asString(row.onyomi),
            kunyomi: this._asString(row.kunyomi),
            tags: this._asString(row.tags),
            meanings: this._safeParseJson(this._asString(row.meaningsJson), []),
            dictionary: this._asString(row.dictionary),
            stats: this._safeParseJson(this._asNullableString(row.statsJson) ?? '{}', {}),
        };
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {import('dictionary-database').DatabaseKanjiMeta}
     * @throws {Error}
     */
    _deserializeKanjiMetaRow(row) {
        const character = this._asString(row.character);
        const dictionary = this._asString(row.dictionary);
        const mode = this._asString(row.mode);
        const data = /** @type {unknown} */ (this._safeParseJson(this._asString(row.dataJson), null));
        if (mode !== 'freq') {
            throw new Error(`Unknown mode: ${mode}`);
        }
        return {
            character,
            mode: 'freq',
            data: /** @type {import('dictionary-data').GenericFrequencyData} */ (data),
            dictionary,
        };
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {import('dictionary-database').Tag}
     */
    _deserializeTagRow(row) {
        return {
            name: this._asString(row.name),
            category: this._asString(row.category),
            order: this._asNumber(row.order, 0),
            notes: this._asString(row.notes),
            score: this._asNumber(row.score, 0),
            dictionary: this._asString(row.dictionary),
        };
    }

    /**
     * @param {import('core').SafeAny} row
     * @returns {Promise<import('dictionary-database').MediaDataArrayBufferContent>}
     */
    async _deserializeMediaRow(row) {
        const contentOffset = this._asNumber(row.contentOffset, 0);
        const contentLength = this._asNumber(row.contentLength, 0);
        const contentCompressionMethod = this._asNumber(row.contentCompressionMethod, ZIP_COMPRESSION_METHOD_STORE);
        const contentUncompressedLength = this._asNumber(row.contentUncompressedLength, 0);
        let content = this._toArrayBuffer(row.content);
        if (contentLength > 0 && content.byteLength === 0) {
            try {
                let contentBytes = await this._termContentStore.readSlice(contentOffset, contentLength);
                if (contentBytes !== null) {
                    if (contentCompressionMethod !== ZIP_COMPRESSION_METHOD_STORE) {
                        contentBytes = await inflateZipMediaContent(contentBytes, contentCompressionMethod, contentUncompressedLength);
                    }
                    content = (
                        contentBytes.byteOffset === 0 &&
                        contentBytes.byteLength === contentBytes.buffer.byteLength
                    ) ?
                        contentBytes.buffer :
                        contentBytes.buffer.slice(contentBytes.byteOffset, contentBytes.byteOffset + contentBytes.byteLength);
                }
            } catch (e) {
                logTermContentZstdError(e);
            }
        }
        return {
            dictionary: this._asString(row.dictionary),
            path: this._asString(row.path),
            mediaType: this._asString(row.mediaType),
            width: this._asNumber(row.width, 0),
            height: this._asNumber(row.height, 0),
            content,
            contentOffset,
            contentLength,
            contentCompressionMethod,
            contentUncompressedLength,
        };
    }

    /**
     * @param {unknown} field
     * @returns {string[]}
     */
    _splitField(field) {
        return typeof field === 'string' && field.length > 0 ? field.split(' ') : [];
    }

    /**
     * @param {unknown} value
     * @returns {ArrayBuffer}
     */
    _toArrayBuffer(value) {
        if (value instanceof ArrayBuffer) {
            return value;
        }
        if (value instanceof Uint8Array) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        return new ArrayBuffer(0);
    }

    /**
     * @param {unknown} value
     * @returns {Uint8Array|null}
     */
    _toUint8Array(value) {
        if (value instanceof Uint8Array) {
            return value;
        }
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }
        return null;
    }

    /**
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {boolean}
     */
    _areUint8ArraysEqual(a, b) {
        if (a.byteLength !== b.byteLength) {
            return false;
        }
        for (let i = 0, ii = a.byteLength; i < ii; ++i) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * @returns {number}
     */
    _computeStatementCacheMaxEntries() {
        const memoryGiB = this._getApproximateDeviceMemoryGiB();
        return memoryGiB !== null && memoryGiB <= 4 ? LOW_MEMORY_STATEMENT_CACHE_MAX_ENTRIES : DEFAULT_STATEMENT_CACHE_MAX_ENTRIES;
    }

    /**
     * @returns {number}
     */
    _computeTermExactPresenceCacheMaxEntries() {
        const memoryGiB = this._getApproximateDeviceMemoryGiB();
        return memoryGiB !== null && memoryGiB <= 4 ? LOW_MEMORY_TERM_EXACT_PRESENCE_CACHE_MAX_ENTRIES : DEFAULT_TERM_EXACT_PRESENCE_CACHE_MAX_ENTRIES;
    }

    /**
     * @returns {number}
     */
    _computeDefaultTermBulkAddStagingMaxRows() {
        const memoryGiB = this._getApproximateDeviceMemoryGiB();
        if (memoryGiB !== null && memoryGiB <= 4) {
            return TERM_BULK_ADD_STAGING_MAX_ROWS;
        }
        if (memoryGiB !== null && memoryGiB >= 8) {
            return HIGH_MEMORY_TERM_BULK_ADD_STAGING_MAX_ROWS;
        }
        return DEFAULT_TERM_BULK_ADD_STAGING_MAX_ROWS;
    }

    /**
     * @returns {number|null}
     */
    _getApproximateDeviceMemoryGiB() {
        try {
            const rawValue = /** @type {unknown} */ (Reflect.get(globalThis.navigator ?? {}, 'deviceMemory'));
            if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
                return rawValue;
            }
        } catch (_) {
            // NOP
        }
        return null;
    }

    /**
     * @param {number[]} values
     * @returns {number}
     */
    _average(values) {
        if (values.length === 0) { return 0; }
        let total = 0;
        for (const value of values) {
            total += value;
        }
        return total / values.length;
    }

    /**
     * @param {number[]} values
     * @returns {number}
     */
    _p95(values) {
        if (values.length === 0) { return 0; }
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
        return sorted[index];
    }

    /**
     * @param {unknown} value
     * @param {number} defaultValue
     * @returns {number}
     */
    _asNumber(value, defaultValue = 0) {
        if (typeof value === 'number') { return value; }
        if (typeof value === 'bigint') { return Number(value); }
        if (typeof value === 'string' && value.length > 0) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : defaultValue;
        }
        return defaultValue;
    }

    /**
     * @param {unknown} value
     * @returns {number|undefined}
     */
    _asNullableNumber(value) {
        if (value === null || typeof value === 'undefined') {
            return void 0;
        }
        return this._asNumber(value, 0);
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _asString(value) {
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'bigint') {
            return `${value}`;
        }
        return '';
    }

    /**
     * @param {unknown} value
     * @returns {string|undefined}
     */
    _asNullableString(value) {
        if (value === null || typeof value === 'undefined') {
            return void 0;
        }
        return this._asString(value);
    }

    /**
     * @template [T=unknown]
     * @param {string} value
     * @param {T} fallback
     * @returns {T}
     */
    _safeParseJson(value, fallback) {
        try {
            return /** @type {T} */ (parseJson(value));
        } catch (_) {
            return fallback;
        }
    }

    /**
     * @param {string} rules
     * @param {string} definitionTags
     * @param {string} termTags
     * @param {import('dictionary-data').TermGlossary[]} glossary
     * @returns {string}
     */
    _serializeTermEntryContent(rules, definitionTags, termTags, glossary) {
        return JSON.stringify({rules, definitionTags, termTags, glossary});
    }

    /**
     * @param {import('dictionary-database').DatabaseTermEntry} row
     * @returns {Uint8Array|null}
     */
    _getRawTermContentBytesIfAvailable(row) {
        const glossaryJsonBytes = row.termEntryContentRawGlossaryJsonBytes;
        if (!(glossaryJsonBytes instanceof Uint8Array) || glossaryJsonBytes.byteLength === 0) {
            return null;
        }
        const rules = row.rules ?? '';
        const definitionTags = row.definitionTags ?? row.tags ?? '';
        const termTags = row.termTags ?? '';
        const contentBytes = encodeRawTermContentBinary(rules, definitionTags, termTags, glossaryJsonBytes, this._textEncoder);
        row.termEntryContentBytes = contentBytes;
        row.termEntryContentRawGlossaryJsonBytes = void 0;
        return contentBytes;
    }

    /**
     * @param {string} contentJson
     * @returns {string}
     */
    _hashEntryContent(contentJson) {
        return hashTermEntryContentBytes(this._textEncoder.encode(contentJson));
    }

    /**
     * @param {Uint8Array[]} contentBytesList
     * @param {string|null} compressionDictName
     * @param {(string|null)[]} [contentDictNameOverrides]
     * @param {string|null} [uniformRawContentDictName]
     * @returns {{storedChunks: Uint8Array[], contentDictNames: string[]|string, entryToStoredChunkIndexes: number[]|Uint32Array, entryToStoredChunkOffsets: number[]|Uint32Array}}
     */
    _createTermContentStorageChunks(contentBytesList, compressionDictName, contentDictNameOverrides = [], uniformRawContentDictName = null) {
        if (this._termContentStorageMode === TERM_CONTENT_STORAGE_MODE_RAW_BYTES) {
            const firstContentLength = contentBytesList[0]?.byteLength ?? 0;
            let useFixedSizePacking = firstContentLength > 0;
            for (let i = 1; i < contentBytesList.length && useFixedSizePacking; ++i) {
                if (contentBytesList[i].byteLength !== firstContentLength) {
                    useFixedSizePacking = false;
                }
            }
            let storedChunks;
            let entryToStoredChunkIndexes;
            let entryToStoredChunkOffsets;
            if (useFixedSizePacking) {
                const packed = packFixedSizeContentChunksIntoSlabs(
                    contentBytesList,
                    this._rawTermContentPackTargetBytes,
                    firstContentLength,
                );
                storedChunks = packed.packedChunks;
                entryToStoredChunkIndexes = new Uint32Array(contentBytesList.length);
                entryToStoredChunkOffsets = new Uint32Array(contentBytesList.length);
                for (let packedIndex = 0; packedIndex < packed.packedChunks.length; ++packedIndex) {
                    const rowStart = packed.packedRowStarts[packedIndex];
                    const rowCount = packed.packedRowCounts[packedIndex];
                    for (let localIndex = 0; localIndex < rowCount; ++localIndex) {
                        const rowIndex = rowStart + localIndex;
                        entryToStoredChunkIndexes[rowIndex] = packedIndex;
                        entryToStoredChunkOffsets[rowIndex] = localIndex * firstContentLength;
                    }
                }
            } else {
                const packed = packContentChunksIntoSlabs(contentBytesList, this._rawTermContentPackTargetBytes);
                storedChunks = packed.packedChunks;
                entryToStoredChunkIndexes = packed.sourceChunkIndices;
                entryToStoredChunkOffsets = packed.sourceChunkLocalOffsets;
            }
            if (typeof uniformRawContentDictName === 'string' && uniformRawContentDictName.length > 0) {
                return {
                    storedChunks,
                    contentDictNames: uniformRawContentDictName,
                    entryToStoredChunkIndexes,
                    entryToStoredChunkOffsets,
                };
            }
            return {
                storedChunks,
                contentDictNames: contentBytesList.map((contentBytes, index) => {
                    const override = contentDictNameOverrides[index];
                    if (typeof override === 'string' && override.length > 0) {
                        return override;
                    }
                    return isRawTermContentBinary(contentBytes) ?
                        RAW_TERM_CONTENT_DICT_NAME :
                        (isRawTermContentSharedGlossaryBinary(contentBytes) ? RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME : 'raw');
                }),
                entryToStoredChunkIndexes,
                entryToStoredChunkOffsets,
            };
        }
        /** @type {Uint8Array[]} */
        const storedChunks = [];
        /** @type {string[]} */
        const contentDictNames = [];
        for (const contentBytes of contentBytesList) {
            let storedBytes = contentBytes;
            let effectiveDictName = 'raw';
            if (contentBytes.byteLength >= this._termContentCompressionMinBytes) {
                const compressed = compressTermContentZstd(contentBytes, compressionDictName);
                if (compressed.byteLength < contentBytes.byteLength) {
                    storedBytes = compressed;
                    effectiveDictName = compressionDictName ?? '';
                }
            }
            storedChunks.push(storedBytes);
            contentDictNames.push(effectiveDictName);
        }
        return {
            storedChunks,
            contentDictNames,
            entryToStoredChunkIndexes: storedChunks.map((_, index) => index),
            entryToStoredChunkOffsets: storedChunks.map(() => 0),
        };
    }

    /**
     * @param {number} rowCount
     * @returns {number}
     */
    _getTermBulkAddBatchSizeForCount(rowCount) {
        const baseline = this._termBulkAddBatchSize;
        if (!this._adaptiveTermBulkAddBatchSize) {
            return baseline;
        }
        let candidate = baseline;
        if (rowCount >= 300000) {
            candidate = 75000;
        } else if (rowCount >= 160000) {
            candidate = 75000;
        } else if (rowCount >= 60000) {
            candidate = 50000;
        } else if (rowCount >= 20000) {
            candidate = 37500;
        }
        return Math.max(1024, Math.min(100000, Math.max(baseline, candidate)));
    }

    /**
     * @param {Error} error
     * @returns {boolean}
     */
    _isRetryableBeginImmediateError(error) {
        return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(error.message);
    }

    /**
     * @param {Error} error
     * @returns {boolean}
     */
    _isAlreadyInTransactionError(error) {
        return /cannot start a transaction within a transaction/i.test(error.message);
    }

    /**
     * @param {Error} error
     * @returns {boolean}
     */
    _isNoActiveTransactionError(error) {
        return /cannot commit - no transaction is active|cannot rollback - no transaction is active/i.test(error.message);
    }

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    async _sleep(ms) {
        if (ms <= 0) { return; }
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    /**
     * @param {import('@sqlite.org/sqlite-wasm').Database} db
     * @param {boolean} [allowExisting=true]
     * @returns {Promise<void>}
     * @throws {Error}
     */
    async _beginImmediateTransaction(db, allowExisting = true) {
        if (!this._retryBeginImmediateTransaction) {
            try {
                db.exec('BEGIN IMMEDIATE');
            } catch (e) {
                const error = toError(e);
                if (allowExisting && this._isAlreadyInTransactionError(error)) {
                    return;
                }
                throw error;
            }
            return;
        }
        const retryBackoffMs = [0, 8, 16, 32, 64, 128];
        /** @type {Error|null} */
        let lastError = null;
        for (let i = 0; i < retryBackoffMs.length; ++i) {
            await this._sleep(retryBackoffMs[i]);
            try {
                db.exec('BEGIN IMMEDIATE');
                return;
            } catch (e) {
                const error = toError(e);
                if (allowExisting && this._isAlreadyInTransactionError(error)) {
                    return;
                }
                lastError = error;
                if (!this._isRetryableBeginImmediateError(error) || i >= (retryBackoffMs.length - 1)) {
                    throw error;
                }
            }
        }
        if (lastError !== null) {
            throw lastError;
        }
        throw new Error('BEGIN IMMEDIATE failed with unknown error');
    }

    /** */
    _applyRuntimePragmas() {
        const db = this._requireDb();
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA temp_store = MEMORY');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('PRAGMA wal_autocheckpoint = 1000');
        db.exec('PRAGMA cache_size = -16384');
        db.exec('PRAGMA cache_spill = ON');
        db.exec('PRAGMA locking_mode = NORMAL');
    }

    /** */
    _applyImportPragmas() {
        const db = this._requireDb();
        /** @param {string} sql */
        const execBestEffort = (sql) => {
            try {
                db.exec(sql);
            } catch (e) {
                const message = toError(e).message;
                if (!/inside a transaction|cannot change .* within a transaction/i.test(message)) {
                    throw e;
                }
                reportDiagnostics('dictionary-import-pragma-skipped', {
                    sql,
                    reason: message,
                });
            }
        };
        execBestEffort('PRAGMA journal_mode = WAL');
        execBestEffort('PRAGMA synchronous = OFF');
        execBestEffort('PRAGMA temp_store = MEMORY');
        execBestEffort('PRAGMA foreign_keys = OFF');
        execBestEffort('PRAGMA cache_size = -131072');
        execBestEffort('PRAGMA cache_spill = OFF');
        execBestEffort('PRAGMA wal_autocheckpoint = 0');
        // OPFS-backed sqlite handles can see generic I/O/CANTOPEN failures under
        // contention when EXCLUSIVE mode is held for long imports. Keep NORMAL
        // here so concurrent extension handles can continue to cooperate.
        execBestEffort('PRAGMA locking_mode = NORMAL');
    }

    /**
     * @param {import('dictionary-database').MatchSource} matchSource
     * @param {import('dictionary-database').MatchType} matchType
     * @param {import('dictionary-database').DatabaseTermEntryWithId} row
     * @param {number} index
     * @returns {import('dictionary-database').TermEntry}
     */
    _createTerm(matchSource, matchType, row, index) {
        const {sequence} = row;
        return {
            index,
            matchType,
            matchSource,
            term: row.expression,
            reading: row.reading,
            definitionTags: this._splitField(row.definitionTags || row.tags),
            termTags: this._splitField(row.termTags),
            rules: this._splitField(row.rules),
            definitions: row.glossary,
            score: row.score,
            dictionary: row.dictionary,
            id: row.id,
            sequence: typeof sequence === 'number' ? sequence : -1,
        };
    }

    /**
     * @param {import('dictionary-database').DatabaseKanjiEntry} row
     * @param {import('dictionary-database').FindMultiBulkData<string>} data
     * @returns {import('dictionary-database').KanjiEntry}
     */
    _createKanji(row, {itemIndex: index}) {
        const {stats} = row;
        return {
            index,
            character: row.character,
            onyomi: this._splitField(row.onyomi),
            kunyomi: this._splitField(row.kunyomi),
            tags: this._splitField(row.tags),
            definitions: row.meanings,
            stats: typeof stats === 'object' && stats !== null ? stats : {},
            dictionary: row.dictionary,
        };
    }

    /**
     * @param {import('dictionary-database').DatabaseTermMeta} row
     * @param {import('dictionary-database').FindMultiBulkData<string>} data
     * @returns {import('dictionary-database').TermMeta}
     * @throws {Error}
     */
    _createTermMeta({expression: term, mode, data, dictionary}, {itemIndex: index}) {
        switch (mode) {
            case 'freq':
                return {
                    index,
                    term,
                    mode: 'freq',
                    data: /** @type {import('dictionary-data').GenericFrequencyData | import('dictionary-data').TermMetaFrequencyDataWithReading} */ (data),
                    dictionary,
                };
            case 'pitch':
                return {
                    index,
                    term,
                    mode: 'pitch',
                    data: /** @type {import('dictionary-data').TermMetaPitchData} */ (data),
                    dictionary,
                };
            case 'ipa':
                return {
                    index,
                    term,
                    mode: 'ipa',
                    data: /** @type {import('dictionary-data').TermMetaPhoneticData} */ (data),
                    dictionary,
                };
            default:
                throw new Error(`Unknown mode: ${mode}`);
        }
    }

    /**
     * @param {import('dictionary-database').DatabaseKanjiMeta} row
     * @param {import('dictionary-database').FindMultiBulkData<string>} data
     * @returns {import('dictionary-database').KanjiMeta}
     */
    _createKanjiMeta({character, mode, data, dictionary}, {itemIndex: index}) {
        return {index, character, mode, data, dictionary};
    }

    /**
     * @param {import('dictionary-database').MediaDataArrayBufferContent} row
     * @param {import('dictionary-database').FindMultiBulkData<import('dictionary-database').MediaRequest>} data
     * @returns {import('dictionary-database').Media}
     */
    _createMedia(row, {itemIndex: index}) {
        const {dictionary, path, mediaType, width, height, content} = row;
        return {index, dictionary, path, mediaType, width, height, content};
    }
}
