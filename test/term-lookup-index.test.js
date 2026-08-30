/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';
import {
    appendExactRowMatches,
    encodePersistedTermLookupIndexFromPreinternedPlan,
    encodePersistedTermLookupIndexFromValidatedPreinternedPlan,
    encodePersistedTermLookupIndex,
    findExactRows,
    findPrefixRowMatches,
    findPrefixRows,
    findSequenceRows,
    getPersistedTermKeyBytes,
    getPersistedTermSequence,
    parseChecksummedPersistedTermLookupIndex,
    parsePersistedTermLookupIndex,
    rebuildPersistedTermLookupIndexFromBase,
    splitPersistedTermLookupIndex,
} from '../ext/js/dictionary/term-lookup-index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function bytes(value) {
    return encoder.encode(value);
}

/**
 * @param {Array<{expression: string, reading?: string|null, sequence?: number|null}>} rows
 * @returns {import('../ext/js/dictionary/term-lookup-index.js').PersistedTermLookupIndex}
 */
function createIndex(rows) {
    return parsePersistedTermLookupIndex(encodePersistedTermLookupIndex(rows.map(({expression, reading = null, sequence = null}) => ({
        expressionBytes: bytes(expression),
        readingBytes: reading === null ? null : bytes(reading),
        sequence,
    }))));
}

