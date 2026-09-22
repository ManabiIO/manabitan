/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {
    hasCompletePreparedTermLookupIndexes,
    MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS,
    prepareTermLookupIndexesFromPreinternedPlan,
} from '../ext/js/dictionary/term-lookup-index-preparation.js';
import {findExactRows, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js';

const textEncoder = new TextEncoder();

/**
 * @param {number} rowCount
 * @returns {{rowCount: number, readingEqualsExpressionList: Uint8Array, sequenceList: Int32Array, termRecordPreinternedPlan: import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan & {stringOffsets: Uint32Array}}}
 */
function createChunk(rowCount) {
    const expressions = [textEncoder.encode('共通語'), textEncoder.encode('終端語')];
    const readings = [textEncoder.encode('きょうつうご'), textEncoder.encode('しゅうたんご')];
    const values = [...expressions, ...readings];
    const stringLengths = Uint16Array.from(values, ({byteLength}) => byteLength);
    const stringOffsets = new Uint32Array(values.length);
    const stringsBuffer = new Uint8Array(values.reduce((sum, {byteLength}) => sum + byteLength, 0));
    let cursor = 0;
    for (let index = 0; index < values.length; ++index) {
        stringOffsets[index] = cursor;
        stringsBuffer.set(values[index], cursor);
        cursor += values[index].byteLength;
    }
    const expressionIndexes = new Uint32Array(rowCount);
    const readingIndexes = new Uint32Array(rowCount);
    readingIndexes.fill(2);
    expressionIndexes[rowCount - 1] = 1;
    readingIndexes[rowCount - 1] = 3;
    const sequenceList = new Int32Array(rowCount);
    sequenceList.fill(-1);
    sequenceList[rowCount - 1] = 42;
    return {
        rowCount,
        readingEqualsExpressionList: new Uint8Array(rowCount),
        sequenceList,
        termRecordPreinternedPlan: {
            stringLengths,
            stringOffsets,
            stringsBuffer,
            expressionIndexes,
            readingIndexes,
        },
    };
}

/** @param {ReturnType<typeof createChunk>} chunk */
function addUnusedEmptyString(chunk) {
    const plan = chunk.termRecordPreinternedPlan;
    plan.stringLengths = Uint16Array.from([...plan.stringLengths, 0]);
    plan.stringOffsets = Uint32Array.from([...plan.stringOffsets, plan.stringsBuffer.byteLength]);
}

describe('parser-prepared term lookup indexes', () => {
    test('reuses complete whole-chunk plans beyond the conservative split size', () => {
        const rowCount = MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS + 1;
        const chunk = createChunk(rowCount);
        for (let row = 1; row < rowCount - 1; row += 2) {
            chunk.termRecordPreinternedPlan.expressionIndexes[row] = 1;
            chunk.termRecordPreinternedPlan.readingIndexes[row] = 3;
        }
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk);

        expect(prepared?.indexes.size).toBe(1);
        expect(prepared?.indexes.get(`0:${rowCount}`)?.preinternedPlan).toBe(chunk.termRecordPreinternedPlan);
        expect(hasCompletePreparedTermLookupIndexes(prepared?.indexes, rowCount)).toBe(true);
    });

    test('retains malformed-plan validation while reusing whole plans', () => {
        const chunk = createChunk(1);
        chunk.termRecordPreinternedPlan.expressionIndexes[0] = 99;

        expect(() => prepareTermLookupIndexesFromPreinternedPlan(chunk)).toThrow();
    });

    test('counts an explicitly distinct reading even when it shares the expression key', () => {
        const chunk = createChunk(1);
        const firstLength = chunk.termRecordPreinternedPlan.stringLengths[0];
        chunk.termRecordPreinternedPlan.stringLengths = Uint16Array.of(firstLength);
        chunk.termRecordPreinternedPlan.stringOffsets = Uint32Array.of(0);
        chunk.termRecordPreinternedPlan.stringsBuffer = chunk.termRecordPreinternedPlan.stringsBuffer.slice(0, firstLength);
        chunk.termRecordPreinternedPlan.expressionIndexes[0] = 0;
        chunk.termRecordPreinternedPlan.readingIndexes[0] = 0;
        chunk.readingEqualsExpressionList[0] = 0;

        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk);
        const index = parsePersistedTermLookupIndex(prepared?.indexes.get('0:1')?.bytes ?? new Uint8Array());
        expect(findExactRows(index, textEncoder.encode('共通語'), 'reading')).toEqual([0]);
    });

    test('covers every 30K row range and preserves exact keys', () => {
        const rowCount = MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS + 1;
        const chunk = createChunk(rowCount);
        addUnusedEmptyString(chunk);
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk);

        expect(prepared).not.toBeNull();
        expect(prepared?.indexes.size).toBe(2);
        expect(hasCompletePreparedTermLookupIndexes(prepared?.indexes, rowCount)).toBe(true);
        const tail = prepared?.indexes.get(`${MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS}:1`);
        const index = parsePersistedTermLookupIndex(tail?.bytes ?? new Uint8Array());
        expect(findExactRows(index, textEncoder.encode('終端語'), 'expression')).toEqual([0]);
        expect(findExactRows(index, textEncoder.encode('しゅうたんご'), 'reading')).toEqual([0]);
    });

    test('compacts reading-equals-expression rows without retaining empty sentinels', () => {
        const chunk = createChunk(1);
        chunk.readingEqualsExpressionList[0] = 1;
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk);
        const plan = prepared?.indexes.get('0:1')?.preinternedPlan;

        expect(plan?.stringLengths).toHaveLength(1);
        expect(plan?.expressionIndexes).toEqual(Uint32Array.of(0));
        expect(plan?.readingIndexes).toEqual(Uint32Array.of(0));
    });

    test('rejects partial, extra, and detached worker results', () => {
        const rowCount = MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS + 1;
        const chunk = createChunk(rowCount);
        addUnusedEmptyString(chunk);
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk);
        const indexes = prepared?.indexes ?? new Map();
        expect(hasCompletePreparedTermLookupIndexes(indexes, rowCount)).toBe(true);

        indexes.delete(`${MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS}:1`);
        expect(hasCompletePreparedTermLookupIndexes(indexes, rowCount)).toBe(false);

        const single = prepareTermLookupIndexesFromPreinternedPlan(createChunk(1))?.indexes ?? new Map();
        single.set('extra', single.get('0:1'));
        expect(hasCompletePreparedTermLookupIndexes(single, 1)).toBe(false);

        const detached = prepareTermLookupIndexesFromPreinternedPlan(createChunk(1))?.indexes ?? new Map();
        const bytes = detached.get('0:1')?.bytes;
        if (bytes instanceof Uint8Array) { structuredClone(bytes, {transfer: [bytes.buffer]}); }
        expect(hasCompletePreparedTermLookupIndexes(detached, 1)).toBe(false);
    });
});


