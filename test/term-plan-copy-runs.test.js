/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {compactTermRecordPreinternedPlan} from '../ext/js/dictionary/term-record-preinterned-plan.js';

/** @typedef {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

/**
 * @param {number[][]} keys
 * @param {number[]} expressions
 * @param {number[]} readings
 * @param {boolean} [shared]
 * @returns {Plan}
 */
function createPlan(keys, expressions, readings, shared = false) {
    const flattened = keys.flat();
    const storage = shared ? new SharedArrayBuffer(flattened.length + 13) : new ArrayBuffer(flattened.length + 13);
    const allBytes = new Uint8Array(storage);
    allBytes.fill(0xee);
    // Exercise a nonzero byteOffset; offsets in a plan are relative to its view.
    const stringsBuffer = new Uint8Array(storage, 7, flattened.length);
    stringsBuffer.set(flattened);
    let offset = 0;
    return {
        stringsBuffer,
        stringLengths: Uint16Array.from(keys, (key) => key.length),
        stringOffsets: Uint32Array.from(keys, (key) => {
            const result = offset;
            offset += key.length;
            return result;
        }),
        stringHashes: Uint32Array.from(keys, (_, index) => (index * 97) >>> 0),
        expressionIndexes: Uint32Array.from(expressions),
        readingIndexes: Uint32Array.from(readings),
    };
}

/**
 * Independent per-key copy oracle: no contiguous-range inference.
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {boolean[]|Uint8Array} [equal]
 * @returns {Plan}
 */
function referenceCompact(plan, start, count, equal) {
    const sourceOffsets = [];
    let offset = 0;
    for (const length of plan.stringLengths) {
        sourceOffsets.push(offset);
        offset += length;
    }
    /** @type {Map<number, number>} */
    const remap = new Map();
    const expressions = [];
    const readings = [];
    /**
     * @param {number} oldIndex
     * @returns {number}
     */
    const intern = (oldIndex) => {
        let index = remap.get(oldIndex);
        if (typeof index === 'undefined') {
            index = remap.size;
            remap.set(oldIndex, index);
        }
        return index;
    };
    for (let row = start; row < start + count; ++row) {
        const expression = plan.expressionIndexes[row];
        expressions.push(intern(expression));
        readings.push(intern(equal?.[row] === true || equal?.[row] === 1 ? expression : plan.readingIndexes[row]));
    }
    const keys = [...remap.keys()];
    const outputOffsets = [];
    const outputBytes = [];
    for (const key of keys) {
        outputOffsets.push(outputBytes.length);
        for (let i = 0; i < plan.stringLengths[key]; ++i) {
            outputBytes.push(plan.stringsBuffer[sourceOffsets[key] + i]);
        }
    }
    return {
        stringsBuffer: Uint8Array.from(outputBytes),
        stringOffsets: Uint32Array.from(outputOffsets),
        stringLengths: Uint16Array.from(keys, (key) => plan.stringLengths[key]),
        stringHashes: plan.stringHashes ? Uint32Array.from(keys, (key) => /** @type {Uint32Array} */ (plan.stringHashes)[key]) : void 0,
        expressionIndexes: Uint32Array.from(expressions),
        readingIndexes: Uint32Array.from(readings),
    };
}

/**
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {boolean[]|Uint8Array} [equal]
 * @returns {Plan|null}
 */
function check(plan, start, count, equal) {
    const expected = referenceCompact(plan, start, count, equal);
    const before = new Uint8Array(new Uint8Array(plan.stringsBuffer.buffer));
    const scratch = new Uint32Array(plan.stringLengths.length);
    const actual = compactTermRecordPreinternedPlan(plan, start, count, scratch, equal);
    expect(actual).toStrictEqual(expected);
    expect(actual?.stringsBuffer.buffer).not.toBe(plan.stringsBuffer.buffer);
    expect(actual?.stringsBuffer.byteOffset).toBe(0);
    expect(new Uint8Array(plan.stringsBuffer.buffer)).toStrictEqual(before);
    expect(scratch.every((value) => value === 0)).toBe(true);
    return actual;
}

