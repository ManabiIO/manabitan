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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {number[]} scores
 * @param {number} [contentLength=64]
 * @returns {Promise<Awaited<ReturnType<TermRecordOpfsStore['_encodeArtifactChunkRecords']>>>}
 */
async function encode(scores, contentLength = 64) {
    const encoder = new TextEncoder();
    const rowCount = scores.length;
    const store = new TermRecordOpfsStore();
    return await store._encodeArtifactChunkRecords(
        {
            dictionary: 'format-selection',
            rowCount,
            expressionBytesList: scores.map((_, index) => encoder.encode(`term-${index}`)),
            readingBytesList: [],
            readingEqualsExpressionList: new Uint8Array(rowCount).fill(1),
            scoreList: Float64Array.from(scores),
            sequenceList: Int32Array.from(scores, (_, index) => index),
        },
        Float64Array.from(scores, (_, index) => (2 ** 40) + (index * 64)),
        new Uint32Array(rowCount).fill(contentLength),
    );
}

describe('artifact record format selection', () => {
    test('empty input retains the legacy empty representation', async () => {
        const result = await encode([]);
        expect(result.recordFieldsFormat).toBe(1);
        expect(result.recordFields.byteLength).toBe(0);
        expect(result.lookupIndexBytes.byteLength).toBe(0);
    });

    test('small integer input retains fixed-width legacy fields', async () => {
        const result = await encode([-2147483648, 2147483647]);
        expect(result.recordFieldsFormat).toBe(1);
        expect(result.recordFields.byteLength).toBe(24);
        const view = new DataView(result.recordFields.buffer);
        expect(view.getInt32(8, true)).toBe(-2147483648);
        expect(view.getInt32(20, true)).toBe(2147483647);
    });

    test('compact fields are strictly smaller than legacy fields', async () => {
        const scores = Array.from({length: 32}, (_, index) => index % 3);
        const result = await encode(scores);
        expect(result.recordFieldsFormat).toBe(2);
        expect(result.recordFields.byteLength).toBe(16 + (3 * 4) + (32 * 8));
        expect(result.recordFields.byteLength).toBeLessThan(scores.length * 12);
    });

    test('long content lengths select legacy fields', async () => {
        const scores = new Array(32).fill(0);
        const result = await encode(scores, 65535);
        expect(result.recordFieldsFormat).toBe(1);
        expect(result.recordFields.byteLength).toBe(scores.length * 12);
    });

    test('unique scores reject an unprofitable compact representation', async () => {
        const scores = Array.from({length: 32}, (_, index) => index);
        const result = await encode(scores);
        expect(result.recordFieldsFormat).toBe(1);
        expect(result.recordFields.byteLength).toBe(scores.length * 12);
    });

    for (const score of [1.5, -2.25, -0, (2 ** 40) + 0.5, -(2 ** 40), Number.MAX_VALUE]) {
        for (const contentLength of [64, 65535]) {
            test(`preserves float64 score ${Object.is(score, -0) ? '-0' : score} with length ${contentLength}`, async () => {
                const scores = [0, 1, 2, 0, 1, 2, 0, score];
                const result = await encode(scores, contentLength);
                expect(result.recordFieldsFormat).toBe(3);
                expect(result.recordFields.byteLength).toBe(scores.length * 16);
                const view = new DataView(result.recordFields.buffer);
                for (let index = 0; index < scores.length; ++index) {
                    expect(Object.is(view.getFloat64((index * 16) + 8, true), scores[index])).toBe(true);
                }
            });
        }
    }

    test('does not rescan the score column to recover the selected format', async () => {
        const scoreList = new Int32Array(32);
        const scan = vi.spyOn(scoreList, 'some');
        const encoder = new TextEncoder();
        const store = new TermRecordOpfsStore();
        try {
            const result = await store._encodeArtifactChunkRecords(
                {
                    dictionary: 'single-score-scan',
                    rowCount: scoreList.length,
                    expressionBytesList: Array.from(scoreList, (_, index) => encoder.encode(`term-${index}`)),
                    readingBytesList: [],
                    readingEqualsExpressionList: new Uint8Array(scoreList.length).fill(1),
                    scoreList,
                    sequenceList: new Int32Array(scoreList.length),
                },
                new Float64Array(scoreList.length),
                new Uint32Array(scoreList.length),
            );
            expect(result.recordFieldsFormat).toBe(2);
            expect(scan).toHaveBeenCalledTimes(1);
        } finally {
            scan.mockRestore();
        }
    });
});
