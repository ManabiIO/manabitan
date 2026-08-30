/*
 * Copyright (C) 2026  Manabitan authors
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

import {safePerformance} from '../core/safe-performance.js';
import {
    encodePersistedTermLookupIndexFromPreinternedPlan,
    encodePersistedTermLookupIndexFromValidatedPreinternedPlan,
} from './term-lookup-index.js';
import {
    compactTermRecordPreinternedPlan,
    hasCompleteTermRecordPreinternedPlan,
} from './term-record-preinterned-plan.js';

export const MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS = 30000;

const MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS = 0xffff - 1;

/**
 * @typedef {{bytes: Uint8Array, preinternedPlan: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan}} PreparedTermLookupIndex
 */

/**
 * Builds offset-independent lookup sidecars from a parser-owned string plan.
 * The same helper runs in parser workers and remains available to the storage
 * owner as a fallback.
 * @param {{rowCount: number, readingEqualsExpressionList: boolean[]|Uint8Array, sequenceList: (number|undefined)[]|Int32Array, termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null}} chunk
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
    const validatedReadingPostingCount = validateReusableWholePlan(
        preinternedPlan,
        count,
        scratch,
        chunk.readingEqualsExpressionList,
    );
    const reuseWholePlan = validatedReadingPostingCount !== null;
    const runRowLimit = reuseWholePlan ? count : MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS;
    /** @type {Map<string, PreparedTermLookupIndex>} */
    const indexes = new Map();
    for (let runStart = 0; runStart < count; runStart += runRowLimit) {
        const runCount = Math.min(runRowLimit, count - runStart);
        const isWholeChunk = runStart === 0 && runCount === count;
        const compactStartedAt = safePerformance.now();
        const runPlan = reuseWholePlan ?
            preinternedPlan :
            /** @type {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan} */ (
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
        const bytes = reuseWholePlan ?
            encodePersistedTermLookupIndexFromValidatedPreinternedPlan(
                runPlan,
                readingEqualsExpressionList,
                sequenceList,
                runCount,
                /** @type {number} */ (validatedReadingPostingCount),
            ) :
            encodePersistedTermLookupIndexFromPreinternedPlan(
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
 * A complete parser plan can back one persisted lookup/record segment without
 * compaction when every interned key is used and both compact-index dimensions
 * fit below the uint16 null sentinel.
 * @param {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan} plan
 * @param {number} rowCount
 * @param {Uint32Array} scratch
 * @param {boolean[]|Uint8Array} readingEqualsExpressionList
 * @returns {number|null} The validated reading posting count, or `null` when compaction is required.
 */
function validateReusableWholePlan(plan, rowCount, scratch, readingEqualsExpressionList) {
    const keyCount = plan.stringLengths.length;
    if (
        rowCount > MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS ||
        keyCount > MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS
    ) {
        return null;
    }
    let referencedKeyCount = 0;
    let readingPostingCount = 0;
    try {
        for (let row = 0; row < rowCount; ++row) {
            const expressionIndex = plan.expressionIndexes[row];
            const readingEqualsExpression = (
                readingEqualsExpressionList[row] === true ||
                readingEqualsExpressionList[row] === 1
            );
            const readingIndex = readingEqualsExpression ?
                expressionIndex :
                plan.readingIndexes[row];
            if (
                expressionIndex >= keyCount ||
                readingIndex >= keyCount ||
                plan.stringLengths[expressionIndex] === 0 ||
                plan.stringLengths[readingIndex] === 0
            ) {
                return null;
            }
            if (scratch[expressionIndex] === 0) {
                scratch[expressionIndex] = 1;
                ++referencedKeyCount;
            }
            if (scratch[readingIndex] === 0) {
                scratch[readingIndex] = 1;
                ++referencedKeyCount;
            }
            if (!readingEqualsExpression) { ++readingPostingCount; }
        }
        return referencedKeyCount === keyCount ? readingPostingCount : null;
    } finally {
        if (referencedKeyCount > 0) {
            for (let key = 0; key < keyCount; ++key) { scratch[key] = 0; }
        }
    }
}

/**
 * @param {unknown} value
 * @param {number} rowCount
 * @returns {value is PreparedTermLookupIndex}
 */
function isCompletePreparedTermLookupIndex(value, rowCount) {
    if (typeof value !== 'object' || value === null) { return false; }
    const bytes = /** @type {unknown} */ (Reflect.get(value, 'bytes'));
    const planValue = /** @type {unknown} */ (Reflect.get(value, 'preinternedPlan'));
    const plan = /** @type {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null} */ (
        typeof planValue === 'object' && planValue !== null ? planValue : null
    );
    return (
        bytes instanceof Uint8Array &&
        bytes.byteLength > 0 &&
        hasCompleteTermRecordPreinternedPlan(plan, rowCount)
    );
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
    const wholeChunk = /** @type {unknown} */ (value.get(`0:${rowCount}`));
    if (
        value.size === 1 &&
        rowCount <= MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS &&
        isCompletePreparedTermLookupIndex(wholeChunk, rowCount) &&
        wholeChunk.preinternedPlan.stringLengths.length <= MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS &&
        wholeChunk.preinternedPlan.stringLengths.every((length) => length > 0)
    ) {
        return true;
    }
    let coveredRows = 0;
    for (let runStart = 0; runStart < rowCount; runStart += MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS) {
        const runCount = Math.min(MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS, rowCount - runStart);
        const prepared = /** @type {unknown} */ (value.get(`${runStart}:${runCount}`));
        if (!isCompletePreparedTermLookupIndex(prepared, runCount)) {
            return false;
        }
        coveredRows += runCount;
    }
    return coveredRows === rowCount && value.size === Math.ceil(rowCount / MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS);
}