describe('persisted term lookup index', () => {
    test('preinterns duplicate strings exactly across capacity growth', () => {
        const planBuilder = createTermRecordPreinternedPlanBuilder(2);
        const values = Array.from({length: 257}, (_, index) => bytes(`term-${index}`));
        const indexes = values.map((value) => planBuilder.internStringBytes(value));

        expect(values.map((value) => planBuilder.internStringBytes(new Uint8Array(value)))).toEqual(indexes);
        const plan = planBuilder.buildPlan(
            Uint32Array.from(indexes),
            Uint32Array.from([...indexes].reverse()),
        );
        expect(plan.stringLengths).toHaveLength(values.length);
        expect(plan.expressionIndexes).toEqual(Uint32Array.from(indexes));
        expect(plan.readingIndexes).toEqual(Uint32Array.from([...indexes].reverse()));
        expect(decoder.decode(plan.stringsBuffer)).toBe(
            values.map((value) => decoder.decode(value)).join(''),
        );
    });

    test('builds byte-identical indexes directly from preinterned parser plans', () => {
        const strings = ['食べる', 'たべる', 'する'];
        const stringBytes = strings.map(bytes);
        const planBuilder = createTermRecordPreinternedPlanBuilder();
        const stringIndexes = stringBytes.map((value) => planBuilder.internStringBytes(value));
        const plan = planBuilder.buildPlan(
            new Uint32Array([stringIndexes[0], stringIndexes[2]]),
            new Uint32Array([stringIndexes[1], stringIndexes[2]]),
        );
        const rowEncoded = encodePersistedTermLookupIndex([
            {expressionBytes: stringBytes[0], readingBytes: stringBytes[1], sequence: 10},
            {expressionBytes: stringBytes[2], readingBytes: null, sequence: 11},
        ]);
        const planEncoded = encodePersistedTermLookupIndexFromPreinternedPlan(
            plan,
            new Uint8Array([0, 1]),
            new Int32Array([10, 11]),
            2,
        );
        const validatedPlanEncoded = encodePersistedTermLookupIndexFromValidatedPreinternedPlan(
            plan,
            new Uint8Array([0, 1]),
            new Int32Array([10, 11]),
            2,
            1,
        );

        expect(planEncoded).toEqual(rowEncoded);
        expect(validatedPlanEncoded).toEqual(rowEncoded);
    });

    test('rejects malformed preinterned parser plans', () => {
        const plan = {
            stringLengths: new Uint16Array([3]),
            stringsBuffer: bytes('abc'),
            expressionIndexes: new Uint32Array([0]),
            readingIndexes: new Uint32Array([0]),
        };
        const encode = (value = plan) => encodePersistedTermLookupIndexFromPreinternedPlan(
            value,
            new Uint8Array([1]),
            new Int32Array([1]),
            1,
        );

        expect(() => encode({...plan, stringsBuffer: bytes('ab')})).toThrow(
            'Invalid preinterned term-record string arena',
        );
        expect(() => encode({...plan, expressionIndexes: new Uint32Array([1])})).toThrow(
            'Invalid preinterned term-record key reference',
        );
        expect(() => encodePersistedTermLookupIndexFromPreinternedPlan(
            plan,
            new Uint8Array(),
            new Int32Array([1]),
            1,
        )).toThrow('Invalid preinterned term-record plan for lookup index');
        expect(() => encodePersistedTermLookupIndexFromValidatedPreinternedPlan(
            plan,
            new Uint8Array([1]),
            new Int32Array([1]),
            1,
            2,
        )).toThrow('Invalid validated reading posting count');
    });

    test('round trips exact expression and reading lookups without decoding stored keys', () => {
        const index = createIndex([
            {expression: '食べる', reading: 'たべる', sequence: 10},
            {expression: '食べる', reading: 'たべる', sequence: 11},
            {expression: '飲む', reading: 'のむ'},
        ]);

        expect(findExactRows(index, bytes('食べる'), 'expression').sort((a, b) => a - b)).toEqual([0, 1]);
        expect(findExactRows(index, bytes('たべる'), 'reading').sort((a, b) => a - b)).toEqual([0, 1]);
        expect(findExactRows(index, bytes('ない'), 'expression')).toEqual([]);
        const expressionBytes = getPersistedTermKeyBytes(index, 2, 'expression');
        expect(expressionBytes).not.toBeNull();
        expect(decoder.decode(/** @type {Uint8Array} */ (expressionBytes))).toBe('飲む');
        expect(getPersistedTermKeyBytes(index, 3, 'expression')).toBeNull();
    });

    test('stores row-oriented lookup columns compactly as 16-bit values', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('食べる'), readingBytes: bytes('たべる'), sequence: 1},
            {expressionBytes: bytes('する'), readingBytes: null, sequence: null},
        ]);
        const containerHeader = new Uint32Array(encoded.buffer, encoded.byteOffset, 4);
        const baseHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16, 8);
        const derivedOffset = 16 + containerHeader[2];
        const derivedHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + derivedOffset, 8);
        const index = parsePersistedTermLookupIndex(encoded);
        const rowCount = baseHeader[0];
        const keyCount = baseHeader[1];
        const keyBytesLength = baseHeader[2];
        const sequenceKeyCount = baseHeader[4];
        const keySlotCount = derivedHeader[2];
        const sequenceSlotCount = derivedHeader[3];
        const readingPostingCount = derivedHeader[4];
        const sequencePostingCount = derivedHeader[6];
        /**
         * @param {number} value
         * @returns {number}
         */
        const align4 = (value) => (value + 3) & ~3;
        const compactU16Count =
            (keyCount + 1) +
            rowCount +
            (keyCount + 1) +
            readingPostingCount +
            sequenceSlotCount +
            sequenceKeyCount +
            (sequenceKeyCount + 1) +
            sequencePostingCount;

        expect(baseHeader[3]).toBe(7);
        expect(derivedHeader[7]).toBe(7);
        expect(encoded.byteLength).toBe(
            16 +
            32 + align4(keyBytesLength) + align4((keyCount + (rowCount * 3)) * 2) + (sequenceKeyCount * 4) +
            32 + align4((keySlotCount + keyCount + compactU16Count) * 2),
        );
        expect(index.expressionKeys).toBeInstanceOf(Uint16Array);
        expect(index.readingKeys).toBeInstanceOf(Uint16Array);
        expect(index.expressionPostingOffsets).toBeInstanceOf(Uint16Array);
        expect(index.expressionPostingRows).toBeInstanceOf(Uint16Array);
        expect(index.readingPostingOffsets).toBeInstanceOf(Uint16Array);
        expect(index.readingPostingRows).toBeInstanceOf(Uint16Array);
        expect(index.sequenceHeads).toBeInstanceOf(Uint16Array);
        expect(index.sequenceNext).toBeInstanceOf(Uint16Array);
        expect(index.sequenceKeys).toBeInstanceOf(Int32Array);
        expect(index.sequencePostingOffsets).toBeInstanceOf(Uint16Array);
        expect(index.sequencePostingRows).toBeInstanceOf(Uint16Array);
        expect(index.readingKeys[1]).toBe(0xffff);
        expect(getPersistedTermSequence(index, 0)).toBe(1);
        expect(getPersistedTermSequence(index, 1)).toBeNull();
        expect(index.sequenceRowKeys).toEqual(new Uint16Array([0, 0xffff]));
    });

    test('omits sequence keys and postings when every row has no sequence', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: null},
        ]);
        const containerHeader = new Uint32Array(encoded.buffer, encoded.byteOffset, 4);
        const baseHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16, 8);
        const derivedHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16 + containerHeader[2], 8);
        const index = parsePersistedTermLookupIndex(encoded);

        expect(baseHeader[4]).toBe(0);
        expect(derivedHeader[6]).toBe(0);
        expect(index.sequenceKeys).toHaveLength(0);
        expect(index.sequenceNext).toHaveLength(0);
        expect(index.sequencePostingOffsets).toEqual(new Uint16Array([0]));
        expect(index.sequencePostingRows).toHaveLength(0);
        expect(findSequenceRows(index, 0)).toEqual([]);
    });

    test('round trips a full production-sized 30,000-row lookup chunk', () => {
        const rowCount = 30_000;
        const plan = {
            stringLengths: new Uint16Array([1]),
            stringOffsets: new Uint32Array([0]),
            stringHashes: new Uint32Array([0xe40c292c]),
            stringsBuffer: bytes('a'),
            expressionIndexes: new Uint32Array(rowCount),
            readingIndexes: new Uint32Array(rowCount),
        };
        const encoded = encodePersistedTermLookupIndexFromPreinternedPlan(
            plan,
            new Uint8Array(rowCount).fill(1),
            new Int32Array(rowCount).fill(-1),
            rowCount,
        );
        const index = parsePersistedTermLookupIndex(encoded);

        expect(index.expressionPostingOffsets).toEqual(new Uint16Array([0, rowCount]));
        expect(index.expressionPostingRows[0]).toBe(0);
        expect(index.expressionPostingRows[rowCount - 1]).toBe(rowCount - 1);
        expect(findExactRows(index, bytes('a'), 'expression')).toHaveLength(rowCount);
    });

    test('rejects row counts that collide with the compact null sentinel', () => {
        const plan = {
            stringLengths: new Uint16Array([1]),
            stringsBuffer: bytes('a'),
            expressionIndexes: new Uint32Array([0]),
            readingIndexes: new Uint32Array([0]),
        };

        expect(() => encodePersistedTermLookupIndexFromPreinternedPlan(
            plan,
            new Uint8Array([1]),
            new Int32Array([-1]),
            0xffff,
        )).toThrow('Term lookup index has too many rows for one chunk');
    });

    test('appends expression and reading matches with one row offset', () => {
        const index = createIndex([
            {expression: 'する', reading: null},
            {expression: '為る', reading: 'する'},
            {expression: '別', reading: 'べつ'},
        ]);
        const expression = [1];
        const reading = [2];

        appendExactRowMatches(index, bytes('する'), expression, reading, 100);

        expect(expression).toEqual([1, 100]);
        expect(reading).toEqual([2, 101]);
    });

    test('omits expression-equal readings from the reading index', () => {
        const index = createIndex([
            // Import normalization represents reading === expression as null.
            {expression: 'する', reading: null},
            {expression: '為る', reading: 'する'},
        ]);

        expect(findExactRows(index, bytes('する'), 'expression')).toEqual([0]);
        expect(findExactRows(index, bytes('する'), 'reading')).toEqual([1]);
        expect(getPersistedTermKeyBytes(index, 0, 'reading')).toBeNull();
    });

    test('retains duplicate postings and finds sequences', () => {
        const index = createIndex([
            {expression: '同じ', reading: 'おなじ', sequence: 42},
            {expression: '同じ', reading: 'おなじ', sequence: 42},
            {expression: '別', reading: 'べつ', sequence: 7},
        ]);

        expect(findExactRows(index, bytes('同じ'), 'expression').sort((a, b) => a - b)).toEqual([0, 1]);
        expect(findExactRows(index, bytes('おなじ'), 'reading').sort((a, b) => a - b)).toEqual([0, 1]);
        expect(findSequenceRows(index, 42)).toEqual([1, 0]);
        expect(findSequenceRows(index, 7)).toEqual([2]);
        expect(findSequenceRows(index, -1)).toEqual([]);
        expect(findSequenceRows(index, 1.5)).toEqual([]);
    });

    test('rebuilds equivalent derived postings from the authoritative base', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('同じ'), readingBytes: bytes('おなじ'), sequence: 42},
            {expressionBytes: bytes('同じ'), readingBytes: bytes('おなじ'), sequence: 42},
            {expressionBytes: bytes('別'), readingBytes: null, sequence: null},
        ]);
        const {base, derived} = splitPersistedTermLookupIndex(encoded);
        const rebuilt = rebuildPersistedTermLookupIndexFromBase(base);
        const rebuiltSections = splitPersistedTermLookupIndex(rebuilt);
        const index = parsePersistedTermLookupIndex(rebuilt);

        expect(rebuiltSections.base).toStrictEqual(base);
        expect(rebuiltSections.derived).toStrictEqual(derived);
        expect(findExactRows(index, bytes('同じ'), 'expression')).toEqual([0, 1]);
        expect(findSequenceRows(index, 42)).toEqual([1, 0]);
    });

    test('rejects authoritative base corruption without consulting derived postings', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: 1},
        ]);
        const {base} = splitPersistedTermLookupIndex(encoded);
        const corruptBase = new Uint8Array(base);
        const baseHeader = new Uint32Array(corruptBase.buffer, corruptBase.byteOffset, 8);
        const keyLengthsOffset = 32 + ((baseHeader[2] + 3) & ~3);
        new DataView(corruptBase.buffer).setUint16(keyLengthsOffset, 0, true);

        expect(() => rebuildPersistedTermLookupIndexFromBase(corruptBase)).toThrow(
            'Invalid persisted term lookup key boundary',
        );
    });

    test('uses dense chained hash tables without losing collision matches', () => {
        const rows = Array.from({length: 10}, (_, index) => ({
            expressionBytes: bytes(`expression-${index}`),
            readingBytes: bytes(`reading-${index}`),
            sequence: index,
        }));
        const encoded = encodePersistedTermLookupIndex(rows);
        const containerHeader = new Uint32Array(encoded.buffer, encoded.byteOffset, 4);
        const baseHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16, 8);
        const derivedHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16 + containerHeader[2], 8);
        const index = parsePersistedTermLookupIndex(encoded);

        expect(derivedHeader[2]).toBeLessThan(baseHeader[1]);
        expect(derivedHeader[3]).toBeLessThan(baseHeader[0]);
        for (let row = 0; row < rows.length; ++row) {
            expect(findExactRows(index, rows[row].expressionBytes, 'expression')).toEqual([row]);
            expect(findExactRows(index, rows[row].readingBytes, 'reading')).toEqual([row]);
            expect(findSequenceRows(index, row)).toEqual([row]);
        }
        expect(findExactRows(index, bytes('missing'), 'expression')).toEqual([]);
        expect(findSequenceRows(index, rows.length)).toEqual([]);
    });

    test('finds forward prefixes and Unicode suffixes at code point boundaries', () => {
        const index = createIndex([
            {expression: '食べる', reading: 'たべる'},
            {expression: '食べた', reading: 'たべた'},
            {expression: '旅😀', reading: 'たび'},
            {expression: '😀', reading: 'えがお'},
            {expression: '旅😺', reading: 'たびねこ'},
        ]);

        expect(index.forwardReady).toBe(false);
        expect(findPrefixRows(index, bytes('食べ'), 'expression')).toEqual(expect.arrayContaining([
            {row: 0, exact: false},
            {row: 1, exact: false},
        ]));
        expect(index.forwardReady).toBe(true);
        expect(findPrefixRows(index, bytes('たべる'), 'reading')).toEqual([{row: 0, exact: true}]);
        const combined = findPrefixRowMatches(index, bytes('食べ'));
        expect(combined.expression).toEqual(expect.arrayContaining([
            {row: 0, exact: false},
            {row: 1, exact: false},
        ]));
        expect(combined.reading).toEqual([]);
        expect(index.reverseReady).toBe(false);
        expect(findPrefixRows(index, bytes('😀'), 'expression', true).sort((a, b) => a.row - b.row)).toEqual([
            {row: 2, exact: false},
            {row: 3, exact: true},
        ]);
        expect(index.reverseReady).toBe(true);
        expect(findPrefixRows(index, bytes('不存在'), 'expression')).toEqual([]);
        expect(findPrefixRows(index, new Uint8Array(), 'expression')).toEqual([]);
        expect(findPrefixRowMatches(index, new Uint8Array())).toEqual({expression: [], reading: []});
    });

    test('rejects truncated and malformed payloads', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('食べる'), readingBytes: bytes('たべる'), sequence: 1},
        ]);
        const truncated = encoded.slice(0, encoded.byteLength - 1);
        const malformed = new Uint8Array(encoded);
        new Uint32Array(malformed.buffer, malformed.byteOffset, 4)[2] = 3;

        expect(() => parsePersistedTermLookupIndex(truncated)).toThrow('Invalid persisted term lookup index container');
        expect(() => parsePersistedTermLookupIndex(malformed)).toThrow('Invalid persisted term lookup index container');
    });

    test('rejects corrupt persisted key hash references and cycles', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: 1},
            {expressionBytes: bytes('beta'), readingBytes: bytes('べーた'), sequence: 2},
        ]);
        const containerHeader = new Uint32Array(encoded.buffer, encoded.byteOffset, 4);
        const baseHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16, 8);
        const derivedOffset = 16 + containerHeader[2];
        const derivedHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + derivedOffset, 8);
        const keyCount = baseHeader[1];
        const keySlotCount = derivedHeader[2];
        const keyHeadsOffset = derivedOffset + 32;
        const keyNextOffset = keyHeadsOffset + (keySlotCount * 2);

        const invalidReference = new Uint8Array(encoded);
        new DataView(invalidReference.buffer).setUint16(keyHeadsOffset, keyCount, true);
        expect(() => parsePersistedTermLookupIndex(invalidReference)).toThrow(
            'Invalid persisted 16-bit term lookup reference',
        );
        expect(() => parseChecksummedPersistedTermLookupIndex(invalidReference)).toThrow(
            'Invalid persisted 16-bit term lookup reference',
        );

        const cyclic = new Uint8Array(encoded);
        const cyclicView = new DataView(cyclic.buffer);
        let head = 0xffff;
        for (let slot = 0; slot < keySlotCount && head === 0xffff; ++slot) {
            head = cyclicView.getUint16(keyHeadsOffset + (slot * 2), true);
        }
        cyclicView.setUint16(keyNextOffset + (head * 2), head, true);
        expect(() => parsePersistedTermLookupIndex(cyclic)).toThrow(
            'Cyclic or duplicated persisted term lookup hash chain',
        );
        expect(() => parseChecksummedPersistedTermLookupIndex(cyclic)).toThrow(
            'Cyclic or duplicated persisted term lookup hash chain',
        );
    });

    test('rejects lookup keys assigned to the wrong hash bucket', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('gamma'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('delta'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('epsilon'), readingBytes: null, sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const sourceSlot = index.keyHeads.findIndex((value) => value !== 0xffff);
        const targetSlot = (sourceSlot + 1) & (index.keyHeads.length - 1);
        const key = index.keyHeads[sourceSlot];
        index.keyHeads[sourceSlot] = index.keyNext[key];
        index.keyNext[key] = index.keyHeads[targetSlot];
        index.keyHeads[targetSlot] = key;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup hash bucket',
        );
    });

    test('rejects corrupt compact key lengths', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: null},
        ]);
        const baseHeader = new Uint32Array(encoded.buffer, encoded.byteOffset + 16, 8);
        const alignedKeyBytesLength = (baseHeader[2] + 3) & ~3;
        const keyLengthsOffset = 16 + 32 + alignedKeyBytesLength;
        const zeroLength = new Uint8Array(encoded);
        new DataView(zeroLength.buffer).setUint16(keyLengthsOffset, 0, true);
        expect(() => parsePersistedTermLookupIndex(zeroLength)).toThrow(
            'Invalid persisted term lookup key boundary',
        );

        const incompleteArena = new Uint8Array(encoded);
        const incompleteView = new DataView(incompleteArena.buffer);
        incompleteView.setUint16(
            keyLengthsOffset,
            incompleteView.getUint16(keyLengthsOffset, true) - 1,
            true,
        );
        expect(() => parseChecksummedPersistedTermLookupIndex(incompleteArena)).toThrow(
            'Invalid persisted term lookup key arena',
        );
    });

    test('rejects postings assigned to a different key', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: null},
            {expressionBytes: bytes('beta'), readingBytes: bytes('べーた'), sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const firstRow = index.expressionPostingRows[0];
        const secondRow = index.expressionPostingRows[1];
        index.expressionPostingRows[0] = secondRow;
        index.expressionPostingRows[1] = secondRow;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup posting row',
        );
        expect(firstRow).not.toBe(secondRow);
    });

    test('rejects duplicate reading postings while reconstructing row ownership', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: null},
            {expressionBytes: bytes('beta'), readingBytes: bytes('べーた'), sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        index.readingPostingRows[1] = index.readingPostingRows[0];

        expect(() => parseChecksummedPersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup posting row',
        );
    });

    test('rejects out-of-range posting rows through semantic validation', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        index.expressionPostingRows[0] = index.expressionKeys.length;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup posting row',
        );
    });

    test('rejects sequence rows assigned to the wrong hash bucket', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 42},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: 3},
            {expressionBytes: bytes('gamma'), readingBytes: null, sequence: 7},
            {expressionBytes: bytes('delta'), readingBytes: null, sequence: 19},
            {expressionBytes: bytes('epsilon'), readingBytes: null, sequence: 11},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const sourceSlot = index.sequenceHeads.findIndex((value) => value !== 0xffff);
        const targetSlot = (sourceSlot + 1) & (index.sequenceHeads.length - 1);
        const row = index.sequenceHeads[sourceSlot];
        index.sequenceHeads[sourceSlot] = index.sequenceNext[row];
        index.sequenceNext[row] = index.sequenceHeads[targetSlot];
        index.sequenceHeads[targetSlot] = row;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted sequence lookup hash chain',
        );
    });

    test('rejects out-of-range sequence chain references during fused validation', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 42},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const slot = index.sequenceHeads.findIndex((value) => value !== 0xffff);
        index.sequenceHeads[slot] = index.sequenceKeys.length;

        expect(() => parseChecksummedPersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted 16-bit term lookup reference',
        );
    });

    test('rejects duplicate persisted sequence keys', () => {
        const encoded = encodePersistedTermLookupIndex(
            Array.from({length: 9}, (_, sequence) => ({
                expressionBytes: bytes(`expression-${sequence}`),
                readingBytes: null,
                sequence,
            })),
        );
        const index = parsePersistedTermLookupIndex(encoded);
        const head = index.sequenceHeads.find((key) => key !== 0xffff && index.sequenceNext[key] !== 0xffff);
        expect(head).toBeDefined();
        if (typeof head === 'undefined') { throw new Error('Expected a colliding sequence hash chain'); }
        const duplicate = index.sequenceNext[head];
        index.sequenceKeys[duplicate] = index.sequenceKeys[head];

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Duplicate persisted sequence lookup key',
        );
    });

    test('rejects empty sequence posting lists', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 1},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: 2},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        index.sequencePostingOffsets[1] = 0;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Incomplete persisted sequence lookup postings',
        );
    });

    test('rejects duplicate and out-of-range sequence posting rows', () => {
        const duplicate = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 1},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: 2},
        ]);
        const duplicateIndex = parsePersistedTermLookupIndex(duplicate);
        duplicateIndex.sequencePostingRows[1] = duplicateIndex.sequencePostingRows[0];
        expect(() => parseChecksummedPersistedTermLookupIndex(duplicate)).toThrow(
            'Invalid persisted sequence lookup posting row',
        );

        const outOfRange = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 1},
        ]);
        const outOfRangeIndex = parsePersistedTermLookupIndex(outOfRange);
        outOfRangeIndex.sequencePostingRows[0] = outOfRangeIndex.expressionKeys.length;
        expect(() => parsePersistedTermLookupIndex(outOfRange)).toThrow(
            'Invalid persisted sequence lookup posting row',
        );
    });

    test('rejects malformed persisted sequence dimensions', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: 1},
        ]);
        new Uint32Array(encoded.buffer, encoded.byteOffset, 16)[8] = 2;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup index dimensions',
        );
    });
});
