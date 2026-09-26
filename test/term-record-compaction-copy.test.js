/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {compactTermRecordPreinternedPlan, compactTermRecordPreinternedPlanRuns} from '../ext/js/dictionary/term-record-preinterned-plan.js';

/**
 * @param {number[]} lengths
 * @param {boolean} shared
 * @returns {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan}
 */
function createPlan(lengths, shared) {
    const bytesLength = lengths.reduce((sum, length) => sum + length, 0);
    const buffer = shared ? new SharedArrayBuffer(bytesLength + 26) : new ArrayBuffer(bytesLength + 26);
    const bytes = new Uint8Array(buffer);
    bytes.fill(0xff);
    const stringsBuffer = bytes.subarray(13, 13 + bytesLength);
    for (let i = 0; i < stringsBuffer.length; ++i) { stringsBuffer[i] = (i * 23) & 0xff; }
    const stringOffsets = new Uint32Array(lengths.length);
    for (let i = 1; i < lengths.length; ++i) { stringOffsets[i] = stringOffsets[i - 1] + lengths[i - 1]; }
    const expressionIndexes = Uint32Array.from(lengths, (_value, index) => lengths.length - 1 - index);
    const readingIndexes = Uint32Array.from(lengths, (_value, index) => index);
    return {
        stringLengths: Uint16Array.from(lengths),
        stringOffsets,
        stringHashes: Uint32Array.from(lengths, (value, index) => value * 31 + index),
        stringsBuffer,
        expressionIndexes,
        readingIndexes,
    };
}

/**
 * @param {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} plan
 * @param {number} index
 * @returns {Uint8Array}
 */
function stringBytes(plan, index) {
    const offset = plan.stringOffsets?.[index] ?? 0;
    return plan.stringsBuffer.subarray(offset, offset + plan.stringLengths[index]);
}

describe.each([false, true])('compaction copy with shared input=%s', (shared) => {
    test.each([0, 1, 2, 3, 15, 16, 31, 32, 33, 64, 256, 65535])('preserves %i-byte keys at a nonzero byte offset', (length) => {
        const plan = createPlan([length, 33, 1], shared);
        const source = Uint8Array.from(plan.stringsBuffer);
        const scratch = new Uint32Array(plan.stringLengths.length);
        const result = compactTermRecordPreinternedPlan(plan, 0, 3, scratch);
        expect(result).not.toBeNull();
        if (result === null) { throw new Error('Expected compacted plan'); }
        expect(result.stringsBuffer.buffer).not.toBe(plan.stringsBuffer.buffer);
        for (let row = 0; row < 3; ++row) {
            for (const column of ['expressionIndexes', 'readingIndexes']) {
                const key = /** @type {'expressionIndexes'|'readingIndexes'} */ (column);
                expect(stringBytes(result, result[key][row])).toEqual(stringBytes(plan, plan[key][row]));
                expect(result.stringHashes?.[result[key][row]]).toBe(plan.stringHashes?.[plan[key][row]]);
            }
        }
        expect(plan.stringsBuffer).toEqual(source);
        expect([...scratch]).toEqual([0, 0, 0]);
        result.stringsBuffer.fill(0);
        expect(plan.stringsBuffer).toEqual(source);
    });

    test('copies mixed runs identically to independent compactions and clears reusable scratch', () => {
        const plan = createPlan([0, 1, 31, 32, 33, 64, 7, 255, 3], shared);
        const before = Uint8Array.from(plan.stringsBuffer);
        const scratch = new Uint32Array(plan.stringLengths.length);
        const flags = Uint8Array.from([0, 1, 0, 1, 0, 0, 1, 0, 0]);
        const runs = compactTermRecordPreinternedPlanRuns(plan, 9, 4, scratch, flags);
        expect(runs).toHaveLength(3);
        for (let i = 0; i < runs.length; ++i) {
            expect(runs[i]).toEqual(compactTermRecordPreinternedPlan(plan, i * 4, Math.min(4, 9 - i * 4), scratch, flags));
            expect([...scratch]).toEqual(new Array(9).fill(0));
        }
        expect(plan.stringsBuffer).toEqual(before);
    });
});