describe('lookup string arena validation', () => {
    test.each([0, 1, 0xffffffff])('rejects an invalid interior key offset (%s) on the whole-plan path', (offset) => {
        const chunk = createChunk(2);
        // All four keys are referenced, selecting the whole-plan fast path.
        chunk.termRecordPreinternedPlan.stringOffsets[1] = offset;
        expect(() => prepareTermLookupIndexesFromPreinternedPlan(chunk)).toThrow();
    });
});


describe('lookup preparation scratch ownership', () => {
    test.each(['expressionIndexes', 'readingIndexes', 'stringHashes'])('does not modify source %s before whole-plan admission', (field) => {
        const chunk = createChunk(4);
        chunk.termRecordPreinternedPlan.stringHashes = new Uint32Array(4);
        const scratch = /** @type {Uint32Array} */ (Reflect.get(chunk.termRecordPreinternedPlan, field));
        const before = structuredClone(chunk);
        expect(() => prepareTermLookupIndexesFromPreinternedPlan(chunk, scratch)).toThrow(/scratch overlaps source storage/);
        expect(chunk).toEqual(before);
    });

    test.each([false, true])('protects sequences on whole/fallback preparation (singlePass=%s)', (singlePass) => {
        const chunk = createChunk(4);
        // Reference every key while scratch aliases real sequence storage.
        chunk.termRecordPreinternedPlan.expressionIndexes.set([0, 1, 0, 1]);
        chunk.termRecordPreinternedPlan.readingIndexes.set([2, 3, 2, 3]);
        chunk.sequenceList.set([0, 42, 0, 43]);
        const scratch = new Uint32Array(chunk.sequenceList.buffer);
        const before = structuredClone(chunk);
        expect(() => prepareTermLookupIndexesFromPreinternedPlan(chunk, scratch, {experimentalSinglePassLookupCompaction: singlePass})).toThrow(/scratch overlaps source storage/);
        expect(chunk).toEqual(before);
    });

    test('protects packed equality flags from the earlier whole-plan probe', () => {
        const chunk = createChunk(4);
        const buffer = new ArrayBuffer(16);
        chunk.readingEqualsExpressionList = new Uint8Array(buffer, 1, 4);
        const before = structuredClone(chunk);
        expect(() => prepareTermLookupIndexesFromPreinternedPlan(chunk, new Uint32Array(buffer))).toThrow(/scratch overlaps source storage/);
        expect(chunk).toEqual(before);
    });

    test('cloned shared-buffer wrappers cannot overwrite sequence storage', () => {
        const chunk = createChunk(4);
        const buffer = new SharedArrayBuffer(16);
        chunk.sequenceList = new Int32Array(buffer);
        const before = structuredClone(chunk);
        const expected = prepareTermLookupIndexesFromPreinternedPlan(structuredClone(chunk));
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk, new Uint32Array(structuredClone(buffer)));
        expect(prepared?.indexes).toEqual(expected?.indexes);
        expect(chunk).toEqual(before);
    });

    test('disjoint source in unused scratch suffix remains supported', () => {
        const chunk = createChunk(4);
        const buffer = new ArrayBuffer(64);
        const flags = new Uint8Array(buffer, 32, 4);
        flags.set(chunk.readingEqualsExpressionList);
        chunk.readingEqualsExpressionList = flags;
        const expected = prepareTermLookupIndexesFromPreinternedPlan(structuredClone(chunk));
        const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk, new Uint32Array(buffer));
        expect(prepared?.indexes).toEqual(expected?.indexes);
    });
});