describe('compacted term-plan contiguous copy runs', () => {
    test('copies thousands of adjacent keys with a single source view', () => {
        const keys = Array.from({length: 4096}, (_, i) => [i & 255, (i >>> 8) & 255, 0]);
        const indexes = keys.map((_, i) => i);
        const plan = createPlan(keys, indexes, indexes);
        const subarray = vi.spyOn(plan.stringsBuffer, 'subarray');
        check(plan, 0, indexes.length);
        expect(subarray).toHaveBeenCalledTimes(1);
        expect(subarray).toHaveBeenCalledWith(0, 4096 * 3);
    });

    test.each([
        {name: 'gaps', order: [0, 2, 3], runs: 2},
        {name: 'reverse order', order: [3, 2, 1, 0], runs: 4},
        {name: 'repeated keys', order: [0, 0, 1, 1, 2, 3], runs: 1},
        {name: 'initial and final omitted keys', order: [1, 2], runs: 1},
        {name: 'one key', order: [2], runs: 1},
        {name: 'empty selection', order: [], runs: 0},
    ])('preserves $name without copying unreferenced ranges', ({order, runs}) => {
        const plan = createPlan([[0, 1], [10, 11, 12], [20], [30, 31]], order, order);
        const subarray = vi.spyOn(plan.stringsBuffer, 'subarray');
        check(plan, 0, order.length);
        expect(subarray).toHaveBeenCalledTimes(runs);
    });

    test('keeps first-reference expression/reading order, not source order', () => {
        check(createPlan([[1], [2, 3], [4], [5, 6]], [2, 0], [3, 1]), 0, 2);
    });

    test.each([false, true])('supports shared=%s source slabs without borrowing the output', (shared) => {
        const plan = createPlan([[1, 2], [3], [4, 5]], [0, 1, 2], [0, 1, 2], shared);
        const compact = check(plan, 0, 3);
        plan.stringsBuffer.fill(99);
        expect(compact?.stringsBuffer).toStrictEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    });

    test('coalesces through referenced and unreferenced zero-length keys', () => {
        const plan = createPlan([[1], [], [2, 3], [], [4]], [1, 0, 2, 4], [1, 0, 2, 4]);
        const subarray = vi.spyOn(plan.stringsBuffer, 'subarray');
        check(plan, 0, 4);
        expect(subarray).toHaveBeenCalledTimes(1);
    });

    test('preserves zero-byte referenced strings without copying', () => {
        const plan = createPlan([[], [], []], [2, 0, 1], [1, 2, 0]);
        const subarray = vi.spyOn(plan.stringsBuffer, 'subarray');
        const compact = check(plan, 0, 3);
        expect(compact?.stringLengths).toHaveLength(3);
        expect(subarray).not.toHaveBeenCalled();
    });

    test.each([false, true])('supports optional offsets/hashes and nonzero row start, typed equality=%s', (typed) => {
        const plan = createPlan([[1], [], [2, 3], [4]], [3, 0, 2], [0, 1, 3]);
        Reflect.deleteProperty(plan, 'stringOffsets');
        Reflect.deleteProperty(plan, 'stringHashes');
        check(plan, 1, 2, typed ? Uint8Array.from([0, 1, 0]) : [false, true, false]);
    });

    test('retains full structural validation even for an unreferenced malformed key', () => {
        const plan = createPlan([[1], [2], [3]], [0], [0]);
        plan.stringOffsets = Uint32Array.from([0, 1, 1]);
        const subarray = vi.spyOn(plan.stringsBuffer, 'subarray');
        expect(() => compactTermRecordPreinternedPlan(plan, 0, 1, new Uint32Array(3))).toThrow('arena is out of bounds');
        expect(subarray).not.toHaveBeenCalled();
    });

    test('preserves the maximum persisted key length', () => {
        check(createPlan([new Array(65535).fill(65), [0], new Array(65535).fill(66)], [0, 2], [1, 2]), 0, 2);
    });

    test('matches independent per-key copying for 1000 deterministic uneven plans', () => {
        let state = 0x13579bdf;
        const next = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
        };
        for (let trial = 0; trial < 1000; ++trial) {
            const keys = Array.from({length: 1 + next() % 40}, () => Array.from({length: next() % 21}, () => next() & 255));
            const count = next() % 60;
            const expressions = Array.from({length: count}, () => next() % keys.length);
            const readings = Array.from({length: count}, () => next() % keys.length);
            const plan = createPlan(keys, expressions, readings, trial % 7 === 0);
            if (trial % 2 === 0) { Reflect.deleteProperty(plan, 'stringOffsets'); }
            if (trial % 3 === 0) { Reflect.deleteProperty(plan, 'stringHashes'); }
            const start = next() % (count + 1);
            const size = next() % (count - start + 1);
            const equal = Uint8Array.from({length: count}, () => next() % 2);
            check(plan, start, size, equal);
        }
    });
});
