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

import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    inflateCompressedTermBankSourcesWasm,
    initializeTermBankWasmParser,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from './term-bank-wasm-parser.js';
import {safePerformance} from '../core/safe-performance.js';
import {prepareTermLookupIndexesFromPreinternedPlan} from './term-lookup-index-preparation.js';

/** @typedef {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean, prepareLookupIndexes?: boolean}} ParserOptions */
/** @typedef {{compressionMethod: unknown, compressedSize: unknown, uncompressedSize: unknown, signature: unknown, filename?: unknown}} CompressedSourceMetadata */
/** @typedef {{type: 'initialize', module: unknown}} InitializeRequest */
/** @typedef {{type: 'parse', id: unknown, sourceBuffers: unknown, sourceMetadata?: unknown, sourceSentEpochMs?: unknown, version: unknown, chunkSize?: unknown, options?: unknown}} ParseRequest */

Reflect.set(globalThis, '__manabitanTermBankParserWorker', true);

/** @type {Promise<void>|null} */
let initialization = null;

self.addEventListener('message', onMessage);

/** @param {MessageEvent<unknown>} event */
function onMessage(event) {
    const data = /** @type {InitializeRequest|ParseRequest|null} */ (
        typeof event.data === 'object' ? event.data : null
    );
    if (data?.type === 'initialize') {
        void initialize(data);
    } else if (data?.type === 'parse') {
        void parse(data);
    }
}

/** @param {InitializeRequest} data */
async function initialize(data) {
    try {
        if (!(data.module instanceof WebAssembly.Module)) {
            throw new TypeError('Term-bank parser worker module is invalid');
        }
        setTermBankWasmModule(data.module);
        initialization = initializeTermBankWasmParser();
        await initialization;
        self.postMessage({type: 'ready'});
    } catch (error) {
        self.postMessage({type: 'initialization-error', error: serializeError(error)});
    }
}

