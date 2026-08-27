/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {safePerformance} from '../core/safe-performance.js';
import {encodePersistedTermLookupIndexFromPreinternedPlan} from './term-lookup-index.js';
import {
    compactTermRecordPreinternedPlan,
    hasCompleteTermRecordPreinternedPlan,
} from './term-record-preinterned-plan.js';

export const MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS = 30000;

/**
 * @typedef {{bytes: Uint8Array, preinternedPlan: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan}} PreparedTermLookupIndex
 */

/**
 * Builds offset-independent lookup sidecars from a parser-owned string plan.
 * The same helper runs in parser workers and remains available to the storage
 * owner as a fallback.
 * @param {{rowCount: number, readingEqualsExpressionList: boolean[]|Uint8Array, sequenceList: (number|undefined)[]|Int32Array, termRecordPreinternedPlan?: import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan|null}} chunk
 * @param {Uint32Array|null} [remapScratch=null]
 * @returns {{indexes: Map<string, PreparedTermLookupIndex>, compactMs: number, indexEncodeMs: number, totalMs: number}|null}
 */
export function prepareTermLookupIndexesFromPreinternedPlan(chunk, remapScratch = null) {
    const count = chunk.rowCount;
    const preinternedPlan = chunk.termRecordPreinternedPlan ?? null;
    if (count <= 0 || !hasCompleteTermRecordPreinternedPlan(preinternedPlan, count)) {
        return null;
    }
    if (
        chunk.readingEqualsExpressionList.length < count ||
        chunk.sequenceList.length < count
    ) {
        return null;
    }
    const startedAt = safePerformance.now();
    let compactMs = 0;
    let indexEncodeMs = 0;
    const scratch = remapScratch instanceof Uint32Array && remapScratch.length >= preinternedPlan.stringLengths.length ?
        remapScratch :
        new Uint32Array(preinternedPlan.stringLengths.length);
    /** @type {Map<string, PreparedTermLookupIndex>} */
    const indexes = new Map();
    for (let runStart = 0; runStart < count; runStart += MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS) {
        const runCount = Math.min(MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS, count - runStart);
        const isWholeChunk = runStart === 0 && runCount === count;
        const compactStartedAt = safePerformance.now();
        const runPlan = /** @type {import('./term-record-wasm-encoder.js').PreinternedTermRecordPlan} */ (
            compactTermRecordPreinternedPlan(
                preinternedPlan,
                runStart,
                runCount,
                scratch,
                chunk.readingEqualsExpressionList,
            )
        );
        compactMs += safePerformance.now() - compactStartedAt;
        const readingEqualsExpressionList = isWholeChunk ?
            chunk.readingEqualsExpressionList :
            chunk.readingEqualsExpressionList.slice(runStart, runStart + runCount);
        const sequenceList = isWholeChunk ?
            chunk.sequenceList :
            chunk.sequenceList.slice(runStart, runStart + runCount);
        const encodeStartedAt = safePerformance.now();
        const bytes = encodePersistedTermLookupIndexFromPreinternedPlan(
            runPlan,
            readingEqualsExpressionList,
            sequenceList,
            runCount,
        );
        indexEncodeMs += safePerformance.now() - encodeStartedAt;
        indexes.set(`${runStart}:${runCount}`, {bytes, preinternedPlan: runPlan});
    }
    return {
        indexes,
        compactMs,
        indexEncodeMs,
        totalMs: safePerformance.now() - startedAt,
    };
}

/**
 * Rejects partial or detached worker results before the storage sink trusts
 * them. Index payload integrity is validated when the sidecar is loaded.
 * @param {unknown} value
 * @param {number} rowCount
 * @returns {value is Map<string, PreparedTermLookupIndex>}
 */
export function hasCompletePreparedTermLookupIndexes(value, rowCount) {
    if (!(value instanceof Map) || !Number.isSafeInteger(rowCount) || rowCount <= 0) { return false; }
    let coveredRows = 0;
    for (let runStart = 0; runStart < rowCount; runStart += MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS) {
        const runCount = Math.min(MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS, rowCount - runStart);
        const prepared = value.get(`${runStart}:${runCount}`);
        if (
            !(prepared?.bytes instanceof Uint8Array) ||
            prepared.bytes.byteLength === 0 ||
            !hasCompleteTermRecordPreinternedPlan(prepared.preinternedPlan, runCount)
        ) {
            return false;
        }
        coveredRows += runCount;
    }
    return coveredRows === rowCount && value.size === Math.ceil(rowCount / MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS);
}
