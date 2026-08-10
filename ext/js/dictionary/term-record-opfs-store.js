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
    findPrefixRows,
    findSequenceRows,
    getPersistedTermKeyBytes,
    hashTermLookupKeyBytes,
    parsePersistedTermLookupIndex,
    warmPersistedTermPrefixIndex,
} from './term-lookup-index.js';
import {encodeTermRecordArtifactChunkWithWasmPreinterned, encodeTermRecordsWithWasm, encodeTermRecordsWithWasmPreinterned} from './term-record-wasm-encoder.js';

const SHARD_DIRECTORY_NAME = 'manabitan-term-records';
const SHARD_FILE_PREFIX = 'dict-';
const SHARD_FILE_SUFFIX = '.mbtr';
const LOOKUP_INDEX_FILE_SUFFIX = '.mbti';
const SHARD_FILE_CONTENT_DICT_SEPARATOR = '|';
const SHARD_FILE_SEGMENT_SEPARATOR = '^';
const BINARY_MAGIC_TEXT = 'MBTRR12B';
const BINARY_MAGIC_BYTES = 8;
const CHUNK_HEADER_BYTES = 16;
const STRING_TABLE_HEADER_BYTES = 8;
const RECORD_HEADER_BYTES = 24;
const U32_NULL = 0xffffffff;
const MAX_CONTENT_OFFSET_DELTA = U32_NULL - 1;
const U32_RANGE = 0x100000000;
const U16_NULL = 0xffff;
const READING_EQUALS_EXPRESSION_U32 = 0xffffffff;
const DEFAULT_FLUSH_THRESHOLD_BYTES = 32 * 1024 * 1024;
const LOW_MEMORY_FLUSH_THRESHOLD_BYTES = 16 * 1024 * 1024;
const PREFIX_WARM_YIELD_BUDGET_MS = 8;
const HIGH_MEMORY_FLUSH_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_QUEUED_WRITE_BUDGET_BYTES = 64 * 1024 * 1024;
const LOW_MEMORY_QUEUED_WRITE_BUDGET_BYTES = 24 * 1024 * 1024;
const HIGH_MEMORY_QUEUED_WRITE_BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_WRITE_COALESCE_TARGET_BYTES = 4 * 1024 * 1024;
const LOW_MEMORY_WRITE_COALESCE_TARGET_BYTES = 1024 * 1024;
const HIGH_MEMORY_WRITE_COALESCE_TARGET_BYTES = 32 * 1024 * 1024;
const LARGE_IMPORT_EXPECTED_BYTES_THRESHOLD = 512 * 1024 * 1024;
const LARGE_IMPORT_WRITE_COALESCE_TARGET_BYTES = 64 * 1024 * 1024;
const WRITE_COALESCE_MAX_CHUNKS = 512;
const MAX_SHARD_SEGMENT_FILE_BYTES = 1024 * 1024 * 1024;
const SHARD_LOAD_CONCURRENCY = 3;
const LOOKUP_INDEX_MAGIC_TEXT = 'MBTIDX06';
const LOOKUP_INDEX_MAGIC_BYTES = 8;
const LOOKUP_INDEX_FILE_HEADER_BYTES = 24;
const LOOKUP_INDEX_CHUNK_HEADER_BYTES = 32;
const LOOKUP_INDEX_FLUSH_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MAX_COMPACT_LOOKUP_INDEX_ROWS = 30000;
const PERSISTED_ONLY_IMPORT_ROW_THRESHOLD = 250000;

/**
 * @param {unknown[]} rows
 * @returns {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}
 */
function getTermRecordPreinternedPlan(rows) {
    const value = /** @type {{termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}} */ (/** @type {unknown} */ (rows)).termRecordPreinternedPlan;
    return value ?? null;
}

/**
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} plan
 * @param {number[]} indexes
 * @returns {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}
 */
function selectTermRecordPreinternedPlan(plan, indexes) {
    if (plan === null) { return null; }
    const count = indexes.length;
    const expressionIndexes = new Uint32Array(count);
    const readingIndexes = new Uint32Array(count);
    for (let i = 0; i < count; ++i) {
        const sourceIndex = indexes[i];
        expressionIndexes[i] = plan.expressionIndexes[sourceIndex];
        readingIndexes[i] = plan.readingIndexes[sourceIndex];
    }
    return {
        stringLengths: plan.stringLengths,
        stringOffsets: plan.stringOffsets,
        stringHashes: plan.stringHashes,
        stringsBuffer: plan.stringsBuffer,
        expressionIndexes,
        readingIndexes,
    };
}

/**
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} plan
 * @param {number} start
 * @param {number} count
 * @returns {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}
 */
function sliceTermRecordPreinternedPlan(plan, start, count) {
    if (plan === null) { return null; }
    const end = start + count;
    return {
        stringLengths: plan.stringLengths,
        stringOffsets: plan.stringOffsets,
        stringHashes: plan.stringHashes,
        stringsBuffer: plan.stringsBuffer,
        expressionIndexes: plan.expressionIndexes.subarray(start, end),
        readingIndexes: plan.readingIndexes.subarray(start, end),
    };
}

/**
 * Copies and remaps only the strings referenced by a row slice.
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} plan
 * @param {number} start
 * @param {number} count
 * @param {Uint32Array} remapScratch
 * @returns {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}
 * @throws {RangeError} If the requested row range or scratch buffer is invalid.
 */