/** @param {ParseRequest} data */
async function parse(data) {
    const id = typeof data.id === 'number' && Number.isSafeInteger(data.id) ? data.id : -1;
    const sourceDeliveryMs = Number.isSafeInteger(data.sourceSentEpochMs) && /** @type {number} */ (data.sourceSentEpochMs) >= 0 ?
        Math.max(0, Date.now() - /** @type {number} */ (data.sourceSentEpochMs)) :
        null;
    /** @type {ArrayBuffer[]} */
    const sourceBuffers = [];
    if (Array.isArray(data.sourceBuffers)) {
        for (const value of /** @type {unknown[]} */ (data.sourceBuffers)) {
            if (value instanceof ArrayBuffer) { sourceBuffers.push(value); }
        }
    }
    try {
        if (initialization === null) {
            throw new Error('Term-bank parser worker is not initialized');
        }
        await initialization;
        if (!Array.isArray(data.sourceBuffers) || sourceBuffers.length !== data.sourceBuffers.length) {
            throw new TypeError('Term-bank parser worker source buffers are invalid');
        }
        if (data.version !== 1 && data.version !== 3) {
            throw new TypeError('Term-bank parser worker dictionary version is invalid');
        }
        const chunkSize = typeof data.chunkSize === 'number' && Number.isFinite(data.chunkSize) ? data.chunkSize : void 0;
        const rawOptions = data.options;
        const options = /** @type {ParserOptions} */ (
            typeof rawOptions === 'object' && rawOptions !== null ? rawOptions : {}
        );
        const sourceBytes = sourceBuffers.map((buffer) => new Uint8Array(buffer));
        let preloadedSource;
        if (typeof data.sourceMetadata !== 'undefined') {
            if (!Array.isArray(data.sourceMetadata) || data.sourceMetadata.length !== sourceBytes.length) {
                throw new TypeError('Term-bank parser worker compressed source metadata is invalid');
            }
            const sourceMetadata = /** @type {CompressedSourceMetadata[]} */ (data.sourceMetadata);
            preloadedSource = await inflateCompressedTermBankSourcesWasm(sourceBytes.map((bytes, index) => {
                const metadata = sourceMetadata[index];
                return {
                    bytes,
                    compressionMethod: /** @type {0|8} */ (metadata.compressionMethod),
                    compressedSize: /** @type {number} */ (metadata.compressedSize),
                    uncompressedSize: /** @type {number} */ (metadata.uncompressedSize),
                    signature: /** @type {number} */ (metadata.signature),
                    filename: typeof metadata.filename === 'string' ? metadata.filename : void 0,
                };
            }));
        }
        /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|null} */
        let resultChunk = null;
        let resultRowCount = 0;
        let resultCopyMs = 0;
        let borrowsWorkerMemory = false;
        await parseTermBankWithWasmColumnChunks(
            typeof preloadedSource === 'undefined' ? sourceBytes : new Uint8Array(0),
            data.version,
            (chunk) => {
                if (resultChunk !== null) {
                    throw new Error('Parallel term-bank parser emitted multiple chunks');
                }
                resultRowCount = chunk.rowCount;
                const tResultCopyStart = safePerformance.now();
                // Only the content slab has an explicit release contract. Record
                // fields and lookup metadata can outlive content persistence
                // while record/index writes are still running.
                resultChunk = copyWasmBackedColumnChunk(chunk, true);
                borrowsWorkerMemory = (
                    typeof SharedArrayBuffer === 'function' &&
                    chunk.contentBytesBuffer?.buffer instanceof SharedArrayBuffer &&
                    resultChunk.contentBytesBuffer?.buffer === chunk.contentBytesBuffer.buffer
                );
                resultCopyMs = Math.max(0, safePerformance.now() - tResultCopyStart);
            },
            chunkSize,
            {...options, maxPendingChunks: 1, singleChunk: true, preloadedSource},
        );
        if (resultChunk === null) {
            throw new Error('Parallel term-bank parser did not emit a chunk');
        }
        const stableResultChunk = /** @type {ReturnType<typeof copyWasmBackedColumnChunk>} */ (resultChunk);
        const profile = consumeLastTermBankWasmParseProfile();
        if (profile !== null) {
            profile.resultCopyMs = resultCopyMs;
            profile.sourceDeliveryMs = sourceDeliveryMs ?? 0;
            profile.borrowedContentResultCount = borrowsWorkerMemory ? 1 : 0;
            if (typeof preloadedSource !== 'undefined') {
                Object.assign(profile, {
                    sourceInflateMs: preloadedSource.inflateMs,
                    sourceCompressedBytes: preloadedSource.compressedBytes,
                    sourceUncompressedBytes: preloadedSource.uncompressedBytes,
                });
            }
        }
        if (options.prepareLookupIndexes === true && !(stableResultChunk.preparedLookupIndexes instanceof Map)) {
            const prepared = prepareTermLookupIndexesFromPreinternedPlan(stableResultChunk);
            if (prepared !== null) {
                stableResultChunk.preparedLookupIndexes = prepared.indexes;
                stableResultChunk.preparedLookupIndexEncodeMs = prepared.totalMs;
                if (profile !== null) {
                    profile.lookupIndexPrepareMs = prepared.totalMs;
                    profile.lookupIndexCompactMs = prepared.compactMs;
                    profile.lookupIndexEncodeMs = prepared.indexEncodeMs;
                }
            }
        }
        const transfer = collectChunkTransferables(stableResultChunk);
        self.postMessage({
            type: 'result',
            id,
            rowCount: resultRowCount,
            resultSentEpochMs: Date.now(),
            borrowsWorkerMemory,
            chunk: stableResultChunk,
            profile,
        }, transfer);
    } catch (error) {
        self.postMessage({type: 'parse-error', id, error: serializeError(error)});
    }
}

/**
 * @param {ReturnType<typeof copyWasmBackedColumnChunk>} chunk
 * @returns {Transferable[]}
 */
