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
    initializeTermBankWasmParser,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from './term-bank-wasm-parser.js';
import {safePerformance} from '../core/safe-performance.js';

/** @typedef {{initialContentBytesPerRow?: number, mediaHintFastScan?: boolean, maxPendingChunks?: number, computeContentHashes?: boolean, emitContentSlab?: boolean, emitTokenBinaryContent?: boolean, useNativeStringPlan?: boolean, emitTermByteLists?: boolean, singleChunk?: boolean}} ParserOptions */
/** @typedef {{type: 'initialize', module: unknown}} InitializeRequest */
/** @typedef {{type: 'parse', id: unknown, sourceBuffers: unknown, version: unknown, chunkSize?: unknown, options?: unknown}} ParseRequest */

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
        /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|null} */
        let resultChunk = null;
        let resultCopyMs = 0;
        await parseTermBankWithWasmColumnChunks(
            sourceBytes,
            data.version,
            (chunk) => {
                if (resultChunk !== null) {
                    throw new Error('Parallel term-bank parser emitted multiple chunks');
                }
                self.postMessage({type: 'parsed', id, rowCount: chunk.rowCount});
                const tResultCopyStart = safePerformance.now();
                resultChunk = copyWasmBackedColumnChunk(chunk, true);
                resultCopyMs = Math.max(0, safePerformance.now() - tResultCopyStart);
            },
            chunkSize,
            {...options, maxPendingChunks: 1, singleChunk: true},
        );
        if (resultChunk === null) {
            throw new Error('Parallel term-bank parser did not emit a chunk');
        }
        const profile = consumeLastTermBankWasmParseProfile();
        if (profile !== null) { profile.resultCopyMs = resultCopyMs; }
        const transfer = collectChunkTransferables(resultChunk);
        self.postMessage({type: 'result', id, chunk: resultChunk, profile}, transfer);
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
    const rawDedupPlan = /** @type {unknown} */ (chunk.contentDedupPlan);
    const dedupPlan = /** @type {{resolvedFlags?: unknown, resolvedOffsets?: unknown, resolvedLengths?: unknown, pendingEpochs?: unknown, pendingIndexes?: unknown, pendingSpanOffsetsScratch?: unknown, pendingSpanLengthsScratch?: unknown}|null} */ (
        typeof rawDedupPlan === 'object' ? rawDedupPlan : null
    );
    if (typeof dedupPlan === 'object' && dedupPlan !== null) {
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