function compactTermRecordPreinternedPlan(plan, start, count, remapScratch) {
    if (plan === null) { return null; }
    if (
        start < 0 || count < 0 ||
        (start + count) > plan.expressionIndexes.length ||
        (start + count) > plan.readingIndexes.length ||
        remapScratch.length < plan.stringLengths.length
    ) {
        throw new RangeError('Invalid preinterned plan compaction range');
    }
    const referencedOldIndexes = [];
    const expressionIndexes = new Uint32Array(count);
    const readingIndexes = new Uint32Array(count);
    try {
        for (let i = 0; i < count; ++i) {
            const sourceIndex = start + i;
            const expressionOldIndex = plan.expressionIndexes[sourceIndex];
            const readingOldIndex = plan.readingIndexes[sourceIndex];
            if (expressionOldIndex >= plan.stringLengths.length) {
                throw new RangeError(`Preinterned string index out of bounds: ${expressionOldIndex}`);
            }
            let expressionRemap = remapScratch[expressionOldIndex];
            if (expressionRemap === 0) {
                referencedOldIndexes.push(expressionOldIndex);
                expressionRemap = referencedOldIndexes.length;
                remapScratch[expressionOldIndex] = expressionRemap;
            }
            expressionIndexes[i] = expressionRemap - 1;

            if (readingOldIndex >= plan.stringLengths.length) {
                throw new RangeError(`Preinterned string index out of bounds: ${readingOldIndex}`);
            }
            let readingRemap = remapScratch[readingOldIndex];
            if (readingRemap === 0) {
                referencedOldIndexes.push(readingOldIndex);
                readingRemap = referencedOldIndexes.length;
                remapScratch[readingOldIndex] = readingRemap;
            }
            readingIndexes[i] = readingRemap - 1;
        }
    } finally {
        for (const oldIndex of referencedOldIndexes) {
            remapScratch[oldIndex] = 0;
        }
    }
    const stringLengths = new Uint16Array(referencedOldIndexes.length);
    const stringOffsets = new Uint32Array(referencedOldIndexes.length);
    const stringHashes = plan.stringHashes instanceof Uint32Array ?
        new Uint32Array(referencedOldIndexes.length) :
        void 0;
    const sourceStringHashes = plan.stringHashes;
    let sourceStringOffsets = plan.stringOffsets;
    if (!(sourceStringOffsets instanceof Uint32Array) || sourceStringOffsets.length !== plan.stringLengths.length) {
        sourceStringOffsets = new Uint32Array(plan.stringLengths.length);
        let sourceOffset = 0;
        for (let i = 0; i < plan.stringLengths.length; ++i) {
            sourceStringOffsets[i] = sourceOffset;
            sourceOffset += plan.stringLengths[i];
        }
    }
    let stringsByteLength = 0;
    for (let i = 0; i < referencedOldIndexes.length; ++i) {
        const oldIndex = referencedOldIndexes[i];
        stringOffsets[i] = stringsByteLength;
        stringLengths[i] = plan.stringLengths[oldIndex];
        if (stringHashes instanceof Uint32Array && sourceStringHashes instanceof Uint32Array) {
            stringHashes[i] = sourceStringHashes[oldIndex];
        }
        stringsByteLength += stringLengths[i];
    }
    const stringsBuffer = new Uint8Array(stringsByteLength);
    let cursor = 0;
    for (const oldIndex of referencedOldIndexes) {
        const oldOffset = sourceStringOffsets[oldIndex];
        const length = plan.stringLengths[oldIndex];
        stringsBuffer.set(plan.stringsBuffer.subarray(oldOffset, oldOffset + length), cursor);
        cursor += length;
    }
    return {
        stringLengths,
        stringOffsets,
        stringHashes,
        stringsBuffer,
        expressionIndexes,
        readingIndexes,
    };
}

/**
 * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} plan
 * @param {number} count
 * @returns {plan is import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}
 */
function hasCompleteTermRecordPreinternedPlan(plan, count) {
    return (
        plan !== null &&
        plan.stringLengths instanceof Uint16Array &&
        plan.stringsBuffer instanceof Uint8Array &&
        plan.expressionIndexes instanceof Uint32Array &&
        plan.readingIndexes instanceof Uint32Array &&
        plan.expressionIndexes.length >= count &&
        plan.readingIndexes.length >= count
    );
}

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
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.byteLength; ++i) {
        hash = Math.imul(hash ^ bytes[i], 0x01000193);
    }
    return hash >>> 0;
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 */
function hashTermRecordFixedFields(view, offset) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < RECORD_HEADER_BYTES; i += 4) {
        hash = Math.imul(hash ^ view.getUint32(offset + i, true), 0x01000193);
    }
    return hash >>> 0;
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
 * @property {boolean} appendFormatValidated
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
 * @property {number} chunkHeaderHash
 * @property {Uint8Array} recordFixedFieldsHashes
 * @property {import('./term-lookup-index.js').PersistedTermLookupIndex} lookupIndex
 */

