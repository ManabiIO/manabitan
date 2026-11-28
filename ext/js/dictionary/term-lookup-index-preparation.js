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
    compactTermRecordPreinternedPlanRuns,
    getOwnedCompactionScratch,
    hasCompleteTermRecordPreinternedPlan,
    hasCompletePreparedTermRecordPreinternedPlan,
} from './term-record-preinterned-plan.js';

export const MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS = 30000;

const MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS = 0xffff - 1;

/**
 * @typedef {{bytes: Uint8Array, routeFilter?: Uint32Array|null, preinternedPlan: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan, preparedScores?: PreparedTermRecordScores}} PreparedTermLookupIndex
 */

/**
 * Builds offset-independent lookup sidecars from a parser-owned string plan.
 * The same helper runs in parser workers and remains available to the storage
 * owner as a fallback.
 * @param {{rowCount: number, readingEqualsExpressionList: boolean[]|Uint8Array, sequenceList: (number|undefined)[]|Int32Array|Float64Array, termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null}} chunk
 * @param {Uint32Array|null} [remapScratch=null]
 * @param {import('dictionary-importer').ImportExperiments} [experiments={}]
 * @returns {{indexes: Map<string, PreparedTermLookupIndex>, compactMs: number, indexEncodeMs: number, totalMs: number, directArenaSegments: number, directArenaCopiedBytesAvoided: number, compactionSourceValidationPasses: number}|null}
 */
