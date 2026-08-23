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
    compactTermRecordPreinternedPlan,
    createTermRecordPreinternedPlanBuilder,
    getTermRecordPreinternedPlan,
    hasCompleteTermRecordPreinternedPlan,
    selectTermRecordPreinternedPlan,
    sliceTermRecordPreinternedPlan,
} from '../ext/js/dictionary/term-record-preinterned-plan.js';

/**
 * @returns {import('../ext/js/dictionary/term-record-wasm-encoder.js').PreinternedTermRecordPlan}
 */
function createPlan() {
    return {
        stringLengths: Uint16Array.from([1, 2, 1]),
        stringHashes: Uint32Array.from([11, 22, 33]),
        stringsBuffer: Uint8Array.from([65, 66, 67, 68]),
        expressionIndexes: Uint32Array.from([0, 2, 1]),
        readingIndexes: Uint32Array.from([1, 0, 2]),
    };
}

describe('term record preinterned plan helpers', () => {
    test('gets optional plans without allocating replacements', () => {
        const plan = createPlan();
        const rows = [];
        expect(getTermRecordPreinternedPlan(rows)).toBeNull();
        Reflect.set(rows, 'termRecordPreinternedPlan', plan);
        expect(getTermRecordPreinternedPlan(rows)).toBe(plan);
    });

    test('slices row indexes as views while preserving shared string storage', () => {
        const plan = createPlan();
        const slice = sliceTermRecordPreinternedPlan(plan, 1, 2);
        expect(slice?.stringLengths).toBe(plan.stringLengths);
        expect(slice?.stringsBuffer).toBe(plan.stringsBuffer);
        expect([...slice?.expressionIndexes ?? []]).toStrictEqual([2, 1]);
        expect([...slice?.readingIndexes ?? []]).toStrictEqual([0, 2]);
        plan.expressionIndexes[1] = 0;
        expect(slice?.expressionIndexes[0]).toBe(0);
        expect(sliceTermRecordPreinternedPlan(plan, 3, 0)?.expressionIndexes).toHaveLength(0);
        expect(sliceTermRecordPreinternedPlan(null, 0, 1)).toBeNull();
        expect(() => sliceTermRecordPreinternedPlan(plan, 1, 3)).toThrow('Invalid preinterned plan row range');
        expect(() => sliceTermRecordPreinternedPlan(plan, 0.5, 1)).toThrow('Invalid preinterned plan row range');
    });

    test('selects arbitrary rows while sharing interned strings', () => {
        const plan = createPlan();
        const selected = selectTermRecordPreinternedPlan(plan, [2, 0, 2]);
        expect(selected?.stringsBuffer).toBe(plan.stringsBuffer);
        expect([...selected?.expressionIndexes ?? []]).toStrictEqual([1, 0, 1]);
        expect([...selected?.readingIndexes ?? []]).toStrictEqual([2, 1, 2]);
        expect(selectTermRecordPreinternedPlan(null, [0])).toBeNull();
        expect(() => selectTermRecordPreinternedPlan(plan, [3])).toThrow('Preinterned plan row index out of bounds: 3');
    });

    test('compacts referenced strings and resets scratch after failures', () => {
        const plan = createPlan();
        const scratch = new Uint32Array(3);
        const compact = compactTermRecordPreinternedPlan(plan, 1, 1, scratch);
        expect([...compact?.stringLengths ?? []]).toStrictEqual([1, 1]);
        expect([...compact?.stringHashes ?? []]).toStrictEqual([33, 11]);
        expect([...compact?.stringsBuffer ?? []]).toStrictEqual([68, 65]);
        expect([...compact?.expressionIndexes ?? []]).toStrictEqual([0]);
        expect([...compact?.readingIndexes ?? []]).toStrictEqual([1]);
        expect([...scratch]).toStrictEqual([0, 0, 0]);

        const malformedPlan = {...plan, readingIndexes: Uint32Array.from([1, 9, 2])};
        expect(() => compactTermRecordPreinternedPlan(malformedPlan, 1, 1, scratch))
            .toThrow('Preinterned string index out of bounds: 9');
        expect([...scratch]).toStrictEqual([0, 0, 0]);
        expect(() => compactTermRecordPreinternedPlan(plan, -1, 1, scratch))
            .toThrow('Invalid preinterned plan row range');
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 1, new Uint32Array(2)))
            .toThrow('Invalid preinterned plan compaction scratch');
        expect(compactTermRecordPreinternedPlan(null, 0, 1, scratch)).toBeNull();
    });

    test('maps equal readings to expressions without retaining an empty sentinel key', () => {
        const plan = {
            stringLengths: Uint16Array.from([4, 0]),
            stringOffsets: Uint32Array.from([0, 4]),
            stringsBuffer: Uint8Array.from([116, 101, 114, 109]),
            expressionIndexes: Uint32Array.from([0]),
            readingIndexes: Uint32Array.from([1]),
        };
        const compact = compactTermRecordPreinternedPlan(
            plan,
            0,
            1,
            new Uint32Array(2),
            new Uint8Array([1]),
        );

        expect(compact?.stringLengths).toStrictEqual(Uint16Array.from([4]));
        expect(compact?.stringsBuffer).toStrictEqual(Uint8Array.from([116, 101, 114, 109]));
        expect(compact?.expressionIndexes).toStrictEqual(Uint32Array.from([0]));
        expect(compact?.readingIndexes).toStrictEqual(Uint32Array.from([0]));
        expect(() => compactTermRecordPreinternedPlan(
            plan,
            0,
            1,
            new Uint32Array(2),
            new Uint8Array(0),
        )).toThrow('Invalid preinterned plan reading-equality range');
    });

    test('maps equal readings using source indexes for nonzero row slices', () => {
        const plan = {
            stringLengths: Uint16Array.from([1, 4, 0, 4]),
            stringOffsets: Uint32Array.from([0, 1, 5, 5]),
            stringsBuffer: Uint8Array.from([120, 116, 101, 114, 109, 107, 97, 110, 97]),
            expressionIndexes: Uint32Array.from([0, 1, 1]),
            readingIndexes: Uint32Array.from([0, 2, 3]),
        };
        const compact = compactTermRecordPreinternedPlan(
            plan,
            1,
            2,
            new Uint32Array(4),
            new Uint8Array([0, 1, 0]),
        );

        expect(compact?.stringLengths).toStrictEqual(Uint16Array.from([4, 4]));
        expect(compact?.stringsBuffer).toStrictEqual(Uint8Array.from([116, 101, 114, 109, 107, 97, 110, 97]));
        expect(compact?.expressionIndexes).toStrictEqual(Uint32Array.from([0, 0]));
        expect(compact?.readingIndexes).toStrictEqual(Uint32Array.from([0, 1]));
    });

    test('rejects dirty scratch without erasing storage owned by its caller', () => {
        const plan = createPlan();
        const scratch = Uint32Array.from([7, 0, 0]);
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 1, scratch))
            .toThrow('Preinterned plan compaction scratch is not clear');
        expect([...scratch]).toStrictEqual([7, 0, 0]);
    });

    test('supports omitted offsets and hashes and produces an owned zero-row plan', () => {
        const plan = createPlan();
        Reflect.deleteProperty(plan, 'stringHashes');
        const compact = compactTermRecordPreinternedPlan(plan, 3, 0, new Uint32Array(3));
        expect(compact?.stringOffsets).toStrictEqual(new Uint32Array(0));
        expect(compact?.stringHashes).toBeUndefined();
        expect(compact?.stringsBuffer).toStrictEqual(new Uint8Array(0));
        expect(hasCompleteTermRecordPreinternedPlan(compact, 0)).toBe(true);
    });

    test('rejects malformed structural metadata and fully validates compaction inputs', () => {
        const plan = createPlan();
        expect(hasCompleteTermRecordPreinternedPlan({...plan, stringHashes: new Uint32Array(2)}, 3)).toBe(false);
        expect(hasCompleteTermRecordPreinternedPlan({...plan, stringOffsets: new Uint32Array(2)}, 3)).toBe(false);
        expect(hasCompleteTermRecordPreinternedPlan({...plan, stringsBuffer: new Uint8Array(3)}, 3)).toBe(false);
        expect(() => compactTermRecordPreinternedPlan(
            {...plan, stringOffsets: Uint32Array.from([0, 2, 3])},
            0,
            1,
            new Uint32Array(3),
        )).toThrow('Preinterned plan string arena is out of bounds');
    });

    test('owns encoded strings while retaining zero-copy typed row-index views', () => {
        const builder = createTermRecordPreinternedPlanBuilder(1);
        const sourceBytes = Uint8Array.from([65]);
        const firstIndex = builder.internStringBytes(sourceBytes);
        const expressionIndexes = Uint32Array.from([firstIndex]);
        const readingIndexes = Uint32Array.from([firstIndex]);
        const plan = builder.buildPlan(expressionIndexes, readingIndexes);

        sourceBytes[0] = 90;
        expressionIndexes[0] = 9;
        readingIndexes[0] = 9;
        builder.internStringBytes(Uint8Array.from([66]));
        const laterPlan = builder.buildPlan([0], [0]);

        expect(plan.stringsBuffer).toStrictEqual(Uint8Array.from([65]));
        expect(plan.stringLengths).toStrictEqual(Uint16Array.from([1]));
        expect(plan.expressionIndexes).toStrictEqual(Uint32Array.from([9]));
        expect(plan.readingIndexes).toStrictEqual(Uint32Array.from([9]));
        expect(laterPlan.stringsBuffer).toStrictEqual(Uint8Array.from([90, 66]));
        expect(() => builder.buildPlan([0], [0], 2)).toThrow('Invalid preinterned plan row count');
        expect(() => createTermRecordPreinternedPlanBuilder(Number.POSITIVE_INFINITY))
            .toThrow('Invalid initial preinterned string capacity');
    });

    test('requires complete typed row indexes for the requested count', () => {
        const plan = createPlan();
        expect(hasCompleteTermRecordPreinternedPlan(plan, 3)).toBe(true);
        expect(hasCompleteTermRecordPreinternedPlan(plan, 4)).toBe(false);
        expect(hasCompleteTermRecordPreinternedPlan({...plan, expressionIndexes: [0, 1, 2]}, 3)).toBe(false);
        expect(hasCompleteTermRecordPreinternedPlan(null, 0)).toBe(false);
    });
});