/**
 * @typedef {object} TermRecordRenamePlan
 * @property {TermRecordShardState} state
 * @property {{dictionaryName: string, contentDictName: string, segmentIndex: number}} shardInfo
 * @property {string} nextFileName
 * @property {FileSystemFileHandle} nextFileHandle
 * @property {ArrayBuffer} bytes
 * @property {number} fileSize
 * @property {ArrayBuffer|null} indexBytes
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
        /** @type {number} */
        this._persistentLookupGeneration = 0;
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
        /** @type {{flushPendingWritesMs: number, awaitQueuedWritesMs: number, closeWritableMs: number, totalMs: number, drainCycleCount: number, writeCallCount: number, singleChunkWriteCount: number, mergedWriteCount: number, totalWriteBytes: number, mergedWriteBytes: number, maxWriteBytes: number, minWriteBytes: number, mergedGroupChunkCount: number, maxMergedGroupChunkCount: number, minMergedGroupChunkCount: number, writeCoalesceTargetBytes: number}|null} */
        this._lastEndImportSessionMetrics = null;
        /** @type {{drainCycleCount: number, writeCallCount: number, singleChunkWriteCount: number, mergedWriteCount: number, totalWriteBytes: number, mergedWriteBytes: number, maxWriteBytes: number, minWriteBytes: number, mergedGroupChunkCount: number, maxMergedGroupChunkCount: number, minMergedGroupChunkCount: number, writeCoalesceTargetBytes: number}} */
        this._writeDrainMetrics = this._createEmptyWriteDrainMetrics();
    }

    /** */
    _invalidateAllPersistentLookupState() {
        ++this._persistentLookupGeneration;
        this._persistentRecordChunksByDictionary.clear();
        this._persistentIndexLoadedDictionaryNames.clear();
        this._persistentIndexLoadPromiseByDictionary.clear();
        this._randomReadChunkMetadataCache.clear();
    }

    /**
     * @param {string} dictionaryName
     */
    _invalidatePersistentLookupState(dictionaryName) {
        ++this._persistentLookupGeneration;
        this._persistentRecordChunksByDictionary.delete(dictionaryName);
        this._persistentIndexLoadedDictionaryNames.delete(dictionaryName);
        this._persistentIndexLoadPromiseByDictionary.delete(dictionaryName);
        this._randomReadChunkMetadataCache.clear();
    }

    /**
     * @returns {Promise<void>}
     */
    async prepare() {
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
        this._loadedDictionaryNames.clear();
        this._allShardContentsLoaded = false;
        this._rootDirectoryHandle = null;
        this._recordsDirectoryHandle = null;
        this._shardStateByFileName.clear();
        this._activeAppendShardStateByKey.clear();
        this._invalidateAllPersistentLookupState();
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
        if (this._importSessionActive) {
            return;
        }
        this._importSessionActive = true;
        this._deferIndexBuild = true;
        this._indexDirty = true;
        this._reloadFromShardsAfterImport = false;
        this._indexByDictionary.clear();
        this._invalidateAllPersistentLookupState();
        this._queuedWriteBudgetBytes = this._computeQueuedWriteBudgetBytes();
        this._writeCoalesceTargetBytes = this._computeWriteCoalesceTargetBytes();
        this._writeDrainMetrics = this._createEmptyWriteDrainMetrics();
        for (const state of this._shardStateByFileName.values()) {
            state.pendingWriteBytes = 0;
            state.pendingWriteChunks = [];
            state.queuedWriteBytes = 0;
            state.queuedWritePromise = null;
            state.queuedWriteError = null;
            state.queuedWriteChunks = [];
            state.initialFileLength = state.fileLength;
            state.pendingLookupIndexChunks = [];
            state.pendingLookupIndexBytes = 0;
            state.pendingLookupIndexRecordCount = 0;
            state.lookupIndexFileHandle = null;
            state.lookupIndexWritable = null;
            state.lookupIndexChunkCount = 0;
            state.lookupIndexRecordCount = 0;
        }
    }

    /**
     * @returns {Promise<import('dictionary-import-journal').TermRecordCheckpoint>}
     */
    async createImportCheckpoint() {
        await this._closeAllWritables();
        if (this._recordsDirectoryHandle === null) { return {shards: []}; }
        const shards = [];
        for (const fileName of await this._listTermRecordStorageFileNames()) {
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
            checkpointByName.set(shard.fileName, shard.fileLength);
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
            await this.prepare();
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
        const wasImportSessionActive = this._importSessionActive;
        const tFlushPendingWritesStart = safePerformance.now();
        if (wasImportSessionActive) {
            await this._flushPendingWrites();
            this._importSessionActive = false;
        } else {
            this._importSessionActive = false;
            await this._flushPendingWrites();
        }
        flushPendingWritesMs = safePerformance.now() - tFlushPendingWritesStart;
        const tAwaitQueuedWritesStart = safePerformance.now();
        await this._awaitQueuedWrites();
        awaitQueuedWritesMs = safePerformance.now() - tAwaitQueuedWritesStart;
        const tCloseWritableStart = safePerformance.now();
        await this._closeAllWritables();
        closeWritableMs = safePerformance.now() - tCloseWritableStart;
        this._deferIndexBuild = false;
        this._lastEndImportSessionMetrics = {
            flushPendingWritesMs,
            awaitQueuedWritesMs,
            closeWritableMs,
            totalMs: safePerformance.now() - tStart,
            ...this._writeDrainMetrics,
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
     * @returns {{flushPendingWritesMs: number, awaitQueuedWritesMs: number, closeWritableMs: number, totalMs: number, drainCycleCount: number, writeCallCount: number, singleChunkWriteCount: number, mergedWriteCount: number, totalWriteBytes: number, mergedWriteBytes: number, maxWriteBytes: number, minWriteBytes: number, mergedGroupChunkCount: number, maxMergedGroupChunkCount: number, minMergedGroupChunkCount: number, writeCoalesceTargetBytes: number}|null}
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
        return this._recordsById.size;
    }

    /**
     * @returns {boolean}
     */
    isEmpty() {
        return this._recordsById.size === 0;
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
     * @param {{dictionary: string, rowCount: number, dictionaryTotalRows?: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number, termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}} chunk
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
        const stableStringOffsets = preinternedPlan?.stringOffsets;
        const stableStringLengths = preinternedPlan?.stringLengths;
        const stableStringsBuffer = preinternedPlan?.stringsBuffer;
        const stableExpressionIndexes = preinternedPlan?.expressionIndexes;
        const stableReadingIndexes = preinternedPlan?.readingIndexes;
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
        const skipRecordMaterialization = (
            this._importSessionActive &&
            (chunk.dictionaryTotalRows ?? count) >= PERSISTED_ONLY_IMPORT_ROW_THRESHOLD
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
        const {bytes, contentOffsetBase, lookupIndexBytes, fixedFieldsHashes} = await this._encodeRecords(records, preinternedPlan);
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
            fixedFieldsHashes,
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
     * @returns {Promise<{encodeMs: number, appendWriteMs: number, validationMs: number, wasmEncodeMs: number, lookupIndexEncodeMs: number}>}
     */
    async _encodeAndAppendArtifactChunkForState(state, chunk, firstId, contentOffsets, contentLengths, preinternedPlan = null, contentDictName = 'raw') {
        let encodeMs = 0;
        let appendWriteMs = 0;
        let validationMs = 0;
        let wasmEncodeMs = 0;
        let lookupIndexEncodeMs = 0;
        const count = chunk.rowCount;
        for (let runStart = 0; runStart < count;) {
            let runEnd = runStart;
            let minContentOffset = Number.POSITIVE_INFINITY;
            let maxContentOffset = Number.NEGATIVE_INFINITY;
            while (runEnd < count) {
                if ((runEnd - runStart) >= MAX_COMPACT_LOOKUP_INDEX_ROWS) {
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
            const runPlan = isWholeChunk ?
                preinternedPlan :
                compactTermRecordPreinternedPlan(
                    preinternedPlan,
                    runStart,
                    runCount,
                    this._getPreinternedCompactionRemap(preinternedPlan?.stringLengths.length ?? 0),
                );
            const tEncodeStart = safePerformance.now();
            const encodedChunk = await this._encodeArtifactChunkRecords(runChunk, runOffsets, runLengths, runPlan);
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
                encodedChunk.fixedFieldsHashes,
            );
            appendWriteMs += safePerformance.now() - tAppendStart;
            runStart = runEnd;
        }
        return {encodeMs, appendWriteMs, validationMs, wasmEncodeMs, lookupIndexEncodeMs};
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
        this._loadedDictionaryNames.delete(dictionaryName);
        this._allShardContentsLoaded = false;
        let deletedCount = 0;
        const ids = [...this._recordsById.keys()];
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
        await Promise.all([
            this._tryLoadPersistentDictionaryIndex(fromName),
            this._tryLoadPersistentDictionaryIndex(toName),
        ]);
        const hasLiveTargetRecords = this._hasRecordsForDictionary(toName);
        if (!hasLiveTargetRecords && !this._indexByDictionary.has(toName)) {
            const removedStaleTargetFiles = await this.cleanupShardFilesByDictionaryPredicate((dictionaryName) => dictionaryName === toName);
            if (removedStaleTargetFiles.length > 0) {
                reportDiagnostics('term-record-store-rename-cleanup-stale-target', {
                    fromName,
                    toName,
                    removedStaleTargetFiles,
                });
            }
        }

        const recordIdsToRename = [];
        for (const id of this._recordsById.keys()) {
            const record = this._recordsById.get(id);
            if (typeof record === 'undefined' || record.dictionary !== fromName) { continue; }
            recordIdsToRename.push(id);
        }
        const renamedCount = recordIdsToRename.length > 0 ?
            recordIdsToRename.length :
            (this._persistentRecordChunksByDictionary.get(fromName) ?? []).reduce((sum, {count}) => sum + count, 0);
        if (renamedCount === 0) {
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
            return renamedCount;
        }
        const sourceStates = [...this._shardStateByFileName.values()]
            .filter((state) => this._decodeDictionaryNameFromShardFileName(state.fileName) === fromName)
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        /** @type {TermRecordRenamePlan[]} */
        const renamePlans = [];
        for (const state of sourceStates) {
            let file;
            try {
                file = await state.fileHandle.getFile();
            } catch (_) {
                continue;
            }
            const shardInfo = this._decodeShardInfoFromShardFileName(state.fileName);
            if (shardInfo === null) { continue; }
            /** @type {ArrayBuffer|null} */
            let indexBytes = null;
            try {
                const indexFileHandle = await this._recordsDirectoryHandle.getFileHandle(
                    `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                    {create: false},
                );
                indexBytes = await (await indexFileHandle.getFile()).arrayBuffer();
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
                                bytes: await file.arrayBuffer(),
                                fileSize: file.size,
                                indexBytes,
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
            }
            renamePlans.push({
                state,
                shardInfo,
                nextFileName,
                nextFileHandle,
                bytes: await file.arrayBuffer(),
                fileSize: file.size,
                indexBytes,
            });
        }
        /**
         * @param {FileSystemFileHandle} fileHandle
         * @param {ArrayBuffer} bytes
         * @returns {Promise<void>}
         */
        const writeShardBytes = async (fileHandle, bytes) => {
            const writable = await fileHandle.createWritable();
            try {
                await writable.truncate(0);
                if (bytes.byteLength > 0) {
                    await writable.write(bytes);
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
                await writeShardBytes(plan.nextFileHandle, plan.bytes);
                if (plan.indexBytes !== null) {
                    const nextIndexHandle = await this._recordsDirectoryHandle.getFileHandle(
                        `${plan.nextFileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                        {create: true},
                    );
                    await writeShardBytes(nextIndexHandle, plan.indexBytes);
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
                    await writeShardBytes(restoredHandle, plan.bytes);
                    if (plan.indexBytes !== null) {
                        const restoredIndexHandle = await this._recordsDirectoryHandle.getFileHandle(
                            `${plan.state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                            {create: true},
                        );
                        await writeShardBytes(restoredIndexHandle, plan.indexBytes);
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

        return renamedCount;
    }

    /**
     * @param {(dictionaryName: string) => boolean} predicate
     * @returns {Promise<string[]>}
     */
    async cleanupShardFilesByDictionaryPredicate(predicate) {
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
            removedDictionaryNames.add(dictionaryName);
            const state = this._shardStateByFileName.get(fileName);
            if (typeof state !== 'undefined') {
                await this._flushPendingWritesForShard(state);
                await this._closeShardWritable(state);
                this._shardStateByFileName.delete(fileName);
                this._activeAppendShardStateByKey.delete(state.logicalKey);
            }
            try {
                await this._recordsDirectoryHandle.removeEntry(fileName);
                removedFileNames.push(fileName);
            } catch (_) {
                // NOP
            }
            try {
                await this._recordsDirectoryHandle.removeEntry(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`);
            } catch (_) {
                // NOP
            }
        }
        if (removedDictionaryNames.size > 0) {
            for (const dictionaryName of removedDictionaryNames) {
                this._loadedDictionaryNames.delete(dictionaryName);
                this._recordIdsByDictionary.delete(dictionaryName);
                this._recordIdStaleDictionaryNames.delete(dictionaryName);
                this._invalidatePersistentLookupState(dictionaryName);
            }
            for (const id of this._recordsById.keys()) {
                const record = this._recordsById.get(id);
                if (typeof record === 'undefined' || !removedDictionaryNames.has(record.dictionary)) {
                    continue;
                }
                this._deleteRecord(id);
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
            const contentOffsetBase = readSafeU64Le(prefixView, 8);
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
     * @param {{fileName: string}} chunk
     * @returns {Promise<void>}
     */
    async _loadShardForRandomReadFallback(chunk) {
        const state = this._shardStateByFileName.get(chunk.fileName);
        if (typeof state === 'undefined') { return; }
        const deferIndexBuild = this._deferIndexBuild;
        this._deferIndexBuild = true;
        try {
            await this._loadShardStateContents(state);
        } finally {
            this._deferIndexBuild = deferIndexBuild;
        }
    }

    /**
     * @param {Iterable<number>} ids
     * @returns {Promise<Map<number, TermRecord>>}
     */
    async getByIdsAsync(ids) {
        const idList = [...ids];
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
        /** @type {Array<[NonNullable<ReturnType<TermRecordOpfsStore['_findPersistentRecordChunk']>>, number[]]>} */
        const fallbackEntries = [];
        let nextChunkIndex = 0;
        const readNextChunk = async () => {
            while (true) {
                const chunkIndex = nextChunkIndex++;
                if (chunkIndex >= chunkEntries.length) { return; }
                const [chunk, chunkIds] = chunkEntries[chunkIndex];
                if (chunk === null) { continue; }
                try {
                    const metadata = await this._loadRandomReadChunkMetadata(chunk);
                    if (metadata === null) { throw new Error(`Invalid term-record chunk metadata for ${chunk.fileName}`); }
                    let minOrdinal = Number.POSITIVE_INFINITY;
                    let maxOrdinal = -1;
                    for (const id of chunkIds) {
                        const ordinal = id - chunk.firstId;
                        minOrdinal = Math.min(minOrdinal, ordinal);
                        maxOrdinal = Math.max(maxOrdinal, ordinal);
                    }
                    const records = await this._readFileRange(
                        metadata.file,
                        metadata.recordsStart + (minOrdinal * RECORD_HEADER_BYTES),
                        metadata.recordsStart + ((maxOrdinal + 1) * RECORD_HEADER_BYTES),
                    );
                    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
                    for (const id of chunkIds) {
                        const ordinal = id - chunk.firstId;
                        let cursor = (ordinal - minOrdinal) * RECORD_HEADER_BYTES;
                        const fixedFieldsOffset = cursor;
                        const expressionIndex = view.getUint32(cursor, true); cursor += 4;
                        const readingIndex = view.getUint32(cursor, true); cursor += 4;
                        const contentOffsetDelta = view.getUint32(cursor, true); cursor += 4;
                        const rawContentLength = view.getUint32(cursor, true); cursor += 4;
                        const score = view.getInt32(cursor, true); cursor += 4;
                        const rawSequence = view.getInt32(cursor, true);
                        if (expressionIndex >= metadata.strings.length) {
                            throw new TermRecordIntegrityError(`Invalid expression index for term record ${id}`);
                        }
                        const expression = metadata.strings[expressionIndex];
                        const reading = readingIndex === READING_EQUALS_EXPRESSION_U32 ?
                            expression :
                            metadata.strings[readingIndex];
                        if (typeof reading !== 'string') {
                            throw new TermRecordIntegrityError(`Invalid reading index for term record ${id}`);
                        }
                        const expectedExpression = getPersistedTermKeyBytes(chunk.lookupIndex, ordinal, 'expression');
                        const expectedReading = getPersistedTermKeyBytes(chunk.lookupIndex, ordinal, 'reading') ?? expectedExpression;
                        const expectedFixedFieldsHash = new DataView(
                            chunk.recordFixedFieldsHashes.buffer,
                            chunk.recordFixedFieldsHashes.byteOffset + (ordinal * 4),
                            4,
                        ).getUint32(0, true);
                        if (
                            expectedExpression === null ||
                            expectedReading === null ||
                            expectedFixedFieldsHash !== hashTermRecordFixedFields(view, fixedFieldsOffset) ||
                            !bytesEqual(expectedExpression, this._textEncoder.encode(expression)) ||
                            !bytesEqual(expectedReading, this._textEncoder.encode(reading))
                        ) {
                            throw new TermRecordIntegrityError(`Term-record checksum mismatch for ${id} in ${chunk.fileName}`);
                        }
                        const entryContentOffset = contentOffsetDelta === U32_NULL ?
                            -1 :
                            metadata.contentOffsetBase + contentOffsetDelta;
                        if (entryContentOffset >= 0 && !Number.isSafeInteger(entryContentOffset)) {
                            throw new Error(`Unsafe content offset for term record ${id}`);
                        }
                        const record = {
                            id,
                            dictionary: chunk.dictionaryName,
                            expression,
                            reading,
                            expressionReverse: null,
                            readingReverse: null,
                            entryContentOffset,
                            entryContentLength: rawContentLength === U32_NULL ? -1 : rawContentLength,
                            entryContentDictName: chunk.contentDictName,
                            score,
                            sequence: rawSequence >= 0 ? rawSequence : null,
                        };
                        this._storeRecord(record);
                        result.set(id, record);
                    }
                } catch (error) {
                    if (error instanceof TermRecordIntegrityError) {
                        reportDiagnostics('term-record-random-read-integrity-error', {
                            fileName: chunk.fileName,
                            firstId: chunk.firstId,
                            count: chunk.count,
                            requestedIds: chunkIds,
                            error: error.message,
                        });
                        throw error;
                    }
                    fallbackEntries.push([chunk, chunkIds]);
                }
            }
        };
        const randomReadConcurrency = Math.min(4, chunkEntries.length);
        const readResults = await Promise.allSettled(
            Array.from({length: randomReadConcurrency}, () => readNextChunk()),
        );
        const failedRead = readResults.find((readResult) => readResult.status === 'rejected');
        if (typeof failedRead !== 'undefined' && failedRead.status === 'rejected') {
            throw failedRead.reason;
        }
        // Serialize corrupt-sidecar fallbacks because multiple chunks can share one shard.
        for (const [chunk, chunkIds] of fallbackEntries) {
            await this._loadShardForRandomReadFallback(chunk);
            for (const id of chunkIds) {
                const record = this._recordsById.get(id);
                if (typeof record !== 'undefined') { result.set(id, record); }
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
        if (content.byteLength < BINARY_MAGIC_BYTES) {
            return null;
        }
        const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
        const magic = this._textDecoder.decode(content.subarray(0, BINARY_MAGIC_BYTES));
        if (magic !== BINARY_MAGIC_TEXT) {
            return null;
        }
        let cursor = BINARY_MAGIC_BYTES;
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
            return true;
        }
        const existing = this._persistentIndexLoadPromiseByDictionary.get(dictionaryName);
        if (typeof existing !== 'undefined') { return await existing; }
        const generation = this._persistentLookupGeneration;
        const load = this._loadPersistentDictionaryIndex(dictionaryName, generation);
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
     * @param {number} generation
     * @returns {Promise<boolean>}
     */
    async _loadPersistentDictionaryIndex(dictionaryName, generation) {
        if (this._persistentIndexLoadedDictionaryNames.has(dictionaryName)) {
            return true;
        }
        if (this._recordsDirectoryHandle === null) { return false; }
        const states = [...this._shardStateByFileName.values()]
            .filter((state) => this._decodeDictionaryNameFromShardFileName(state.fileName) === dictionaryName)
            .sort((a, b) => a.fileName.localeCompare(b.fileName));
        if (states.length === 0) { return false; }
        /** @type {PersistentRecordChunk[]} */
        const recordChunks = [];
        try {
            for (const state of states) {
                const indexFileHandle = await this._recordsDirectoryHandle.getFileHandle(
                    `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`,
                    {create: false},
                );
                const [recordFile, indexFile] = await Promise.all([
                    state.fileHandle.getFile(),
                    indexFileHandle.getFile(),
                ]);
                if (recordFile.size <= 0 || indexFile.size < LOOKUP_INDEX_FILE_HEADER_BYTES) {
                    return false;
                }
                const content = new Uint8Array(await indexFile.arrayBuffer());
                const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
                if (this._textDecoder.decode(content.subarray(0, LOOKUP_INDEX_MAGIC_BYTES)) !== LOOKUP_INDEX_MAGIC_TEXT) {
                    return false;
                }
                const expectedRecordFileLength = readSafeU64Le(view, 8);
                const chunkCount = view.getUint32(16, true);
                const expectedRecordCount = view.getUint32(20, true);
                if (expectedRecordFileLength !== recordFile.size || chunkCount === 0 || expectedRecordCount === 0) {
                    return false;
                }
                let cursor = LOOKUP_INDEX_FILE_HEADER_BYTES;
                let actualRecordCount = 0;
                for (let chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex) {
                    if ((cursor + LOOKUP_INDEX_CHUNK_HEADER_BYTES) > content.byteLength) { return false; }
                    const firstId = view.getUint32(cursor, true); cursor += 4;
                    const count = view.getUint32(cursor, true); cursor += 4;
                    const recordChunkOffset = readSafeU64Le(view, cursor); cursor += 8;
                    const payloadLength = view.getUint32(cursor, true); cursor += 4;
                    const payloadHash = view.getUint32(cursor, true); cursor += 4;
                    const chunkHeaderHash = view.getUint32(cursor, true); cursor += 4;
                    const fixedFieldsHashesHash = view.getUint32(cursor, true); cursor += 4;
                    const payloadEnd = cursor + payloadLength;
                    const fixedFieldsHashesEnd = payloadEnd + (count * 4);
                    if (
                        firstId <= 0 ||
                        count === 0 ||
                        (firstId + count - 1) > 0xffffffff ||
                        (recordChunkOffset + CHUNK_HEADER_BYTES + STRING_TABLE_HEADER_BYTES) > recordFile.size ||
                        fixedFieldsHashesEnd > content.byteLength
                    ) {
                        return false;
                    }
                    const payload = content.subarray(cursor, payloadEnd);
                    if (hashLookupIndexBytes(payload) !== payloadHash) { return false; }
                    const fixedFieldsHashesBytes = content.subarray(payloadEnd, fixedFieldsHashesEnd);
                    if (hashLookupIndexBytes(fixedFieldsHashesBytes) !== fixedFieldsHashesHash) { return false; }
                    const lookupIndex = parsePersistedTermLookupIndex(payload);
                    if (
                        lookupIndex.expressionKeys.length !== count ||
                        lookupIndex.readingKeys.length !== count ||
                        lookupIndex.sequenceValues.length !== count
                    ) {
                        return false;
                    }
                    recordChunks.push({
                        firstId,
                        count,
                        fileName: state.fileName,
                        fileHandle: state.fileHandle,
                        chunkOffset: recordChunkOffset,
                        dictionaryName,
                        contentDictName: state.sharedContentDictName ?? 'raw',
                        chunkHeaderHash,
                        recordFixedFieldsHashes: fixedFieldsHashesBytes,
                        lookupIndex,
                    });
                    actualRecordCount += count;
                    cursor = fixedFieldsHashesEnd;
                }
                if (cursor !== content.byteLength || actualRecordCount !== expectedRecordCount) {
                    return false;
                }
            }
        } catch (_) {
            return false;
        }
        recordChunks.sort((a, b) => a.firstId - b.firstId);
        for (let i = 1; i < recordChunks.length; ++i) {
            if (recordChunks[i].firstId <= (recordChunks[i - 1].firstId + recordChunks[i - 1].count - 1)) {
                return false;
            }
        }
        if (
            generation !== this._persistentLookupGeneration ||
            this._importSessionActive ||
            states.some((state) => this._shardStateByFileName.get(state.fileName) !== state)
        ) {
            return false;
        }
        this._indexByDictionary.delete(dictionaryName);
        this._persistentRecordChunksByDictionary.set(dictionaryName, recordChunks);
        this._persistentIndexLoadedDictionaryNames.add(dictionaryName);
        return true;
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
        return this._persistentIndexLoadedDictionaryNames.has(dictionaryName);
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
            return;
        }
        /** @type {Set<string>} */
        const pending = new Set();
        for (const dictionaryName of dictionaryNames) {
            const name = `${dictionaryName}`.trim();
            if (name.length === 0 || this._loadedDictionaryNames.has(name)) {
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
        /** @type {TermRecordShardState[]} */
        const statesToLoad = [];
        for (const state of this._shardStateByFileName.values()) {
            const dictionaryName = this._decodeDictionaryNameFromShardFileName(state.fileName);
            if (dictionaryName !== null && pending.has(dictionaryName)) {
                statesToLoad.push(state);
            }
        }
        statesToLoad.sort((a, b) => a.fileName.localeCompare(b.fileName));
        await this._loadShardStatesContents(statesToLoad);
        for (const dictionaryName of pending) {
            this._loadedDictionaryNames.add(dictionaryName);
        }
    }

    /**
     * @returns {Promise<void>}
     */
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
            if (dictionaryName !== null && dictionaryName.length > 0) {
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
            const summary = {
                expectedShardCount: 0,
                actualShardCount: this._shardStateByFileName.size,
                missingShardCount: 0,
                missingShardFileNames: [],
                missingDictionaryNames: [],
                orphanShardCount: 0,
                orphanShardFileNames: [],
                orphanDictionaryNames: [],
                removedOrphanShardCount: 0,
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
            if (this._recordsDirectoryHandle !== null) {
                try {
                    await this._recordsDirectoryHandle.removeEntry(fileName);
                    ++removedOrphanShardCount;
                } catch (_) {
                    // NOP
                }
            }
            this._shardStateByFileName.delete(fileName);
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
        if (content.byteLength < BINARY_MAGIC_BYTES) {
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
        if (content.byteLength < BINARY_MAGIC_BYTES || shardDictionaryName === null) {
            return false;
        }
        const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
        const magic = this._textDecoder.decode(content.subarray(0, BINARY_MAGIC_BYTES));
        if (magic !== BINARY_MAGIC_TEXT) {
            return false;
        }
        let cursor = BINARY_MAGIC_BYTES;
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
     * @returns {Promise<{bytes: Uint8Array, contentOffsetBase: number, lookupIndexBytes: Uint8Array, fixedFieldsHashes: Uint8Array|null}>}
     */
    async _encodeRecords(records, preinternedPlan = null) {
        if (records.length === 0) {
            return {
                bytes: new Uint8Array(0),
                contentOffsetBase: 0,
                lookupIndexBytes: new Uint8Array(0),
                fixedFieldsHashes: new Uint8Array(0),
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
                        fixedFieldsHashes: encoded.fixedFieldsHashes,
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
            fixedFieldsHashes: null,
        };
    }

    /**
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array, sequenceList: (number|undefined)[]|Int32Array, fixedContentOffsetBase?: number, fixedContentLength?: number}} chunk
     * @param {number[]|Uint32Array|Float64Array} contentOffsets
     * @param {number[]|Uint32Array} contentLengths
     * @param {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null} [preinternedPlan]
     * @returns {Promise<{bytes: Uint8Array, contentOffsetBase: number, lookupIndexBytes: Uint8Array, fixedFieldsHashes: Uint8Array|null, validationMs: number, wasmEncodeMs: number, lookupIndexEncodeMs: number}>}
     */
    async _encodeArtifactChunkRecords(chunk, contentOffsets, contentLengths, preinternedPlan = null) {
        if (chunk.rowCount === 0) {
            return {
                bytes: new Uint8Array(0),
                contentOffsetBase: 0,
                lookupIndexBytes: new Uint8Array(0),
                fixedFieldsHashes: new Uint8Array(0),
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
                    const lookupIndexBytes = encodePersistedTermLookupIndexFromPreinternedPlan(
                        preinternedPlan,
                        chunk.readingEqualsExpressionList,
                        chunk.sequenceList,
                        chunk.rowCount,
                    );
                    return {
                        bytes: encoded.bytes,
                        contentOffsetBase,
                        lookupIndexBytes,
                        fixedFieldsHashes: encoded.fixedFieldsHashes,
                        validationMs,
                        wasmEncodeMs,
                        lookupIndexEncodeMs: safePerformance.now() - tLookupIndexEncodeStart,
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
            const lookupIndexBytes = encodePersistedTermLookupIndexFromPreinternedPlan(
                preinternedPlan,
                chunk.readingEqualsExpressionList,
                chunk.sequenceList,
                chunk.rowCount,
            );
            return {
                bytes,
                contentOffsetBase,
                lookupIndexBytes,
                fixedFieldsHashes: null,
                validationMs,
                wasmEncodeMs,
                lookupIndexEncodeMs: safePerformance.now() - tLookupIndexEncodeStart,
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
     * @param {number} [contentOffsetBase=0]
     * @param {Uint8Array|null} [lookupIndexBytes=null]
     * @param {Uint8Array|null} [fixedFieldsHashes=null]
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
        fixedFieldsHashes = null,
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
        const binaryHeader = state.fileLength === 0 ? this._createBinaryHeader(state.sharedContentDictName) : null;
        const recordChunkOffset = state.fileLength + (binaryHeader?.byteLength ?? 0);
        const chunks = binaryHeader !== null ?
            [
                binaryHeader,
                this._createChunkHeader(firstId, count, contentOffsetBase),
                chunk,
            ] :
            [
                this._createChunkHeader(firstId, count, contentOffsetBase),
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
                fixedFieldsHashes,
            );
            state.pendingLookupIndexChunks.push(lookupIndexChunk);
            state.pendingLookupIndexBytes += lookupIndexChunk.byteLength;
            state.pendingLookupIndexRecordCount += count;
            if (state.pendingLookupIndexBytes >= LOOKUP_INDEX_FLUSH_THRESHOLD_BYTES) {
                await this._flushPendingLookupIndexChunks(state);
            }
        }

        if (!this._importSessionActive || state.pendingWriteBytes >= this._flushThresholdBytes) {
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
     * @returns {Uint8Array}
     */
    _createBinaryHeader(contentDictName = 'raw') {
        const header = this._textEncoder.encode(BINARY_MAGIC_TEXT);
        const {meta: entryContentDictNameMeta, bytes: entryContentDictNameBytes} = this._encodeEntryContentDictNameMeta(contentDictName);
        const hasExtendedMeta = entryContentDictNameMeta > ENTRY_CONTENT_DICT_NAME_VALUE_MASK;
        const output = new Uint8Array(
            header.byteLength +
            2 +
            (hasExtendedMeta ? 4 : 0) +
            (entryContentDictNameBytes?.byteLength ?? 0),
        );
        output.set(header, 0);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        let cursor = header.byteLength;
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

    /**
     * @param {Uint8Array} payload
     * @param {number} firstId
     * @param {number} count
     * @param {number} [contentOffsetBase=0]
     * @returns {Uint8Array}
     */
    _withChunkHeader(payload, firstId, count, contentOffsetBase = 0) {
        const header = this._createChunkHeader(firstId, count, contentOffsetBase);
        const output = new Uint8Array(header.byteLength + payload.byteLength);
        output.set(header, 0);
        output.set(payload, header.byteLength);
        return output;
    }

    /**
     * @param {number} firstId
     * @param {number} count
     * @param {number} [contentOffsetBase=0]
     * @returns {Uint8Array}
     */
    _createChunkHeader(firstId, count, contentOffsetBase = 0) {
        const output = new Uint8Array(CHUNK_HEADER_BYTES);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        view.setUint32(0, firstId >>> 0, true);
        view.setUint32(4, count >>> 0, true);
        writeSafeU64Le(view, 8, contentOffsetBase);
        return output;
    }

    /**
     * @param {number} firstId
     * @param {number} count
     * @param {number} recordChunkOffset
     * @param {number} contentOffsetBase
     * @param {Uint8Array} payload
     * @param {Uint8Array} recordPayload
     * @param {Uint8Array|null} [precomputedFixedFieldsHashes=null]
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
        precomputedFixedFieldsHashes = null,
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
        let fixedFieldsHashes = precomputedFixedFieldsHashes;
        if (fixedFieldsHashes === null) {
            fixedFieldsHashes = new Uint8Array(count * 4);
            const fixedFieldsHashesView = new DataView(
                fixedFieldsHashes.buffer,
                fixedFieldsHashes.byteOffset,
                fixedFieldsHashes.byteLength,
            );
            for (let i = 0; i < count; ++i) {
                fixedFieldsHashesView.setUint32(
                    i * 4,
                    hashTermRecordFixedFields(recordPayloadView, recordsOffset + (i * RECORD_HEADER_BYTES)),
                    true,
                );
            }
        } else if (fixedFieldsHashes.byteLength !== count * 4) {
            throw new Error('Invalid precomputed term-record fixed-field hashes');
        }
        const output = new Uint8Array(
            LOOKUP_INDEX_CHUNK_HEADER_BYTES +
            payload.byteLength +
            fixedFieldsHashes.byteLength,
        );
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        view.setUint32(0, firstId, true);
        view.setUint32(4, count, true);
        writeSafeU64Le(view, 8, recordChunkOffset);
        view.setUint32(16, payload.byteLength, true);
        view.setUint32(20, hashLookupIndexBytes(payload), true);
        view.setUint32(24, hashLookupIndexBytes(this._createChunkHeader(firstId, count, contentOffsetBase)), true);
        view.setUint32(28, hashLookupIndexBytes(fixedFieldsHashes), true);
        output.set(payload, LOOKUP_INDEX_CHUNK_HEADER_BYTES);
        output.set(fixedFieldsHashes, LOOKUP_INDEX_CHUNK_HEADER_BYTES + payload.byteLength);
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
                state.lookupIndexWritable === null
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
        await this._flushPendingLookupIndexChunks(state);
        const writable = state.lookupIndexWritable;
        if (writable === null) { return; }
        try {
            const header = new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES);
            header.set(this._textEncoder.encode(LOOKUP_INDEX_MAGIC_TEXT), 0);
            const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
            writeSafeU64Le(view, 8, state.fileLength);
            view.setUint32(16, state.lookupIndexChunkCount, true);
            view.setUint32(20, state.lookupIndexRecordCount, true);
            await writable.seek(0);
            await writable.write(header);
        } finally {
            try {
                await writable.close();
            } finally {
                state.lookupIndexWritable = null;
                state.lookupIndexFileHandle = null;
            }
        }
        state.pendingLookupIndexChunks = [];
        state.pendingLookupIndexBytes = 0;
        state.pendingLookupIndexRecordCount = 0;
        state.lookupIndexChunkCount = 0;
        state.lookupIndexRecordCount = 0;
    }

    /**
     * @param {TermRecordShardState} state
     * @returns {Promise<void>}
     */
    async _flushPendingLookupIndexChunks(state) {
        if (state.pendingLookupIndexChunks.length === 0 || this._recordsDirectoryHandle === null) {
            return;
        }
        if (state.lookupIndexWritable === null) {
            const indexFileName = `${state.fileName}${LOOKUP_INDEX_FILE_SUFFIX}`;
            state.lookupIndexFileHandle = await this._recordsDirectoryHandle.getFileHandle(indexFileName, {create: true});
            state.lookupIndexWritable = await state.lookupIndexFileHandle.createWritable();
            await state.lookupIndexWritable.truncate(0);
            await state.lookupIndexWritable.write(new Uint8Array(LOOKUP_INDEX_FILE_HEADER_BYTES));
        }
        const chunks = state.pendingLookupIndexChunks;
        const recordCount = state.pendingLookupIndexRecordCount;
        await state.lookupIndexWritable.write(new Blob(chunks));
        state.lookupIndexChunkCount += chunks.length;
        state.lookupIndexRecordCount += recordCount;
        state.pendingLookupIndexChunks = [];
        state.pendingLookupIndexBytes = 0;
        state.pendingLookupIndexRecordCount = 0;
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
        for (const state of this._shardStateByFileName.values()) {
            await this._awaitQueuedWritesForShard(state);
            await this._closeShardWritable(state);
            await this._flushLookupIndexFile(state);
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
            const header = this._createBinaryHeader(contentDictName);
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
                const chunkHeader = this._createChunkHeader(runRecords[0].id, runRecords.length, encoded.contentOffsetBase);
                await writable.write(chunkHeader);
                await writable.write(encoded.bytes);
                fileLength += chunkHeader.byteLength + encoded.bytes.byteLength;
                runStart = runEnd;
            }
            await writable.close();
            const state = this._createShardState(fileName, fileHandle, fileLength, contentDictName);
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
     * @returns {Promise<void>}
     */
    async _loadShardStateContents(state, existingFile = null) {
        let file = existingFile;
        if (file === null) {
            try {
                file = await state.fileHandle.getFile();
            } catch (_) {
                return;
            }
        }
        state.fileLength = file.size;
        if (file.size <= 0) {
            return;
        }
        const arrayBuffer = await file.arrayBuffer();
        const content = new Uint8Array(arrayBuffer);
        if (
            this._isBinaryFormat(content) &&
            this._loadBinary(content, this._decodeDictionaryNameFromShardFileName(state.fileName))
        ) {
            return;
        }
        this._invalidShardFileNames.push(state.fileName);
        this._shardStateByFileName.delete(state.fileName);
        this._activeAppendShardStateByKey.delete(state.logicalKey);
        if (this._recordsDirectoryHandle !== null) {
            try {
                await this._recordsDirectoryHandle.removeEntry(state.fileName);
            } catch (_) {
                // NOP
            }
        }
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
                state.lookupIndexWritable !== null
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
                this._shardStateByFileName.delete(fileName);
                this._activeAppendShardStateByKey.delete(state.logicalKey);
            }
            await this._removeStorageFileOrTruncate(fileName, false);
            await this._removeStorageFileOrTruncate(`${fileName}${LOOKUP_INDEX_FILE_SUFFIX}`, true);
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
            appendFormatValidated: fileLength === 0,
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
        if (file.size < BINARY_MAGIC_BYTES) {
            throw new Error(`Cannot append to truncated term-record shard: ${state.fileName}`);
        }
        const magicBytes = await this._readFileRange(file, 0, BINARY_MAGIC_BYTES);
        const magic = this._textDecoder.decode(magicBytes);
        if (magic !== BINARY_MAGIC_TEXT) {
            throw new Error(`Cannot append ${BINARY_MAGIC_TEXT} records to ${magic || 'unknown'} shard: ${state.fileName}`);
        }
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