export function prepareTermLookupIndexesFromPreinternedPlan(chunk, remapScratch = null, experiments = {}) {
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
    // Whole-plan admission writes scratch too, before the compactor can guard
    // it. Protect all row columns, including the sequence column encoded later.
    const scratch = getOwnedCompactionScratch(
        preinternedPlan,
        remapScratch instanceof Uint32Array && remapScratch.length >= preinternedPlan.stringLengths.length ?
            remapScratch :
            new Uint32Array(preinternedPlan.stringLengths.length),
        chunk.readingEqualsExpressionList,
        chunk.sequenceList,
    );
    const validatedReadingPostingCount = validateReusableWholePlan(
        preinternedPlan,
        count,
        scratch,
        chunk.readingEqualsExpressionList,
    );
    const reuseWholePlan = validatedReadingPostingCount !== null;
    const runRowLimit = reuseWholePlan ? count : MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS;
    const runsStartedAt = safePerformance.now();
    const compactRuns = !reuseWholePlan && experiments.experimentalSinglePassLookupCompaction === true ?
        compactTermRecordPreinternedPlanRuns(preinternedPlan, count, runRowLimit, scratch, chunk.readingEqualsExpressionList) :
        null;
    if (compactRuns !== null) { compactMs += safePerformance.now() - runsStartedAt; }
    const directArena = experiments.experimentalDirectLookupArena === true;
    let directArenaCopiedBytesAvoided = 0;
    /** @type {Map<string, PreparedTermLookupIndex>} */
    const indexes = new Map();
    for (let runStart = 0; runStart < count; runStart += runRowLimit) {
        const runCount = Math.min(runRowLimit, count - runStart);
        const isWholeChunk = runStart === 0 && runCount === count;
        const compactStartedAt = safePerformance.now();
        const runPlan = reuseWholePlan ?
            preinternedPlan :
            (compactRuns !== null ?
                compactRuns[runStart / runRowLimit] :
            /** @type {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan} */ (
                compactTermRecordPreinternedPlan(
                    preinternedPlan,
                    runStart,
                    runCount,
                    scratch,
                    chunk.readingEqualsExpressionList,
                )
            ));
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
                directArena,
            ) :
            encodePersistedTermLookupIndexFromPreinternedPlan(
                runPlan,
                readingEqualsExpressionList,
                sequenceList,
                runCount,
                directArena,
            );
        indexEncodeMs += safePerformance.now() - encodeStartedAt;
        indexes.set(`${runStart}:${runCount}`, {bytes, preinternedPlan: runPlan});
        if (directArena) { directArenaCopiedBytesAvoided += bytes.byteLength - 16; }
    }
    return {
        indexes,
        compactMs,
        indexEncodeMs,
        totalMs: safePerformance.now() - startedAt,
        directArenaSegments: directArena ? indexes.size : 0,
        directArenaCopiedBytesAvoided,
        compactionSourceValidationPasses: reuseWholePlan ? 0 : (compactRuns !== null ? 1 : indexes.size),
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
 * @param {boolean} [requireNonemptyStrings=false]
 * @returns {value is PreparedTermLookupIndex}
 */
function isCompletePreparedTermLookupIndex(value, rowCount, requireNonemptyStrings = false) {
    if (typeof value !== 'object' || value === null) { return false; }
    const bytes = /** @type {unknown} */ (Reflect.get(value, 'bytes'));
    const planValue = /** @type {unknown} */ (Reflect.get(value, 'preinternedPlan'));
    const plan = /** @type {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null} */ (
        typeof planValue === 'object' && planValue !== null ? planValue : null
    );
    return (
        bytes instanceof Uint8Array &&
        bytes.byteLength > 0 &&
        hasCompletePreparedTermRecordPreinternedPlan(plan, rowCount, requireNonemptyStrings)
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
        isCompletePreparedTermLookupIndex(wholeChunk, rowCount, true) &&
        wholeChunk.preinternedPlan.stringLengths.length <= MAX_PERSISTED_TERM_LOOKUP_INDEX_ITEMS
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

/* eslint-disable @stylistic/semi */
/** @typedef {{scores: Int32Array, keys: Uint16Array}} PreparedTermRecordScores */

const U16_NULL = 0xffff
const INLINE_SCORE_RADIUS = 256
const typedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get

/**
 * The builtin getters check the actual storage and element kind, including
 * prototype-spoofed views. No shared memory or property accessors participate
 * in the synchronous score validation and output copy.
 * @param {unknown} value
 * @param {object} prototype
 * @param {string} name
 * @returns {boolean}
 */
function isPrivateColumn(value, prototype, name) {
    if (
        !ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype ||
        Object.hasOwn(value, 'buffer') || Object.hasOwn(value, 'length') ||
        Object.hasOwn(value, 'byteLength') || Object.hasOwn(value, 'byteOffset') ||
        typeof typedArrayName !== 'function' || typeof arrayBufferByteLength !== 'function'
    ) { return false }
    try {
        if (typedArrayName.call(value) !== name) { return false }
        arrayBufferByteLength.call(value.buffer)
        return true
    } catch { return false }
}

/**
 * Prepare the same first-occurrence score table as the record encoder for one
 * exact prepared-lookup range. The storage owner validates these optional
 * columns against its current scores before using them.
 * @param {Int32Array|Float64Array} source
 * @param {number} first
 * @param {number} count
 * @returns {PreparedTermRecordScores|null}
 */
export function prepareTermRecordScores(source, first, count) {
    if (
        !isPrivateColumn(source, Int32Array.prototype, 'Int32Array') ||
        !Number.isSafeInteger(first) || first < 0 ||
        !Number.isSafeInteger(count) || count <= 0 || first > source.length - count
    ) { return null }
    const keys = new Uint16Array(count)
    /** @type {number[]} */
    const scores = []
    /** @type {Map<number, number>} */
    const indexes = new Map()
    const inlineIndexes = new Uint16Array(INLINE_SCORE_RADIUS * 2)
    for (let i = 0; i < count; ++i) {
        const score = source[first + i]
        const inline = score + INLINE_SCORE_RADIUS
        const useInline = inline >= 0 && inline < inlineIndexes.length
        let key = useInline ? inlineIndexes[inline] - 1 : (indexes.get(score) ?? -1)
        if (key < 0) {
            key = scores.length
            if (key >= U16_NULL - 1) { return null }
            if (useInline) {
                inlineIndexes[inline] = key + 1
            } else {
                indexes.set(score, key)
            }
            scores.push(score)
        }
        keys[i] = key
    }
    return {scores: Int32Array.from(scores), keys}
}

/**
 * Capture private typed columns and reject duplicate dictionary values. This
 * does not certify row values: the encoder must check each key, its first-use
 * order, and its equality to the live score in the same synchronous operation.
 * @param {unknown} prepared
 * @param {number} count
 * @returns {PreparedTermRecordScores|null}
 */
export function getPreparedTermRecordScoreColumns(prepared, count) {
    if (typeof prepared !== 'object' || prepared === null) { return null }
    /** @type {unknown} */
    let scores
    /** @type {unknown} */
    let keys
    try {
        scores = Object.getOwnPropertyDescriptor(prepared, 'scores')?.value
        keys = Object.getOwnPropertyDescriptor(prepared, 'keys')?.value
    } catch { return null }
    if (
        !isPrivateColumn(scores, Int32Array.prototype, 'Int32Array') ||
        !isPrivateColumn(keys, Uint16Array.prototype, 'Uint16Array') ||
        !(scores instanceof Int32Array) || !(keys instanceof Uint16Array) ||
        scores.length === 0 || scores.length >= U16_NULL || keys.length !== count
    ) { return null }
    /** @type {Set<number>} */
    const seen = new Set()
    for (let i = 0; i < scores.length; ++i) {
        const score = scores[i]
        if (seen.has(score)) { return null }
        seen.add(score)
    }
    return {scores, keys}
}
/* eslint-enable @stylistic/semi */
