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