function collectChunkTransferables(chunk) {
    /** @type {Set<ArrayBuffer>} */
    const buffers = new Set();
    /** @param {unknown} value */
    const addView = (value) => {
        if (!ArrayBuffer.isView(value)) { return; }
        const buffer = value.buffer;
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) { buffers.add(buffer); }
    };
    for (const bytes of chunk.expressionBytesList) { addView(bytes); }
    for (const bytes of chunk.readingBytesList) { addView(bytes); }
    for (const bytes of chunk.contentBytesList) { addView(bytes); }
    addView(chunk.readingEqualsExpressionList);
    addView(chunk.scoreList);
    addView(chunk.sequenceList);
    addView(chunk.contentHash1List);
    addView(chunk.contentHash2List);
    addView(chunk.contentBytesBuffer);
    addView(chunk.contentMetaList);
    addView(chunk.contentUniqueIndexList);
    for (const {row} of chunk.mediaRows) {
        addView(row.expressionBytes);
        addView(row.readingBytes);
        addView(row.glossaryJsonBytes);
        addView(row.termEntryContentBytes);
    }
    const plan = chunk.termRecordPreinternedPlan;
    addView(plan.stringLengths);
    addView(plan.stringOffsets);
    addView(plan.stringHashes);
    addView(plan.stringsBuffer);
    addView(plan.expressionIndexes);
    addView(plan.readingIndexes);
    const preparedLookupIndexes = /** @type {unknown} */ (chunk.preparedLookupIndexes);
    if (preparedLookupIndexes instanceof Map) {
        for (const prepared of preparedLookupIndexes.values()) {
            if (typeof prepared !== 'object' || prepared === null) { continue; }
            addView(Reflect.get(prepared, 'bytes'));
            const preparedPlan = /** @type {unknown} */ (Reflect.get(prepared, 'preinternedPlan'));
            if (typeof preparedPlan !== 'object' || preparedPlan === null) { continue; }
            addView(Reflect.get(preparedPlan, 'stringLengths'));
            addView(Reflect.get(preparedPlan, 'stringOffsets'));
            addView(Reflect.get(preparedPlan, 'stringHashes'));
            addView(Reflect.get(preparedPlan, 'stringsBuffer'));
            addView(Reflect.get(preparedPlan, 'expressionIndexes'));
            addView(Reflect.get(preparedPlan, 'readingIndexes'));
        }
    }
    const rawDedupPlan = /** @type {unknown} */ (chunk.contentDedupPlan);
    const dedupPlan = /** @type {{uniqueRowIndexes?: unknown, uniqueSignatures?: unknown, resolvedFlags?: unknown, resolvedOffsets?: unknown, resolvedLengths?: unknown, pendingEpochs?: unknown, pendingIndexes?: unknown, pendingSpanOffsetsScratch?: unknown, pendingSpanLengthsScratch?: unknown}|null} */ (
        typeof rawDedupPlan === 'object' ? rawDedupPlan : null
    );
    if (typeof dedupPlan === 'object' && dedupPlan !== null) {
        if (dedupPlan.uniqueRowIndexes instanceof Uint32Array) {
            addView(dedupPlan.uniqueRowIndexes);
        }
        addView(dedupPlan.uniqueSignatures);
        addView(dedupPlan.resolvedFlags);
        addView(dedupPlan.resolvedOffsets);
        addView(dedupPlan.resolvedLengths);
        addView(dedupPlan.pendingEpochs);
        addView(dedupPlan.pendingIndexes);
        addView(dedupPlan.pendingSpanOffsetsScratch);
        addView(dedupPlan.pendingSpanLengthsScratch);
    }
    return [...buffers];
}

/**
 * @param {unknown} error
 * @returns {{name: string, message: string, stack?: string}}
 */
function serializeError(error) {
    if (error instanceof Error) {
        return {name: error.name, message: error.message, ...(typeof error.stack === 'string' ? {stack: error.stack} : {})};
    }
    return {name: 'Error', message: `${error}`};
}
