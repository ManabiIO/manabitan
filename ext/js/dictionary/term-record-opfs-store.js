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

import {reportDiagnostics} from '../core/diagnostics-reporter.js';
import {safePerformance} from '../core/safe-performance.js';
import {toError} from '../core/to-error.js';
import {
    RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
    RAW_TERM_CONTENT_DICT_NAME,
    RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from './raw-term-content.js';
import {
    appendExactRowMatches,
    encodePersistedTermLookupIndexFromPreinternedPlan,
    encodePersistedTermLookupIndexFromRecordPayload,
    findExactRows,
    findPrefixRowMatches,
    findPrefixRows,
    findSequenceRows,
    getPersistedTermKeyBytes,
    getPersistedTermSequence,
    hashTermLookupKeyBytes,
    parseChecksummedPersistedTermLookupIndex,
    warmPersistedTermPrefixIndex,
} from './term-lookup-index.js';
import {
    hasCompletePreparedTermLookupIndexes,
    MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS,
    prepareTermLookupIndexesFromPreinternedPlan,
} from './term-lookup-index-preparation.js';
import {
    compactTermRecordPreinternedPlan,
    getTermRecordPreinternedPlan,
    hasCompleteTermRecordPreinternedPlan,
    selectTermRecordPreinternedPlan,
    sliceTermRecordPreinternedPlan,
} from './term-record-preinterned-plan.js';
import {encodeTermRecordArtifactChunkWithWasmPreinterned, encodeTermRecordsWithWasm, encodeTermRecordsWithWasmPreinterned} from './term-record-wasm-encoder.js';

const SHARD_DIRECTORY_NAME = 'manabitan-term-records';
const SHARD_FILE_PREFIX = 'dict-';
const SHARD_FILE_SUFFIX = '.mbtr';
const LOOKUP_INDEX_FILE_SUFFIX = '.mbti';
const SHARD_FILE_CONTENT_DICT_SEPARATOR = '|';
const SHARD_FILE_SEGMENT_SEPARATOR = '^';
const BINARY_MAGIC_TEXT = 'MBTRR15X';
const BINARY_MAGIC_BYTES = 8;
const SHARD_GENERATION_BYTES = 16;
const BINARY_HEADER_PREFIX_BYTES = BINARY_MAGIC_BYTES + SHARD_GENERATION_BYTES;
const CHUNK_HEADER_BYTES = 20;
const STRING_TABLE_HEADER_BYTES = 8;
const RECORD_HEADER_BYTES = 24;
const U32_NULL = 0xffffffff;
const MAX_CONTENT_OFFSET_DELTA = U32_NULL - 1;
const U32_RANGE = 0x100000000;
const U16_NULL = 0xffff;
const READING_EQUALS_EXPRESSION_U32 = 0xffffffff;
const DEFAULT_FLUSH_THRESHOLD_BYTES = 8 * 1024 * 1024;
const LOW_MEMORY_FLUSH_THRESHOLD_BYTES = 8 * 1024 * 1024;
const PREFIX_WARM_YIELD_BUDGET_MS = 8;
const HIGH_MEMORY_FLUSH_THRESHOLD_BYTES = 16 * 1024 * 1024;
const DEFAULT_QUEUED_WRITE_BUDGET_BYTES = 64 * 1024 * 1024;
const LOW_MEMORY_QUEUED_WRITE_BUDGET_BYTES = 24 * 1024 * 1024;
const HIGH_MEMORY_QUEUED_WRITE_BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_WRITE_COALESCE_TARGET_BYTES = 4 * 1024 * 1024;
const LOW_MEMORY_WRITE_COALESCE_TARGET_BYTES = 1024 * 1024;
const HIGH_MEMORY_WRITE_COALESCE_TARGET_BYTES = 16 * 1024 * 1024;
const LARGE_IMPORT_EXPECTED_BYTES_THRESHOLD = 512 * 1024 * 1024;
const LARGE_IMPORT_WRITE_COALESCE_TARGET_BYTES = 64 * 1024 * 1024;
const WRITE_COALESCE_MAX_CHUNKS = 512;
const MAX_SHARD_SEGMENT_FILE_BYTES = 1024 * 1024 * 1024;
const SHARD_LOAD_CONCURRENCY = 3;
const LOOKUP_INDEX_MAGIC_TEXT = 'MBTIDX10';
const LOOKUP_INDEX_MAGIC_BYTES = 8;
const LOOKUP_INDEX_FILE_HEADER_BYTES = 40;
const LOOKUP_INDEX_CHUNK_HEADER_BYTES = 40;
const LOOKUP_INDEX_RECORD_FIELDS_BYTES = 12;
const LOOKUP_INDEX_FLUSH_THRESHOLD_BYTES = 4 * 1024 * 1024;
const EAGER_IMPORT_RECORD_WRITE_START_BYTES = 4 * 1024 * 1024;
const EAGER_IMPORT_LOOKUP_INDEX_WRITE_START_BYTES = 2 * 1024 * 1024;
const MAX_COMPACT_LOOKUP_INDEX_ROWS = MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS;
const PERSISTED_ONLY_IMPORT_ROW_THRESHOLD = 250000;
const SMALL_SHARD_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;
const STORAGE_READ_RETRY_COUNT = 2;
const REPAIR_YIELD_BUDGET_MS = 8;
const MAX_LOOKUP_INDEX_OVERHEAD_BYTES = 64 * 1024 * 1024;
const MAX_REPAIR_CHUNK_PAYLOAD_BYTES = 256 * 1024 * 1024;

/**
 * @param {{fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
 * @param {number} count
 * @returns {boolean}
 */
function hasFixedContentSpan(chunk, count) {
    return (
        count > 0 &&
        typeof chunk.fixedContentOffsetBase === 'number' &&
        Number.isFinite(chunk.fixedContentOffsetBase) &&
        chunk.fixedContentOffsetBase >= 0 &&
        typeof chunk.fixedContentLength === 'number' &&
        Number.isFinite(chunk.fixedContentLength) &&
        chunk.fixedContentLength >= 0
    );
}

/**
 * @param {{fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
 * @param {number[]|Uint32Array|Float64Array} contentOffsets
 * @param {number} index
 * @returns {number}
 */
function getArtifactContentOffset(chunk, contentOffsets, index) {
    if (hasFixedContentSpan(chunk, index + 1)) {
        return /** @type {number} */ (chunk.fixedContentOffsetBase) + (index * /** @type {number} */ (chunk.fixedContentLength));
    }
    return contentOffsets[index];
}

/**
 * @param {{fixedContentLength?: number}} chunk
 * @param {number[]|Uint32Array} contentLengths
 * @param {number} index
 * @returns {number}
 */
function getArtifactContentLength(chunk, contentLengths, index) {
    return typeof chunk.fixedContentLength === 'number' ? chunk.fixedContentLength : contentLengths[index];
}

/**
 * Reconstructs parser string offsets only for small imports which retain
 * materialized records. Persisted-only imports do not need this metadata.
 * @param {Uint16Array|undefined} lengths
 * @param {number} byteLength
 * @returns {Uint32Array|null}
 */
function reconstructTermStringOffsets(lengths, byteLength) {
    if (!(lengths instanceof Uint16Array) || lengths.length === 0) { return null; }
    const offsets = new Uint32Array(lengths.length);
    let cursor = 0;
    for (let i = 0; i < lengths.length; ++i) {
        const length = lengths[i];
        if (length <= 0 || cursor > byteLength - length) { return null; }
        offsets[i] = cursor;
        cursor += length;
    }
    return cursor === byteLength ? offsets : null;
}

/**
 * @param {Uint8Array} output
 * @param {number} offset
 * @param {number} value
 * @returns {number}
 */
function writeU16Le(output, offset, value) {
    output[offset] = value & 0xff;
    output[offset + 1] = (value >>> 8) & 0xff;
    return offset + 2;
}

/**
 * @param {Uint8Array} output
 * @param {number} offset
 * @param {number} value
 * @returns {number}
 */
function writeU32Le(output, offset, value) {
    output[offset] = value & 0xff;
    output[offset + 1] = (value >>> 8) & 0xff;
    output[offset + 2] = (value >>> 16) & 0xff;
    output[offset + 3] = (value >>> 24) & 0xff;
    return offset + 4;
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 * @throws {RangeError} If value is outside the non-negative safe integer range.
 */
function writeSafeU64Le(view, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Invalid unsigned 64-bit safe integer: ${value}`);
    }
    const high = Math.floor(value / U32_RANGE);
    const low = value - (high * U32_RANGE);
    view.setUint32(offset, low, true);
    view.setUint32(offset + 4, high, true);
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 * @throws {RangeError} If the decoded value is outside the safe integer range.
 */
function readSafeU64Le(view, offset) {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = low + (high * U32_RANGE);
    if (!Number.isSafeInteger(value)) {
        throw new RangeError('Term content offset base exceeds the JavaScript safe integer range');
    }
    return value;
}

/**
 * @param {number} value
 * @throws {RangeError} If value is not a supported content offset.
 */
function validateContentOffset(value) {
    if (value !== -1 && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`Invalid term content offset: ${value}`);
    }
}

/**
 * @param {number} value
 * @throws {RangeError} If value is not a supported content length.
 */
function validateContentLength(value) {
    if (value !== -1 && (!Number.isSafeInteger(value) || value < 0 || value >= U32_NULL)) {
        throw new RangeError(`Invalid term content length: ${value}`);
    }
}

/**
 * @param {number[]} offsets
 * @returns {number}
 * @throws {RangeError} If an offset is invalid.
 */
function getContentOffsetBase(offsets) {
    let base = Number.POSITIVE_INFINITY;
    for (const offset of offsets) {
        validateContentOffset(offset);
        if (offset >= 0 && offset < base) { base = offset; }
    }
    return base === Number.POSITIVE_INFINITY ? 0 : base;
}

/**
 * @param {number} offset
 * @param {number} base
 * @returns {number}
 * @throws {RangeError} If the offset is outside the encodable chunk range.
 */
function getContentOffsetDelta(offset, base) {
    if (offset < 0) { return U32_NULL; }
    const delta = offset - base;
    if (!Number.isSafeInteger(delta) || delta < 0 || delta > MAX_CONTENT_OFFSET_DELTA) {
        throw new RangeError(`Term content offset ${offset} is outside the encodable chunk range for base ${base}`);
    }
    return delta;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function hashLookupIndexBytes(bytes) {
    return hashTermLookupKeyBytes(bytes);
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function bytesEqual(a, b) {
    if (a.byteLength !== b.byteLength) { return false; }
    for (let i = 0; i < a.byteLength; ++i) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
}

/**
 * @param {Array<{expressionBytes: Uint8Array, readingBytes: Uint8Array|null, sequence: number|null}>} rows
 * @returns {Uint8Array}
 * @throws {RangeError} If an indexed string is too large for the sidecar format.
 */
const ENTRY_CONTENT_DICT_NAME_CODE_RAW = 0;
const ENTRY_CONTENT_DICT_NAME_CODE_RAW_V2 = 1;
const ENTRY_CONTENT_DICT_NAME_CODE_RAW_V3 = 2;
const ENTRY_CONTENT_DICT_NAME_CODE_RAW_V4 = 3;
const ENTRY_CONTENT_DICT_NAME_CODE_JMDICT = 4;
const ENTRY_CONTENT_DICT_NAME_CODE_RAW_V6 = 5;
const ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM = 0xff;
const ENTRY_CONTENT_DICT_NAME_VALUE_MASK = 0x7fff;

/** Error raised when a persisted record no longer matches its lookup sidecar. */
class TermRecordIntegrityError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'TermRecordIntegrityError';
    }
}

/** Error raised when a persisted lookup index cannot be trusted. */
class PersistentLookupIndexError extends Error {
    /**
     * @param {'missing'|'invalid'|'transient'} kind
     * @param {string} message
     * @param {unknown} [cause]
     */
    constructor(kind, message, cause) {
        super(message, typeof cause === 'undefined' ? void 0 : {cause});
        /** @type {string} */
        this.name = 'PersistentLookupIndexError';
        /** @type {'missing'|'invalid'|'transient'} */
        this.kind = kind;
    }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isStorageEntryNotFoundError(error) {
    return error instanceof Error && (
        error.name === 'NotFoundError' ||
        /\b(?:file|entry) not found\b/i.test(error.message)
    );
}

class DenseIdRecordStore {
    /** */
    constructor() {
        /** @type {(TermRecord|undefined)[]} */
        this._records = [];
        /** @type {number} */
        this.size = 0;
    }

    /** */
    clear() {
        this._records = [];
        this.size = 0;
    }

    /**
     * @param {number} maxId
     * @returns {void}
     */
    ensureCapacity(maxId) {
        if (maxId < 0) { return; }
        const requiredLength = maxId + 1;
        if (this._records.length >= requiredLength) { return; }
        this._records.length = requiredLength;
    }

    /**
     * @param {number} id
     * @param {TermRecord} record
     * @returns {DenseIdRecordStore}
     */
    set(id, record) {
        if (typeof this._records[id] === 'undefined') {
            ++this.size;
        }
        this._records[id] = record;
        return this;
    }

    /**
     * @param {number} id
     * @returns {TermRecord|undefined}
     */
    get(id) {
        return this._records[id];
    }

    /**
     * @param {number} id
     * @returns {boolean}
     */
    delete(id) {
        if (typeof this._records[id] === 'undefined') {
            return false;
        }
        this._records[id] = void 0;
        --this.size;
        return true;
    }

    /**
     * @returns {Generator<number, void, void>}
     * @yields {number}
     */
    *keys() {
        for (let i = 1, ii = this._records.length; i < ii; ++i) {
            if (typeof this._records[i] !== 'undefined') {
                yield i;
            }
        }
    }

    /**
     * @returns {Generator<TermRecord, void, void>}
     * @yields {TermRecord}
     */
    *values() {
        for (let i = 1, ii = this._records.length; i < ii; ++i) {
            const record = this._records[i];
            if (typeof record !== 'undefined') {
                yield record;
            }
        }
    }

    /**
     * @returns {(TermRecord|undefined)[]}
     */
    getRawRecords() {
        return this._records;
    }
}

/**
 * @typedef {object} TermRecord
 * @property {number} id
 * @property {string} dictionary
 * @property {string} [expression]
 * @property {string} [reading]
 * @property {boolean} [readingEqualsExpression]
 * @property {Uint8Array} [expressionBytes]
 * @property {Uint8Array} [readingBytes]
 * @property {string|null} [expressionReverse]
 * @property {string|null} [readingReverse]
 * @property {number} entryContentOffset
 * @property {number} entryContentLength
 * @property {string} entryContentDictName
 * @property {number} score
 * @property {number|null} sequence
 */

/**
 * @typedef {object} TermRecordShardState
 * @property {string} fileName
 * @property {FileSystemFileHandle} fileHandle
 * @property {FileSystemWritableFileStream|null} writable
 * @property {number} fileLength
 * @property {number} pendingWriteBytes
 * @property {Uint8Array[]} pendingWriteChunks
 * @property {number} queuedWriteBytes
 * @property {Promise<void>|null} queuedWritePromise
 * @property {Error|null} queuedWriteError
 * @property {Uint8Array[]} queuedWriteChunks
 * @property {boolean} importWriteStarted
 * @property {string|null} sharedContentDictName
 * @property {number} segmentIndex
 * @property {string} logicalKey
 * @property {number} initialFileLength
 * @property {Uint8Array[]} pendingLookupIndexChunks
 * @property {number} pendingLookupIndexBytes
 * @property {number} pendingLookupIndexRecordCount
 * @property {FileSystemFileHandle|null} lookupIndexFileHandle
 * @property {FileSystemWritableFileStream|null} lookupIndexWritable
 * @property {number} lookupIndexChunkCount
 * @property {number} lookupIndexRecordCount
 * @property {number} lookupIndexQueuedBytes
 * @property {number} lookupIndexMaxQueuedBytes
 * @property {Promise<void>|null} lookupIndexWritePromise
 * @property {Error|null} lookupIndexWriteError
 * @property {boolean} appendFormatValidated
 * @property {Uint8Array} generationId
 */

/**
 * @typedef {object} TermRecordEndImportSessionMetrics
 * @property {number} flushPendingWritesMs
 * @property {number} awaitQueuedWritesMs
 * @property {number} closeWritableMs
 * @property {number} totalMs
 * @property {number} drainCycleCount
 * @property {number} writeCallCount
 * @property {number} singleChunkWriteCount
 * @property {number} mergedWriteCount
 * @property {number} totalWriteBytes
 * @property {number} mergedWriteBytes
 * @property {number} maxWriteBytes
 * @property {number} minWriteBytes
 * @property {number} mergedGroupChunkCount
 * @property {number} maxMergedGroupChunkCount
 * @property {number} minMergedGroupChunkCount
 * @property {number} writeCoalesceTargetBytes
 * @property {number} lookupIndexWriteCallCount
 * @property {number} lookupIndexWriteBytes
 * @property {number} lookupIndexAwaitMs
 * @property {number} lookupIndexMaxQueuedBytes
 */

/**
 * @typedef {object} PersistentRecordChunk
 * @property {number} firstId
 * @property {number} count
 * @property {string} fileName
 * @property {FileSystemFileHandle} fileHandle
 * @property {number} chunkOffset
 * @property {string} dictionaryName
 * @property {string} contentDictName
 * @property {number} contentOffsetBase
 * @property {number} chunkHeaderHash
 * @property {Uint8Array} recordFields
 * @property {import('./term-lookup-index.js').PersistedTermLookupIndex} lookupIndex
 */

/**
 * @typedef {object} TermRecordRenamePlan
 * @property {TermRecordShardState} state
 * @property {{dictionaryName: string, contentDictName: string, segmentIndex: number}} shardInfo
 * @property {string} nextFileName
 * @property {FileSystemFileHandle} nextFileHandle
 * @property {File} file
 * @property {number} fileSize
 * @property {File|null} indexFile
 */

export class TermRecordOpfsStore {
    constructor() {
        /** @type {FileSystemDirectoryHandle|null} */
        this._rootDirectoryHandle = null;
        /** @type {FileSystemDirectoryHandle|null} */
        this._recordsDirectoryHandle = null;
        /** @type {Map<string, TermRecordShardState>} */
        this._shardStateByFileName = new Map();
        /** @type {Map<string, TermRecordShardState>} */
        this._activeAppendShardStateByKey = new Map();
        /** @type {Map<string, PersistentRecordChunk[]>} */
        this._persistentRecordChunksByDictionary = new Map();
        /** @type {Set<string>} */
        this._persistentIndexLoadedDictionaryNames = new Set();
        /** @type {Map<string, Promise<boolean>>} */
        this._persistentIndexLoadPromiseByDictionary = new Map();
        /** @type {Map<string, Promise<boolean>>} */
        this._persistentIndexRepairPromiseByDictionary = new Map();
        /** @type {Promise<void>} */
        this._storageMutationTail = Promise.resolve();
        /** @type {boolean} */
        this._storageMutationActive = false;
        /** @type {Map<string, {kind: 'missing'|'invalid'|'transient', message: string}>} */
        this._persistentIndexFailureByDictionary = new Map();
        /** @type {Map<string, {status: 'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired', reason: string|null}>} */
        this._dictionaryHealthByName = new Map();
        /** @type {((dictionaryName: string, status: 'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired', reason: string|null) => void)|null} */
        this._dictionaryHealthChangeHandler = null;
        /** @type {number} */
        this._persistentLookupGeneration = 0;
        /** @type {Map<string, number>} */
        this._persistentLookupGenerationByDictionary = new Map();
        /** @type {Map<string, Promise<{file: File, strings: string[], recordsStart: number, contentOffsetBase: number, firstId: number, count: number}|null>>} */
        this._randomReadChunkMetadataCache = new Map();
        /** @type {number} */
        this._flushThresholdBytes = this._computeFlushThresholdBytes();
        /** @type {number} */
        this._queuedWriteBudgetBytes = this._computeQueuedWriteBudgetBytes();
        /** @type {boolean} */
        this._importSessionActive = false;
        /** @type {DenseIdRecordStore} */
        this._recordsById = new DenseIdRecordStore();
        /** @type {Map<string, number[]>} */
        this._recordIdsByDictionary = new Map();
        /** @type {Set<string>} */
        this._recordIdStaleDictionaryNames = new Set();
        /** @type {number} */
        this._nextId = 1;
        /** @type {boolean} */
        this._nextIdMayNeedShardScan = false;
        /** @type {Map<string, {expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}>} */
        this._indexByDictionary = new Map();
        /** @type {WeakSet<{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}>} */
        this._reverseIndexReady = new WeakSet();
        /** @type {boolean} */
        this._deferIndexBuild = false;
        /** @type {boolean} */
        this._indexDirty = false;
        /** @type {boolean} */
        this._reloadFromShardsAfterImport = false;
        /** @type {Set<string>} */
        this._importSessionDictionaryNames = new Set();
        /** @type {Set<string>} */
        this._loadedDictionaryNames = new Set();
        /** @type {boolean} */
        this._allShardContentsLoaded = false;
        /** @type {TextEncoder} */
        this._textEncoder = new TextEncoder();
        /** @type {TextDecoder} */
        this._textDecoder = new TextDecoder();
        /** @type {boolean} */
        this._wasmEncoderUnavailable = false;
        /** @type {Uint32Array} */
        this._preinternedCompactionRemap = new Uint32Array(0);
        /** @type {string[]} */
        this._invalidShardFileNames = [];
        /** @type {number} */
        this._writeCoalesceTargetBytes = this._computeWriteCoalesceTargetBytes();
        /** @type {number|null} */
        this._expectedImportBytes = null;
        /** @type {TermRecordEndImportSessionMetrics|null} */
        this._lastEndImportSessionMetrics = null;
        /** @type {{drainCycleCount: number, writeCallCount: number, singleChunkWriteCount: number, mergedWriteCount: number, totalWriteBytes: number, mergedWriteBytes: number, maxWriteBytes: number, minWriteBytes: number, mergedGroupChunkCount: number, maxMergedGroupChunkCount: number, minMergedGroupChunkCount: number, writeCoalesceTargetBytes: number}} */
        this._writeDrainMetrics = this._createEmptyWriteDrainMetrics();
        /** @type {{writeCallCount: number, writeBytes: number, awaitMs: number, maxQueuedBytes: number}} */
        this._lookupIndexWriteMetrics = this._createEmptyLookupIndexWriteMetrics();
    }

    /** */
    _invalidateAllPersistentLookupState() {
        ++this._persistentLookupGeneration;
        this._persistentRecordChunksByDictionary.clear();
        this._persistentIndexLoadedDictionaryNames.clear();
        this._persistentIndexLoadPromiseByDictionary.clear();
        this._persistentIndexFailureByDictionary.clear();
        this._randomReadChunkMetadataCache.clear();
        this._persistentLookupGenerationByDictionary.clear();
    }

    /**
     * @param {string} dictionaryName
     */
    _invalidatePersistentLookupState(dictionaryName) {
        const recordChunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (typeof recordChunks !== 'undefined') {
            for (const {fileName, chunkOffset} of recordChunks) {
                this._randomReadChunkMetadataCache.delete(`${fileName}:${chunkOffset}`);
            }
        }
        this._persistentLookupGenerationByDictionary.set(
            dictionaryName,
            (this._persistentLookupGenerationByDictionary.get(dictionaryName) ?? 0) + 1,
        );
        this._persistentRecordChunksByDictionary.delete(dictionaryName);
        this._persistentIndexLoadedDictionaryNames.delete(dictionaryName);
        this._persistentIndexLoadPromiseByDictionary.delete(dictionaryName);
        this._persistentIndexFailureByDictionary.delete(dictionaryName);
    }

    /**
     * Invalidates only the dictionary whose shard bytes are about to change.
     * Unrelated dictionaries remain lookup-ready throughout an import.
     * @param {string} dictionaryName
     */
    _registerDictionaryMutation(dictionaryName) {
        let firstMutation = true;
        if (this._importSessionActive) {
            firstMutation = !this._importSessionDictionaryNames.has(dictionaryName);
            this._importSessionDictionaryNames.add(dictionaryName);
        }
        this._indexByDictionary.delete(dictionaryName);
        if (firstMutation) {
            this._invalidatePersistentLookupState(dictionaryName);
        }
    }

    /**
     * Keeps destructive shard mutations serialized and waits for every repair
     * which was already allowed to publish derived sidecars.
     * @template T
     * @param {() => Promise<T>} callback
     * @param {boolean} [allowActiveImport=false]
     * @returns {Promise<T>}
     */
    async _runExclusiveStorageMutation(callback, allowActiveImport = false) {
        const previous = this._storageMutationTail;
        /** @type {() => void} */
        let release = () => {};
        this._storageMutationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        this._storageMutationActive = true;
        try {
            await this._awaitPersistentIndexRepairs();
            if (this._importSessionActive && !allowActiveImport) {
                throw new Error('Cannot mutate term-record storage during an active import session');
            }
            return await callback();
        } finally {
            this._storageMutationActive = false;
            release();
        }
    }

    /** @returns {Promise<void>} */
    async _awaitPersistentIndexRepairs() {
        while (this._persistentIndexRepairPromiseByDictionary.size > 0) {
            await Promise.allSettled(this._persistentIndexRepairPromiseByDictionary.values());
        }
    }

    /**
     * @param {string} dictionaryName
     * @returns {number}
     */
    _getPersistentLookupGeneration(dictionaryName) {
        return this._persistentLookupGenerationByDictionary.get(dictionaryName) ?? 0;
    }

    /**
     * @param {string} dictionaryName
     * @returns {{status: 'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired', reason: string|null}}
     */
    getDictionaryHealth(dictionaryName) {
        return this._dictionaryHealthByName.get(dictionaryName) ?? {status: 'available', reason: null};
    }

    /**
     * Returns bounded runtime state for diagnosing lookup availability without
     * reading record or sidecar payloads.
     * @param {Iterable<string>} [dictionaryNames=[]]
     * @returns {{importSessionActive: boolean, reloadFromShardsAfterImport: boolean, persistentLookupGeneration: number, dictionaries: Array<Record<string, unknown>>}}
     */
    getDiagnostics(dictionaryNames = []) {
        const names = [...new Set([...dictionaryNames].map((value) => `${value}`.trim()).filter((value) => value.length > 0))];
        const dictionaries = names.map((dictionaryName) => {
            const states = this._getDictionaryShardStates(dictionaryName);
            return {
                dictionaryName,
                health: this.getDictionaryHealth(dictionaryName),
                loaded: this._loadedDictionaryNames.has(dictionaryName),
                persistentIndexLoaded: this._persistentIndexLoadedDictionaryNames.has(dictionaryName),
                persistentIndexLoading: this._persistentIndexLoadPromiseByDictionary.has(dictionaryName),
                persistentIndexRepairing: this._persistentIndexRepairPromiseByDictionary.has(dictionaryName),
                persistentIndexFailure: this._persistentIndexFailureByDictionary.get(dictionaryName) ?? null,
                persistentChunkCount: this._persistentRecordChunksByDictionary.get(dictionaryName)?.length ?? 0,
                materializedRecordCount: this._getLiveRecordIdsForDictionary(dictionaryName)?.length ?? 0,
                shardCount: states.length,
                shardBytes: states.reduce((sum, state) => sum + state.fileLength, 0),
                shardFiles: states.slice(0, 8).map((state) => state.fileName),
            };
        });
        return {
            importSessionActive: this._importSessionActive,
            reloadFromShardsAfterImport: this._reloadFromShardsAfterImport,
            persistentLookupGeneration: this._persistentLookupGeneration,
            dictionaries,
        };
    }

    /**
     * @param {((dictionaryName: string, status: 'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired', reason: string|null) => void)|null} handler
     */
    setDictionaryHealthChangeHandler(handler) {
        this._dictionaryHealthChangeHandler = handler;
    }

    /**
     * @param {string} dictionaryName
     * @returns {boolean}
     */
    isDictionaryAvailable(dictionaryName) {
        const {status} = this.getDictionaryHealth(dictionaryName);
        return status === 'available' || status === 'repairPending';
    }

    /**
     * @param {string} dictionaryName
     * @param {string} reason
     */
    markDictionaryReimportRequired(dictionaryName, reason) {
        this._setDictionaryHealth(dictionaryName, 'reimportRequired', reason);
        this._discardMaterializedDictionary(dictionaryName);
        this._invalidatePersistentLookupState(dictionaryName);
    }

    /**
     * @param {string} dictionaryName
     * @param {'available'|'repairPending'|'repairing'|'temporarilyUnavailable'|'reimportRequired'} status
     * @param {string|null} reason
     */
    _setDictionaryHealth(dictionaryName, status, reason = null) {
        const previous = this._dictionaryHealthByName.get(dictionaryName);
        if (status === 'available') {
            this._dictionaryHealthByName.delete(dictionaryName);
        } else {
            this._dictionaryHealthByName.set(dictionaryName, {status, reason});
        }
        if (previous?.status === status && previous.reason === reason) { return; }
        reportDiagnostics('term-record-dictionary-health-changed', {
            dictionaryName,
            previousStatus: previous?.status ?? 'available',
            status,
            reason,
        });
        try {
            this._dictionaryHealthChangeHandler?.(dictionaryName, status, reason);
        } catch (error) {
            reportDiagnostics('term-record-dictionary-health-persist-failed', {
                dictionaryName,
                status,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async prepare() {
        await this._runExclusiveStorageMutation(async () => await this._prepare());
    }

    /** @returns {Promise<void>} */
    async _prepare() {
        await this._closeAllWritables();
        this._recordsById.clear();
        this._recordIdsByDictionary.clear();
        this._recordIdStaleDictionaryNames.clear();
        this._indexByDictionary.clear();
        this._nextId = 1;
        this._nextIdMayNeedShardScan = false;
        this._deferIndexBuild = false;
        this._indexDirty = false;
        this._reloadFromShardsAfterImport = false;
        this._importSessionDictionaryNames.clear();
        this._loadedDictionaryNames.clear();
        this._allShardContentsLoaded = false;
        this._rootDirectoryHandle = null;
        this._recordsDirectoryHandle = null;
        this._shardStateByFileName.clear();
        this._activeAppendShardStateByKey.clear();
        this._invalidateAllPersistentLookupState();
        this._dictionaryHealthByName.clear();
        this._preinternedCompactionRemap = new Uint32Array(0);
        this._invalidShardFileNames = [];
        if (typeof navigator === 'undefined' || !('storage' in navigator) || !('getDirectory' in navigator.storage)) {
            return;
        }
        const rootDirectoryHandle = await navigator.storage.getDirectory();
        this._rootDirectoryHandle = rootDirectoryHandle;
        this._recordsDirectoryHandle = await rootDirectoryHandle.getDirectoryHandle(SHARD_DIRECTORY_NAME, {create: true});

        const shardFileCount = await this._loadShardFiles(false);
        this._nextIdMayNeedShardScan = shardFileCount > 0;
        if (shardFileCount === 0) {
            this._nextIdMayNeedShardScan = false;
            await this.verifyIntegrity();
            this._allShardContentsLoaded = true;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async beginImportSession() {
        await this._runExclusiveStorageMutation(async () => {
            if (this._importSessionActive) {
                return;
            }
            this._importSessionActive = true;
            this._deferIndexBuild = true;
            this._indexDirty = true;
            this._reloadFromShardsAfterImport = false;
            this._importSessionDictionaryNames.clear();
            this._indexByDictionary.clear();
            this._queuedWriteBudgetBytes = this._computeQueuedWriteBudgetBytes();
            this._writeCoalesceTargetBytes = this._computeWriteCoalesceTargetBytes();
            this._writeDrainMetrics = this._createEmptyWriteDrainMetrics();
            this._lookupIndexWriteMetrics = this._createEmptyLookupIndexWriteMetrics();
            for (const state of this._shardStateByFileName.values()) {
                state.pendingWriteBytes = 0;
                state.pendingWriteChunks = [];
                state.queuedWriteBytes = 0;
                state.queuedWritePromise = null;
                state.queuedWriteError = null;
                state.queuedWriteChunks = [];
                state.importWriteStarted = false;
                state.initialFileLength = state.fileLength;
                state.pendingLookupIndexChunks = [];
                state.pendingLookupIndexBytes = 0;
                state.pendingLookupIndexRecordCount = 0;
                state.lookupIndexFileHandle = null;
                state.lookupIndexWritable = null;
                state.lookupIndexChunkCount = 0;
                state.lookupIndexRecordCount = 0;
                state.lookupIndexQueuedBytes = 0;
                state.lookupIndexMaxQueuedBytes = 0;
                state.lookupIndexWritePromise = null;
                state.lookupIndexWriteError = null;
            }
        }, true);
    }

    /**
     * @returns {Promise<import('dictionary-import-journal').TermRecordCheckpoint>}
     */
    async createImportCheckpoint() {
        await this._closeAllWritables();
        if (this._recordsDirectoryHandle === null) { return {shards: []}; }
        const shards = [];
        for (const fileName of await this._listTermRecordStorageFileNames()) {
            if (fileName.endsWith(LOOKUP_INDEX_FILE_SUFFIX)) { continue; }
            const fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName);
            shards.push({fileName, fileLength: (await fileHandle.getFile()).size});
        }
        return {shards};
    }

    /**
     * @param {import('dictionary-import-journal').TermRecordCheckpoint} checkpoint
     * @returns {Promise<void>}
     */
    async rollbackImportSession(checkpoint) {
        await this._runExclusiveStorageMutation(
            async () => await this._rollbackImportSession(checkpoint),
            true,
        );
    }

    /**
     * @param {import('dictionary-import-journal').TermRecordCheckpoint} checkpoint
     * @returns {Promise<void>}
     */
    async _rollbackImportSession(checkpoint) {
        if (
            typeof checkpoint !== 'object' ||
            checkpoint === null ||
            !Array.isArray(checkpoint.shards)
        ) {
            throw new TypeError('Invalid term-record import checkpoint');
        }
        await this._abandonImportWritesForRollback();
        if (this._recordsDirectoryHandle === null) { return; }
        /** @type {Map<string, number>} */
        const checkpointByName = new Map();
        for (const shard of checkpoint.shards) {
            if (
                typeof shard !== 'object' ||
                shard === null ||
                typeof shard.fileName !== 'string' ||
                shard.fileName.length === 0 ||
                !Number.isSafeInteger(shard.fileLength) ||
                shard.fileLength < 0 ||
                checkpointByName.has(shard.fileName)
            ) {
                throw new TypeError('Invalid term-record import checkpoint shard');
            }
            if (!shard.fileName.endsWith(LOOKUP_INDEX_FILE_SUFFIX)) {
                checkpointByName.set(shard.fileName, shard.fileLength);
            }
        }
        /** @type {Error[]} */
        const errors = [];
        /** @type {string[]} */
        let currentFileNames = [];
        try {
            currentFileNames = await this._listTermRecordStorageFileNames();
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
        for (const fileName of currentFileNames) {
            try {
                const fileLength = checkpointByName.get(fileName);
                if (typeof fileLength === 'undefined') {
                    await this._recordsDirectoryHandle.removeEntry(fileName);
                    continue;
                }
                const fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName);
                const writable = await fileHandle.createWritable({keepExistingData: true});
                try {
                    await writable.truncate(fileLength);
                } finally {
                    await writable.close();
                }
            } catch (error) {
                errors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        for (const {fileName, fileLength} of checkpoint.shards) {
            if (fileName.endsWith(LOOKUP_INDEX_FILE_SUFFIX)) { continue; }
            try {
                const fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName);
                if ((await fileHandle.getFile()).size !== fileLength) {
                    throw new Error(`Cannot restore missing term-record bytes for ${fileName}`);
                }
            } catch (error) {
                errors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        try {
            await this._prepare();
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, 'Failed to roll back term-record import storage');
        }
    }

    /**
     * Stops import writes without flushing data which is about to be rolled back.
     * @returns {Promise<void>}
     */
    async _abandonImportWritesForRollback() {
        this._importSessionActive = false;
        this._deferIndexBuild = false;
        this._indexDirty = false;
        this._preinternedCompactionRemap = new Uint32Array(0);
        this._importSessionDictionaryNames.clear();
        const states = [...this._shardStateByFileName.values()];
        const queuedWrites = [];
        for (const state of states) {
            state.pendingWriteBytes = 0;
            state.pendingWriteChunks = [];
            state.queuedWriteBytes = 0;
            state.queuedWriteChunks = [];
            state.pendingLookupIndexChunks = [];
            state.pendingLookupIndexBytes = 0;
            state.pendingLookupIndexRecordCount = 0;
            if (state.queuedWritePromise !== null) {
                queuedWrites.push(state.queuedWritePromise);
            }
            if (state.lookupIndexWritePromise !== null) {
                queuedWrites.push(state.lookupIndexWritePromise);
            }
        }
        const settledWrites = await Promise.allSettled(queuedWrites);
        const abandonedWriteErrors = settledWrites
            .filter((result) => result.status === 'rejected')
            .map((result) => (
                result.reason instanceof Error ?
                    result.reason.message :
                    String(result.reason)
            ));
        if (abandonedWriteErrors.length > 0) {
            reportDiagnostics('term-record-store-rollback-abandoned-write-errors', {
                errors: abandonedWriteErrors,
            });
        }
        for (const state of states) {
            state.queuedWritePromise = null;
            state.queuedWriteError = null;
            state.lookupIndexWritePromise = null;
            state.lookupIndexWriteError = null;
            state.lookupIndexQueuedBytes = 0;
            const writable = state.writable;
            state.writable = null;
            if (writable !== null) {
                try {
                    const abort = /** @type {unknown} */ (Reflect.get(writable, 'abort'));
                    const closePromise = typeof abort === 'function' ?
                        /** @type {() => Promise<void>} */ (abort).call(writable) :
                        writable.close();
                    await closePromise;
                } catch (_) {
                    // Restoration below uses fresh handles and verifies every checkpoint file.
                }
            }
            const lookupIndexWritable = state.lookupIndexWritable;
            state.lookupIndexWritable = null;
            state.lookupIndexFileHandle = null;
            state.lookupIndexChunkCount = 0;
            state.lookupIndexRecordCount = 0;
            if (lookupIndexWritable === null) { continue; }
            try {
                const abort = /** @type {unknown} */ (Reflect.get(lookupIndexWritable, 'abort'));
                const closePromise = typeof abort === 'function' ?
                    /** @type {() => Promise<void>} */ (abort).call(lookupIndexWritable) :
                    lookupIndexWritable.close();
                await closePromise;
            } catch (_) {
                // Checkpoint restoration validates the committed sidecar bytes below.
            }
        }
        this._invalidateAllPersistentLookupState();
    }

    /**
     * @returns {Promise<void>}
     */
    async endImportSession() {
        try {
            await this._endImportSession();
        } finally {
            this._preinternedCompactionRemap = new Uint32Array(0);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _endImportSession() {
        if (!this._importSessionActive && !this._hasPendingShardWrites()) {
            return;
        }
        const tStart = safePerformance.now();
        let flushPendingWritesMs = 0;
        let awaitQueuedWritesMs = 0;
        let closeWritableMs = 0;
        const tFlushPendingWritesStart = safePerformance.now();
        await this._flushPendingWrites();
        flushPendingWritesMs = safePerformance.now() - tFlushPendingWritesStart;
        const tAwaitQueuedWritesStart = safePerformance.now();
        await this._awaitQueuedWrites();
        awaitQueuedWritesMs = safePerformance.now() - tAwaitQueuedWritesStart;
        const tCloseWritableStart = safePerformance.now();
        await this._closeAllWritables();
        for (const dictionaryName of this._importSessionDictionaryNames) {
            this._setDictionaryHealth(dictionaryName, 'available');
        }
        this._importSessionDictionaryNames.clear();
        this._importSessionActive = false;
        closeWritableMs = safePerformance.now() - tCloseWritableStart;
        this._deferIndexBuild = false;
        this._lastEndImportSessionMetrics = {
            flushPendingWritesMs,
            awaitQueuedWritesMs,
            closeWritableMs,
            totalMs: safePerformance.now() - tStart,
            ...this._writeDrainMetrics,
            lookupIndexWriteCallCount: this._lookupIndexWriteMetrics.writeCallCount,
            lookupIndexWriteBytes: this._lookupIndexWriteMetrics.writeBytes,
            lookupIndexAwaitMs: this._lookupIndexWriteMetrics.awaitMs,
            lookupIndexMaxQueuedBytes: this._lookupIndexWriteMetrics.maxQueuedBytes,
        };
        if (this._reloadFromShardsAfterImport) {
            this._indexByDictionary.clear();
            this._indexDirty = false;
            return;
        }
        if (this._indexDirty) {
            this._indexByDictionary.clear();
            this._indexDirty = false;
        }
    }

    /**
     * @returns {TermRecordEndImportSessionMetrics|null}
     */
    getLastEndImportSessionMetrics() {
        return this._lastEndImportSessionMetrics;
    }

    /**
     * @param {number|null} value
     */
    setExpectedImportBytes(value) {
        this._expectedImportBytes = (typeof value === 'number' && Number.isFinite(value) && value > 0) ?
            Math.max(1, Math.trunc(value)) :
            null;
        this._writeCoalesceTargetBytes = this._computeWriteCoalesceTargetBytes();
        this._writeDrainMetrics = this._createEmptyWriteDrainMetrics();
    }

    /**
     * @returns {Promise<void>}
     */
    async reset() {
        await this._closeAllWritables();
        this._recordsById.clear();
        this._recordIdsByDictionary.clear();
        this._recordIdStaleDictionaryNames.clear();
        this._indexByDictionary.clear();
        this._nextId = 1;
        this._nextIdMayNeedShardScan = false;
        this._deferIndexBuild = false;
        this._indexDirty = false;
        this._shardStateByFileName.clear();
        this._invalidShardFileNames = [];
        this._activeAppendShardStateByKey.clear();
        this._invalidateAllPersistentLookupState();
        this._dictionaryHealthByName.clear();
        this._importSessionDictionaryNames.clear();
        this._preinternedCompactionRemap = new Uint32Array(0);
        this._loadedDictionaryNames.clear();
        this._allShardContentsLoaded = false;
        if (this._recordsDirectoryHandle === null) {
            return;
        }
        const shardFileNames = await this._listTermRecordStorageFileNames();
        for (const fileName of shardFileNames) {
            try {
                await this._recordsDirectoryHandle.removeEntry(fileName);
            } catch (_) {
                // NOP
            }
        }
    }

    /**
     * @returns {number}
     */
    get size() {
        let count = this._recordsById.size;
        for (const dictionaryName of this._persistentIndexLoadedDictionaryNames) {
            const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
            if (typeof chunks === 'undefined') { continue; }
            let persistentCount = 0;
            for (const chunk of chunks) { persistentCount += chunk.count; }
            const materializedCount = this._getLiveRecordIdsForDictionary(dictionaryName)?.length ?? 0;
            count += Math.max(0, persistentCount - materializedCount);
        }
        return count;
    }

    /**
     * @returns {boolean}
     */
    isEmpty() {
        return this.size === 0;
    }

    /**
     * @param {{dictionary: string, expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, expressionReverse: string|null, readingReverse: string|null, entryContentOffset: number, entryContentLength: number, entryContentDictName: string|null, score: number, sequence: number|null}[]} records
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @returns {Promise<void>}
     */
    async appendBatch(records, preinternedPlan = null) {
        if (records.length === 0) { return; }
        await this._ensureNextIdReadyForAppend();
        /** @type {Map<string, TermRecord[]>} */
        const recordsByShard = new Map();
        for (const row of records) {
            const id = this._nextId++;
            const record = {
                id,
                dictionary: row.dictionary,
                expression: row.expression,
                reading: row.reading,
                expressionBytes: row.expressionBytes instanceof Uint8Array ? row.expressionBytes : void 0,
                readingBytes: row.readingBytes instanceof Uint8Array ? row.readingBytes : void 0,
                expressionReverse: row.expressionReverse,
                readingReverse: row.readingReverse,
                entryContentOffset: row.entryContentOffset,
                entryContentLength: row.entryContentLength,
                entryContentDictName: row.entryContentDictName ?? 'raw',
                score: row.score,
                sequence: row.sequence,
            };
            this._storeRecord(record);
            this._loadedDictionaryNames.add(record.dictionary);
            this._setDictionaryHealth(record.dictionary, 'available');
            const shardFileName = this._getShardFileName(record.dictionary, record.entryContentDictName);
            const shardRecords = recordsByShard.get(shardFileName);
            if (typeof shardRecords === 'undefined') {
                recordsByShard.set(shardFileName, [record]);
            } else {
                shardRecords.push(record);
            }
            if (!this._deferIndexBuild) {
                const existingIndex = this._indexByDictionary.get(record.dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
        }
        if (this._deferIndexBuild) {
            this._indexDirty = true;
        }
        for (const dictionaryRecords of recordsByShard.values()) {
            const firstRecord = dictionaryRecords[0];
            const state = await this._getOrCreateShardState(firstRecord.dictionary, firstRecord.entryContentDictName);
            if (state === null) { continue; }
            await this._encodeAndAppendChunkRunsForState(state, dictionaryRecords, preinternedPlan);
        }
    }

    /**
     * Fast-path append for SQL row arrays from dictionary-database bulk term insert.
     * @param {unknown[][]} rows
     * @param {number} start
     * @param {number} count
     * @returns {Promise<void>}
     */
    async appendBatchFromTermRows(rows, start, count) {
        if (count <= 0) { return; }
        await this._ensureNextIdReadyForAppend();
        /** @type {Map<string, TermRecord[]>|null} */
        let recordsByShard = null;
        /** @type {TermRecord[]} */
        const singleDictionaryRecords = [];
        let singleDictionaryName = '';
        let singleContentDictName = 'raw';
        for (let i = start, ii = start + count; i < ii; ++i) {
            const row = /** @type {[string, string, string, (string|null), (string|null), unknown, number, number, (string|null), unknown, unknown, unknown, number, unknown, (number|null)]} */ (rows[i]);
            const id = this._nextId++;
            const dictionary = row[0];
            /** @type {TermRecord} */
            const record = {
                id,
                dictionary,
                expression: row[1],
                reading: row[2],
                expressionReverse: row[3],
                readingReverse: row[4],
                entryContentOffset: row[6],
                entryContentLength: row[7],
                entryContentDictName: row[8] ?? 'raw',
                score: row[12],
                sequence: row[14],
            };
            this._storeRecord(record);
            this._loadedDictionaryNames.add(dictionary);
            if (i === start) {
                singleDictionaryName = dictionary;
                singleContentDictName = record.entryContentDictName;
            }
            if (recordsByShard === null) {
                if (dictionary === singleDictionaryName && record.entryContentDictName === singleContentDictName) {
                    singleDictionaryRecords.push(record);
                } else {
                    recordsByShard = new Map();
                    recordsByShard.set(this._getShardFileName(singleDictionaryName, singleContentDictName), singleDictionaryRecords);
                    recordsByShard.set(this._getShardFileName(dictionary, record.entryContentDictName), [record]);
                }
            } else {
                const shardFileName = this._getShardFileName(dictionary, record.entryContentDictName);
                let dictionaryRecords = recordsByShard.get(shardFileName);
                if (typeof dictionaryRecords === 'undefined') {
                    dictionaryRecords = [];
                    recordsByShard.set(shardFileName, dictionaryRecords);
                }
                dictionaryRecords.push(record);
            }
            if (!this._deferIndexBuild) {
                const existingIndex = this._indexByDictionary.get(dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
        }
        if (this._deferIndexBuild) {
            this._indexDirty = true;
        }
        if (recordsByShard === null) {
            const state = await this._getOrCreateShardState(singleDictionaryName, singleContentDictName);
            if (state !== null) {
                await this._encodeAndAppendChunkRunsForState(state, singleDictionaryRecords);
            }
            return;
        }
        for (const dictionaryRecords of recordsByShard.values()) {
            const firstRecord = dictionaryRecords[0];
            const state = await this._getOrCreateShardState(firstRecord.dictionary, firstRecord.entryContentDictName);
            if (state === null) { continue; }
            await this._encodeAndAppendChunkRunsForState(state, dictionaryRecords);
        }
    }

    /**
     * Fast-path append for importer DatabaseTermEntry arrays paired with resolved content refs.
     * @param {unknown[]} rows
     * @param {number} start
     * @param {number} count
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {(string|null)[]} contentDictNames
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @returns {Promise<{buildRecordsMs: number, encodeMs: number, appendWriteMs: number}>}
     */
    async appendBatchFromResolvedImportTermEntries(rows, start, count, contentOffsets, contentLengths, contentDictNames, preinternedPlan = null) {
        if (count <= 0) { return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0}; }
        if (contentOffsets.length < (start + count) || contentLengths.length < (start + count) || contentDictNames.length < (start + count)) {
            throw new Error('appendBatchFromResolvedImportTermEntries content refs length is smaller than row count');
        }
        await this._ensureNextIdReadyForAppend();
        const tBuildStart = safePerformance.now();
        let buildRecordsMs = 0;
        let encodeMs = 0;
        let appendWriteMs = 0;
        /** @type {Map<string, {records: TermRecord[], indexes: number[]}>|null} */
        let recordsByShard = null;
        /** @type {TermRecord[]} */
        const singleDictionaryRecords = new Array(count);
        let singleDictionaryRecordCount = 0;
        let singleDictionaryName = '';
        let singleContentDictName = 'raw';
        for (let i = start, ii = start + count; i < ii; ++i) {
            const row = /** @type {{dictionary: string, expression: string, reading: string, readingEqualsExpression?: boolean, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, expressionReverse?: string, readingReverse?: string, score: number, sequence?: number}} */ (rows[i]);
            const id = this._nextId++;
            const dictionary = row.dictionary;
            const readingEqualsExpression = row.readingEqualsExpression ?? (row.reading === row.expression);
            const useLazyArtifactStrings = preinternedPlan !== null;
            /** @type {TermRecord} */
            const record = {
                id,
                dictionary,
                expression: useLazyArtifactStrings ? '' : row.expression,
                reading: useLazyArtifactStrings ? '' : row.reading,
                readingEqualsExpression,
                expressionBytes: row.expressionBytes instanceof Uint8Array ? row.expressionBytes : void 0,
                readingBytes: !readingEqualsExpression && row.readingBytes instanceof Uint8Array ? row.readingBytes : void 0,
                expressionReverse: row.expressionReverse ?? null,
                readingReverse: row.readingReverse ?? null,
                entryContentOffset: contentOffsets[i],
                entryContentLength: contentLengths[i],
                entryContentDictName: contentDictNames[i] ?? 'raw',
                score: row.score,
                sequence: typeof row.sequence === 'number' ? row.sequence : null,
            };
            this._storeRecord(record);
            this._loadedDictionaryNames.add(dictionary);
            if (i === start) {
                singleDictionaryName = dictionary;
                singleContentDictName = record.entryContentDictName;
            }
            if (recordsByShard === null) {
                if (dictionary === singleDictionaryName && record.entryContentDictName === singleContentDictName) {
                    singleDictionaryRecords[singleDictionaryRecordCount++] = record;
                } else {
                    recordsByShard = new Map();
                    recordsByShard.set(
                        this._getShardFileName(singleDictionaryName, singleContentDictName),
                        {
                            records: singleDictionaryRecords.slice(0, singleDictionaryRecordCount),
                            indexes: Array.from({length: singleDictionaryRecordCount}, (_, index) => index),
                        },
                    );
                    recordsByShard.set(this._getShardFileName(dictionary, record.entryContentDictName), {records: [record], indexes: [i - start]});
                }
            } else {
                const shardFileName = this._getShardFileName(dictionary, record.entryContentDictName);
                let shardRecords = recordsByShard.get(shardFileName);
                if (typeof shardRecords === 'undefined') {
                    shardRecords = {records: [], indexes: []};
                    recordsByShard.set(shardFileName, shardRecords);
                }
                shardRecords.records.push(record);
                shardRecords.indexes.push(i - start);
            }
            if (!this._deferIndexBuild) {
                const existingIndex = this._indexByDictionary.get(dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
        }
        if (this._deferIndexBuild) {
            this._indexDirty = true;
        }
        buildRecordsMs = safePerformance.now() - tBuildStart;
        if (recordsByShard === null) {
            const state = await this._getOrCreateShardState(singleDictionaryName, singleContentDictName);
            if (state !== null) {
                const metrics = await this._encodeAndAppendChunkRunsForState(state, singleDictionaryRecords, preinternedPlan);
                encodeMs += metrics.encodeMs;
                appendWriteMs += metrics.appendWriteMs;
            }
            return {buildRecordsMs, encodeMs, appendWriteMs};
        }
        for (const {records: dictionaryRecords, indexes} of recordsByShard.values()) {
            const firstRecord = dictionaryRecords[0];
            const state = await this._getOrCreateShardState(firstRecord.dictionary, firstRecord.entryContentDictName);
            if (state === null) { continue; }
            const metrics = await this._encodeAndAppendChunkRunsForState(state, dictionaryRecords, preinternedPlan, indexes);
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
        }
        return {buildRecordsMs, encodeMs, appendWriteMs};
    }

    /**
     * Fast-path append for importer DatabaseTermEntry arrays paired with content spans.
     * @param {unknown[]} rows
     * @param {number} start
     * @param {number} count
     * @param {{offset: number, length: number}[]} spans
     * @returns {Promise<void>}
     */
    async appendBatchFromImportTermEntries(rows, start, count, spans) {
        if (count <= 0) { return; }
        if (spans.length < count) {
            throw new Error('appendBatchFromImportTermEntries spans length is smaller than row count');
        }
        await this._ensureNextIdReadyForAppend();
        /** @type {Map<string, TermRecord[]>|null} */
        let recordsByShard = null;
        /** @type {TermRecord[]} */
        const singleDictionaryRecords = [];
        let singleDictionaryName = '';
        let singleContentDictName = 'raw';
        for (let i = 0; i < count; ++i) {
            const row = /** @type {{dictionary: string, expression: string, reading: string, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, expressionReverse?: string, readingReverse?: string, score: number, sequence?: number}} */ (rows[start + i]);
            const span = spans[i];
            const id = this._nextId++;
            const dictionary = row.dictionary;
            /** @type {TermRecord} */
            const record = {
                id,
                dictionary,
                expression: row.expression,
                reading: row.reading,
                expressionBytes: row.expressionBytes instanceof Uint8Array ? row.expressionBytes : void 0,
                readingBytes: row.readingBytes instanceof Uint8Array ? row.readingBytes : void 0,
                expressionReverse: row.expressionReverse ?? null,
                readingReverse: row.readingReverse ?? null,
                entryContentOffset: span.offset,
                entryContentLength: span.length,
                entryContentDictName: 'raw',
                score: row.score,
                sequence: typeof row.sequence === 'number' ? row.sequence : null,
            };
            this._storeRecord(record);
            this._loadedDictionaryNames.add(dictionary);
            if (i === 0) {
                singleDictionaryName = dictionary;
                singleContentDictName = record.entryContentDictName;
            }
            if (recordsByShard === null) {
                if (dictionary === singleDictionaryName && record.entryContentDictName === singleContentDictName) {
                    singleDictionaryRecords.push(record);
                } else {
                    recordsByShard = new Map();
                    recordsByShard.set(this._getShardFileName(singleDictionaryName, singleContentDictName), singleDictionaryRecords);
                    recordsByShard.set(this._getShardFileName(dictionary, record.entryContentDictName), [record]);
                }
            } else {
                const shardFileName = this._getShardFileName(dictionary, record.entryContentDictName);
                let dictionaryRecords = recordsByShard.get(shardFileName);
                if (typeof dictionaryRecords === 'undefined') {
                    dictionaryRecords = [];
                    recordsByShard.set(shardFileName, dictionaryRecords);
                }
                dictionaryRecords.push(record);
            }
            if (!this._deferIndexBuild) {
                const existingIndex = this._indexByDictionary.get(dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
        }
        if (this._deferIndexBuild) {
            this._indexDirty = true;
        }
        if (recordsByShard === null) {
            const state = await this._getOrCreateShardState(singleDictionaryName, singleContentDictName);
            if (state !== null) {
                await this._encodeAndAppendChunkRunsForState(state, singleDictionaryRecords);
            }
            return;
        }
        for (const dictionaryRecords of recordsByShard.values()) {
            const firstRecord = dictionaryRecords[0];
            const state = await this._getOrCreateShardState(firstRecord.dictionary, firstRecord.entryContentDictName);
            if (state === null) { continue; }
            await this._encodeAndAppendChunkRunsForState(state, dictionaryRecords);
        }
    }

    /**
     * Fast-path append for importer DatabaseTermEntry arrays paired with raw content offset/length arrays.
     * @param {unknown[]} rows
     * @param {number} start
     * @param {number} count
     * @param {number[]} contentOffsets
     * @param {number[]} contentLengths
     * @param {string|null} [contentDictName='raw']
     * @returns {Promise<{buildRecordsMs: number, encodeMs: number, appendWriteMs: number}>}
     */
    async appendBatchFromImportTermEntriesResolvedContent(rows, start, count, contentOffsets, contentLengths, contentDictName = 'raw') {
        if (count <= 0) { return {buildRecordsMs: 0, encodeMs: 0, appendWriteMs: 0}; }
        if (contentOffsets.length < count || contentLengths.length < count) {
            throw new Error('appendBatchFromImportTermEntriesResolvedContent content arrays are smaller than row count');
        }
        await this._ensureNextIdReadyForAppend();
        const tBuildStart = safePerformance.now();
        let buildRecordsMs = 0;
        let encodeMs = 0;
        let appendWriteMs = 0;
        /** @type {Map<string, TermRecord[]>|null} */
        let recordsByShard = null;
        /** @type {TermRecord[]} */
        const singleDictionaryRecords = new Array(count);
        let singleDictionaryRecordCount = 0;
        let firstDictionaryName = '';
        const normalizedContentDictName = contentDictName ?? 'raw';
        for (let i = 0; i < count; ++i) {
            const row = /** @type {{dictionary: string, expression: string, reading: string, readingEqualsExpression?: boolean, expressionBytes?: Uint8Array, readingBytes?: Uint8Array, expressionReverse?: string, readingReverse?: string, score: number, sequence?: number}} */ (rows[start + i]);
            const id = this._nextId++;
            const dictionary = row.dictionary;
            /** @type {TermRecord} */
            const record = {
                id,
                dictionary,
                expression: row.expression,
                reading: row.reading,
                readingEqualsExpression: row.readingEqualsExpression === true,
                expressionBytes: row.expressionBytes instanceof Uint8Array ? row.expressionBytes : void 0,
                readingBytes: row.readingBytes instanceof Uint8Array ? row.readingBytes : void 0,
                expressionReverse: row.expressionReverse ?? null,
                readingReverse: row.readingReverse ?? null,
                entryContentOffset: contentOffsets[i],
                entryContentLength: contentLengths[i],
                entryContentDictName: normalizedContentDictName,
                score: row.score,
                sequence: typeof row.sequence === 'number' ? row.sequence : null,
            };
            this._storeRecord(record);
            if (i === 0) {
                firstDictionaryName = dictionary;
            }
            if (recordsByShard === null) {
                if (dictionary === firstDictionaryName) {
                    singleDictionaryRecords[singleDictionaryRecordCount++] = record;
                } else {
                    recordsByShard = new Map();
                    recordsByShard.set(this._getShardFileName(firstDictionaryName, normalizedContentDictName), singleDictionaryRecords.slice(0, singleDictionaryRecordCount));
                    recordsByShard.set(this._getShardFileName(dictionary, normalizedContentDictName), [record]);
                }
            } else {
                const shardFileName = this._getShardFileName(dictionary, normalizedContentDictName);
                let dictionaryRecords = recordsByShard.get(shardFileName);
                if (typeof dictionaryRecords === 'undefined') {
                    dictionaryRecords = [];
                    recordsByShard.set(shardFileName, dictionaryRecords);
                }
                dictionaryRecords.push(record);
            }
            if (!this._deferIndexBuild) {
                const existingIndex = this._indexByDictionary.get(dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
        }
        if (this._deferIndexBuild) {
            this._indexDirty = true;
        }
        buildRecordsMs = safePerformance.now() - tBuildStart;
        const preinternedPlan = (
            start === 0 &&
            count === rows.length &&
            rows !== null &&
            typeof rows === 'object'
        ) ?
            getTermRecordPreinternedPlan(rows) :
            null;
        if (recordsByShard === null) {
            const state = await this._getOrCreateShardState(firstDictionaryName, normalizedContentDictName);
            if (state !== null) {
                const metrics = await this._encodeAndAppendChunkRunsForState(state, singleDictionaryRecords, preinternedPlan);
                encodeMs += metrics.encodeMs;
                appendWriteMs += metrics.appendWriteMs;
            }
            return {buildRecordsMs, encodeMs, appendWriteMs};
        }
        for (const dictionaryRecords of recordsByShard.values()) {
            const firstRecord = dictionaryRecords[0];
            const state = await this._getOrCreateShardState(firstRecord.dictionary, firstRecord.entryContentDictName);
            if (state === null) { continue; }
            const metrics = await this._encodeAndAppendChunkRunsForState(state, dictionaryRecords, preinternedPlan);
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
        }
        return {buildRecordsMs, encodeMs, appendWriteMs};
    }

    /**
     * @param {{dictionary: string, rowCount: number, dictionaryTotalRows?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number, termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null, preparedLookupIndexes?: Map<string, {bytes: Uint8Array, preinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}>}} chunk
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {string | (string|null)[]} contentDictNames
     * @returns {Promise<{buildRecordsMs: number, encodeMs: number, appendWriteMs: number, validationMs: number, wasmEncodeMs: number, lookupIndexEncodeMs: number}>}
     */
    async appendBatchFromArtifactChunkResolvedContent(chunk, contentOffsets, contentLengths, contentDictNames) {
        const count = chunk.rowCount;
        if (count <= 0) {
            return {
                buildRecordsMs: 0,
                encodeMs: 0,
                appendWriteMs: 0,
                validationMs: 0,
                wasmEncodeMs: 0,
                lookupIndexEncodeMs: 0,
            };
        }
        const fixedContentSpan = hasFixedContentSpan(chunk, count);
        if (
            (!fixedContentSpan && (contentOffsets.length < count || contentLengths.length < count)) ||
            (Array.isArray(contentDictNames) && contentDictNames.length < count)
        ) {
            throw new Error('appendBatchFromArtifactChunkResolvedContent content arrays are smaller than row count');
        }
        await this._ensureNextIdReadyForAppend();
        const uniformContentDictName = Array.isArray(contentDictNames) ? null : (contentDictNames ?? 'raw');
        const tBuildStart = safePerformance.now();
        const firstId = this._nextId;
        const firstContentDictName = uniformContentDictName ?? (contentDictNames[0] ?? 'raw');
        const preinternedPlan = chunk.termRecordPreinternedPlan ?? null;
        const stableStringLengths = preinternedPlan?.stringLengths;
        const stableStringsBuffer = preinternedPlan?.stringsBuffer;
        const stableExpressionIndexes = preinternedPlan?.expressionIndexes;
        const stableReadingIndexes = preinternedPlan?.readingIndexes;
        const skipRecordMaterialization = (
            this._importSessionActive &&
            (chunk.dictionaryTotalRows ?? count) >= PERSISTED_ONLY_IMPORT_ROW_THRESHOLD
        );
        const stableStringOffsets = skipRecordMaterialization ?
            null :
            (
                preinternedPlan?.stringOffsets instanceof Uint32Array ?
                    preinternedPlan.stringOffsets :
                    reconstructTermStringOffsets(stableStringLengths, stableStringsBuffer?.byteLength ?? -1)
            );
        const hasStableStringSlices = (
            stableStringOffsets instanceof Uint32Array &&
            stableStringLengths instanceof Uint16Array &&
            stableStringsBuffer instanceof Uint8Array &&
            stableExpressionIndexes instanceof Uint32Array &&
            stableReadingIndexes instanceof Uint32Array &&
            stableStringOffsets.length === stableStringLengths.length &&
            stableExpressionIndexes.length >= count &&
            stableReadingIndexes.length >= count
        );
        if (skipRecordMaterialization) {
            this._nextId += count;
            this._reloadFromShardsAfterImport = true;
            this._loadedDictionaryNames.delete(chunk.dictionary);
            this._allShardContentsLoaded = false;
        } else {
            this._recordsById.ensureCapacity(firstId + count - 1);
            const existingIndex = this._deferIndexBuild ? void 0 : this._indexByDictionary.get(chunk.dictionary);
            for (let i = 0; i < count; ++i) {
                const id = this._nextId++;
                const sequenceValue = chunk.sequenceList[i];
                const entryContentDictName = uniformContentDictName ?? (contentDictNames[i] ?? 'raw');
                const expressionIndex = stableExpressionIndexes?.[i] ?? -1;
                const readingIndex = stableReadingIndexes?.[i] ?? -1;
                const hasStableExpression = hasStableStringSlices && expressionIndex >= 0 && expressionIndex < stableStringLengths.length;
                const hasStableReading = hasStableStringSlices && readingIndex >= 0 && readingIndex < stableStringLengths.length;
                const expressionOffset = hasStableExpression ? stableStringOffsets[expressionIndex] : 0;
                const readingOffset = hasStableReading ? stableStringOffsets[readingIndex] : 0;
                const expressionBytes = hasStableExpression ?
                    stableStringsBuffer.subarray(expressionOffset, expressionOffset + stableStringLengths[expressionIndex]) :
                    chunk.expressionBytesList[i];
                const readingBytes = hasStableReading ?
                    stableStringsBuffer.subarray(readingOffset, readingOffset + stableStringLengths[readingIndex]) :
                    chunk.readingBytesList[i];
                /** @type {TermRecord} */
                const record = {
                    id,
                    dictionary: chunk.dictionary,
                    readingEqualsExpression: chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1,
                    expressionBytes,
                    readingBytes: (chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1) ? void 0 : readingBytes,
                    entryContentOffset: getArtifactContentOffset(chunk, contentOffsets, i),
                    entryContentLength: getArtifactContentLength(chunk, contentLengths, i),
                    entryContentDictName,
                    score: chunk.scoreList[i] ?? 0,
                    sequence: typeof sequenceValue === 'number' && sequenceValue >= 0 ? sequenceValue : null,
                };
                this._storeRecord(record);
                this._loadedDictionaryNames.add(chunk.dictionary);
                if (typeof existingIndex !== 'undefined') {
                    this._addRecordToDictionaryIndex(existingIndex, record);
                }
            }
            if (this._deferIndexBuild) {
                this._indexDirty = true;
            }
        }
        const buildRecordsMs = safePerformance.now() - tBuildStart;
        let encodeMs = 0;
        let appendWriteMs = 0;
        let validationMs = 0;
        let wasmEncodeMs = 0;
        let lookupIndexEncodeMs = 0;
        if (uniformContentDictName !== null) {
            const state = await this._getOrCreateShardState(chunk.dictionary, uniformContentDictName);
            if (state === null) {
                return {buildRecordsMs, encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
            }
            const metrics = await this._encodeAndAppendArtifactChunkForState(
                state,
                chunk,
                firstId,
                contentOffsets,
                contentLengths,
                chunk.termRecordPreinternedPlan ?? null,
                uniformContentDictName,
                chunk.preparedLookupIndexes ?? null,
            );
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
            validationMs += metrics.validationMs;
            wasmEncodeMs += metrics.wasmEncodeMs;
            lookupIndexEncodeMs += metrics.lookupIndexEncodeMs;
            return {buildRecordsMs, encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
        }
        let singleContentDictName = true;
        for (let i = 1; i < count; ++i) {
            if ((contentDictNames[i] ?? 'raw') !== firstContentDictName) {
                singleContentDictName = false;
                break;
            }
        }
        if (singleContentDictName) {
            const state = await this._getOrCreateShardState(chunk.dictionary, firstContentDictName);
            if (state === null) {
                return {buildRecordsMs, encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
            }
            const metrics = await this._encodeAndAppendArtifactChunkForState(
                state,
                chunk,
                firstId,
                contentOffsets,
                contentLengths,
                chunk.termRecordPreinternedPlan ?? null,
                firstContentDictName,
                chunk.preparedLookupIndexes ?? null,
            );
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
            validationMs += metrics.validationMs;
            wasmEncodeMs += metrics.wasmEncodeMs;
            lookupIndexEncodeMs += metrics.lookupIndexEncodeMs;
            return {buildRecordsMs, encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
        }
        for (let runStart = 0; runStart < count;) {
            const contentDictName = contentDictNames[runStart] ?? 'raw';
            let runEnd = runStart + 1;
            while (runEnd < count && (contentDictNames[runEnd] ?? 'raw') === contentDictName) {
                ++runEnd;
            }
            const runCount = runEnd - runStart;
            const state = await this._getOrCreateShardState(chunk.dictionary, contentDictName);
            if (state === null) {
                runStart = runEnd;
                continue;
            }
            /** @type {{dictionary: string, rowCount: number, dictionaryTotalRows?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}} */
            const chunkSlice = {
                dictionary: chunk.dictionary,
                rowCount: runCount,
                expressionBytesList: chunk.expressionBytesList.slice(runStart, runEnd),
                readingBytesList: chunk.readingBytesList.slice(runStart, runEnd),
                readingEqualsExpressionList: chunk.readingEqualsExpressionList.slice(runStart, runEnd),
                scoreList: chunk.scoreList.slice(runStart, runEnd),
                sequenceList: chunk.sequenceList.slice(runStart, runEnd),
                termRecordPreinternedPlan: sliceTermRecordPreinternedPlan(chunk.termRecordPreinternedPlan ?? null, runStart, runCount),
            };
            const metrics = await this._encodeAndAppendArtifactChunkForState(
                state,
                chunkSlice,
                firstId + runStart,
                contentOffsets.slice(runStart, runEnd),
                contentLengths.slice(runStart, runEnd),
                chunkSlice.termRecordPreinternedPlan ?? null,
                contentDictName,
            );
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
            validationMs += metrics.validationMs;
            wasmEncodeMs += metrics.wasmEncodeMs;
            lookupIndexEncodeMs += metrics.lookupIndexEncodeMs;
            runStart = runEnd;
        }
        return {buildRecordsMs, encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
    }

    /**
     * @param {TermRecordShardState} state
     * @param {TermRecord[]} records
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @returns {Promise<{encodeMs: number, appendWriteMs: number}>}
     */
    async _encodeAndAppendChunkForState(state, records, preinternedPlan = null) {
        const tEncodeStart = safePerformance.now();
        const {bytes, contentOffsetBase, lookupIndexBytes, recordFields} = await this._encodeRecords(records, preinternedPlan);
        const encodeMs = safePerformance.now() - tEncodeStart;
        const tAppendStart = safePerformance.now();
        await this._appendEncodedChunk(
            state,
            bytes,
            records[0]?.id ?? 0,
            records.length,
            null,
            contentOffsetBase,
            lookupIndexBytes,
            recordFields,
        );
        const appendWriteMs = safePerformance.now() - tAppendStart;
        return {encodeMs, appendWriteMs};
    }

    /**
     * The current shard format stores `firstId` and `count` per chunk, so the
     * records written in a single chunk must have contiguous IDs.
     * @param {TermRecordShardState} state
     * @param {TermRecord[]} records
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @param {number[]|null} [recordIndexes=null]
     * @returns {Promise<{encodeMs: number, appendWriteMs: number}>}
     */
    async _encodeAndAppendChunkRunsForState(state, records, preinternedPlan = null, recordIndexes = null) {
        let encodeMs = 0;
        let appendWriteMs = 0;
        for (let runStart = 0; runStart < records.length;) {
            let runEnd = runStart + 1;
            let minContentOffset = records[runStart].entryContentOffset >= 0 ? records[runStart].entryContentOffset : Number.POSITIVE_INFINITY;
            let maxContentOffset = records[runStart].entryContentOffset >= 0 ? records[runStart].entryContentOffset : Number.NEGATIVE_INFINITY;
            while (runEnd < records.length && records[runEnd].id === (records[runEnd - 1].id + 1)) {
                const contentOffset = records[runEnd].entryContentOffset;
                const nextMinContentOffset = contentOffset >= 0 ? Math.min(minContentOffset, contentOffset) : minContentOffset;
                const nextMaxContentOffset = contentOffset >= 0 ? Math.max(maxContentOffset, contentOffset) : maxContentOffset;
                if (
                    nextMinContentOffset !== Number.POSITIVE_INFINITY &&
                    (nextMaxContentOffset - nextMinContentOffset) > MAX_CONTENT_OFFSET_DELTA
                ) {
                    break;
                }
                minContentOffset = nextMinContentOffset;
                maxContentOffset = nextMaxContentOffset;
                ++runEnd;
            }
            const runRecords = records.slice(runStart, runEnd);
            const runPlan = (
                recordIndexes !== null ?
                    selectTermRecordPreinternedPlan(preinternedPlan, recordIndexes.slice(runStart, runEnd)) :
                    sliceTermRecordPreinternedPlan(preinternedPlan, runStart, runEnd - runStart)
            );
            const metrics = await this._encodeAndAppendChunkForState(state, runRecords, runPlan);
            encodeMs += metrics.encodeMs;
            appendWriteMs += metrics.appendWriteMs;
            runStart = runEnd;
        }
        return {encodeMs, appendWriteMs};
    }

    /**
     * @param {TermRecordShardState} state
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
     * @param {number} firstId
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @param {string} [contentDictName='raw']
     * @param {Map<string, {bytes: Uint8Array, preinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}>|null} [preparedLookupIndexes=null]
     * @returns {Promise<{encodeMs: number, appendWriteMs: number, validationMs: number, wasmEncodeMs: number, lookupIndexEncodeMs: number}>}
     */
    async _encodeAndAppendArtifactChunkForState(state, chunk, firstId, contentOffsets, contentLengths, preinternedPlan = null, contentDictName = 'raw', preparedLookupIndexes = null) {
        let encodeMs = 0;
        let appendWriteMs = 0;
        let validationMs = 0;
        let wasmEncodeMs = 0;
        let lookupIndexEncodeMs = 0;
        const count = chunk.rowCount;
        const hasWholeChunkPreparedIndex = (
            preparedLookupIndexes?.has(`0:${count}`) === true &&
            hasCompletePreparedTermLookupIndexes(preparedLookupIndexes, count)
        );
        const runRowLimit = hasWholeChunkPreparedIndex ? count : MAX_COMPACT_LOOKUP_INDEX_ROWS;
        for (let runStart = 0; runStart < count;) {
            let runEnd = runStart;
            let minContentOffset = Number.POSITIVE_INFINITY;
            let maxContentOffset = Number.NEGATIVE_INFINITY;
            while (runEnd < count) {
                if ((runEnd - runStart) >= runRowLimit) {
                    break;
                }
                const contentOffset = getArtifactContentOffset(chunk, contentOffsets, runEnd);
                validateContentOffset(contentOffset);
                const nextMinContentOffset = contentOffset >= 0 ? Math.min(minContentOffset, contentOffset) : minContentOffset;
                const nextMaxContentOffset = contentOffset >= 0 ? Math.max(maxContentOffset, contentOffset) : maxContentOffset;
                if (
                    runEnd > runStart &&
                    nextMinContentOffset !== Number.POSITIVE_INFINITY &&
                    (nextMaxContentOffset - nextMinContentOffset) > MAX_CONTENT_OFFSET_DELTA
                ) {
                    break;
                }
                minContentOffset = nextMinContentOffset;
                maxContentOffset = nextMaxContentOffset;
                ++runEnd;
            }
            const runCount = runEnd - runStart;
            const isWholeChunk = runStart === 0 && runEnd === count;
            const runChunk = isWholeChunk ?
                chunk :
                {
                    dictionary: chunk.dictionary,
                    rowCount: runCount,
                    expressionBytesList: chunk.expressionBytesList.slice(runStart, runEnd),
                    readingBytesList: chunk.readingBytesList.slice(runStart, runEnd),
                    readingEqualsExpressionList: chunk.readingEqualsExpressionList.slice(runStart, runEnd),
                    scoreList: chunk.scoreList.slice(runStart, runEnd),
                    sequenceList: chunk.sequenceList.slice(runStart, runEnd),
                    fixedContentOffsetBase: (
                        typeof chunk.fixedContentOffsetBase === 'number' && typeof chunk.fixedContentLength === 'number' ?
                            chunk.fixedContentOffsetBase + (runStart * chunk.fixedContentLength) :
                            void 0
                    ),
                    fixedContentLength: chunk.fixedContentLength,
                };
            const runOffsets = isWholeChunk || hasFixedContentSpan(runChunk, runCount) ? contentOffsets : contentOffsets.slice(runStart, runEnd);
            const runLengths = isWholeChunk || hasFixedContentSpan(runChunk, runCount) ? contentLengths : contentLengths.slice(runStart, runEnd);
            const preparedLookupIndex = preparedLookupIndexes?.get(`${runStart}:${runCount}`) ?? null;
            const runPlan = preparedLookupIndex?.preinternedPlan ?? compactTermRecordPreinternedPlan(
                preinternedPlan,
                runStart,
                runCount,
                this._getPreinternedCompactionRemap(preinternedPlan?.stringLengths.length ?? 0),
                chunk.readingEqualsExpressionList,
            );
            const tEncodeStart = safePerformance.now();
            const encodedChunk = await this._encodeArtifactChunkRecords(
                runChunk,
                runOffsets,
                runLengths,
                runPlan,
                preparedLookupIndex?.bytes ?? null,
            );
            encodeMs += safePerformance.now() - tEncodeStart;
            validationMs += encodedChunk.validationMs;
            wasmEncodeMs += encodedChunk.wasmEncodeMs;
            lookupIndexEncodeMs += encodedChunk.lookupIndexEncodeMs;
            const tAppendStart = safePerformance.now();
            await this._appendEncodedChunk(
                state,
                encodedChunk.bytes,
                firstId + runStart,
                runCount,
                contentDictName,
                encodedChunk.contentOffsetBase,
                encodedChunk.lookupIndexBytes,
                encodedChunk.recordFields,
            );
            appendWriteMs += safePerformance.now() - tAppendStart;
            runStart = runEnd;
        }
        return {encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
    }

    /**
     * Builds offset-independent lookup sidecars before term content persistence
     * completes. Exact range keys ensure offset-driven shard splits safely fall
     * back to the normal encoder.
     * @param {{rowCount: number, readingEqualsExpressionList: boolean[]|Uint8Array, sequenceList: (number|undefined)[]|Int32Array, termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}} chunk
     * @returns {{indexes: Map<string, {bytes: Uint8Array, preinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}>, encodeMs: number}|null}
     */
    prepareArtifactChunkLookupIndexes(chunk) {
        const result = prepareTermLookupIndexesFromPreinternedPlan(
            chunk,
            this._getPreinternedCompactionRemap(chunk.termRecordPreinternedPlan?.stringLengths.length ?? 0),
        );
        return result === null ? null : {indexes: result.indexes, encodeMs: result.totalMs};
    }

    /**
     * @param {number} minimumLength
     * @returns {Uint32Array}
     */
    _getPreinternedCompactionRemap(minimumLength) {
        if (this._preinternedCompactionRemap.length < minimumLength) {
            this._preinternedCompactionRemap = new Uint32Array(minimumLength);
        }
        return this._preinternedCompactionRemap;
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<number>}
     */
    async deleteByDictionary(dictionaryName) {
        return await this._runExclusiveStorageMutation(async () => await this._deleteByDictionary(dictionaryName));
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<number>}
     */
    async _deleteByDictionary(dictionaryName) {
        this._loadedDictionaryNames.delete(dictionaryName);
        this._allShardContentsLoaded = false;
        let deletedCount = 0;
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName) ?? [...this._recordsById.keys()];
        for (const id of ids) {
            const record = this._recordsById.get(id);
            if (typeof record === 'undefined' || record.dictionary !== dictionaryName) { continue; }
            this._deleteRecord(id);
            ++deletedCount;
        }
        this._recordIdsByDictionary.delete(dictionaryName);
        this._recordIdStaleDictionaryNames.delete(dictionaryName);
        this._indexByDictionary.delete(dictionaryName);
        this._invalidatePersistentLookupState(dictionaryName);
        this._setDictionaryHealth(dictionaryName, 'available');
        await this._deleteShardByDictionary(dictionaryName);
        return deletedCount;
    }

    /**
     * @param {string} fromDictionaryName
     * @param {string} toDictionaryName
     * @param {boolean} [preserveSourceFiles=false]
     * @returns {Promise<number>}
     */
    async replaceDictionaryName(fromDictionaryName, toDictionaryName, preserveSourceFiles = false) {
        return await this._runExclusiveStorageMutation(async () => await this._replaceDictionaryName(
            fromDictionaryName,
            toDictionaryName,
            preserveSourceFiles,
        ));
    }

    /**
     * Removes a destination copy created with preserveSourceFiles=true and
     * reloads the still-authoritative source shards.
     * @param {string} fromDictionaryName
     * @param {string} toDictionaryName
     * @returns {Promise<void>}
     * @throws {Error} If rollback cleanup or source reload fails.
     */
    async rollbackPreservedDictionaryRename(fromDictionaryName, toDictionaryName) {
        const fromName = `${fromDictionaryName}`.trim();
        const toName = `${toDictionaryName}`.trim();
        if (fromName.length === 0 || toName.length === 0 || fromName === toName) {
            throw new Error('Dictionary rename rollback titles must be distinct and non-empty');
        }
        await this._runExclusiveStorageMutation(async () => {
            if (this._recordsDirectoryHandle === null) {
                await this._replaceDictionaryName(toName, fromName, false);
                return;
            }
            /** @type {Error[]} */
            const errors = [];
            try {
                await this._cleanupShardFilesByDictionaryPredicate((dictionaryName) => dictionaryName === toName);
            } catch (error) {
                errors.push(toError(error));
            }
            try {
                await this._prepare();
            } catch (error) {
                errors.push(toError(error));
            }
            if (errors.length > 0) {
                throw new AggregateError(errors, `Failed to roll back preserved dictionary rename ${toName} to ${fromName}`);
            }
        });
    }

    /**
     * @param {string} fromDictionaryName
     * @param {string} toDictionaryName
     * @param {boolean} preserveSourceFiles
     * @returns {Promise<number>}
     */
    async _replaceDictionaryName(fromDictionaryName, toDictionaryName, preserveSourceFiles) {
        const fromName = `${fromDictionaryName}`.trim();
        const toName = `${toDictionaryName}`.trim();
        if (fromName.length === 0 || toName.length === 0 || fromName === toName) {
            return 0;
        }

        this._loadedDictionaryNames.delete(fromName);
        this._loadedDictionaryNames.delete(toName);
        this._allShardContentsLoaded = false;
        await this._flushPendingWrites();
        await this._awaitQueuedWrites();
        await this._closeAllWritables();
        const [sourceIndexLoaded] = await Promise.all([
            this._tryLoadPersistentDictionaryIndex(fromName),
            this._tryLoadPersistentDictionaryIndex(toName),
        ]);
        const hasLiveTargetRecords = this._hasRecordsForDictionary(toName);
        if (!hasLiveTargetRecords && !this._indexByDictionary.has(toName)) {
            const removedStaleTargetFiles = await this._cleanupShardFilesByDictionaryPredicate((dictionaryName) => dictionaryName === toName);
            if (removedStaleTargetFiles.length > 0) {
                reportDiagnostics('term-record-store-rename-cleanup-stale-target', {
                    fromName,
                    toName,
                    removedStaleTargetFiles,
                });
            }
        }

        const sourceStates = [...this._shardStateByFileName.values()]
            .filter((state) => this._decodeDictionaryNameFromShardFileName(state.fileName) === fromName)
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        let hasUsableSourceIndex = sourceIndexLoaded;
        if (!hasUsableSourceIndex && sourceStates.length > 0 && !this._hasRecordsForDictionary(fromName)) {
            hasUsableSourceIndex = await this._tryRepairPersistentDictionaryIndex(fromName, true) &&
            await this._tryLoadPersistentDictionaryIndex(fromName);
            if (!hasUsableSourceIndex) {
                throw new Error(`Cannot rename dictionary with unreadable term-record shards: ${fromName}`);
            }
        }

        const recordIdsToRename = [];
        const candidateRecordIds = this._getLiveRecordIdsForDictionary(fromName) ?? this._recordsById.keys();
        for (const id of candidateRecordIds) {
            const record = this._recordsById.get(id);
            if (typeof record === 'undefined' || record.dictionary !== fromName) { continue; }
            recordIdsToRename.push(id);
        }
        const renamedCount = recordIdsToRename.length > 0 ?
            recordIdsToRename.length :
            (this._persistentRecordChunksByDictionary.get(fromName) ?? []).reduce((sum, {count}) => sum + count, 0);
        if (renamedCount === 0) {
            if (sourceStates.length > 0) {
                throw new Error(`Cannot establish source record count for dictionary rename: ${fromName}`);
            }
            return 0;
        }

        if (this._recordsDirectoryHandle === null) {
            for (const id of recordIdsToRename) {
                const record = this._recordsById.get(id);
                if (typeof record !== 'undefined') {
                    record.dictionary = toName;
                }
            }
            this._renameRecordIdIndex(fromName, toName, recordIdsToRename);
            this._indexByDictionary.delete(fromName);
            this._indexByDictionary.delete(toName);
            this._indexDirty = false;
            this._setDictionaryHealth(fromName, 'available');
            this._setDictionaryHealth(toName, 'available');
            return renamedCount;
        }
        /** @type {TermRecordRenamePlan[]} */
        const renamePlans = [];
        for (const state of sourceStates) {
            let file;
            try {
                file = await state.fileHandle.getFile();
            } catch (error) {
                throw new Error(`Cannot read source shard during dictionary rename: ${state.fileName}`, {cause: error});
            }
            const shardInfo = this._decodeShardInfoFromShardFileName(state.fileName);
            if (shardInfo === null) {
                throw new Error(`Cannot decode source shard name during dictionary rename: ${state.fileName}`);
            }
            /** @type {File|null} */
            let indexFile = null;
            try {
                if (!hasUsableSourceIndex) { throw new Error('Source lookup index is unavailable'); }
                const indexFileHandle = await this._recordsDirectoryHandle.getFileHandle(
                    `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                    {create: false},
                );
                indexFile = await indexFileHandle.getFile();
            } catch (_) {
                // Older shards without a sidecar retain the full-shard fallback.
            }
            const nextFileName = this._getShardSegmentFileName(toName, shardInfo.contentDictName, shardInfo.segmentIndex);
            const existingTargetState = this._shardStateByFileName.get(nextFileName);
            if (typeof existingTargetState !== 'undefined') {
                if (hasLiveTargetRecords) {
                    throw new Error(`Target shard file already exists for dictionary rename: ${nextFileName}`);
                }
                await this._flushPendingWritesForShard(existingTargetState);
                await this._closeShardWritable(existingTargetState);
                this._shardStateByFileName.delete(nextFileName);
                this._activeAppendShardStateByKey.delete(existingTargetState.logicalKey);
                try {
                    await this._recordsDirectoryHandle.removeEntry(nextFileName);
                } catch (_) {
                    // NOP - fall through and let create/write validation below fail if cleanup was insufficient.
                }
                try {
                    await this._recordsDirectoryHandle.removeEntry(`${nextFileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
                } catch (_) {
                    // NOP
                }
                reportDiagnostics('term-record-store-rename-remove-colliding-target', {
                    fromName,
                    toName,
                    nextFileName,
                });
            }
            const nextFileHandle = await this._recordsDirectoryHandle.getFileHandle(nextFileName, {create: true});
            try {
                const nextFile = await nextFileHandle.getFile();
                if (nextFile.size > 0) {
                    if (!hasLiveTargetRecords) {
                        try {
                            await this._recordsDirectoryHandle.removeEntry(nextFileName);
                            try {
                                await this._recordsDirectoryHandle.removeEntry(`${nextFileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
                            } catch (_) {
                                // NOP
                            }
                            reportDiagnostics('term-record-store-rename-remove-colliding-target-bytes', {
                                fromName,
                                toName,
                                nextFileName,
                                nextFileSize: nextFile.size,
                            });
                            const replacementHandle = await this._recordsDirectoryHandle.getFileHandle(nextFileName, {create: true});
                            renamePlans.push({
                                state,
                                shardInfo,
                                nextFileName,
                                nextFileHandle: replacementHandle,
                                file,
                                fileSize: file.size,
                                indexFile,
                            });
                            continue;
                        } catch (_) {
                            // NOP - fall through to the explicit collision error below.
                        }
                    }
                    throw new Error(`Target shard file already contains data for dictionary rename: ${nextFileName}`);
                }
            } catch (e) {
                if (e instanceof Error && /already contains data|already exists/.test(e.message)) {
                    throw e;
                }
                throw new Error(`Cannot inspect target shard during dictionary rename: ${nextFileName}`, {cause: e});
            }
            renamePlans.push({
                state,
                shardInfo,
                nextFileName,
                nextFileHandle,
                file,
                fileSize: file.size,
                indexFile,
            });
        }
        /**
         * @param {FileSystemFileHandle} fileHandle
         * @param {File} file
         * @returns {Promise<void>}
         */
        const writeShardFile = async (fileHandle, file) => {
            const writable = await fileHandle.createWritable();
            try {
                await writable.truncate(0);
                if (file.size > 0) {
                    await writable.write(file);
                }
            } finally {
                await writable.close();
            }
        };
        /** @type {TermRecordRenamePlan[]} */
        const createdPlans = [];
        /** @type {TermRecordRenamePlan[]} */
        const removedPlans = [];
        try {
            for (const plan of renamePlans) {
                await writeShardFile(plan.nextFileHandle, plan.file);
                if (plan.indexFile !== null) {
                    const nextIndexHandle = await this._recordsDirectoryHandle.getFileHandle(
                        `${plan.nextFileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                        {create: true},
                    );
                    await writeShardFile(nextIndexHandle, plan.indexFile);
                }
                createdPlans.push(plan);
            }
            if (!preserveSourceFiles) {
                for (const plan of renamePlans) {
                    await this._recordsDirectoryHandle.removeEntry(plan.state.fileName);
                    try {
                        await this._recordsDirectoryHandle.removeEntry(`${plan.state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
                    } catch (_) {
                        // NOP
                    }
                    removedPlans.push(plan);
                }
            }
        } catch (e) {
            for (const plan of [...removedPlans].reverse()) {
                try {
                    const restoredHandle = await this._recordsDirectoryHandle.getFileHandle(plan.state.fileName, {create: true});
                    await writeShardFile(restoredHandle, plan.file);
                    if (plan.indexFile !== null) {
                        const restoredIndexHandle = await this._recordsDirectoryHandle.getFileHandle(
                            `${plan.state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                            {create: true},
                        );
                        await writeShardFile(restoredIndexHandle, plan.indexFile);
                    }
                } catch (_) {
                    // NOP - preserve original failure.
                }
            }
            for (const plan of [...createdPlans].reverse()) {
                try {
                    await this._recordsDirectoryHandle.removeEntry(plan.nextFileName);
                    try {
                        await this._recordsDirectoryHandle.removeEntry(`${plan.nextFileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
                    } catch (_) {
                        // NOP
                    }
                } catch (_) {
                    // NOP - preserve original failure.
                }
            }
            throw e;
        }

        for (const id of recordIdsToRename) {
            const record = this._recordsById.get(id);
            if (typeof record !== 'undefined') {
                record.dictionary = toName;
            }
        }
        this._renameRecordIdIndex(fromName, toName, recordIdsToRename);
        this._indexByDictionary.delete(fromName);
        this._indexByDictionary.delete(toName);
        this._invalidatePersistentLookupState(fromName);
        this._invalidatePersistentLookupState(toName);
        this._indexDirty = false;
        for (const plan of renamePlans) {
            this._shardStateByFileName.delete(plan.state.fileName);
            this._activeAppendShardStateByKey.delete(plan.state.logicalKey);
            const nextState = this._createShardState(
                plan.nextFileName,
                plan.nextFileHandle,
                plan.fileSize,
                plan.shardInfo.contentDictName,
                plan.shardInfo.segmentIndex,
                this._getShardFileName(toName, plan.shardInfo.contentDictName),
            );
            this._shardStateByFileName.set(plan.nextFileName, nextState);
            this._setActiveAppendShardState(nextState);
        }
        this._setDictionaryHealth(fromName, 'available');
        this._setDictionaryHealth(toName, 'available');

        return renamedCount;
    }

    /**
     * @param {(dictionaryName: string) => boolean} predicate
     * @returns {Promise<string[]>}
     */
    async cleanupShardFilesByDictionaryPredicate(predicate) {
        return await this._runExclusiveStorageMutation(
            async () => await this._cleanupShardFilesByDictionaryPredicate(predicate),
        );
    }

    /**
     * @param {(dictionaryName: string) => boolean} predicate
     * @returns {Promise<string[]>}
     */
    async _cleanupShardFilesByDictionaryPredicate(predicate) {
        if (this._recordsDirectoryHandle === null) {
            return [];
        }
        this._allShardContentsLoaded = false;
        const removedFileNames = [];
        /** @type {Set<string>} */
        const removedDictionaryNames = new Set();
        const fileNames = await this._listShardFileNames();
        for (const fileName of fileNames) {
            const dictionaryName = this._decodeDictionaryNameFromShardFileName(fileName);
            if (dictionaryName === null || !predicate(dictionaryName)) {
                continue;
            }
            const state = this._shardStateByFileName.get(fileName);
            if (typeof state !== 'undefined') {
                await this._flushPendingWritesForShard(state);
                await this._closeShardWritable(state);
            }
            await this._removeStorageFileOrTruncate(fileName, true);
            if (typeof state !== 'undefined') {
                this._shardStateByFileName.delete(fileName);
                this._activeAppendShardStateByKey.delete(state.logicalKey);
            }
            await this._removeStorageFileOrTruncate(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
            removedDictionaryNames.add(dictionaryName);
            removedFileNames.push(fileName);
        }
        if (removedDictionaryNames.size > 0) {
            const recordIdsToDelete = [];
            let requiresFullRecordScan = false;
            for (const dictionaryName of removedDictionaryNames) {
                const ids = this._getLiveRecordIdsForDictionary(dictionaryName);
                if (typeof ids === 'undefined') {
                    requiresFullRecordScan = true;
                    break;
                }
                for (const id of ids) {
                    recordIdsToDelete.push(id);
                }
            }
            if (requiresFullRecordScan) {
                recordIdsToDelete.length = 0;
                for (const id of this._recordsById.keys()) {
                    const record = this._recordsById.get(id);
                    if (typeof record !== 'undefined' && removedDictionaryNames.has(record.dictionary)) {
                        recordIdsToDelete.push(id);
                    }
                }
            }
            for (const id of recordIdsToDelete) {
                this._deleteRecord(id);
            }
            for (const dictionaryName of removedDictionaryNames) {
                this._loadedDictionaryNames.delete(dictionaryName);
                this._recordIdsByDictionary.delete(dictionaryName);
                this._recordIdStaleDictionaryNames.delete(dictionaryName);
                this._invalidatePersistentLookupState(dictionaryName);
                this._setDictionaryHealth(dictionaryName, 'available');
            }
            this._indexByDictionary.clear();
            this._indexDirty = false;
        }
        return removedFileNames;
    }

    /**
     * @param {Iterable<number>} ids
     * @returns {Map<number, TermRecord>}
     */
    getByIds(ids) {
        /** @type {Map<number, TermRecord>} */
        const result = new Map();
        for (const id of ids) {
            const record = this._recordsById.get(id);
            if (typeof record !== 'undefined') {
                result.set(id, record);
            }
        }
        return result;
    }

    /**
     * @param {File} file
     * @param {number} start
     * @param {number} end
     * @returns {Promise<Uint8Array>}
     */
    async _readFileRange(file, start, end) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size) {
            throw new RangeError(`Invalid term-record file range: ${start}..${end} of ${file.size}`);
        }
        const slice = /** @type {unknown} */ (Reflect.get(file, 'slice'));
        if (typeof slice === 'function') {
            const blob = /** @type {Blob} */ (/** @type {(start: number, end: number) => Blob} */ (slice).call(file, start, end));
            return new Uint8Array(await blob.arrayBuffer());
        }
        const content = new Uint8Array(await file.arrayBuffer());
        return content.slice(start, end);
    }

    /**
     * @param {number} id
     * @returns {PersistentRecordChunk|null}
     */
    _findPersistentRecordChunk(id) {
        for (const chunks of this._persistentRecordChunksByDictionary.values()) {
            let low = 0;
            let high = chunks.length - 1;
            while (low <= high) {
                const middle = (low + high) >>> 1;
                const chunk = chunks[middle];
                if (id < chunk.firstId) {
                    high = middle - 1;
                } else if (id >= (chunk.firstId + chunk.count)) {
                    low = middle + 1;
                } else {
                    return chunk;
                }
            }
        }
        return null;
    }

    /**
     * @param {PersistentRecordChunk} chunk
     * @returns {Promise<{file: File, strings: string[], recordsStart: number, contentOffsetBase: number, firstId: number, count: number}|null>}
     */
    async _loadRandomReadChunkMetadata(chunk) {
        const cacheKey = `${chunk.fileName}:${chunk.chunkOffset}`;
        const cached = this._randomReadChunkMetadataCache.get(cacheKey);
        if (typeof cached !== 'undefined') { return await cached; }
        const load = (async () => {
            const file = await chunk.fileHandle.getFile();
            const prefix = await this._readFileRange(
                file,
                chunk.chunkOffset,
                chunk.chunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES,
            );
            const prefixView = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
            const firstId = prefixView.getUint32(0, true);
            const count = prefixView.getUint32(4, true);
            let contentOffsetBase;
            try {
                contentOffsetBase = readSafeU64Le(prefixView, 8);
            } catch (error) {
                throw new TermRecordIntegrityError(
                    `Invalid term-record content offset base for ${chunk.fileName}: ${String(error)}`,
                );
            }
            if (hashLookupIndexBytes(prefix.subarray(0, CHUNK_HEADER_BYTES)) !== chunk.chunkHeaderHash) {
                throw new TermRecordIntegrityError(`Term-record chunk header checksum mismatch for ${chunk.fileName}`);
            }
            const stringCount = prefixView.getUint32(CHUNK_HEADER_BYTES, true);
            const stringBytesLength = prefixView.getUint32(CHUNK_HEADER_BYTES + 4, true);
            if (firstId !== chunk.firstId || count !== chunk.count || stringCount > count * 2) {
                throw new TermRecordIntegrityError(`Invalid term-record chunk metadata for ${chunk.fileName}`);
            }
            const tableBytes = (stringCount * 2) + stringBytesLength;
            const table = await this._readFileRange(
                file,
                chunk.chunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES,
                chunk.chunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES + tableBytes,
            );
            const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
            const strings = new Array(stringCount);
            let lengthsCursor = 0;
            let stringsCursor = stringCount * 2;
            for (let i = 0; i < stringCount; ++i) {
                const length = tableView.getUint16(lengthsCursor, true); lengthsCursor += 2;
                if ((stringsCursor + length) > table.byteLength) {
                    throw new TermRecordIntegrityError(`Invalid term-record string table for ${chunk.fileName}`);
                }
                strings[i] = this._decodeString(table, stringsCursor, length);
                stringsCursor += length;
            }
            if (stringsCursor !== table.byteLength) {
                throw new TermRecordIntegrityError(`Invalid term-record string table length for ${chunk.fileName}`);
            }
            return {
                file,
                strings,
                recordsStart: chunk.chunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES + tableBytes,
                contentOffsetBase,
                firstId,
                count,
            };
        })();
        this._randomReadChunkMetadataCache.set(cacheKey, load);
        try {
            const result = await load;
            if (result === null) { this._randomReadChunkMetadataCache.delete(cacheKey); }
            return result;
        } catch (error) {
            if (this._randomReadChunkMetadataCache.get(cacheKey) === load) {
                this._randomReadChunkMetadataCache.delete(cacheKey);
            }
            throw error;
        }
    }

    /**
     * @param {{fileName: string, dictionaryName: string}} chunk
     * @returns {Promise<boolean>}
     */
    async _loadShardForRandomReadFallback(chunk) {
        const state = this._shardStateByFileName.get(chunk.fileName);
        if (typeof state === 'undefined' || !this._canMaterializeDictionaryFallback(chunk.dictionaryName)) { return false; }
        const deferIndexBuild = this._deferIndexBuild;
        this._deferIndexBuild = true;
        try {
            return await this._loadShardStateContents(state);
        } finally {
            this._deferIndexBuild = deferIndexBuild;
        }
    }

    /**
     * @param {Iterable<number>} ids
     * @returns {Promise<Map<number, TermRecord>>}
     */
    async getByIdsAsync(ids) {
        const idList = [...new Set(ids)];
        const result = this.getByIds(idList);
        /** @type {Map<ReturnType<TermRecordOpfsStore['_findPersistentRecordChunk']>, number[]>} */
        const idsByChunk = new Map();
        for (const id of idList) {
            if (result.has(id)) { continue; }
            const chunk = this._findPersistentRecordChunk(id);
            if (chunk === null) { continue; }
            const chunkIds = idsByChunk.get(chunk);
            if (typeof chunkIds === 'undefined') {
                idsByChunk.set(chunk, [id]);
            } else {
                chunkIds.push(id);
            }
        }
        const chunkEntries = [...idsByChunk];
        for (const [chunk, chunkIds] of chunkEntries) {
            if (chunk === null) { continue; }
            if (
                this.getDictionaryHealth(chunk.dictionaryName).status === 'reimportRequired' ||
                !(this._persistentRecordChunksByDictionary.get(chunk.dictionaryName) ?? []).includes(chunk)
            ) { continue; }
            const fieldsView = new DataView(
                chunk.recordFields.buffer,
                chunk.recordFields.byteOffset,
                chunk.recordFields.byteLength,
            );
            for (const id of chunkIds) {
                const ordinal = id - chunk.firstId;
                const fieldsOffset = ordinal * LOOKUP_INDEX_RECORD_FIELDS_BYTES;
                const expressionBytes = getPersistedTermKeyBytes(chunk.lookupIndex, ordinal, 'expression');
                if (expressionBytes === null) { continue; }
                const readingBytes = getPersistedTermKeyBytes(chunk.lookupIndex, ordinal, 'reading');
                const contentOffsetDelta = fieldsView.getUint32(fieldsOffset, true);
                const rawContentLength = fieldsView.getUint32(fieldsOffset + 4, true);
                const entryContentOffset = contentOffsetDelta === U32_NULL ?
                    -1 :
                    chunk.contentOffsetBase + contentOffsetDelta;
                const expression = this._textDecoder.decode(expressionBytes);
                const record = {
                    id,
                    dictionary: chunk.dictionaryName,
                    expression,
                    reading: readingBytes === null ? expression : this._textDecoder.decode(readingBytes),
                    expressionReverse: null,
                    readingReverse: null,
                    entryContentOffset,
                    entryContentLength: rawContentLength === U32_NULL ? -1 : rawContentLength,
                    entryContentDictName: chunk.contentDictName,
                    score: fieldsView.getInt32(fieldsOffset + 8, true),
                    sequence: getPersistedTermSequence(chunk.lookupIndex, ordinal),
                };
                this._storeRecord(record);
                result.set(id, record);
            }
        }
        return result;
    }

    /**
     * @returns {number[]}
     */
    getAllIds() {
        return [...this._recordsById.keys()].sort((a, b) => a - b);
    }

    /**
     * @param {TermRecord} record
     * @returns {boolean} Whether the record must be added to its dictionary indexes.
     */
    _storeRecord(record) {
        const existing = this._recordsById.get(record.id);
        this._recordsById.set(record.id, record);
        if (typeof existing !== 'undefined') {
            if (existing.dictionary !== record.dictionary) {
                this._markRecordIdsStale(existing.dictionary);
                this._markRecordIdsStale(record.dictionary);
                let ids = this._recordIdsByDictionary.get(record.dictionary);
                if (typeof ids === 'undefined') {
                    ids = [];
                    this._recordIdsByDictionary.set(record.dictionary, ids);
                }
                ids.push(record.id);
                return true;
            }
            return false;
        }
        this._getOrCreateRecordIdsForDictionary(record.dictionary).push(record.id);
        return true;
    }

    /**
     * @param {TermRecord} record
     * @param {number[]} recordIds
     * @returns {boolean} Whether the record must be added to its dictionary indexes.
     */
    _storeRecordWithKnownDictionaryIds(record, recordIds) {
        if (typeof this._recordsById.get(record.id) !== 'undefined') {
            return this._storeRecord(record);
        }
        this._recordsById.set(record.id, record);
        recordIds.push(record.id);
        return true;
    }

    /**
     * @param {string} dictionaryName
     * @returns {number[]}
     */
    _getOrCreateRecordIdsForDictionary(dictionaryName) {
        let ids = this._recordIdsByDictionary.get(dictionaryName);
        if (typeof ids === 'undefined') {
            ids = [];
            this._recordIdsByDictionary.set(dictionaryName, ids);
        }
        return ids;
    }

    /**
     * @param {string} dictionaryName
     * @returns {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}}
     */
    _getOrCreateDictionaryIndex(dictionaryName) {
        let index = this._indexByDictionary.get(dictionaryName);
        if (typeof index === 'undefined') {
            index = {
                expression: new Map(),
                reading: new Map(),
                expressionReverse: new Map(),
                readingReverse: new Map(),
                sequence: new Map(),
            };
            this._indexByDictionary.set(dictionaryName, index);
        }
        return index;
    }

    /**
     * @param {string} dictionaryName
     * @returns {number[]|undefined}
     */
    _getLiveRecordIdsForDictionary(dictionaryName) {
        const ids = this._recordIdsByDictionary.get(dictionaryName);
        if (typeof ids === 'undefined') {
            return void 0;
        }
        if (!this._recordIdStaleDictionaryNames.has(dictionaryName)) {
            return ids;
        }
        /** @type {Set<number>} */
        const seenIds = new Set();
        /** @type {number[]} */
        const compactedIds = [];
        const records = this._recordsById.getRawRecords();
        for (const id of ids) {
            if (seenIds.has(id)) { continue; }
            seenIds.add(id);
            const record = records[id];
            if (typeof record !== 'undefined' && record.dictionary === dictionaryName) {
                compactedIds.push(id);
            }
        }
        this._recordIdsByDictionary.set(dictionaryName, compactedIds);
        this._recordIdStaleDictionaryNames.delete(dictionaryName);
        return compactedIds;
    }

    /**
     * @param {number} id
     * @returns {boolean}
     */
    _deleteRecord(id) {
        const existing = this._recordsById.get(id);
        const deleted = this._recordsById.delete(id);
        if (deleted && typeof existing !== 'undefined') {
            this._markRecordIdsStale(existing.dictionary);
        }
        return deleted;
    }

    /**
     * @param {string} dictionaryName
     * @returns {void}
     */
    _markRecordIdsStale(dictionaryName) {
        if (dictionaryName.length > 0) {
            this._recordIdStaleDictionaryNames.add(dictionaryName);
        }
    }

    /**
     * @param {string} fromName
     * @param {string} toName
     * @param {number[]} renamedIds
     * @returns {void}
     */
    _renameRecordIdIndex(fromName, toName, renamedIds) {
        const existingFromIds = this._recordIdsByDictionary.get(fromName);
        if (typeof existingFromIds !== 'undefined') {
            this._recordIdsByDictionary.delete(fromName);
        }
        this._markRecordIdsStale(fromName);
        this._markRecordIdsStale(toName);
        let toIds = this._recordIdsByDictionary.get(toName);
        if (typeof toIds === 'undefined') {
            toIds = [];
            this._recordIdsByDictionary.set(toName, toIds);
        }
        for (const id of renamedIds) {
            toIds.push(id);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _ensureNextIdReadyForAppend() {
        if (!this._nextIdMayNeedShardScan || this._recordsDirectoryHandle === null) {
            return;
        }
        let maxId = this._nextId - 1;
        for (const state of this._shardStateByFileName.values()) {
            let file;
            try {
                file = await state.fileHandle.getFile();
            } catch (_) {
                continue;
            }
            if (file.size <= 0) { continue; }
            const content = new Uint8Array(await file.arrayBuffer());
            const shardMaxId = this._scanCurrentBinaryMaxRecordId(content);
            if (typeof shardMaxId === 'number' && shardMaxId > maxId) {
                maxId = shardMaxId;
            }
        }
        this._nextId = Math.max(this._nextId, maxId + 1);
        this._nextIdMayNeedShardScan = false;
    }

    /**
     * @param {Uint8Array} content
     * @returns {number|null}
     */
    _scanCurrentBinaryMaxRecordId(content) {
        if (content.byteLength < BINARY_HEADER_PREFIX_BYTES) {
            return null;
        }
        const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
        const magic = this._textDecoder.decode(content.subarray(0, BINARY_MAGIC_BYTES));
        if (magic !== BINARY_MAGIC_TEXT) {
            return null;
        }
        let cursor = BINARY_HEADER_PREFIX_BYTES;
        if ((cursor + 2) > content.byteLength) { return null; }
        const entryContentDictNameMeta16 = view.getUint16(cursor, true); cursor += 2;
        let entryContentDictNameMeta = entryContentDictNameMeta16;
        if (entryContentDictNameMeta16 === U16_NULL) {
            if ((cursor + 4) > content.byteLength) { return null; }
            entryContentDictNameMeta = view.getUint32(cursor, true); cursor += 4;
        }
        const entryContentDictNameLength = (entryContentDictNameMeta & 0xff) === ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM ?
            (entryContentDictNameMeta >>> 8) :
            0;
        cursor += entryContentDictNameLength;
        if (cursor > content.byteLength) { return null; }

        let maxId = 0;
        while ((cursor + CHUNK_HEADER_BYTES) <= content.byteLength) {
            const chunkBaseId = view.getUint32(cursor, true); cursor += 4;
            const chunkCount = view.getUint32(cursor, true); cursor += 4;
            if (chunkBaseId <= 0 || chunkCount === 0) { break; }
            cursor += 8; // 64-bit entry-content offset base
            cursor += 4; // record payload checksum
            maxId = Math.max(maxId, chunkBaseId + chunkCount - 1);
            if ((cursor + STRING_TABLE_HEADER_BYTES) > content.byteLength) { return maxId; }
            const stringCount = view.getUint32(cursor, true); cursor += 4;
            const stringBytesLength = view.getUint32(cursor, true); cursor += 4;
            cursor += (stringCount * 2) + stringBytesLength;
            if (cursor > content.byteLength) { return maxId; }
            for (let i = 0; i < chunkCount; ++i) {
                if ((cursor + RECORD_HEADER_BYTES) > content.byteLength) { return maxId; }
                cursor += 4; // expression string table index
                cursor += 4; // reading string table index, or READING_EQUALS_EXPRESSION_U32
                cursor += 4; // entry content offset
                cursor += 4; // entry content length
                cursor += 4; // score
                cursor += 4; // sequence
                if (cursor > content.byteLength) { return maxId; }
            }
        }
        return maxId > 0 ? maxId : null;
    }

    /**
     * @param {string} dictionaryName
     * @returns {Generator<TermRecord, void, void>}
     * @yields {TermRecord}
     */
    *_iterateRecordsForDictionary(dictionaryName) {
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName);
        if (typeof ids !== 'undefined') {
            const records = this._recordsById.getRawRecords();
            for (const id of ids) {
                const record = records[id];
                if (typeof record !== 'undefined') {
                    yield record;
                }
            }
            return;
        }
        for (const record of this._recordsById.values()) {
            if (record.dictionary === dictionaryName) {
                yield record;
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @returns {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}}
     */
    getDictionaryIndex(dictionaryName) {
        this._ensureIndexesReady();
        const existing = this._indexByDictionary.get(dictionaryName);
        if (typeof existing !== 'undefined') {
            if (
                existing.expression.size === 0 &&
                existing.reading.size === 0 &&
                this._hasRecordsForDictionary(dictionaryName)
            ) {
                this._indexByDictionary.delete(dictionaryName);
            } else {
                return existing;
            }
        }
        const created = {
            expression: new Map(),
            reading: new Map(),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        };
        this._addDictionaryRecordsToIndex(dictionaryName, created);
        if (
            created.expression.size === 0 &&
            created.reading.size === 0 &&
            this._hasRecordsForDictionary(dictionaryName)
        ) {
            this._rebuildIndexesFromRecords();
            const rebuilt = this._indexByDictionary.get(dictionaryName);
            if (typeof rebuilt !== 'undefined') {
                return rebuilt;
            }
        }
        this._indexByDictionary.set(dictionaryName, created);
        return created;
    }

    /**
     * @param {Iterable<string>} dictionaryNames
     * @returns {void}
     */
    ensureDictionaryIndexes(dictionaryNames) {
        this._ensureIndexesReady();
        /** @type {Set<string>} */
        const pending = new Set();
        for (const dictionaryName of dictionaryNames) {
            const name = `${dictionaryName}`.trim();
            if (name.length === 0) { continue; }
            const existing = this._indexByDictionary.get(name);
            if (typeof existing === 'undefined') {
                pending.add(name);
            } else if (
                existing.expression.size === 0 &&
                existing.reading.size === 0 &&
                this._hasRecordsForDictionary(name)
            ) {
                this._indexByDictionary.delete(name);
                pending.add(name);
            }
        }
        if (pending.size === 0) { return; }
        if (pending.size === 1) {
            this.getDictionaryIndex(/** @type {string} */ ([...pending][0]));
            return;
        }

        /** @type {Map<string, {expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}>} */
        const createdIndexes = new Map();
        for (const name of pending) {
            const index = {
                expression: new Map(),
                reading: new Map(),
                expressionReverse: new Map(),
                readingReverse: new Map(),
                sequence: new Map(),
            };
            createdIndexes.set(name, index);
            this._indexByDictionary.set(name, index);
        }
        for (const [name, index] of createdIndexes) {
            this._addDictionaryRecordsToIndex(name, index);
        }
        for (const [name, index] of createdIndexes) {
            if (
                index.expression.size === 0 &&
                index.reading.size === 0 &&
                this._hasRecordsForDictionary(name)
            ) {
                this._indexByDictionary.delete(name);
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @param {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}} [index]
     * @returns {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}}
     */
    ensureDictionaryReverseIndex(dictionaryName, index = this.getDictionaryIndex(dictionaryName)) {
        if (this._reverseIndexReady.has(index)) {
            return index;
        }
        index.expressionReverse.clear();
        index.readingReverse.clear();
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName)) {
            for (const [expression, ids] of index.expression) {
                index.expressionReverse.set(this._reverseString(expression), ids);
            }
            for (const [reading, ids] of index.reading) {
                index.readingReverse.set(this._reverseString(reading), ids);
            }
        } else {
            this._addDictionaryRecordsToReverseIndex(dictionaryName, index);
        }
        this._reverseIndexReady.add(index);
        return index;
    }

    /**
     * @returns {string[]}
     */
    getShardFileNames() {
        return [...this._shardStateByFileName.keys()].sort((a, b) => a.localeCompare(b));
    }

    /**
     * @param {string} dictionaryName
     * @returns {boolean}
     */
    _hasRecordsForDictionary(dictionaryName) {
        if ((this._persistentRecordChunksByDictionary.get(dictionaryName)?.length ?? 0) > 0) {
            return true;
        }
        const ids = this._recordIdsByDictionary.get(dictionaryName);
        if (typeof ids !== 'undefined') {
            for (const id of ids) {
                const record = this._recordsById.get(id);
                if (typeof record !== 'undefined' && record.dictionary === dictionaryName) {
                    return true;
                }
            }
            return false;
        }
        for (const record of this._recordsById.values()) {
            if (record.dictionary === dictionaryName) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {number} id
     * @returns {TermRecord|undefined}
     */
    getById(id) {
        return this._recordsById.get(id);
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<boolean>}
     */
    async _tryLoadPersistentDictionaryIndex(dictionaryName) {
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName)) {
            this._setDictionaryHealth(dictionaryName, 'available');
            return true;
        }
        const existing = this._persistentIndexLoadPromiseByDictionary.get(dictionaryName);
        if (typeof existing !== 'undefined') { return await existing; }
        const globalGeneration = this._persistentLookupGeneration;
        const dictionaryGeneration = this._getPersistentLookupGeneration(dictionaryName);
        const load = (async () => {
            for (let attempt = 0; attempt < STORAGE_READ_RETRY_COUNT; ++attempt) {
                if (await this._loadPersistentDictionaryIndex(
                    dictionaryName,
                    globalGeneration,
                    dictionaryGeneration,
                )) {
                    return true;
                }
                if (this._persistentIndexFailureByDictionary.get(dictionaryName)?.kind !== 'transient') {
                    break;
                }
                await new Promise((resolve) => { setTimeout(resolve, 0); });
            }
            return false;
        })();
        this._persistentIndexLoadPromiseByDictionary.set(dictionaryName, load);
        try {
            return await load;
        } finally {
            if (this._persistentIndexLoadPromiseByDictionary.get(dictionaryName) === load) {
                this._persistentIndexLoadPromiseByDictionary.delete(dictionaryName);
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @param {number} globalGeneration
     * @param {number} [dictionaryGeneration]
     * @returns {Promise<boolean>}
     */
    async _loadPersistentDictionaryIndex(
        dictionaryName,
        globalGeneration,
        dictionaryGeneration = this._getPersistentLookupGeneration(dictionaryName),
    ) {
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName)) {
            this._setDictionaryHealth(dictionaryName, 'available');
            return true;
        }
        if (this._recordsDirectoryHandle === null) {
            this._recordPersistentIndexFailure(dictionaryName, 'transient', 'Term-record directory is unavailable');
            return false;
        }
        const states = [...this._shardStateByFileName.values()]
            .filter((state) => this._decodeDictionaryNameFromShardFileName(state.fileName) === dictionaryName)
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        if (states.length === 0) {
            this._recordPersistentIndexFailure(dictionaryName, 'missing', 'No term-record shards exist');
            return false;
        }
        /** @type {PersistentRecordChunk[]} */
        const recordChunks = [];
        try {
            for (const state of states) {
                let indexFileHandle;
                try {
                    indexFileHandle = await this._recordsDirectoryHandle.getFileHandle(
                        `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                        {create: false},
                    );
                } catch (error) {
                    if (isStorageEntryNotFoundError(error)) {
                        throw new PersistentLookupIndexError('missing', `Lookup index is missing for ${state.fileName}`, error);
                    }
                    throw error;
                }
                let recordFile;
                let indexFile;
                try {
                    [recordFile, indexFile] = await Promise.all([
                        state.fileHandle.getFile(),
                        indexFileHandle.getFile(),
                    ]);
                } catch (error) {
                    if (isStorageEntryNotFoundError(error)) {
                        throw new PersistentLookupIndexError(
                            'invalid',
                            `Term-record shard or lookup index disappeared for ${state.fileName}`,
                            error,
                        );
                    }
                    throw error;
                }
                if (recordFile.size < (BINARY_HEADER_PREFIX_BYTES + 2) || indexFile.size < LOOKUP_INDEX_FILE_HEADER_BYTES) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index is truncated for ${state.fileName}`);
                }
                const [indexHeader, recordHeader] = await Promise.all([
                    this._readFileRange(indexFile, 0, LOOKUP_INDEX_FILE_HEADER_BYTES),
                    this._readFileRange(recordFile, 0, BINARY_HEADER_PREFIX_BYTES),
                ]);
                const headerView = new DataView(indexHeader.buffer, indexHeader.byteOffset, indexHeader.byteLength);
                if (this._textDecoder.decode(indexHeader.subarray(0, LOOKUP_INDEX_MAGIC_BYTES)) !== LOOKUP_INDEX_MAGIC_TEXT) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index header is invalid for ${state.fileName}`);
                }
                if (this._textDecoder.decode(recordHeader.subarray(0, BINARY_MAGIC_BYTES)) !== BINARY_MAGIC_TEXT) {
                    throw new PersistentLookupIndexError('invalid', `Term-record shard header is invalid for ${state.fileName}`);
                }
                const recordGenerationId = recordHeader.subarray(BINARY_MAGIC_BYTES, BINARY_HEADER_PREFIX_BYTES);
                const indexGenerationId = indexHeader.subarray(24, LOOKUP_INDEX_FILE_HEADER_BYTES);
                if (!bytesEqual(recordGenerationId, indexGenerationId)) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index generation does not match ${state.fileName}`);
                }
                state.generationId = new Uint8Array(recordGenerationId);
                let expectedRecordFileLength;
                try {
                    expectedRecordFileLength = readSafeU64Le(headerView, 8);
                } catch (error) {
                    throw new PersistentLookupIndexError(
                        'invalid',
                        `Lookup index record length is invalid for ${state.fileName}`,
                        error,
                    );
                }
                const chunkCount = headerView.getUint32(16, true);
                const expectedRecordCount = headerView.getUint32(20, true);
                if (expectedRecordFileLength !== recordFile.size || chunkCount === 0 || expectedRecordCount === 0) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index metadata does not match ${state.fileName}`);
                }
                const minimumIndexBytes = LOOKUP_INDEX_FILE_HEADER_BYTES +
                (chunkCount * LOOKUP_INDEX_CHUNK_HEADER_BYTES) +
                (expectedRecordCount * LOOKUP_INDEX_RECORD_FIELDS_BYTES);
                const maximumIndexBytes = Math.max(
                    MAX_LOOKUP_INDEX_OVERHEAD_BYTES,
                    Math.min(Number.MAX_SAFE_INTEGER, (recordFile.size * 4) + MAX_LOOKUP_INDEX_OVERHEAD_BYTES),
                );
                if (
                    !Number.isSafeInteger(minimumIndexBytes) ||
                    minimumIndexBytes > indexFile.size ||
                    indexFile.size > maximumIndexBytes
                ) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index size is implausible for ${state.fileName}`);
                }
                const content = new Uint8Array(await indexFile.arrayBuffer());
                const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
                let cursor = LOOKUP_INDEX_FILE_HEADER_BYTES;
                let actualRecordCount = 0;
                for (let chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex) {
                    if ((cursor + LOOKUP_INDEX_CHUNK_HEADER_BYTES) > content.byteLength) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index chunk header is truncated for ${state.fileName}`);
                    }
                    const firstId = view.getUint32(cursor, true); cursor += 4;
                    const count = view.getUint32(cursor, true); cursor += 4;
                    let recordChunkOffset;
                    try {
                        recordChunkOffset = readSafeU64Le(view, cursor);
                    } catch (error) {
                        throw new PersistentLookupIndexError(
                            'invalid',
                            `Lookup index record offset is invalid for ${state.fileName}`,
                            error,
                        );
                    }
                    cursor += 8;
                    let contentOffsetBase;
                    try {
                        contentOffsetBase = readSafeU64Le(view, cursor);
                    } catch (error) {
                        throw new PersistentLookupIndexError(
                            'invalid',
                            `Lookup index content offset base is invalid for ${state.fileName}`,
                            error,
                        );
                    }
                    cursor += 8;
                    const payloadLength = view.getUint32(cursor, true); cursor += 4;
                    const payloadHash = view.getUint32(cursor, true); cursor += 4;
                    const chunkHeaderHash = view.getUint32(cursor, true); cursor += 4;
                    const recordFieldsHash = view.getUint32(cursor, true); cursor += 4;
                    const payloadEnd = cursor + payloadLength;
                    const recordFieldsEnd = payloadEnd + (count * LOOKUP_INDEX_RECORD_FIELDS_BYTES);
                    if (
                        firstId <= 0 ||
                        count === 0 ||
                        (firstId + count - 1) > 0xffffffff ||
                        (recordChunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES) > recordFile.size ||
                        recordFieldsEnd > content.byteLength
                    ) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index chunk metadata is invalid for ${state.fileName}`);
                    }
                    const payload = content.subarray(cursor, payloadEnd);
                    if (hashLookupIndexBytes(payload) !== payloadHash) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index payload checksum failed for ${state.fileName}`);
                    }
                    const recordFields = content.subarray(payloadEnd, recordFieldsEnd);
                    if (hashLookupIndexBytes(recordFields) !== recordFieldsHash) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index record fields checksum failed for ${state.fileName}`);
                    }
                    if (contentOffsetBase > Number.MAX_SAFE_INTEGER - MAX_CONTENT_OFFSET_DELTA) {
                        const recordFieldsView = new DataView(
                            recordFields.buffer,
                            recordFields.byteOffset,
                            recordFields.byteLength,
                        );
                        for (let row = 0; row < count; ++row) {
                            const contentOffsetDelta = recordFieldsView.getUint32(
                                row * LOOKUP_INDEX_RECORD_FIELDS_BYTES,
                                true,
                            );
                            if (
                                contentOffsetDelta !== U32_NULL &&
                                !Number.isSafeInteger(contentOffsetBase + contentOffsetDelta)
                            ) {
                                throw new PersistentLookupIndexError(
                                    'invalid',
                                    `Lookup index record offset is unsafe for ${state.fileName}`,
                                );
                            }
                        }
                    }
                    let lookupIndex;
                    try {
                        lookupIndex = parseChecksummedPersistedTermLookupIndex(payload);
                    } catch (error) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index payload is invalid for ${state.fileName}`, error);
                    }
                    if (
                        lookupIndex.expressionKeys.length !== count ||
                        lookupIndex.readingKeys.length !== count ||
                        lookupIndex.sequencePostingRows.length > count
                    ) {
                        throw new PersistentLookupIndexError('invalid', `Lookup index row counts are invalid for ${state.fileName}`);
                    }
                    recordChunks.push({
                        firstId,
                        count,
                        fileName: state.fileName,
                        fileHandle: state.fileHandle,
                        chunkOffset: recordChunkOffset,
                        dictionaryName,
                        contentDictName: state.sharedContentDictName ?? 'raw',
                        contentOffsetBase,
                        chunkHeaderHash,
                        recordFields,
                        lookupIndex,
                    });
                    actualRecordCount += count;
                    cursor = recordFieldsEnd;
                }
                if (cursor !== content.byteLength || actualRecordCount !== expectedRecordCount) {
                    throw new PersistentLookupIndexError('invalid', `Lookup index file length is invalid for ${state.fileName}`);
                }
            }
        } catch (error) {
            if (error instanceof PersistentLookupIndexError) {
                this._recordPersistentIndexFailure(dictionaryName, error.kind, error.message);
            } else {
                this._recordPersistentIndexFailure(
                    dictionaryName,
                    'transient',
                    error instanceof Error ? error.message : String(error),
                );
            }
            return false;
        }
        recordChunks.sort((a, b) => a.firstId - b.firstId);
        for (let i = 1; i < recordChunks.length; ++i) {
            if (recordChunks[i].firstId <= (recordChunks[i - 1].firstId + recordChunks[i - 1].count - 1)) {
                this._recordPersistentIndexFailure(dictionaryName, 'invalid', 'Lookup index record ranges overlap');
                return false;
            }
        }
        if (
            globalGeneration !== this._persistentLookupGeneration ||
            dictionaryGeneration !== this._getPersistentLookupGeneration(dictionaryName) ||
            this._importSessionActive ||
            states.some((state) => this._shardStateByFileName.get(state.fileName) !== state)
        ) {
            this._recordPersistentIndexFailure(dictionaryName, 'transient', 'Lookup index generation changed while loading');
            return false;
        }
        this._indexByDictionary.delete(dictionaryName);
        this._persistentRecordChunksByDictionary.set(dictionaryName, recordChunks);
        this._persistentIndexLoadedDictionaryNames.add(dictionaryName);
        this._persistentIndexFailureByDictionary.delete(dictionaryName);
        this._setDictionaryHealth(dictionaryName, 'available');
        return true;
    }

    /**
     * @param {string} dictionaryName
     * @param {'missing'|'invalid'|'transient'} kind
     * @param {string} message
     */
    _recordPersistentIndexFailure(dictionaryName, kind, message) {
        this._persistentIndexFailureByDictionary.set(dictionaryName, {kind, message});
        reportDiagnostics('term-record-persistent-index-load-failed', {dictionaryName, kind, message});
    }

    /**
     * @param {string} dictionaryName
     * @param {boolean} [allowDuringStorageMutation=false]
     * @returns {Promise<boolean>}
     */
    async _tryRepairPersistentDictionaryIndex(dictionaryName, allowDuringStorageMutation = false) {
        if (this._importSessionActive || (this._storageMutationActive && !allowDuringStorageMutation)) {
            return false;
        }
        const existing = this._persistentIndexRepairPromiseByDictionary.get(dictionaryName);
        if (typeof existing !== 'undefined') { return await existing; }
        const repair = this._repairPersistentDictionaryIndex(dictionaryName);
        this._persistentIndexRepairPromiseByDictionary.set(dictionaryName, repair);
        try {
            return await repair;
        } finally {
            if (this._persistentIndexRepairPromiseByDictionary.get(dictionaryName) === repair) {
                this._persistentIndexRepairPromiseByDictionary.delete(dictionaryName);
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<boolean>}
     */
    async _repairPersistentDictionaryIndex(dictionaryName) {
        if (this._recordsDirectoryHandle === null) {
            this._setDictionaryHealth(dictionaryName, 'temporarilyUnavailable', 'Term-record directory is unavailable');
            return false;
        }
        const states = this._getDictionaryShardStates(dictionaryName);
        if (states.length === 0) {
            this._setDictionaryHealth(dictionaryName, 'reimportRequired', 'Dictionary record data is missing');
            return false;
        }
        this._setDictionaryHealth(dictionaryName, 'repairing', null);
        const globalGeneration = this._persistentLookupGeneration;
        const generation = this._getPersistentLookupGeneration(dictionaryName);
        const startedAt = safePerformance.now();
        let recordCount = 0;
        let indexBytes = 0;
        try {
            for (const state of states) {
                if (
                    globalGeneration !== this._persistentLookupGeneration ||
                    generation !== this._getPersistentLookupGeneration(dictionaryName) ||
                    this._importSessionActive ||
                    this._shardStateByFileName.get(state.fileName) !== state
                ) {
                    this._recordPersistentIndexFailure(dictionaryName, 'transient', 'Lookup index generation changed during repair');
                    this._setDictionaryHealth(dictionaryName, 'temporarilyUnavailable', 'Dictionary repair was superseded by a storage update');
                    return false;
                }
                const result = await this._rebuildLookupIndexForShard(state);
                recordCount += result.recordCount;
                indexBytes += result.indexBytes;
            }
            if (
                globalGeneration !== this._persistentLookupGeneration ||
                generation !== this._getPersistentLookupGeneration(dictionaryName) ||
                this._importSessionActive ||
                states.some((state) => this._shardStateByFileName.get(state.fileName) !== state)
            ) {
                this._recordPersistentIndexFailure(dictionaryName, 'transient', 'Lookup index generation changed during repair');
                this._setDictionaryHealth(dictionaryName, 'temporarilyUnavailable', 'Dictionary repair was superseded by a storage update');
                return false;
            }
            this._invalidatePersistentLookupState(dictionaryName);
            reportDiagnostics('term-record-persistent-index-repair-complete', {
                dictionaryName,
                shardCount: states.length,
                recordCount,
                indexBytes,
                elapsedMs: safePerformance.now() - startedAt,
            });
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const integrityFailure = error instanceof TermRecordIntegrityError;
            if (integrityFailure) {
                this.markDictionaryReimportRequired(dictionaryName, 'Dictionary record data is damaged');
            } else {
                this._setDictionaryHealth(
                    dictionaryName,
                    'temporarilyUnavailable',
                    'Dictionary repair could not access browser storage',
                );
            }
            reportDiagnostics('term-record-persistent-index-repair-failed', {
                dictionaryName,
                shardCount: states.length,
                elapsedMs: safePerformance.now() - startedAt,
                integrityFailure,
                error: message,
            });
            return false;
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<{recordCount: number, indexBytes: number}>}
     */
    async _rebuildLookupIndexForShard(state) {
        if (this._recordsDirectoryHandle === null) {
            throw new Error('Term-record directory is unavailable');
        }
        let file;
        try {
            file = await state.fileHandle.getFile();
        } catch (error) {
            if (isStorageEntryNotFoundError(error)) {
                throw new TermRecordIntegrityError(`Term-record shard no longer exists: ${state.fileName}`);
            }
            throw error;
        }
        state.fileLength = file.size;
        if (file.size < (BINARY_HEADER_PREFIX_BYTES + 2)) {
            throw new TermRecordIntegrityError(`Term-record shard is truncated: ${state.fileName}`);
        }
        const initialHeaderLength = Math.min(file.size, BINARY_HEADER_PREFIX_BYTES + 2 + 4);
        const initialHeader = await this._readFileRange(file, 0, initialHeaderLength);
        if (!this._isBinaryFormat(initialHeader)) {
            throw new TermRecordIntegrityError(`Term-record shard header is invalid: ${state.fileName}`);
        }
        const initialView = new DataView(initialHeader.buffer, initialHeader.byteOffset, initialHeader.byteLength);
        const generationId = new Uint8Array(initialHeader.subarray(BINARY_MAGIC_BYTES, BINARY_HEADER_PREFIX_BYTES));
        state.generationId = generationId;
        let cursor = BINARY_HEADER_PREFIX_BYTES;
        const meta16 = initialView.getUint16(cursor, true); cursor += 2;
        let meta = meta16;
        if (meta16 === U16_NULL) {
            if ((cursor + 4) > initialHeader.byteLength) {
                throw new TermRecordIntegrityError(`Term-record shard metadata is truncated: ${state.fileName}`);
            }
            meta = initialView.getUint32(cursor, true); cursor += 4;
        }
        const customNameLength = (meta & 0xff) === ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM ? (meta >>> 8) : 0;
        cursor += customNameLength;
        if (cursor > file.size) {
            throw new TermRecordIntegrityError(`Term-record shard dictionary metadata is truncated: ${state.fileName}`);
        }

        const indexFileName = `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`;
        const indexFileHandle = await this._recordsDirectoryHandle.getFileHandle(indexFileName, {create: true});
        const writable = await indexFileHandle.createWritable();
        let chunkCount = 0;
        let recordCount = 0;
        let indexBytes = LOOKUP_INDEX_FILE_HEADER_BYTES;
        let yieldDeadline = safePerformance.now() + REPAIR_YIELD_BUDGET_MS;
        try {
            await writable.truncate(0);
            await writable.seek(0);
            await writable.write(new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES));
            while (cursor < file.size) {
                const chunkOffset = cursor;
                const prefixEnd = cursor + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES;
                if (prefixEnd > file.size) {
                    throw new TermRecordIntegrityError(`Term-record chunk header is truncated: ${state.fileName}`);
                }
                const prefix = await this._readFileRange(file, cursor, prefixEnd);
                const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
                const firstId = view.getUint32(0, true);
                const count = view.getUint32(4, true);
                let contentOffsetBase;
                try {
                    contentOffsetBase = readSafeU64Le(view, 8);
                } catch (error) {
                    throw new TermRecordIntegrityError(`Term-record chunk content offset is invalid: ${state.fileName}: ${String(error)}`);
                }
                const expectedPayloadHash = view.getUint32(16, true);
                const stringCount = view.getUint32(CHUNK_HEADER_BYTES, true);
                const stringBytesLength = view.getUint32(CHUNK_HEADER_BYTES + 4, true);
                const lastId = firstId + count - 1;
                if (
                    firstId <= 0 ||
                    count === 0 ||
                    lastId > 0xffffffff ||
                    stringCount === 0 ||
                    stringCount > (count * 2)
                ) {
                    throw new TermRecordIntegrityError(`Term-record chunk metadata is invalid: ${state.fileName}`);
                }
                const payloadLength = STRING_TABLE_HEADER_BYTES + (stringCount * 2) + stringBytesLength + (count * RECORD_HEADER_BYTES);
                const payloadStart = cursor + CHUNK_HEADER_BYTES;
                const payloadEnd = payloadStart + payloadLength;
                if (
                    !Number.isSafeInteger(payloadEnd) ||
                    payloadLength > MAX_REPAIR_CHUNK_PAYLOAD_BYTES ||
                    payloadEnd > file.size
                ) {
                    throw new TermRecordIntegrityError(`Term-record chunk payload is truncated: ${state.fileName}`);
                }
                const payload = await this._readFileRange(file, payloadStart, payloadEnd);
                if (hashLookupIndexBytes(payload) !== expectedPayloadHash) {
                    throw new TermRecordIntegrityError(`Term-record chunk payload checksum failed: ${state.fileName}`);
                }
                let lookupPayload;
                try {
                    lookupPayload = encodePersistedTermLookupIndexFromRecordPayload(payload, count);
                } catch (error) {
                    if (error instanceof RangeError) { throw error; }
                    throw new TermRecordIntegrityError(`Term-record chunk payload is invalid: ${state.fileName}: ${String(error)}`);
                }
                const indexChunk = this._createLookupIndexChunk(
                    firstId,
                    count,
                    chunkOffset,
                    contentOffsetBase,
                    lookupPayload,
                    payload,
                );
                await writable.write(indexChunk);
                ++chunkCount;
                recordCount += count;
                indexBytes += indexChunk.byteLength;
                cursor = payloadEnd;
                if (safePerformance.now() >= yieldDeadline) {
                    await new Promise((resolve) => { setTimeout(resolve, 0); });
                    yieldDeadline = safePerformance.now() + REPAIR_YIELD_BUDGET_MS;
                }
            }
            if (chunkCount === 0 || recordCount === 0 || cursor !== file.size) {
                throw new TermRecordIntegrityError(`Term-record shard contains no complete records: ${state.fileName}`);
            }
            const header = new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES);
            header.set(this._textEncoder.encode(LOOKUP_INDEX_MAGIC_TEXT), 0);
            const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
            writeSafeU64Le(headerView, 8, file.size);
            headerView.setUint32(16, chunkCount, true);
            headerView.setUint32(20, recordCount, true);
            header.set(generationId, 24);
            await writable.seek(0);
            await writable.write(header);
            await writable.close();
        } catch (error) {
            const abort = Reflect.get(writable, 'abort');
            if (typeof abort === 'function') {
                try {
                    await /** @type {() => Promise<void>} */ (abort).call(writable);
                } catch (_) {
                    // Preserve the original repair failure.
                }
            }
            if (error instanceof TermRecordIntegrityError) {
                await this._discardInvalidShardState(state);
            }
            throw error;
        }
        return {recordCount, indexBytes};
    }

    /**
     * @param {string} dictionaryName
     * @returns {TermRecordShardState[]}
     */
    _getDictionaryShardStates(dictionaryName) {
        return [...this._shardStateByFileName.values()]
            .filter((state) => this._decodeDictionaryNameFromShardFileName(state.fileName) === dictionaryName)
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
    }

    /**
     * @param {string} dictionaryName
     * @returns {boolean}
     */
    _canMaterializeDictionaryFallback(dictionaryName) {
        const states = this._getDictionaryShardStates(dictionaryName);
        return states.length > 0 && states.reduce((sum, state) => sum + state.fileLength, 0) <= SMALL_SHARD_FALLBACK_MAX_BYTES;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} query
     * @param {'expression'|'reading'} field
     * @returns {number[]}
     */
    findTermIds(dictionaryName, query, field) {
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            const queryBytes = this._textEncoder.encode(query);
            const queryHash = hashTermLookupKeyBytes(queryBytes);
            const ids = [];
            for (const chunk of chunks) {
                for (const row of findExactRows(chunk.lookupIndex, queryBytes, field, queryHash)) {
                    ids.push(chunk.firstId + row);
                }
            }
            return ids;
        }
        return [...(this.getDictionaryIndex(dictionaryName)[field].get(query) ?? [])];
    }

    /**
     * Resolves expression and reading postings together so persistent chunks only
     * hash and probe the query once.
     * @param {string} dictionaryName
     * @param {string} query
     * @returns {{expression: number[], reading: number[]}}
     */
    findTermIdMatches(dictionaryName, query) {
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            const queryBytes = this._textEncoder.encode(query);
            const queryHash = hashTermLookupKeyBytes(queryBytes);
            /** @type {number[]} */
            const expression = [];
            /** @type {number[]} */
            const reading = [];
            for (const chunk of chunks) {
                appendExactRowMatches(
                    chunk.lookupIndex,
                    queryBytes,
                    expression,
                    reading,
                    chunk.firstId,
                    queryHash,
                );
            }
            return {expression, reading};
        }
        const index = this.getDictionaryIndex(dictionaryName);
        return {
            expression: [...(index.expression.get(query) ?? [])],
            reading: [...(index.reading.get(query) ?? [])],
        };
    }

    /**
     * Resolves the same query across dictionaries while sharing UTF-8 encoding
     * and hashing, which are otherwise repeated for every enabled dictionary.
     * @param {string[]} dictionaryNames
     * @param {string} query
     * @returns {Array<{expression: number[], reading: number[]}>}
     */
    findTermIdMatchesForDictionaries(dictionaryNames, query) {
        /** @type {Uint8Array|null} */
        let queryBytes = null;
        let queryHash = 0;
        return dictionaryNames.map((dictionaryName) => {
            const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
            if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
                if (queryBytes === null) {
                    queryBytes = this._textEncoder.encode(query);
                    queryHash = hashTermLookupKeyBytes(queryBytes);
                }
                /** @type {number[]} */
                const expression = [];
                /** @type {number[]} */
                const reading = [];
                for (const chunk of chunks) {
                    appendExactRowMatches(
                        chunk.lookupIndex,
                        queryBytes,
                        expression,
                        reading,
                        chunk.firstId,
                        queryHash,
                    );
                }
                return {expression, reading};
            }
            const index = this.getDictionaryIndex(dictionaryName);
            return {
                expression: [...(index.expression.get(query) ?? [])],
                reading: [...(index.reading.get(query) ?? [])],
            };
        });
    }

    /**
     * @param {Iterable<string>} dictionaryNames
     * @returns {Promise<void>}
     */
    async warmPrefixIndexes(dictionaryNames) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        let yieldDeadline = safePerformance.now() + PREFIX_WARM_YIELD_BUDGET_MS;
        for (const dictionaryName of dictionaryNames) {
            const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
            if (!this._persistentIndexLoadedDictionaryNames.has(dictionaryName) || typeof chunks === 'undefined') {
                continue;
            }
            for (const chunk of chunks) {
                warmPersistedTermPrefixIndex(chunk.lookupIndex);
                if (safePerformance.now() < yieldDeadline) { continue; }
                await new Promise((resolve) => { setTimeout(resolve, 0); });
                yieldDeadline = safePerformance.now() + PREFIX_WARM_YIELD_BUDGET_MS;
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @param {string} query
     * @param {'expression'|'reading'} field
     * @param {boolean} [reverse=false]
     * @returns {Array<{id: number, exact: boolean}>}
     */
    findTermPrefixIdMatches(dictionaryName, query, field, reverse = false) {
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            const queryBytes = this._textEncoder.encode(query);
            const matches = [];
            for (const chunk of chunks) {
                for (const {row, exact} of findPrefixRows(chunk.lookupIndex, queryBytes, field, reverse)) {
                    matches.push({id: chunk.firstId + row, exact});
                }
            }
            return matches;
        }
        const index = this.getDictionaryIndex(dictionaryName);
        const lookup = index[field];
        const matches = [];
        for (const [key, ids] of lookup) {
            const matched = reverse ? key.endsWith(query) : key.startsWith(query);
            if (!matched) { continue; }
            for (const id of ids) { matches.push({id, exact: key === query}); }
        }
        return matches;
    }

    /**
     * Resolves both prefix fields across dictionaries while sharing UTF-8
     * encoding and each persisted key-range scan.
     * @param {string[]} dictionaryNames
     * @param {string} query
     * @param {boolean} [reverse=false]
     * @returns {Array<{expression: Array<{id: number, exact: boolean}>, reading: Array<{id: number, exact: boolean}>}>}
     */
    findTermPrefixIdMatchesForDictionaries(dictionaryNames, query, reverse = false) {
        /** @type {Uint8Array|null} */
        let queryBytes = null;
        return dictionaryNames.map((dictionaryName) => {
            const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
            if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
                queryBytes ??= this._textEncoder.encode(query);
                const expression = [];
                const reading = [];
                for (const chunk of chunks) {
                    const matches = findPrefixRowMatches(chunk.lookupIndex, queryBytes, reverse);
                    for (const {row, exact} of matches.expression) {
                        expression.push({id: chunk.firstId + row, exact});
                    }
                    for (const {row, exact} of matches.reading) {
                        reading.push({id: chunk.firstId + row, exact});
                    }
                }
                return {expression, reading};
            }
            return {
                expression: this.findTermPrefixIdMatches(dictionaryName, query, 'expression', reverse),
                reading: this.findTermPrefixIdMatches(dictionaryName, query, 'reading', reverse),
            };
        });
    }

    /**
     * @param {string} dictionaryName
     * @param {number} sequence
     * @returns {number[]}
     */
    findTermIdsBySequence(dictionaryName, sequence) {
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            const ids = [];
            for (const chunk of chunks) {
                for (const row of findSequenceRows(chunk.lookupIndex, sequence)) {
                    ids.push(chunk.firstId + row);
                }
            }
            return ids;
        }
        return [...(this.getDictionaryIndex(dictionaryName).sequence.get(sequence) ?? [])];
    }

    /**
     * @param {string} dictionaryName
     * @returns {boolean}
     */
    hasPersistentTermLookupIndex(dictionaryName) {
        return (
            this._persistentIndexLoadedDictionaryNames.has(dictionaryName) &&
            this._persistentRecordChunksByDictionary.has(dictionaryName)
        );
    }

    /**
     * @param {string} dictionaryName
     * @returns {boolean}
     */
    _hasCompleteDictionaryLookupState(dictionaryName) {
        if (this.hasPersistentTermLookupIndex(dictionaryName)) { return true; }
        return (
            this._allShardContentsLoaded &&
            this._loadedDictionaryNames.has(dictionaryName) &&
            (!this._importSessionActive || !this._importSessionDictionaryNames.has(dictionaryName)) &&
            this._hasRecordsForDictionary(dictionaryName)
        );
    }

    /**
     * @param {string} dictionaryName
     * @returns {number}
     */
    getDictionaryRecordCount(dictionaryName) {
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            let count = 0;
            for (const chunk of chunks) { count += chunk.count; }
            return count;
        }
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName);
        if (typeof ids !== 'undefined') { return ids.length; }
        let count = 0;
        for (const record of this._recordsById.values()) {
            if (record.dictionary === dictionaryName) { ++count; }
        }
        return count;
    }

    /**
     * @param {string} dictionaryName
     * @param {number} limit
     * @returns {number[]}
     */
    getDictionarySampleIds(dictionaryName, limit) {
        if (!Number.isInteger(limit) || limit <= 0) { return []; }
        const chunks = this._persistentRecordChunksByDictionary.get(dictionaryName);
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName) && typeof chunks !== 'undefined') {
            const ids = [];
            for (const chunk of chunks) {
                const count = Math.min(chunk.count, limit - ids.length);
                for (let i = 0; i < count; ++i) { ids.push(chunk.firstId + i); }
                if (ids.length >= limit) { break; }
            }
            return ids;
        }
        const liveIds = this._getLiveRecordIdsForDictionary(dictionaryName);
        if (typeof liveIds !== 'undefined') { return liveIds.slice(0, limit); }
        const ids = [];
        for (const record of this._recordsById.values()) {
            if (record.dictionary !== dictionaryName) { continue; }
            ids.push(record.id);
            if (ids.length >= limit) { break; }
        }
        return ids;
    }

    /**
     * @param {Iterable<string>} dictionaryNames
     * @returns {Promise<void>}
     */
    async ensureDictionariesLoaded(dictionaryNames) {
        if (this._recordsDirectoryHandle === null) {
            for (const value of dictionaryNames) {
                const dictionaryName = `${value}`.trim();
                if (
                    dictionaryName.length > 0 &&
                    this.getDictionaryHealth(dictionaryName).status !== 'reimportRequired'
                ) {
                    this._setDictionaryHealth(
                        dictionaryName,
                        'temporarilyUnavailable',
                        'Term-record directory is unavailable',
                    );
                }
            }
            return;
        }
        /** @type {Set<string>} */
        const pending = new Set();
        for (const dictionaryName of dictionaryNames) {
            const name = `${dictionaryName}`.trim();
            const healthStatus = this.getDictionaryHealth(name).status;
            if (
                name.length === 0 ||
                healthStatus === 'reimportRequired' ||
                (healthStatus === 'available' && this._hasCompleteDictionaryLookupState(name))
            ) {
                continue;
            }
            pending.add(name);
        }
        if (pending.size === 0) {
            return;
        }
        const persistentIndexNames = [...pending];
        /** @type {string[]} */
        const persistentIndexLoadedNames = [];
        let nextPersistentIndex = 0;
        const loadNextPersistentIndex = async () => {
            while (true) {
                const index = nextPersistentIndex++;
                if (index >= persistentIndexNames.length) { return; }
                const dictionaryName = persistentIndexNames[index];
                if (await this._tryLoadPersistentDictionaryIndex(dictionaryName)) {
                    persistentIndexLoadedNames.push(dictionaryName);
                }
            }
        };
        const persistentIndexLoadConcurrency = Math.min(3, persistentIndexNames.length);
        await Promise.all(
            Array.from({length: persistentIndexLoadConcurrency}, () => loadNextPersistentIndex()),
        );
        for (const dictionaryName of persistentIndexLoadedNames) {
            if (pending.delete(dictionaryName)) {
                this._loadedDictionaryNames.add(dictionaryName);
            }
        }
        if (pending.size === 0) { return; }

        // Sidecars are derived data. Repair them from bounded record chunks before
        // considering materialization, and serialize repairs to cap CPU and memory.
        for (const dictionaryName of pending) {
            const failure = this._persistentIndexFailureByDictionary.get(dictionaryName);
            if (failure?.kind === 'transient') {
                this._setDictionaryHealth(
                    dictionaryName,
                    'temporarilyUnavailable',
                    failure.message || 'Dictionary lookup data is temporarily unavailable',
                );
                pending.delete(dictionaryName);
                continue;
            }
            if (!await this._tryRepairPersistentDictionaryIndex(dictionaryName)) { continue; }
            if (await this._tryLoadPersistentDictionaryIndex(dictionaryName)) {
                pending.delete(dictionaryName);
                this._loadedDictionaryNames.add(dictionaryName);
            }
        }
        if (pending.size === 0) { return; }

        for (const dictionaryName of pending) {
            if (this.getDictionaryHealth(dictionaryName).status === 'reimportRequired') {
                continue;
            }
            if (!this._canMaterializeDictionaryFallback(dictionaryName)) {
                if (this.getDictionaryHealth(dictionaryName).status !== 'reimportRequired') {
                    this._setDictionaryHealth(dictionaryName, 'temporarilyUnavailable', 'Dictionary lookup data is unavailable');
                }
                continue;
            }
            const states = this._getDictionaryShardStates(dictionaryName);
            const results = await Promise.all(states.map((state) => this._loadShardStateContents(state)));
            if (results.every(Boolean)) {
                this._loadedDictionaryNames.add(dictionaryName);
                this._setDictionaryHealth(
                    dictionaryName,
                    'repairPending',
                    'Lookup index repair is pending; materialized lookup remains available',
                );
            } else {
                this._discardMaterializedDictionary(dictionaryName);
                if (this.getDictionaryHealth(dictionaryName).status !== 'reimportRequired') {
                    this._setDictionaryHealth(dictionaryName, 'temporarilyUnavailable', 'Dictionary record data could not be loaded');
                }
            }
        }
    }

    /**
     * @param {string} dictionaryName
     */
    _discardMaterializedDictionary(dictionaryName) {
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName) ?? this._recordsById.keys();
        for (const id of ids) {
            const record = this._recordsById.get(id);
            if (record?.dictionary === dictionaryName) {
                this._deleteRecord(id);
            }
        }
        this._recordIdsByDictionary.delete(dictionaryName);
        this._recordIdStaleDictionaryNames.delete(dictionaryName);
        this._indexByDictionary.delete(dictionaryName);
        this._loadedDictionaryNames.delete(dictionaryName);
    }

    /** @returns {Promise<void>} */
    async ensureAllDictionariesLoaded() {
        if (this._allShardContentsLoaded || this._recordsDirectoryHandle === null) {
            return;
        }
        const statesToLoad = [...this._shardStateByFileName.values()]
            .filter((state) => {
                const dictionaryName = this._decodeDictionaryNameFromShardFileName(state.fileName);
                return (
                    dictionaryName === null ||
                    !this._loadedDictionaryNames.has(dictionaryName) ||
                    this._persistentIndexLoadedDictionaryNames.has(dictionaryName)
                );
            })
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        const deferIndexBuild = this._deferIndexBuild;
        this._deferIndexBuild = true;
        try {
            await this._loadShardStatesContents(statesToLoad);
        } finally {
            this._deferIndexBuild = deferIndexBuild;
        }
        for (const state of this._shardStateByFileName.values()) {
            const dictionaryName = this._decodeDictionaryNameFromShardFileName(state.fileName);
            if (dictionaryName !== null && dictionaryName.length > 0 && this.isDictionaryAvailable(dictionaryName)) {
                this._loadedDictionaryNames.add(dictionaryName);
            }
        }
        this._invalidateAllPersistentLookupState();
        this._rebuildIndexesFromRecords();
        this._allShardContentsLoaded = true;
        this._nextIdMayNeedShardScan = false;
    }

    /**
     * @param {string[]|null} [expectedDictionaryNames]
     * @returns {Promise<{
     *   expectedShardCount: number,
     *   actualShardCount: number,
     *   missingShardCount: number,
     *   missingShardFileNames: string[],
     *   missingDictionaryNames: string[],
     *   orphanShardCount: number,
     *   orphanShardFileNames: string[],
     *   orphanDictionaryNames: string[],
     *   removedOrphanShardCount: number,
     *   invalidShardPayloadCount: number,
     *   invalidShardFileNames: string[],
     *   rewroteAllShardsFromMemory: boolean
     * }>}
     */
    async verifyIntegrity(expectedDictionaryNames = null) {
        if (!this._allShardContentsLoaded && this._recordsById.size === 0) {
            /** @type {Set<string>|null} */
            const expectedNames = Array.isArray(expectedDictionaryNames) ?
                new Set(expectedDictionaryNames.filter((name) => typeof name === 'string' && name.length > 0)) :
                null;
            /** @type {Set<string>} */
            const actualNames = new Set();
            /** @type {Map<string, string[]>} */
            const actualFileNamesByDictionary = new Map();
            for (const fileName of this._shardStateByFileName.keys()) {
                const dictionaryName = this._decodeDictionaryNameFromShardFileName(fileName);
                if (dictionaryName === null) { continue; }
                actualNames.add(dictionaryName);
                const fileNames = actualFileNamesByDictionary.get(dictionaryName);
                if (typeof fileNames === 'undefined') {
                    actualFileNamesByDictionary.set(dictionaryName, [fileName]);
                } else {
                    fileNames.push(fileName);
                }
            }
            /** @type {string[]} */
            let missingDictionaryNames = [];
            /** @type {string[]} */
            let orphanDictionaryNames = [];
            if (expectedNames !== null) {
                missingDictionaryNames = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
                orphanDictionaryNames = [...actualNames].filter((name) => !expectedNames.has(name)).sort();
            }
            const orphanShardFileNames = orphanDictionaryNames
                .flatMap((name) => actualFileNamesByDictionary.get(name) ?? [])
                .sort();
            let removedOrphanShardCount = 0;
            for (const fileName of orphanShardFileNames) {
                try {
                    await this._removeStorageFileOrTruncate(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
                    await this._removeStorageFileOrTruncate(fileName, true);
                } catch (error) {
                    reportDiagnostics('term-record-orphan-shard-cleanup-failed', {
                        fileName,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }
                const state = this._shardStateByFileName.get(fileName);
                if (typeof state !== 'undefined') {
                    this._activeAppendShardStateByKey.delete(state.logicalKey);
                }
                this._shardStateByFileName.delete(fileName);
                ++removedOrphanShardCount;
            }
            const summary = {
                expectedShardCount: expectedNames?.size ?? 0,
                actualShardCount: this._shardStateByFileName.size,
                missingShardCount: missingDictionaryNames.length,
                missingShardFileNames: missingDictionaryNames.map((name) => this._getShardFileName(name)),
                missingDictionaryNames,
                orphanShardCount: orphanShardFileNames.length,
                orphanShardFileNames,
                orphanDictionaryNames,
                removedOrphanShardCount,
                invalidShardPayloadCount: this._invalidShardFileNames.length,
                invalidShardFileNames: [...this._invalidShardFileNames].sort(),
                rewroteAllShardsFromMemory: false,
            };
            reportDiagnostics('term-record-shard-integrity-summary', summary);
            return summary;
        }
        /** @type {Set<string>} */
        const expectedShardKeys = new Set();
        /** @type {Set<string>} */
        const expectedShardKeysFromRecords = new Set();
        for (const record of this._recordsById.values()) {
            const shardKey = this._getShardFileName(record.dictionary, record.entryContentDictName);
            expectedShardKeys.add(shardKey);
            expectedShardKeysFromRecords.add(shardKey);
        }
        if (Array.isArray(expectedDictionaryNames)) {
            for (const dictionaryName of expectedDictionaryNames) {
                if (typeof dictionaryName !== 'string' || dictionaryName.length === 0) { continue; }
                expectedShardKeys.add(this._getShardFileName(dictionaryName));
            }
        }

        /** @type {Map<string, string[]>} */
        const actualFilesByShardKey = new Map();
        for (const fileName of this._shardStateByFileName.keys()) {
            const shardInfo = this._decodeShardInfoFromShardFileName(fileName);
            if (shardInfo === null) { continue; }
            const shardKey = this._getShardFileName(shardInfo.dictionaryName, shardInfo.contentDictName);
            const existing = actualFilesByShardKey.get(shardKey);
            if (typeof existing === 'undefined') {
                actualFilesByShardKey.set(shardKey, [fileName]);
            } else {
                existing.push(fileName);
            }
        }

        /** @type {string[]} */
        const missingShardFileNames = [];
        /** @type {string[]} */
        const orphanShardFileNames = [];
        for (const shardKey of expectedShardKeys) {
            if (!actualFilesByShardKey.has(shardKey)) {
                missingShardFileNames.push(shardKey);
            }
        }
        for (const [shardKey, fileNames] of actualFilesByShardKey) {
            if (!expectedShardKeys.has(shardKey)) {
                orphanShardFileNames.push(...fileNames);
            }
        }

        let removedOrphanShardCount = 0;
        for (const fileName of orphanShardFileNames) {
            try {
                // Remove the derived index first. If record removal then fails,
                // the authoritative shard remains registered and its index can
                // be rebuilt; the reverse order can leave hidden stale data.
                await this._removeStorageFileOrTruncate(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
                await this._removeStorageFileOrTruncate(fileName, true);
            } catch (error) {
                reportDiagnostics('term-record-orphan-shard-cleanup-failed', {
                    fileName,
                    error: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            this._shardStateByFileName.delete(fileName);
            ++removedOrphanShardCount;
        }

        let rewroteAllShardsFromMemory = false;
        let shouldRewriteFromMemory = false;
        for (const fileName of missingShardFileNames) {
            if (expectedShardKeysFromRecords.has(fileName)) {
                shouldRewriteFromMemory = true;
                break;
            }
        }
        if (shouldRewriteFromMemory) {
            await this._rewriteAllShardsFromMemory();
            rewroteAllShardsFromMemory = true;
        }

        const missingDictionaryNames = missingShardFileNames
            .map((fileName) => this._decodeDictionaryNameFromShardFileName(fileName))
            .filter((value) => typeof value === 'string');
        const orphanDictionaryNames = orphanShardFileNames
            .map((fileName) => this._decodeDictionaryNameFromShardFileName(fileName))
            .filter((value) => typeof value === 'string');

        const summary = {
            expectedShardCount: expectedShardKeys.size,
            actualShardCount: this._shardStateByFileName.size,
            missingShardCount: missingShardFileNames.length,
            missingShardFileNames: [...missingShardFileNames].sort(),
            missingDictionaryNames: [...new Set(missingDictionaryNames)].sort(),
            orphanShardCount: orphanShardFileNames.length,
            orphanShardFileNames: [...orphanShardFileNames].sort(),
            orphanDictionaryNames: [...new Set(orphanDictionaryNames)].sort(),
            removedOrphanShardCount,
            invalidShardPayloadCount: this._invalidShardFileNames.length,
            invalidShardFileNames: [...this._invalidShardFileNames].sort(),
            rewroteAllShardsFromMemory,
        };
        reportDiagnostics('term-record-shard-integrity-summary', summary);
        return summary;
    }

    /**
     * @param {Uint8Array} content
     * @returns {boolean}
     */
    _isBinaryFormat(content) {
        if (content.byteLength < BINARY_HEADER_PREFIX_BYTES) {
            return false;
        }
        const magic = this._textDecoder.decode(content.subarray(0, BINARY_MAGIC_BYTES));
        return magic === BINARY_MAGIC_TEXT;
    }

    /**
     * @param {Uint8Array} content
     * @param {string|null} shardDictionaryName
     * @returns {boolean}
     */
    _loadBinary(content, shardDictionaryName = null) {
        if (content.byteLength < BINARY_HEADER_PREFIX_BYTES || shardDictionaryName === null) {
            return false;
        }
        const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
        const magic = this._textDecoder.decode(content.subarray(0, BINARY_MAGIC_BYTES));
        if (magic !== BINARY_MAGIC_TEXT) {
            return false;
        }
        let cursor = BINARY_HEADER_PREFIX_BYTES;
        /** @type {TermRecord[]} */
        const parsedRecords = [];
        if ((cursor + 2) > content.byteLength) { return false; }
        const entryContentDictNameMeta16 = view.getUint16(cursor, true); cursor += 2;
        let entryContentDictNameMeta = entryContentDictNameMeta16;
        if (entryContentDictNameMeta16 === U16_NULL) {
            if ((cursor + 4) > content.byteLength) { return false; }
            entryContentDictNameMeta = view.getUint32(cursor, true); cursor += 4;
        }
        const entryContentDictNameLength = (entryContentDictNameMeta & 0xff) === ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM ?
            (entryContentDictNameMeta >>> 8) :
            0;
        if ((cursor + entryContentDictNameLength) > content.byteLength) { return false; }
        const sharedEntryContentDictName = this._decodeEntryContentDictName(
            entryContentDictNameMeta,
            content,
            cursor,
            entryContentDictNameLength,
        );
        cursor += entryContentDictNameLength;
        while (true) {
            if ((cursor + CHUNK_HEADER_BYTES) > content.byteLength) { break; }
            const chunkBaseId = view.getUint32(cursor, true); cursor += 4;
            const chunkCount = view.getUint32(cursor, true); cursor += 4;
            if (chunkBaseId <= 0 || chunkCount === 0) { break; }
            let chunkContentOffsetBase;
            try {
                chunkContentOffsetBase = readSafeU64Le(view, cursor);
            } catch (_) {
                return false;
            }
            cursor += 8;
            const expectedPayloadHash = view.getUint32(cursor, true); cursor += 4;
            const payloadStart = cursor;
            if ((cursor + STRING_TABLE_HEADER_BYTES) > content.byteLength) { return false; }
            const stringCount = view.getUint32(cursor, true); cursor += 4;
            const stringBytesLength = view.getUint32(cursor, true); cursor += 4;
            const stringLengthsBytes = stringCount * 2;
            if ((cursor + stringLengthsBytes + stringBytesLength) > content.byteLength) { return false; }
            /** @type {string[]} */
            const chunkStrings = new Array(stringCount);
            let stringsCursor = cursor + stringLengthsBytes;
            for (let i = 0; i < stringCount; ++i) {
                const stringLength = view.getUint16(cursor, true); cursor += 2;
                if ((stringsCursor + stringLength) > content.byteLength) { return false; }
                const value = this._decodeString(content, stringsCursor, stringLength);
                stringsCursor += stringLength;
                chunkStrings[i] = value;
            }
            cursor = stringsCursor;
            for (let chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex) {
                if ((cursor + RECORD_HEADER_BYTES) > content.byteLength) { return false; }
                const id = chunkBaseId + chunkIndex;
                const expressionIndex = view.getUint32(cursor, true); cursor += 4;
                const readingIndexRaw = view.getUint32(cursor, true); cursor += 4;
                const readingEqualsExpression = readingIndexRaw === READING_EQUALS_EXPRESSION_U32;
                const rawEntryContentOffset = view.getUint32(cursor, true); cursor += 4;
                const rawEntryContentLength = view.getUint32(cursor, true); cursor += 4;
                const score = view.getInt32(cursor, true); cursor += 4;
                const rawSequence = view.getInt32(cursor, true); cursor += 4;
                const expression = expressionIndex < chunkStrings.length ? chunkStrings[expressionIndex] : '';
                if (expression.length === 0) { return false; }
                const reading = readingEqualsExpression ?
                    expression :
                    (readingIndexRaw < chunkStrings.length ? chunkStrings[readingIndexRaw] : '');
                const entryContentOffset = rawEntryContentOffset === U32_NULL ?
                    -1 :
                    chunkContentOffsetBase + rawEntryContentOffset;
                if (entryContentOffset >= 0 && !Number.isSafeInteger(entryContentOffset)) { return false; }

                const record = {
                    id,
                    dictionary: shardDictionaryName,
                    expression,
                    reading,
                    expressionReverse: null,
                    readingReverse: null,
                    entryContentOffset,
                    entryContentLength: rawEntryContentLength === U32_NULL ? -1 : rawEntryContentLength,
                    entryContentDictName: sharedEntryContentDictName,
                    score,
                    sequence: rawSequence >= 0 ? rawSequence : null,
                };
                parsedRecords.push(record);
            }
            if (hashLookupIndexBytes(content.subarray(payloadStart, cursor)) !== expectedPayloadHash) {
                return false;
            }
        }
        if (cursor !== content.byteLength) { return false; }
        const sharedDictionaryRecordIds = this._getOrCreateRecordIdsForDictionary(shardDictionaryName);
        const sharedDictionaryIndex = !this._deferIndexBuild ?
            this._getOrCreateDictionaryIndex(shardDictionaryName) :
            null;
        for (const record of parsedRecords) {
            const indexRecord = this._storeRecordWithKnownDictionaryIds(record, sharedDictionaryRecordIds);
            if (indexRecord && sharedDictionaryIndex !== null) {
                this._addDecodedRecordToDictionaryIndex(
                    sharedDictionaryIndex,
                    record,
                    record.expression ?? '',
                    record.reading ?? record.expression ?? '',
                );
            }
            if (record.id >= this._nextId) {
                this._nextId = record.id + 1;
            }
        }
        return true;
    }

    /**
     * @param {number} meta
     * @param {Uint8Array} content
     * @param {number} offset
     * @param {number} customLength
     * @returns {string}
     */
    _decodeEntryContentDictName(meta, content, offset, customLength) {
        switch (meta & 0xff) {
            case ENTRY_CONTENT_DICT_NAME_CODE_RAW:
                return 'raw';
            case ENTRY_CONTENT_DICT_NAME_CODE_RAW_V2:
                return RAW_TERM_CONTENT_DICT_NAME;
            case ENTRY_CONTENT_DICT_NAME_CODE_RAW_V3:
                return RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME;
            case ENTRY_CONTENT_DICT_NAME_CODE_RAW_V4:
                return RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME;
            case ENTRY_CONTENT_DICT_NAME_CODE_JMDICT:
                return 'jmdict';
            case ENTRY_CONTENT_DICT_NAME_CODE_RAW_V6:
                return RAW_TERM_CONTENT_TOKEN_DICT_NAME;
            case ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM:
                return this._decodeString(content, offset, customLength);
            default:
                return 'raw';
        }
    }

    /**
     * @param {string} value
     * @returns {{meta: number, bytes: Uint8Array|null}}
     * @throws {RangeError} If a custom dictionary name exceeds the persisted format limit.
     */
    _encodeEntryContentDictNameMeta(value) {
        switch (value) {
            case '':
            case 'raw':
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_RAW, bytes: null};
            case RAW_TERM_CONTENT_DICT_NAME:
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_RAW_V2, bytes: null};
            case RAW_TERM_CONTENT_SHARED_GLOSSARY_DICT_NAME:
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_RAW_V3, bytes: null};
            case RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME:
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_RAW_V4, bytes: null};
            case 'jmdict':
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_JMDICT, bytes: null};
            case RAW_TERM_CONTENT_TOKEN_DICT_NAME:
                return {meta: ENTRY_CONTENT_DICT_NAME_CODE_RAW_V6, bytes: null};
            default: {
                const bytes = this._textEncoder.encode(value);
                if (bytes.byteLength > 0x00ffffff) {
                    throw new RangeError('Term-record content dictionary name exceeds the shard format limit');
                }
                return {meta: (((bytes.byteLength >>> 0) << 8) | ENTRY_CONTENT_DICT_NAME_CODE_CUSTOM) >>> 0, bytes};
            }
        }
    }

    /**
     * @param {Uint8Array} content
     * @param {number} offset
     * @param {number} length
     * @returns {string}
     */
    _decodeString(content, offset, length) {
        if (length <= 0) {
            return '';
        }
        return this._textDecoder.decode(content.subarray(offset, offset + length));
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    _reverseString(value) {
        let result = '';
        for (let i = value.length - 1; i >= 0; --i) {
            const c = value.charCodeAt(i);
            if (
                (c & 0xfc00) === 0xdc00 &&
                i > 0
            ) {
                const c2 = value.charCodeAt(i - 1);
                if ((c2 & 0xfc00) === 0xd800) {
                    result += value[i - 1] + value[i];
                    --i;
                    continue;
                }
            }
            result += value[i];
        }
        return result;
    }

    /**
     * @param {TermRecord[]} records
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @returns {Promise<{bytes: Uint8Array, contentOffsetBase: number, lookupIndexBytes: Uint8Array, recordFields: Uint8Array|null}>}
     */
    async _encodeRecords(records, preinternedPlan = null) {
        if (records.length === 0) {
            return {
                bytes: new Uint8Array(0),
                contentOffsetBase: 0,
                lookupIndexBytes: new Uint8Array(0),
                recordFields: new Uint8Array(0),
            };
        }
        const contentOffsetBase = getContentOffsetBase(records.map(({entryContentOffset}) => entryContentOffset));
        for (const {entryContentOffset, entryContentLength} of records) {
            getContentOffsetDelta(entryContentOffset, contentOffsetBase);
            validateContentLength(entryContentLength);
        }
        if (!this._wasmEncoderUnavailable) {
            try {
                const encoded = preinternedPlan === null ?
                    await encodeTermRecordsWithWasm(records, this._textEncoder, contentOffsetBase) :
                    await encodeTermRecordsWithWasmPreinterned(records, this._textEncoder, preinternedPlan, contentOffsetBase);
                if (encoded !== null) {
                    return {
                        bytes: encoded.bytes,
                        contentOffsetBase,
                        lookupIndexBytes: encodePersistedTermLookupIndexFromRecordPayload(encoded.bytes, records.length),
                        recordFields: encoded.recordFields,
                    };
                }
            } catch (_) {
                this._wasmEncoderUnavailable = true;
            }
        }
        /** @type {Array<{record: TermRecord, expressionIndex: number, readingIndex: number}>} */
        const encodedRows = [];
        /** @type {Map<string, number>} */
        const stringIndexByValue = new Map();
        /** @type {Uint8Array[]} */
        const stringBytesList = [];
        /** @type {number[]} */
        const stringLengths = [];
        let stringsByteLength = 0;
        let totalBytes = STRING_TABLE_HEADER_BYTES;
        /**
         * @param {string} value
         * @param {Uint8Array} bytes
         * @returns {number}
         */
        const internStringBytes = (value, bytes) => {
            /** @type {number|undefined} */
            const cached = stringIndexByValue.get(value);
            if (typeof cached === 'number') { return cached; }
            const index = stringBytesList.length;
            stringIndexByValue.set(value, index);
            stringBytesList.push(bytes);
            stringLengths.push(bytes.byteLength);
            stringsByteLength += bytes.byteLength;
            return index;
        };
        for (const record of records) {
            const expression = record.expression ?? '';
            const reading = record.reading ?? expression;
            const readingEqualsExpression = record.readingEqualsExpression ?? (reading === expression);
            const expressionBytes = record.expressionBytes instanceof Uint8Array ? record.expressionBytes : this._textEncoder.encode(expression);
            const readingBytes = record.readingBytes instanceof Uint8Array ? record.readingBytes : this._textEncoder.encode(reading);
            const expressionKey = expression.length > 0 ? expression : this._decodeString(expressionBytes, 0, expressionBytes.byteLength);
            const readingKey = reading.length > 0 ? reading : this._decodeString(readingBytes, 0, readingBytes.byteLength);
            const expressionIndex = internStringBytes(expressionKey, expressionBytes);
            const readingIndex = readingEqualsExpression ?
                READING_EQUALS_EXPRESSION_U32 :
                internStringBytes(readingKey, readingBytes);
            totalBytes += RECORD_HEADER_BYTES;
            encodedRows.push({
                record,
                expressionIndex,
                readingIndex,
            });
        }
        totalBytes += (stringLengths.length * 2) + stringsByteLength;

        const output = new Uint8Array(totalBytes);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        let cursor = 0;
        view.setUint32(cursor, stringLengths.length, true); cursor += 4;
        view.setUint32(cursor, stringsByteLength, true); cursor += 4;
        for (const stringLength of stringLengths) {
            view.setUint16(cursor, stringLength, true); cursor += 2;
        }
        for (const bytes of stringBytesList) {
            output.set(bytes, cursor);
            cursor += bytes.byteLength;
        }
        for (const row of encodedRows) {
            const {record, expressionIndex, readingIndex} = row;
            view.setUint32(cursor, expressionIndex, true); cursor += 4;
            view.setUint32(cursor, readingIndex, true); cursor += 4;
            view.setUint32(cursor, getContentOffsetDelta(record.entryContentOffset, contentOffsetBase), true); cursor += 4;
            view.setUint32(cursor, record.entryContentLength < 0 ? U32_NULL : record.entryContentLength, true); cursor += 4;
            view.setInt32(cursor, record.score, true); cursor += 4;
            view.setInt32(cursor, record.sequence ?? -1, true); cursor += 4;
        }
        return {
            bytes: output,
            contentOffsetBase,
            lookupIndexBytes: encodePersistedTermLookupIndexFromRecordPayload(output, records.length),
            recordFields: null,
        };
    }

    /**
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @param {Uint8Array|null} [preparedLookupIndexBytes=null]
     * @returns {Promise<{bytes: Uint8Array, contentOffsetBase: number, lookupIndexBytes: Uint8Array, recordFields: Uint8Array|null, validationMs: number, wasmEncodeMs: number, lookupIndexEncodeMs: number}>}
     */
    async _encodeArtifactChunkRecords(chunk, contentOffsets, contentLengths, preinternedPlan = null, preparedLookupIndexBytes = null) {
        if (chunk.rowCount === 0) {
            return {
                bytes: new Uint8Array(0),
                contentOffsetBase: 0,
                lookupIndexBytes: new Uint8Array(0),
                recordFields: new Uint8Array(0),
                validationMs: 0,
                wasmEncodeMs: 0,
                lookupIndexEncodeMs: 0,
            };
        }
        const tValidationStart = safePerformance.now();
        const fixedContentSpan = hasFixedContentSpan(chunk, chunk.rowCount);
        let contentOffsetBase = Number.POSITIVE_INFINITY;
        for (let i = 0; i < chunk.rowCount; ++i) {
            const contentOffset = getArtifactContentOffset(chunk, contentOffsets, i);
            const contentLength = getArtifactContentLength(chunk, contentLengths, i);
            validateContentOffset(contentOffset);
            validateContentLength(contentLength);
            if (contentOffset >= 0 && contentOffset < contentOffsetBase) {
                contentOffsetBase = contentOffset;
            }
        }
        if (contentOffsetBase === Number.POSITIVE_INFINITY) { contentOffsetBase = 0; }
        for (let i = 0; i < chunk.rowCount; ++i) {
            getContentOffsetDelta(getArtifactContentOffset(chunk, contentOffsets, i), contentOffsetBase);
        }
        const validationMs = safePerformance.now() - tValidationStart;
        if (preinternedPlan !== null && !fixedContentSpan && !this._wasmEncoderUnavailable) {
            const tWasmEncodeStart = safePerformance.now();
            try {
                const encoded = await encodeTermRecordArtifactChunkWithWasmPreinterned(
                    chunk,
                    contentOffsets,
                    contentLengths,
                    this._textEncoder,
                    preinternedPlan,
                    contentOffsetBase,
                );
                const wasmEncodeMs = safePerformance.now() - tWasmEncodeStart;
                if (encoded !== null) {
                    const tLookupIndexEncodeStart = safePerformance.now();
                    const lookupIndexBytes = preparedLookupIndexBytes ?? encodePersistedTermLookupIndexFromPreinternedPlan(
                        preinternedPlan,
                        chunk.readingEqualsExpressionList,
                        chunk.sequenceList,
                        chunk.rowCount,
                    );
                    return {
                        bytes: encoded.bytes,
                        contentOffsetBase,
                        lookupIndexBytes,
                        recordFields: encoded.recordFields,
                        validationMs,
                        wasmEncodeMs,
                        lookupIndexEncodeMs: preparedLookupIndexBytes === null ? safePerformance.now() - tLookupIndexEncodeStart : 0,
                    };
                }
            } catch (_) {
                this._wasmEncoderUnavailable = true;
            }
        }
        if (hasCompleteTermRecordPreinternedPlan(preinternedPlan, chunk.rowCount)) {
            const tRecordEncodeStart = safePerformance.now();
            const bytes = this._encodePreinternedArtifactChunkRecords(
                chunk,
                contentOffsets,
                contentLengths,
                preinternedPlan,
                contentOffsetBase,
            );
            const wasmEncodeMs = safePerformance.now() - tRecordEncodeStart;
            const tLookupIndexEncodeStart = safePerformance.now();
            const lookupIndexBytes = preparedLookupIndexBytes ?? encodePersistedTermLookupIndexFromPreinternedPlan(
                preinternedPlan,
                chunk.readingEqualsExpressionList,
                chunk.sequenceList,
                chunk.rowCount,
            );
            return {
                bytes,
                contentOffsetBase,
                lookupIndexBytes,
                recordFields: null,
                validationMs,
                wasmEncodeMs,
                lookupIndexEncodeMs: preparedLookupIndexBytes === null ? safePerformance.now() - tLookupIndexEncodeStart : 0,
            };
        }
        /** @type {TermRecord[]} */
        const records = new Array(chunk.rowCount);
        for (let i = 0; i < chunk.rowCount; ++i) {
            const id = i + 1;
            const sequenceValue = chunk.sequenceList[i];
            records[i] = {
                id,
                dictionary: chunk.dictionary,
                expression: '',
                reading: '',
                readingEqualsExpression: chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1,
                expressionBytes: chunk.expressionBytesList[i],
                readingBytes: (chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1) ? void 0 : chunk.readingBytesList[i],
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: getArtifactContentOffset(chunk, contentOffsets, i),
                entryContentLength: getArtifactContentLength(chunk, contentLengths, i),
                entryContentDictName: 'raw',
                score: chunk.scoreList[i] ?? 0,
                sequence: typeof sequenceValue === 'number' && sequenceValue >= 0 ? sequenceValue : null,
            };
        }
        const tRecordEncodeStart = safePerformance.now();
        const encoded = await this._encodeRecords(records, preinternedPlan);
        return {
            ...encoded,
            validationMs,
            wasmEncodeMs: safePerformance.now() - tRecordEncodeStart,
            lookupIndexEncodeMs: 0,
        };
    }

    /**
     * @param {{rowCount: number, readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan} preinternedPlan
     * @param {number} contentOffsetBase
     * @returns {Uint8Array}
     */
    _encodePreinternedArtifactChunkRecords(chunk, contentOffsets, contentLengths, preinternedPlan, contentOffsetBase) {
        const count = chunk.rowCount;
        const stringLengths = preinternedPlan.stringLengths;
        const stringsBuffer = preinternedPlan.stringsBuffer;
        const expressionIndexes = preinternedPlan.expressionIndexes;
        const readingIndexes = preinternedPlan.readingIndexes;
        const fixedContentSpan = hasFixedContentSpan(chunk, count);
        const fixedContentOffsetBase = fixedContentSpan ? /** @type {number} */ (chunk.fixedContentOffsetBase) : 0;
        const fixedContentLength = fixedContentSpan ? /** @type {number} */ (chunk.fixedContentLength) : 0;
        let totalBytes = STRING_TABLE_HEADER_BYTES + (stringLengths.length * 2) + stringsBuffer.byteLength;
        totalBytes += count * RECORD_HEADER_BYTES;

        const output = new Uint8Array(totalBytes);
        let cursor = 0;
        cursor = writeU32Le(output, cursor, stringLengths.length);
        cursor = writeU32Le(output, cursor, stringsBuffer.byteLength);
        for (let i = 0, ii = stringLengths.length; i < ii; ++i) {
            cursor = writeU16Le(output, cursor, stringLengths[i]);
        }
        output.set(stringsBuffer, cursor);
        cursor += stringsBuffer.byteLength;
        for (let i = 0; i < count; ++i) {
            const entryContentLength = fixedContentSpan ? fixedContentLength : contentLengths[i];
            cursor = writeU32Le(output, cursor, expressionIndexes[i] >>> 0);
            cursor = writeU32Le(
                output,
                cursor,
                (chunk.readingEqualsExpressionList[i] === true || chunk.readingEqualsExpressionList[i] === 1) ?
                    READING_EQUALS_EXPRESSION_U32 :
                (readingIndexes[i] >>> 0),
            );
            const entryContentOffset = fixedContentSpan ? fixedContentOffsetBase + (i * fixedContentLength) : contentOffsets[i];
            cursor = writeU32Le(output, cursor, getContentOffsetDelta(entryContentOffset, contentOffsetBase));
            cursor = writeU32Le(output, cursor, entryContentLength < 0 ? U32_NULL : entryContentLength);
            cursor = writeU32Le(output, cursor, chunk.scoreList[i] ?? 0);
            cursor = writeU32Le(output, cursor, chunk.sequenceList[i] ?? -1);
        }
        return output;
    }

    /**
     * @param {TermRecordShardState} state
     * @param {Uint8Array} chunk
     * @param {number} firstId
     * @param {number} count
     * @param {string|null} [contentDictNameOverride=null]
     * @param {number} contentOffsetBase
     * @param {Uint8Array|null} [lookupIndexBytes=null]
     * @param {Uint8Array|null} [recordFields=null]
     * @returns {Promise<void>}
     */
    async _appendEncodedChunk(
        state,
        chunk,
        firstId,
        count,
        contentDictNameOverride = null,
        contentOffsetBase = 0,
        lookupIndexBytes = null,
        recordFields = null,
    ) {
        if (chunk.byteLength <= 0) { return; }
        await this._validateShardAppendFormat(state);
        const firstRecord = this._recordsById.get(firstId) ?? null;
        const contentDictName = contentDictNameOverride ?? firstRecord?.entryContentDictName ?? 'raw';
        if (state.sharedContentDictName === null) {
            state.sharedContentDictName = contentDictName;
        } else if (state.sharedContentDictName !== contentDictName) {
            throw new Error(`Mixed entryContentDictName values are not supported within shard ${state.fileName}`);
        }

        /** @type {Uint8Array|null} */
        const binaryHeader = state.fileLength === 0 ?
            this._createBinaryHeader(state.sharedContentDictName, state.generationId) :
            null;
        const recordChunkOffset = state.fileLength + (binaryHeader?.byteLength ?? 0);
        const recordPayloadHash = hashLookupIndexBytes(chunk);
        const chunks = binaryHeader !== null ?
            [
                binaryHeader,
                this._createChunkHeader(firstId, count, contentOffsetBase, chunk, recordPayloadHash),
                chunk,
            ] :
            [
                this._createChunkHeader(firstId, count, contentOffsetBase, chunk, recordPayloadHash),
                chunk,
            ];
        let totalBytes = 0;
        for (const pendingChunk of chunks) {
            totalBytes += pendingChunk.byteLength;
        }
        state.pendingWriteChunks.push(...chunks);
        state.pendingWriteBytes += totalBytes;
        state.fileLength += totalBytes;
        if (
            state.initialFileLength === 0 &&
            lookupIndexBytes instanceof Uint8Array &&
            lookupIndexBytes.byteLength > 0
        ) {
            const lookupIndexChunk = this._createLookupIndexChunk(
                firstId,
                count,
                recordChunkOffset,
                contentOffsetBase,
                lookupIndexBytes,
                chunk,
                recordFields,
                recordPayloadHash,
            );
            state.pendingLookupIndexChunks.push(lookupIndexChunk);
            state.pendingLookupIndexBytes += lookupIndexChunk.byteLength;
            state.pendingLookupIndexRecordCount += count;
            if (state.lookupIndexWriteError !== null) {
                throw state.lookupIndexWriteError;
            }
            if (state.pendingLookupIndexBytes >= LOOKUP_INDEX_FLUSH_THRESHOLD_BYTES) {
                await this._flushPendingLookupIndexChunks(state, !this._importSessionActive);
            } else if (
                this._importSessionActive &&
                state.lookupIndexChunkCount === 0 &&
                state.lookupIndexWritePromise === null &&
                state.pendingLookupIndexBytes >= EAGER_IMPORT_LOOKUP_INDEX_WRITE_START_BYTES
            ) {
                await this._flushPendingLookupIndexChunks(state, false);
            }
        }

        if (
            !this._importSessionActive ||
            (!state.importWriteStarted && state.pendingWriteBytes >= EAGER_IMPORT_RECORD_WRITE_START_BYTES) ||
            state.pendingWriteBytes >= this._flushThresholdBytes
        ) {
            await this._flushPendingWritesForShard(state);
            if (!this._importSessionActive) {
                await this._closeShardWritable(state);
            }
        }
    }

    /**
     * @param {Uint8Array} payload
     * @param {string} [contentDictName]
     * @returns {Uint8Array}
     */
    _withBinaryHeader(payload, contentDictName = 'raw') {
        const header = this._createBinaryHeader(contentDictName);
        const output = new Uint8Array(header.byteLength + payload.byteLength);
        output.set(header, 0);
        output.set(payload, header.byteLength);
        return output;
    }

    /**
     * @param {string} [contentDictName]
     * @param {Uint8Array} [generationId]
     * @returns {Uint8Array}
     * @throws {Error} If the generation ID or dictionary metadata is invalid.
     */
    _createBinaryHeader(contentDictName = 'raw', generationId = this._createShardGenerationId()) {
        const header = this._textEncoder.encode(BINARY_MAGIC_TEXT);
        if (!(generationId instanceof Uint8Array) || generationId.byteLength !== SHARD_GENERATION_BYTES) {
            throw new Error('Invalid term-record shard generation ID');
        }
        const {meta: entryContentDictNameMeta, bytes: entryContentDictNameBytes} = this._encodeEntryContentDictNameMeta(contentDictName);
        const hasExtendedMeta = entryContentDictNameMeta > ENTRY_CONTENT_DICT_NAME_VALUE_MASK;
        const output = new Uint8Array(
            header.byteLength +
            SHARD_GENERATION_BYTES +
            2 +
            (hasExtendedMeta ? 4 : 0) +
            (entryContentDictNameBytes?.byteLength ?? 0),
        );
        output.set(header, 0);
        output.set(generationId, header.byteLength);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        let cursor = BINARY_HEADER_PREFIX_BYTES;
        if (hasExtendedMeta) {
            view.setUint16(cursor, U16_NULL, true); cursor += 2;
            view.setUint32(cursor, entryContentDictNameMeta >>> 0, true); cursor += 4;
        } else {
            view.setUint16(cursor, entryContentDictNameMeta >>> 0, true); cursor += 2;
        }
        if (entryContentDictNameBytes !== null) {
            output.set(entryContentDictNameBytes, cursor);
        }
        return output;
    }

    /** @returns {Uint8Array} */
    _createShardGenerationId() {
        const generationId = new Uint8Array(SHARD_GENERATION_BYTES);
        const crypto = globalThis.crypto;
        if (typeof crypto?.getRandomValues === 'function') {
            crypto.getRandomValues(generationId);
            return generationId;
        }
        for (let i = 0; i < generationId.length; ++i) {
            generationId[i] = Math.floor(Math.random() * 256);
        }
        return generationId;
    }

    /**
     * @param {Uint8Array} payload
     * @param {number} firstId
     * @param {number} count
     * @param {number} [contentOffsetBase=0]
     * @returns {Uint8Array}
     */
    _withChunkHeader(payload, firstId, count, contentOffsetBase = 0) {
        const header = this._createChunkHeader(firstId, count, contentOffsetBase, payload);
        const output = new Uint8Array(header.byteLength + payload.byteLength);
        output.set(header, 0);
        output.set(payload, header.byteLength);
        return output;
    }

    /**
     * @param {number} firstId
     * @param {number} count
     * @param {number} contentOffsetBase
     * @param {Uint8Array} payload
     * @param {number|null} [payloadHash=null]
     * @returns {Uint8Array}
     * @throws {TypeError|RangeError} If the payload or numeric fields are invalid.
     */
    _createChunkHeader(firstId, count, contentOffsetBase, payload, payloadHash = null) {
        if (!(payload instanceof Uint8Array)) {
            throw new TypeError('Term-record chunk payload is required');
        }
        const output = new Uint8Array(CHUNK_HEADER_BYTES);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        view.setUint32(0, firstId >>> 0, true);
        view.setUint32(4, count >>> 0, true);
        writeSafeU64Le(view, 8, contentOffsetBase);
        view.setUint32(16, payloadHash ?? hashLookupIndexBytes(payload), true);
        return output;
    }

    /**
     * @param {number} firstId
     * @param {number} count
     * @param {number} recordChunkOffset
     * @param {number} contentOffsetBase
     * @param {Uint8Array} payload
     * @param {Uint8Array} recordPayload
     * @param {Uint8Array|null} [precomputedRecordFields=null]
     * @param {number|null} [recordPayloadHash=null]
     * @returns {Uint8Array}
     * @throws {Error} If the encoded record payload does not match the declared record count.
     */
    _createLookupIndexChunk(
        firstId,
        count,
        recordChunkOffset,
        contentOffsetBase,
        payload,
        recordPayload,
        precomputedRecordFields = null,
        recordPayloadHash = null,
    ) {
        const recordPayloadView = new DataView(
            recordPayload.buffer,
            recordPayload.byteOffset,
            recordPayload.byteLength,
        );
        const stringCount = recordPayloadView.getUint32(0, true);
        const stringBytesLength = recordPayloadView.getUint32(4, true);
        const recordsOffset = STRING_TABLE_HEADER_BYTES + (stringCount * 2) + stringBytesLength;
        if (
            recordsOffset > recordPayload.byteLength ||
            (recordPayload.byteLength - recordsOffset) !== (count * RECORD_HEADER_BYTES)
        ) {
            throw new Error('Invalid term-record payload while creating lookup sidecar');
        }
        let recordFields = precomputedRecordFields;
        if (recordFields === null) {
            recordFields = new Uint8Array(count * LOOKUP_INDEX_RECORD_FIELDS_BYTES);
            const recordFieldsView = new DataView(
                recordFields.buffer,
                recordFields.byteOffset,
                recordFields.byteLength,
            );
            for (let i = 0; i < count; ++i) {
                const recordOffset = recordsOffset + (i * RECORD_HEADER_BYTES);
                const fieldsOffset = i * LOOKUP_INDEX_RECORD_FIELDS_BYTES;
                recordFieldsView.setUint32(fieldsOffset, recordPayloadView.getUint32(recordOffset + 8, true), true);
                recordFieldsView.setUint32(fieldsOffset + 4, recordPayloadView.getUint32(recordOffset + 12, true), true);
                recordFieldsView.setInt32(fieldsOffset + 8, recordPayloadView.getInt32(recordOffset + 16, true), true);
            }
        } else if (recordFields.byteLength !== count * LOOKUP_INDEX_RECORD_FIELDS_BYTES) {
            throw new Error('Invalid precomputed term-record fields');
        }
        const output = new Uint8Array(
            LOOKUP_INDEX_CHUNK_HEADER_BYTES +
            payload.byteLength +
            recordFields.byteLength,
        );
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        view.setUint32(0, firstId, true);
        view.setUint32(4, count, true);
        writeSafeU64Le(view, 8, recordChunkOffset);
        writeSafeU64Le(view, 16, contentOffsetBase);
        view.setUint32(24, payload.byteLength, true);
        view.setUint32(28, hashLookupIndexBytes(payload), true);
        view.setUint32(32, hashLookupIndexBytes(this._createChunkHeader(
            firstId,
            count,
            contentOffsetBase,
            recordPayload,
            recordPayloadHash,
        )), true);
        view.setUint32(36, hashLookupIndexBytes(recordFields), true);
        output.set(payload, LOOKUP_INDEX_CHUNK_HEADER_BYTES);
        output.set(recordFields, LOOKUP_INDEX_CHUNK_HEADER_BYTES + payload.byteLength);
        return output;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _flushLookupIndexFile(state) {
        if (
            (
                state.pendingLookupIndexChunks.length === 0 &&
                state.lookupIndexWritable === null &&
                state.lookupIndexWritePromise === null
            ) ||
            this._recordsDirectoryHandle === null
        ) {
            return;
        }
        const indexFileName = `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`;
        if (state.initialFileLength !== 0) {
            try {
                await this._recordsDirectoryHandle.removeEntry(indexFileName);
            } catch (_) {
                // Missing or stale sidecars are handled by the full-shard fallback.
            }
            state.pendingLookupIndexChunks = [];
            state.pendingLookupIndexBytes = 0;
            state.pendingLookupIndexRecordCount = 0;
            return;
        }
        /** @type {Error|null} */
        let operationError = null;
        try {
            await this._flushPendingLookupIndexChunks(state, true);
            const writable = state.lookupIndexWritable;
            if (writable !== null) {
                const header = new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES);
                header.set(this._textEncoder.encode(LOOKUP_INDEX_MAGIC_TEXT), 0);
                const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
                writeSafeU64Le(view, 8, state.fileLength);
                view.setUint32(16, state.lookupIndexChunkCount, true);
                view.setUint32(20, state.lookupIndexRecordCount, true);
                header.set(state.generationId, 24);
                await writable.seek(0);
                await writable.write(header);
            }
        } catch (error) {
            operationError = error instanceof Error ? error : new Error(String(error));
        }
        /** @type {Error|null} */
        let closeError = null;
        const writable = state.lookupIndexWritable;
        if (writable !== null) {
            try {
                await writable.close();
            } catch (error) {
                closeError = error instanceof Error ? error : new Error(String(error));
            } finally {
                state.lookupIndexWritable = null;
            }
        }
        state.lookupIndexFileHandle = null;
        if (operationError !== null && closeError !== null) {
            throw new AggregateError(
                [operationError, closeError],
                `Failed to finalize term-record lookup index ${indexFileName}`,
            );
        }
        if (operationError !== null) { throw operationError; }
        if (closeError !== null) { throw closeError; }
        state.pendingLookupIndexChunks = [];
        state.pendingLookupIndexBytes = 0;
        state.pendingLookupIndexRecordCount = 0;
        state.lookupIndexChunkCount = 0;
        state.lookupIndexRecordCount = 0;
    }

    /**
     * @param {TermRecordShardState} state
     * @param {boolean} [waitForCompletion=true]
     * @returns {Promise<void>}
     */
    async _flushPendingLookupIndexChunks(state, waitForCompletion = true) {
        if (state.lookupIndexWriteError !== null) {
            throw state.lookupIndexWriteError;
        }
        if (state.pendingLookupIndexChunks.length === 0 || this._recordsDirectoryHandle === null) {
            if (waitForCompletion) {
                await this._awaitLookupIndexWritesForShard(state);
            }
            return;
        }
        const chunks = state.pendingLookupIndexChunks;
        const recordCount = state.pendingLookupIndexRecordCount;
        const byteLength = state.pendingLookupIndexBytes;
        state.pendingLookupIndexChunks = [];
        state.pendingLookupIndexBytes = 0;
        state.pendingLookupIndexRecordCount = 0;
        const previousWrite = state.lookupIndexWritePromise ?? Promise.resolve();
        state.lookupIndexQueuedBytes += byteLength;
        state.lookupIndexMaxQueuedBytes = Math.max(state.lookupIndexMaxQueuedBytes, state.lookupIndexQueuedBytes);
        this._lookupIndexWriteMetrics.maxQueuedBytes = Math.max(
            this._lookupIndexWriteMetrics.maxQueuedBytes,
            state.lookupIndexMaxQueuedBytes,
        );
        const writePromise = previousWrite
            .then(async () => {
                if (state.lookupIndexWritable === null) {
                    const indexFileName = `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`;
                    state.lookupIndexFileHandle = await this._recordsDirectoryHandle?.getFileHandle(indexFileName, {create: true}) ?? null;
                    if (state.lookupIndexFileHandle === null) {
                        throw new Error('Term-record lookup index directory became unavailable during import');
                    }
                    state.lookupIndexWritable = await state.lookupIndexFileHandle.createWritable();
                    await state.lookupIndexWritable.truncate(0);
                    await state.lookupIndexWritable.write(new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES));
                }
                await state.lookupIndexWritable.write(new Blob(chunks));
                ++this._lookupIndexWriteMetrics.writeCallCount;
                this._lookupIndexWriteMetrics.writeBytes += byteLength;
                state.lookupIndexChunkCount += chunks.length;
                state.lookupIndexRecordCount += recordCount;
            })
            .catch((error) => {
                state.lookupIndexWriteError = error instanceof Error ? error : new Error(String(error));
                throw state.lookupIndexWriteError;
            })
            .finally(() => {
                state.lookupIndexQueuedBytes = Math.max(0, state.lookupIndexQueuedBytes - byteLength);
            });
        state.lookupIndexWritePromise = writePromise;
        void writePromise.catch(() => {});
        if (waitForCompletion || state.lookupIndexQueuedBytes >= this._queuedWriteBudgetBytes) {
            await this._awaitLookupIndexWritesForShard(state);
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _awaitLookupIndexWritesForShard(state) {
        if (state.lookupIndexWriteError !== null) {
            throw state.lookupIndexWriteError;
        }
        const writePromise = state.lookupIndexWritePromise;
        if (writePromise === null) { return; }
        const startedAt = safePerformance.now();
        try {
            await writePromise;
        } finally {
            this._lookupIndexWriteMetrics.awaitMs += safePerformance.now() - startedAt;
            if (state.lookupIndexWritePromise === writePromise && state.lookupIndexWriteError === null) {
                state.lookupIndexWritePromise = null;
            }
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _flushPendingWrites() {
        if (this._shardStateByFileName.size === 0) {
            return;
        }
        for (const state of this._shardStateByFileName.values()) {
            await this._flushPendingWritesForShard(state);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _awaitQueuedWrites() {
        if (this._shardStateByFileName.size === 0) {
            return;
        }
        for (const state of this._shardStateByFileName.values()) {
            await this._awaitQueuedWritesForShard(state);
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _closeAllWritables() {
        /** @type {Error[]} */
        const errors = [];
        for (const state of this._shardStateByFileName.values()) {
            const results = await Promise.allSettled([
                this._finalizeShardWritable(state),
                this._flushLookupIndexFile(state),
            ]);
            for (const result of results) {
                if (result.status === 'fulfilled') { continue; }
                errors.push(
                    result.reason instanceof Error ?
                        result.reason :
                        new Error(String(result.reason)),
                );
            }
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, 'Failed to finalize term-record storage');
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _finalizeShardWritable(state) {
        /** @type {Error[]} */
        const errors = [];
        try {
            await this._awaitQueuedWritesForShard(state);
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
        try {
            await this._closeShardWritable(state);
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(
                errors,
                `Failed to finalize term-record file ${state.fileName}`,
            );
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _closeShardWritable(state) {
        if (state.writable === null) {
            return;
        }
        try {
            await state.writable.close();
        } catch (error) {
            if (!this._isClosingWritableStreamError(error)) {
                throw error;
            }
        } finally {
            state.writable = null;
        }
    }

    /**
     * @param {unknown} error
     * @returns {boolean}
     */
    _isClosingWritableStreamError(error) {
        const message = (error instanceof Error) ? error.message : String(error);
        return (
            message.includes('closing writable stream') ||
            message.includes('closed or closing stream')
        );
    }

    /**
     * @param {TermRecordShardState} state
     * @param {number} seekOffset
     * @returns {Promise<void>}
     */
    async _reopenShardWritable(state, seekOffset) {
        state.writable = await state.fileHandle.createWritable({keepExistingData: true});
        await state.writable.seek(Math.max(0, seekOffset));
    }

    /**
     * @returns {Promise<void>}
     */
    async _rewriteAllShardsFromMemory() {
        if (this._recordsDirectoryHandle === null) {
            return;
        }
        await this._closeAllWritables();
        this._shardStateByFileName.clear();
        this._activeAppendShardStateByKey.clear();

        const existingShardFileNames = await this._listShardFileNames();
        for (const fileName of existingShardFileNames) {
            try {
                await this._recordsDirectoryHandle.removeEntry(fileName);
            } catch (_) {
                // NOP
            }
            try {
                await this._recordsDirectoryHandle.removeEntry(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
            } catch (_) {
                // NOP
            }
        }
        this._invalidateAllPersistentLookupState();

        /** @type {Map<string, {dictionaryName: string, contentDictName: string, records: TermRecord[]}>} */
        const recordsByShard = new Map();
        const orderedRecords = [...this._recordsById.values()].sort((a, b) => a.id - b.id);
        for (const record of orderedRecords) {
            const contentDictName = record.entryContentDictName ?? 'raw';
            const fileName = this._getShardFileName(record.dictionary, contentDictName);
            const shard = recordsByShard.get(fileName);
            if (typeof shard === 'undefined') {
                recordsByShard.set(fileName, {dictionaryName: record.dictionary, contentDictName, records: [record]});
            } else {
                shard.records.push(record);
            }
        }

        for (const [fileName, shard] of recordsByShard) {
            const {contentDictName, records} = shard;
            const fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName, {create: true});
            const writable = await fileHandle.createWritable();
            await writable.truncate(0);
            let fileLength = 0;
            const generationId = this._createShardGenerationId();
            const header = this._createBinaryHeader(contentDictName, generationId);
            await writable.write(header);
            fileLength += header.byteLength;
            for (let runStart = 0; runStart < records.length;) {
                let runEnd = runStart + 1;
                let minContentOffset = records[runStart].entryContentOffset >= 0 ? records[runStart].entryContentOffset : Number.POSITIVE_INFINITY;
                let maxContentOffset = records[runStart].entryContentOffset >= 0 ? records[runStart].entryContentOffset : Number.NEGATIVE_INFINITY;
                while (runEnd < records.length && records[runEnd].id === (records[runEnd - 1].id + 1)) {
                    const contentOffset = records[runEnd].entryContentOffset;
                    const nextMinContentOffset = contentOffset >= 0 ? Math.min(minContentOffset, contentOffset) : minContentOffset;
                    const nextMaxContentOffset = contentOffset >= 0 ? Math.max(maxContentOffset, contentOffset) : maxContentOffset;
                    if (
                        nextMinContentOffset !== Number.POSITIVE_INFINITY &&
                        (nextMaxContentOffset - nextMinContentOffset) > MAX_CONTENT_OFFSET_DELTA
                    ) {
                        break;
                    }
                    minContentOffset = nextMinContentOffset;
                    maxContentOffset = nextMaxContentOffset;
                    ++runEnd;
                }
                const runRecords = records.slice(runStart, runEnd);
                const encoded = await this._encodeRecords(runRecords);
                const chunkHeader = this._createChunkHeader(
                    runRecords[0].id,
                    runRecords.length,
                    encoded.contentOffsetBase,
                    encoded.bytes,
                );
                await writable.write(chunkHeader);
                await writable.write(encoded.bytes);
                fileLength += chunkHeader.byteLength + encoded.bytes.byteLength;
                runStart = runEnd;
            }
            await writable.close();
            const state = this._createShardState(fileName, fileHandle, fileLength, contentDictName);
            state.generationId = generationId;
            this._shardStateByFileName.set(fileName, state);
            this._setActiveAppendShardState(state);
        }
    }

    /**
     * @param {boolean} materializeRecords
     * @returns {Promise<number>}
     */
    async _loadShardFiles(materializeRecords = true) {
        if (this._recordsDirectoryHandle === null) {
            return 0;
        }
        const entriesMethod = /** @type {unknown} */ (Reflect.get(this._recordsDirectoryHandle, 'entries'));
        if (typeof entriesMethod !== 'function') {
            return 0;
        }
        const entries = /** @type {() => AsyncIterable<[string, FileSystemHandle]>} */ (entriesMethod).call(this._recordsDirectoryHandle);
        let shardFileCount = 0;
        for await (const entry of entries) {
            const name = String(entry[0] ?? '');
            const fileSystemHandle = /** @type {FileSystemHandle} */ (/** @type {unknown} */ (entry[1]));
            if (fileSystemHandle.kind !== 'file' || !this._isShardFileName(name)) {
                continue;
            }
            const fileHandle = /** @type {FileSystemFileHandle} */ (fileSystemHandle);
            let file;
            try {
                file = await fileHandle.getFile();
            } catch (_) {
                continue;
            }
            ++shardFileCount;
            const shardInfo = this._decodeShardInfoFromShardFileName(name);
            const state = this._createShardState(
                name,
                fileHandle,
                file.size,
                shardInfo?.contentDictName ?? null,
                shardInfo?.segmentIndex ?? 0,
                shardInfo === null ? name : this._getShardFileName(shardInfo.dictionaryName, shardInfo.contentDictName),
            );
            this._shardStateByFileName.set(name, state);
            this._setActiveAppendShardState(state);
            if (!materializeRecords || file.size <= 0) {
                continue;
            }
            await this._loadShardStateContents(state, file);
        }
        return shardFileCount;
    }

    /**
     * @param {TermRecordShardState} state
     * @param {File|null} [existingFile=null]
     * @returns {Promise<boolean>}
     */
    async _loadShardStateContents(state, existingFile = null) {
        let file = existingFile;
        if (file === null) {
            try {
                file = await state.fileHandle.getFile();
            } catch (_) {
                return false;
            }
        }
        state.fileLength = file.size;
        if (file.size <= 0) {
            return false;
        }
        let arrayBuffer;
        try {
            arrayBuffer = await file.arrayBuffer();
        } catch (_) {
            return false;
        }
        const content = new Uint8Array(arrayBuffer);
        if (
            this._isBinaryFormat(content) &&
            this._loadBinary(content, this._decodeDictionaryNameFromShardFileName(state.fileName))
        ) {
            return true;
        }
        await this._discardInvalidShardState(state);
        const dictionaryName = this._decodeDictionaryNameFromShardFileName(state.fileName);
        if (dictionaryName !== null) {
            this.markDictionaryReimportRequired(dictionaryName, 'Dictionary record data is damaged');
        }
        return false;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _discardInvalidShardState(state) {
        if (!this._invalidShardFileNames.includes(state.fileName)) {
            this._invalidShardFileNames.push(state.fileName);
        }
        if (this._recordsDirectoryHandle !== null) {
            try {
                await this._closeShardWritable(state);
                await this._removeStorageFileOrTruncate(`${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
                await this._removeStorageFileOrTruncate(state.fileName, true);
            } catch (error) {
                // Keep the invalid state registered so deletion/reimport can
                // retry cleanup instead of appending to a hidden stale file.
                reportDiagnostics('term-record-invalid-shard-cleanup-failed', {
                    fileName: state.fileName,
                    error: error instanceof Error ? error.message : String(error),
                });
                return;
            }
        }
        this._shardStateByFileName.delete(state.fileName);
        this._activeAppendShardStateByKey.delete(state.logicalKey);
    }

    /**
     * @param {TermRecordShardState[]} states
     * @returns {Promise<void>}
     */
    async _loadShardStatesContents(states) {
        if (states.length === 0) {
            return;
        }
        let nextIndex = 0;
        const workerCount = Math.min(SHARD_LOAD_CONCURRENCY, states.length);
        const workers = [];
        for (let i = 0; i < workerCount; ++i) {
            workers.push((async () => {
                while (nextIndex < states.length) {
                    const state = states[nextIndex++];
                    await this._loadShardStateContents(state);
                }
            })());
        }
        await Promise.all(workers);
    }

    /**
     * @returns {Promise<string[]>}
     */
    async _listShardFileNames() {
        if (this._recordsDirectoryHandle === null) {
            return [];
        }
        const entriesMethod = /** @type {unknown} */ (Reflect.get(this._recordsDirectoryHandle, 'entries'));
        if (typeof entriesMethod !== 'function') {
            return [];
        }
        const entries = /** @type {() => AsyncIterable<[string, FileSystemHandle]>} */ (entriesMethod).call(this._recordsDirectoryHandle);
        /** @type {string[]} */
        const names = [];
        for await (const entry of entries) {
            const name = String(entry[0] ?? '');
            const fileSystemHandle = /** @type {FileSystemHandle} */ (/** @type {unknown} */ (entry[1]));
            if (fileSystemHandle.kind === 'file' && this._isShardFileName(name)) {
                names.push(name);
            }
        }
        return names;
    }

    /**
     * @returns {Promise<string[]>}
     */
    async _listTermRecordStorageFileNames() {
        if (this._recordsDirectoryHandle === null) { return []; }
        const entriesMethod = /** @type {unknown} */ (Reflect.get(this._recordsDirectoryHandle, 'entries'));
        if (typeof entriesMethod !== 'function') { return []; }
        const entries = /** @type {() => AsyncIterable<[string, FileSystemHandle]>} */ (entriesMethod).call(this._recordsDirectoryHandle);
        const names = [];
        for await (const entry of entries) {
            const name = String(entry[0] ?? '');
            const fileSystemHandle = /** @type {FileSystemHandle} */ (/** @type {unknown} */ (entry[1]));
            if (
                fileSystemHandle.kind === 'file' &&
                (this._isShardFileName(name) || name.endsWith(`${SHARD_FILE_SUFFIX}${LOOKUP_INDEX_FILE_SUFFIX}`))
            ) {
                names.push(name);
            }
        }
        return names;
    }

    /**
     * @returns {boolean}
     */
    _hasPendingShardWrites() {
        for (const state of this._shardStateByFileName.values()) {
            if (
                state.writable !== null ||
                state.pendingWriteBytes > 0 ||
                state.pendingWriteChunks.length > 0 ||
                state.pendingLookupIndexChunks.length > 0 ||
                state.lookupIndexWritable !== null ||
                state.lookupIndexWritePromise !== null
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} [contentDictName='raw']
     * @returns {Promise<TermRecordShardState|null>}
     */
    async _getOrCreateShardState(dictionaryName, contentDictName = 'raw') {
        this._registerDictionaryMutation(dictionaryName);
        if (this._recordsDirectoryHandle === null) {
            return null;
        }
        const normalizedContentDictName = this._normalizeContentDictName(contentDictName);
        const logicalKey = this._getShardFileName(dictionaryName, normalizedContentDictName);
        const existing = this._activeAppendShardStateByKey.get(logicalKey);
        if (typeof existing !== 'undefined') {
            if (existing.fileLength < MAX_SHARD_SEGMENT_FILE_BYTES) {
                return existing;
            }
            const nextSegmentIndex = existing.segmentIndex + 1;
            const nextFileName = this._getShardSegmentFileName(dictionaryName, normalizedContentDictName, nextSegmentIndex);
            const nextFileHandle = await this._recordsDirectoryHandle.getFileHandle(nextFileName, {create: true});
            const created = this._createShardState(
                nextFileName,
                nextFileHandle,
                this._importSessionActive ? 0 : (await nextFileHandle.getFile()).size,
                normalizedContentDictName,
                nextSegmentIndex,
                logicalKey,
            );
            this._shardStateByFileName.set(nextFileName, created);
            this._activeAppendShardStateByKey.set(logicalKey, created);
            return created;
        }
        const fileName = this._getShardSegmentFileName(dictionaryName, normalizedContentDictName, 0);
        const fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName, {create: true});
        const created = this._createShardState(
            fileName,
            fileHandle,
            this._importSessionActive ? 0 : (await fileHandle.getFile()).size,
            normalizedContentDictName,
            0,
            logicalKey,
        );
        this._shardStateByFileName.set(fileName, created);
        this._activeAppendShardStateByKey.set(logicalKey, created);
        return created;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _flushPendingWritesForShard(state) {
        if (state.pendingWriteBytes <= 0 || state.pendingWriteChunks.length === 0) {
            return;
        }
        if (state.writable === null) {
            state.writable = await state.fileHandle.createWritable({keepExistingData: true});
            const seekOffset = state.fileLength - state.pendingWriteBytes;
            await state.writable.seek(Math.max(0, seekOffset));
        }
        const chunks = this._coalescePendingChunks(state.pendingWriteChunks);
        state.pendingWriteChunks = [];
        state.pendingWriteBytes = 0;
        if (this._importSessionActive) {
            this._queueWriteChunksForShard(state, chunks);
            if (state.queuedWriteBytes >= this._queuedWriteBudgetBytes) {
                const rotated = await this._rotateActiveShardSegmentAfterQueuePressure(state);
                if (!rotated) {
                    await this._awaitQueuedWritesForShard(state);
                }
            }
            return;
        }
        if (state.queuedWritePromise !== null) {
            this._queueWriteChunksForShard(state, chunks);
            await this._awaitQueuedWritesForShard(state);
            return;
        }
        await this._writeChunksForShard(state, chunks);
    }

    /**
     * @param {TermRecordShardState} state
     * @param {Uint8Array[]} chunks
     * @returns {void}
     */
    _queueWriteChunksForShard(state, chunks) {
        if (chunks.length === 0) {
            return;
        }
        if (state.queuedWriteError !== null) {
            return;
        }
        state.importWriteStarted = true;
        for (const chunk of chunks) {
            if (chunk.byteLength <= 0) { continue; }
            state.queuedWriteChunks.push(chunk);
            state.queuedWriteBytes += chunk.byteLength;
        }
        if (state.queuedWritePromise !== null) {
            return;
        }
        state.queuedWritePromise = this._drainQueuedWritesForShard(state);
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _awaitQueuedWritesForShard(state) {
        if (state.queuedWriteError !== null) {
            throw state.queuedWriteError;
        }
        const promise = state.queuedWritePromise;
        if (promise === null) {
            return;
        }
        await promise;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<boolean>}
     */
    async _rotateActiveShardSegmentAfterQueuePressure(state) {
        const logicalKey = state.logicalKey;
        if (logicalKey === null) {
            return false;
        }
        const active = this._activeAppendShardStateByKey.get(logicalKey);
        if (active !== state) {
            return false;
        }
        const nextSegmentIndex = state.segmentIndex + 1;
        const decodedShardInfo = this._decodeShardInfoFromShardFileName(state.logicalKey ?? state.fileName);
        const dictionaryName = decodedShardInfo?.dictionaryName ?? this._decodeShardInfoFromShardFileName(state.fileName)?.dictionaryName ?? '';
        const sharedContentDictName = String(state.sharedContentDictName ?? 'raw');
        const nextFileName = this._getShardSegmentFileName(dictionaryName, sharedContentDictName, nextSegmentIndex);
        const nextFileHandle = await this._recordsDirectoryHandle?.getFileHandle(nextFileName, {create: true});
        if (typeof nextFileHandle === 'undefined') {
            return false;
        }
        const created = this._createShardState(
            nextFileName,
            nextFileHandle,
            0,
            state.sharedContentDictName,
            nextSegmentIndex,
            logicalKey,
        );
        this._shardStateByFileName.set(nextFileName, created);
        this._activeAppendShardStateByKey.set(logicalKey, created);
        return true;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _drainQueuedWritesForShard(state) {
        try {
            ++this._writeDrainMetrics.drainCycleCount;
            while (state.queuedWriteChunks.length > 0) {
                const chunks = state.queuedWriteChunks;
                state.queuedWriteChunks = [];
                state.queuedWriteBytes = 0;
                await this._writeChunksForShard(state, chunks);
            }
        } catch (error) {
            state.queuedWriteError = error instanceof Error ? error : new Error(String(error));
            state.queuedWriteChunks = [];
            state.queuedWriteBytes = 0;
            throw error;
        } finally {
            state.queuedWritePromise = null;
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @param {Uint8Array[]} chunks
     * @returns {Promise<void>}
     */
    async _writeChunksForShard(state, chunks) {
        if (state.writable === null) {
            return;
        }
        let writtenBytes = 0;
        for (const chunk of chunks) {
            if (chunk.byteLength <= 0) { continue; }
            try {
                await /** @type {FileSystemWritableFileStream} */ (state.writable).write(chunk);
                writtenBytes += chunk.byteLength;
            } catch (error) {
                if (!this._isClosingWritableStreamError(error)) {
                    throw error;
                }
                state.writable = null;
                const seekOffset = state.fileLength - this._sumChunkByteLength(chunks) + writtenBytes;
                await this._reopenShardWritable(state, seekOffset);
                if (state.writable === null) {
                    throw error;
                }
                await /** @type {FileSystemWritableFileStream} */ (state.writable).write(chunk);
                writtenBytes += chunk.byteLength;
            }
        }
    }

    /**
     * @param {Uint8Array[]} chunks
     * @returns {number}
     */
    _sumChunkByteLength(chunks) {
        let total = 0;
        for (const chunk of chunks) {
            total += chunk.byteLength;
        }
        return total;
    }

    /**
     * @param {string} dictionaryName
     * @returns {Promise<void>}
     */
    async _deleteShardByDictionary(dictionaryName) {
        if (this._recordsDirectoryHandle === null) {
            return;
        }
        const fileNames = await this._listShardFileNames();
        for (const fileName of fileNames) {
            if (this._decodeDictionaryNameFromShardFileName(fileName) !== dictionaryName) {
                continue;
            }
            const state = this._shardStateByFileName.get(fileName);
            if (typeof state !== 'undefined') {
                await this._flushPendingWritesForShard(state);
                await this._closeShardWritable(state);
            }
            await this._removeStorageFileOrTruncate(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
            await this._removeStorageFileOrTruncate(fileName, false);
            if (typeof state !== 'undefined') {
                this._shardStateByFileName.delete(fileName);
                this._activeAppendShardStateByKey.delete(state.logicalKey);
            }
        }
        this._invalidatePersistentLookupState(dictionaryName);
    }

    /**
     * Removes a storage file, or truncates it when another browser runtime
     * temporarily prevents unlinking an open OPFS handle.
     * @param {string} fileName
     * @param {boolean} allowMissing
     * @returns {Promise<void>}
     * @throws {Error}
     */
    async _removeStorageFileOrTruncate(fileName, allowMissing) {
        if (this._recordsDirectoryHandle === null) { return; }
        try {
            await this._recordsDirectoryHandle.removeEntry(fileName);
            return;
        } catch (removeError) {
            let fileHandle;
            try {
                fileHandle = await this._recordsDirectoryHandle.getFileHandle(fileName, {create: false});
            } catch (lookupError) {
                if (allowMissing) { return; }
                throw new AggregateError(
                    [removeError, lookupError],
                    `Failed to remove or open term-record storage file ${fileName}`,
                );
            }
            try {
                const writable = await fileHandle.createWritable({keepExistingData: true});
                try {
                    await writable.truncate(0);
                } finally {
                    await writable.close();
                }
                const file = await fileHandle.getFile();
                if (file.size > 0) {
                    throw new Error(`Truncated term-record storage file is not empty: ${fileName}`);
                }
                reportDiagnostics('term-record-store-delete-truncated-open-file', {
                    fileName,
                    removeError: removeError instanceof Error ? removeError.message : String(removeError),
                });
            } catch (truncateError) {
                throw new AggregateError(
                    [removeError, truncateError],
                    `Failed to remove or truncate term-record storage file ${fileName}`,
                );
            }
        }
    }

    /**
     * @param {string} fileName
     * @param {FileSystemFileHandle} fileHandle
     * @param {number} fileLength
     * @param {string|null} [sharedContentDictName]
     * @param {number} [segmentIndex=0]
     * @param {string|null} [logicalKey=null]
     * @returns {TermRecordShardState}
     */
    _createShardState(fileName, fileHandle, fileLength, sharedContentDictName = null, segmentIndex = 0, logicalKey = null) {
        return {
            fileName,
            fileHandle,
            writable: null,
            fileLength,
            pendingWriteBytes: 0,
            pendingWriteChunks: [],
            queuedWriteBytes: 0,
            queuedWritePromise: null,
            queuedWriteError: null,
            queuedWriteChunks: [],
            importWriteStarted: false,
            sharedContentDictName,
            segmentIndex,
            logicalKey: logicalKey ?? fileName,
            initialFileLength: fileLength,
            pendingLookupIndexChunks: [],
            pendingLookupIndexBytes: 0,
            pendingLookupIndexRecordCount: 0,
            lookupIndexFileHandle: null,
            lookupIndexWritable: null,
            lookupIndexChunkCount: 0,
            lookupIndexRecordCount: 0,
            lookupIndexQueuedBytes: 0,
            lookupIndexMaxQueuedBytes: 0,
            lookupIndexWritePromise: null,
            lookupIndexWriteError: null,
            appendFormatValidated: fileLength === 0,
            generationId: this._createShardGenerationId(),
        };
    }

    /**
     * Prevents a new-format chunk from being appended to an older shard header.
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _validateShardAppendFormat(state) {
        if (state.appendFormatValidated) { return; }
        const file = await state.fileHandle.getFile();
        if (file.size < BINARY_HEADER_PREFIX_BYTES) {
            throw new Error(`Cannot append to truncated term-record shard: ${state.fileName}`);
        }
        const headerBytes = await this._readFileRange(file, 0, BINARY_HEADER_PREFIX_BYTES);
        const magic = this._textDecoder.decode(headerBytes.subarray(0, BINARY_MAGIC_BYTES));
        if (magic !== BINARY_MAGIC_TEXT) {
            throw new Error(`Cannot append ${BINARY_MAGIC_TEXT} records to ${magic || 'unknown'} shard: ${state.fileName}`);
        }
        state.generationId = new Uint8Array(headerBytes.subarray(BINARY_MAGIC_BYTES));
        state.appendFormatValidated = true;
    }

    /**
     * @param {string} dictionaryName
     * @returns {string|null}
     */
    /**
     * @returns {number}
     */
    _computeFlushThresholdBytes() {
        /** @type {number|null} */
        let memoryGiB = null;
        try {
            const rawValue = /** @type {unknown} */ (Reflect.get(globalThis.navigator ?? {}, 'deviceMemory'));
            if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
                memoryGiB = rawValue;
            }
        } catch (_) {
            // NOP
        }
        if (memoryGiB !== null) {
            if (memoryGiB <= 4) {
                return LOW_MEMORY_FLUSH_THRESHOLD_BYTES;
            }
            if (memoryGiB >= 8) {
                return HIGH_MEMORY_FLUSH_THRESHOLD_BYTES;
            }
        }
        return DEFAULT_FLUSH_THRESHOLD_BYTES;
    }

    /**
     * @returns {number}
     */
    _computeQueuedWriteBudgetBytes() {
        /** @type {number|null} */
        let memoryGiB = null;
        try {
            const rawValue = /** @type {unknown} */ (Reflect.get(globalThis.navigator ?? {}, 'deviceMemory'));
            if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
                memoryGiB = rawValue;
            }
        } catch (_) {
            // NOP
        }
        if (memoryGiB !== null) {
            if (memoryGiB <= 4) {
                return LOW_MEMORY_QUEUED_WRITE_BUDGET_BYTES;
            }
            if (memoryGiB >= 8) {
                return HIGH_MEMORY_QUEUED_WRITE_BUDGET_BYTES;
            }
        }
        return DEFAULT_QUEUED_WRITE_BUDGET_BYTES;
    }


    /**
     * @returns {number}
     */
    _computeWriteCoalesceTargetBytes() {
        if (
            this._expectedImportBytes !== null &&
            this._expectedImportBytes >= LARGE_IMPORT_EXPECTED_BYTES_THRESHOLD
        ) {
            return LARGE_IMPORT_WRITE_COALESCE_TARGET_BYTES;
        }
        /** @type {number|null} */
        let memoryGiB = null;
        try {
            const rawValue = /** @type {unknown} */ (Reflect.get(globalThis.navigator ?? {}, 'deviceMemory'));
            if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
                memoryGiB = rawValue;
            }
        } catch (_) {
            // NOP
        }
        if (memoryGiB !== null) {
            if (memoryGiB <= 4) {
                return LOW_MEMORY_WRITE_COALESCE_TARGET_BYTES;
            }
            if (memoryGiB >= 8) {
                return HIGH_MEMORY_WRITE_COALESCE_TARGET_BYTES;
            }
        }
        return DEFAULT_WRITE_COALESCE_TARGET_BYTES;
    }

    /**
     * @param {Uint8Array[]} chunks
     * @returns {Uint8Array[]}
     */
    _coalescePendingChunks(chunks) {
        const targetBytes = this._writeCoalesceTargetBytes;
        if (chunks.length <= 1 || targetBytes <= 0) {
            if (chunks.length === 1 && chunks[0].byteLength > 0) {
                this._recordWriteDrainGroupMetrics(chunks[0].byteLength, 1, false);
            }
            return chunks;
        }
        /** @type {Uint8Array[]} */
        const result = [];
        /** @type {Uint8Array[]} */
        let group = [];
        let groupBytes = 0;
        for (const chunk of chunks) {
            const chunkBytes = chunk.byteLength;
            if (chunkBytes <= 0) { continue; }
            if (groupBytes > 0 && (groupBytes + chunkBytes > targetBytes || group.length >= WRITE_COALESCE_MAX_CHUNKS)) {
                this._recordWriteDrainGroupMetrics(groupBytes, group.length, group.length > 1);
                result.push(this._mergeChunks(group, groupBytes));
                group = [];
                groupBytes = 0;
            }
            if (chunkBytes >= targetBytes) {
                if (groupBytes > 0) {
                    this._recordWriteDrainGroupMetrics(groupBytes, group.length, group.length > 1);
                    result.push(this._mergeChunks(group, groupBytes));
                    group = [];
                    groupBytes = 0;
                }
                this._recordWriteDrainGroupMetrics(chunkBytes, 1, false);
                result.push(chunk);
                continue;
            }
            group.push(chunk);
            groupBytes += chunkBytes;
        }
        if (groupBytes > 0) {
            this._recordWriteDrainGroupMetrics(groupBytes, group.length, group.length > 1);
            result.push(this._mergeChunks(group, groupBytes));
        }
        return result;
    }

    /**
     * @param {number} byteLength
     * @param {number} chunkCount
     * @param {boolean} merged
     * @returns {void}
     */
    _recordWriteDrainGroupMetrics(byteLength, chunkCount, merged) {
        if (byteLength <= 0 || chunkCount <= 0) { return; }
        ++this._writeDrainMetrics.writeCallCount;
        this._writeDrainMetrics.totalWriteBytes += byteLength;
        if (byteLength > this._writeDrainMetrics.maxWriteBytes) {
            this._writeDrainMetrics.maxWriteBytes = byteLength;
        }
        if (this._writeDrainMetrics.minWriteBytes === 0 || byteLength < this._writeDrainMetrics.minWriteBytes) {
            this._writeDrainMetrics.minWriteBytes = byteLength;
        }
        if (!merged) {
            ++this._writeDrainMetrics.singleChunkWriteCount;
            return;
        }
        ++this._writeDrainMetrics.mergedWriteCount;
        this._writeDrainMetrics.mergedWriteBytes += byteLength;
        this._writeDrainMetrics.mergedGroupChunkCount += chunkCount;
        if (chunkCount > this._writeDrainMetrics.maxMergedGroupChunkCount) {
            this._writeDrainMetrics.maxMergedGroupChunkCount = chunkCount;
        }
        if (
            this._writeDrainMetrics.minMergedGroupChunkCount === 0 ||
            chunkCount < this._writeDrainMetrics.minMergedGroupChunkCount
        ) {
            this._writeDrainMetrics.minMergedGroupChunkCount = chunkCount;
        }
    }

    /**
     * @returns {{drainCycleCount: number, writeCallCount: number, singleChunkWriteCount: number, mergedWriteCount: number, totalWriteBytes: number, mergedWriteBytes: number, maxWriteBytes: number, minWriteBytes: number, mergedGroupChunkCount: number, maxMergedGroupChunkCount: number, minMergedGroupChunkCount: number, writeCoalesceTargetBytes: number}}
     */
    _createEmptyWriteDrainMetrics() {
        return {
            drainCycleCount: 0,
            writeCallCount: 0,
            singleChunkWriteCount: 0,
            mergedWriteCount: 0,
            totalWriteBytes: 0,
            mergedWriteBytes: 0,
            maxWriteBytes: 0,
            minWriteBytes: 0,
            mergedGroupChunkCount: 0,
            maxMergedGroupChunkCount: 0,
            minMergedGroupChunkCount: 0,
            writeCoalesceTargetBytes: this._writeCoalesceTargetBytes,
        };
    }

    /**
     * @returns {{writeCallCount: number, writeBytes: number, awaitMs: number, maxQueuedBytes: number}}
     */
    _createEmptyLookupIndexWriteMetrics() {
        return {
            writeCallCount: 0,
            writeBytes: 0,
            awaitMs: 0,
            maxQueuedBytes: 0,
        };
    }

    /**
     * @param {Uint8Array[]} chunks
     * @param {number} totalBytes
     * @returns {Uint8Array}
     */
    _mergeChunks(chunks, totalBytes) {
        if (chunks.length === 1) {
            return chunks[0];
        }
        const output = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return output;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} [contentDictName='raw']
     * @returns {string}
     */
    _getShardFileName(dictionaryName, contentDictName = 'raw') {
        const normalizedContentDictName = this._normalizeContentDictName(contentDictName);
        const encodedDictionaryName = encodeURIComponent(dictionaryName);
        if (normalizedContentDictName === 'raw') {
            return `${SHARD_FILE_PREFIX}${encodedDictionaryName}${SHARD_FILE_SUFFIX}`;
        }
        const encodedContentDictName = encodeURIComponent(normalizedContentDictName);
        return `${SHARD_FILE_PREFIX}${encodedDictionaryName.length}${SHARD_FILE_CONTENT_DICT_SEPARATOR}${encodedDictionaryName}${encodedContentDictName}${SHARD_FILE_SUFFIX}`;
    }

    /**
     * @param {string} dictionaryName
     * @param {string} [contentDictName='raw']
     * @param {number} [segmentIndex=0]
     * @returns {string}
     */
    _getShardSegmentFileName(dictionaryName, contentDictName = 'raw', segmentIndex = 0) {
        const baseFileName = this._getShardFileName(dictionaryName, contentDictName);
        if (segmentIndex <= 0) {
            return baseFileName;
        }
        return `${baseFileName.slice(0, -SHARD_FILE_SUFFIX.length)}${SHARD_FILE_SEGMENT_SEPARATOR}${segmentIndex}${SHARD_FILE_SUFFIX}`;
    }

    /**
     * @param {string} fileName
     * @returns {boolean}
     */
    _isShardFileName(fileName) {
        return fileName.startsWith(SHARD_FILE_PREFIX) && fileName.endsWith(SHARD_FILE_SUFFIX);
    }

    /**
     * @param {string} fileName
     * @returns {string|null}
     */
    _decodeDictionaryNameFromShardFileName(fileName) {
        if (!this._isShardFileName(fileName)) {
            return null;
        }
        return this._decodeShardInfoFromShardFileName(fileName)?.dictionaryName ?? null;
    }

    /**
     * @param {string|null|undefined} contentDictName
     * @returns {string}
     */
    _normalizeContentDictName(contentDictName) {
        return (typeof contentDictName === 'string' && contentDictName.length > 0) ? contentDictName : 'raw';
    }

    /**
     * @param {string} fileName
     * @returns {{dictionaryName: string, contentDictName: string, segmentIndex: number}|null}
     */
    _decodeShardInfoFromShardFileName(fileName) {
        if (!this._isShardFileName(fileName)) {
            return null;
        }
        let encoded = fileName.slice(SHARD_FILE_PREFIX.length, fileName.length - SHARD_FILE_SUFFIX.length);
        let segmentIndex = 0;
        const segmentSeparatorIndex = encoded.lastIndexOf(SHARD_FILE_SEGMENT_SEPARATOR);
        if (segmentSeparatorIndex > 0) {
            const segmentValue = encoded.slice(segmentSeparatorIndex + SHARD_FILE_SEGMENT_SEPARATOR.length);
            if (/^[0-9]+$/.test(segmentValue)) {
                segmentIndex = Number.parseInt(segmentValue, 10);
                encoded = encoded.slice(0, segmentSeparatorIndex);
            }
        }
        const separatorIndex = encoded.indexOf(SHARD_FILE_CONTENT_DICT_SEPARATOR);
        try {
            if (separatorIndex <= 0) {
                const dictionaryName = decodeURIComponent(encoded);
                return dictionaryName.length > 0 ? {dictionaryName, contentDictName: 'raw', segmentIndex} : null;
            }
            const dictionaryLength = Number.parseInt(encoded.slice(0, separatorIndex), 10);
            if (!Number.isFinite(dictionaryLength) || dictionaryLength < 0) {
                return null;
            }
            const payload = encoded.slice(separatorIndex + SHARD_FILE_CONTENT_DICT_SEPARATOR.length);
            if (payload.length < dictionaryLength) {
                return null;
            }
            const dictionaryName = decodeURIComponent(payload.slice(0, dictionaryLength));
            const contentDictName = decodeURIComponent(payload.slice(dictionaryLength));
            if (dictionaryName.length === 0) {
                return null;
            }
            return {
                dictionaryName,
                contentDictName: contentDictName.length > 0 ? contentDictName : 'raw',
                segmentIndex,
            };
        } catch (_) {
            return null;
        }
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {void}
     */
    _setActiveAppendShardState(state) {
        const existing = this._activeAppendShardStateByKey.get(state.logicalKey);
        if (typeof existing === 'undefined' || existing.segmentIndex <= state.segmentIndex) {
            this._activeAppendShardStateByKey.set(state.logicalKey, state);
        }
    }

    /** */
    _ensureIndexesReady() {
        if (!this._indexDirty) {
            return;
        }
        this._indexByDictionary.clear();
        this._indexDirty = false;
    }

    /** */
    _rebuildIndexesFromRecords() {
        this._indexByDictionary.clear();
        for (const record of this._recordsById.values()) {
            this._addToIndex(record);
        }
        this._indexDirty = false;
    }

    /**
     * @param {TermRecord} record
     */
    _addToIndex(record) {
        this._addRecordToDictionaryIndex(this._getOrCreateDictionaryIndex(record.dictionary), record);
    }

    /**
     * @param {string} dictionaryName
     * @param {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}} index
     */
    _addDictionaryRecordsToIndex(dictionaryName, index) {
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName);
        if (typeof ids !== 'undefined') {
            const records = this._recordsById.getRawRecords();
            for (let i = 0, ii = ids.length; i < ii; ++i) {
                const record = records[ids[i]];
                if (typeof record !== 'undefined') {
                    this._addRecordToDictionaryIndex(index, record);
                }
            }
            return;
        }
        for (const record of this._recordsById.values()) {
            if (record.dictionary === dictionaryName) {
                this._addRecordToDictionaryIndex(index, record);
            }
        }
    }

    /**
     * @param {string} dictionaryName
     * @param {{expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>}} index
     */
    _addDictionaryRecordsToReverseIndex(dictionaryName, index) {
        const ids = this._getLiveRecordIdsForDictionary(dictionaryName);
        if (typeof ids !== 'undefined') {
            const records = this._recordsById.getRawRecords();
            for (let i = 0, ii = ids.length; i < ii; ++i) {
                const record = records[ids[i]];
                if (typeof record !== 'undefined') {
                    this._addRecordReverseToDictionaryIndex(index, record);
                }
            }
            return;
        }
        for (const record of this._recordsById.values()) {
            if (record.dictionary === dictionaryName) {
                this._addRecordReverseToDictionaryIndex(index, record);
            }
        }
    }

    /**
     * @param {{expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>}} index
     * @param {TermRecord} record
     */
    _addRecordReverseToDictionaryIndex(index, record) {
        this._ensureDecodedRecordStrings(record);
        const expression = record.expression ?? '';
        const reading = record.reading ?? expression;
        if (record.expressionReverse === null || typeof record.expressionReverse === 'undefined') {
            record.expressionReverse = this._reverseString(expression);
        }
        if (record.expressionReverse !== null) {
            const expressionReverseList = index.expressionReverse.get(record.expressionReverse);
            if (typeof expressionReverseList === 'undefined') {
                index.expressionReverse.set(record.expressionReverse, [record.id]);
            } else {
                expressionReverseList.push(record.id);
            }
        }
        if (reading !== expression && (record.readingReverse === null || typeof record.readingReverse === 'undefined')) {
            record.readingReverse = this._reverseString(reading);
        }
        if (reading !== expression && record.readingReverse !== null && typeof record.readingReverse !== 'undefined') {
            const readingReverseList = index.readingReverse.get(record.readingReverse);
            if (typeof readingReverseList === 'undefined') {
                index.readingReverse.set(record.readingReverse, [record.id]);
            } else {
                readingReverseList.push(record.id);
            }
        }
    }

    /**
     * @param {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}} index
     * @param {TermRecord} record
     */
    _addRecordToDictionaryIndex(index, record) {
        this._ensureDecodedRecordStrings(record);
        const expression = record.expression ?? '';
        const reading = record.reading ?? expression;
        this._addDecodedRecordToDictionaryIndex(index, record, expression, reading);
    }

    /**
     * @param {{expression: Map<string, number[]>, reading: Map<string, number[]>, expressionReverse: Map<string, number[]>, readingReverse: Map<string, number[]>, sequence: Map<number, number[]>}} index
     * @param {TermRecord} record
     * @param {string} expression
     * @param {string} reading
     */
    _addDecodedRecordToDictionaryIndex(index, record, expression, reading) {
        const expressionList = index.expression.get(expression);
        if (typeof expressionList === 'undefined') {
            index.expression.set(expression, [record.id]);
        } else {
            expressionList.push(record.id);
        }

        if (reading !== expression) {
            const readingList = index.reading.get(reading);
            if (typeof readingList === 'undefined') {
                index.reading.set(reading, [record.id]);
            } else {
                readingList.push(record.id);
            }
        }
        if (this._reverseIndexReady.has(index)) {
            this._addRecordReverseToDictionaryIndex(index, record);
        }
        if (typeof record.sequence === 'number' && record.sequence >= 0) {
            const sequenceList = index.sequence.get(record.sequence);
            if (typeof sequenceList === 'undefined') {
                index.sequence.set(record.sequence, [record.id]);
            } else {
                sequenceList.push(record.id);
            }
        }
    }

    /**
     * @param {TermRecord} record
     * @returns {void}
     */
    _ensureDecodedRecordStrings(record) {
        if ((typeof record.expression !== 'string' || record.expression.length === 0) && record.expressionBytes instanceof Uint8Array && record.expressionBytes.byteLength > 0) {
            record.expression = this._decodeString(record.expressionBytes, 0, record.expressionBytes.byteLength);
        }
        if (typeof record.expression !== 'string') {
            record.expression = '';
        }
        if (typeof record.reading !== 'string' || record.reading.length === 0) {
            if (record.readingEqualsExpression === true) {
                record.reading = record.expression;
            } else if (record.readingBytes instanceof Uint8Array && record.readingBytes.byteLength > 0) {
                record.reading = this._decodeString(record.readingBytes, 0, record.readingBytes.byteLength);
            } else if (typeof record.reading !== 'string') {
                record.reading = '';
            }
        }
    }

    /**
     * @param {unknown} value
     * @param {number} fallback
     * @returns {number}
     */
    _asNumber(value, fallback) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return fallback;
    }

    /**
     * @param {unknown} value
     * @returns {number|null}
     */
    _asNullableNumber(value) {
        if (value === null || typeof value === 'undefined') {
            return null;
        }
        return this._asNumber(value, 0);
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    _asString(value) {
        return typeof value === 'string' ? value : '';
    }

    /**
     * @param {unknown} value
     * @returns {string|null}
     */
    _asNullableString(value) {
        if (value === null || typeof value === 'undefined') {
            return null;
        }
        return this._asString(value);
    }
}
