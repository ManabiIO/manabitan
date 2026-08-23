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
    encodePersistedTermLookupIndexFromRecordPayload,
    encodePersistedTermLookupIndex,
    findExactRows,
    findPrefixRowMatches,
    findPrefixRows,
    findSequenceRows,
    getPersistedTermKeyBytes,
    parsePersistedTermLookupIndex,
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

/**
 * Creates the current term-record payload layout: u32 string count, u32 string
 * arena length, u16 string lengths, string arena, then fixed 24-byte records.
 * @param {string[]} strings
 * @param {Array<{expressionKey: number, readingKey: number, sequence: number}>} records
 * @returns {Uint8Array}
 */
function createRecordPayload(strings, records) {
    const stringBytes = strings.map(bytes);
    const stringBytesLength = stringBytes.reduce((length, value) => length + value.byteLength, 0);
    const stringsOffset = 8 + (strings.length * 2);
    const recordsOffset = stringsOffset + stringBytesLength;
    const output = new Uint8Array(recordsOffset + (records.length * 24));
    const view = new DataView(output.buffer);
    view.setUint32(0, strings.length, true);
    view.setUint32(4, stringBytesLength, true);
    let stringOffset = stringsOffset;
    for (let index = 0; index < stringBytes.length; ++index) {
        const value = stringBytes[index];
        view.setUint16(8 + (index * 2), value.byteLength, true);
        output.set(value, stringOffset);
        stringOffset += value.byteLength;
    }
    for (let row = 0; row < records.length; ++row) {
        const {expressionKey, readingKey, sequence} = records[row];
        const offset = recordsOffset + (row * 24);
        view.setUint32(offset, expressionKey, true);
        view.setUint32(offset + 4, readingKey, true);
        view.setInt32(offset + 20, sequence, true);
    }
    return output;
}

describe('persisted term lookup index', () => {
    test('preinterns duplicate strings exactly across capacity growth', () => {
        const planBuilder = createTermRecordPreinternedPlanBuilder(2);
        const values = Array.from({length: 257}, (_, index) => bytes(`term-${index}`));
        const indexes = values.map((value) => planBuilder.internStringBytes(value));

        expect(values.map((value) => planBuilder.internStringBytes(new Uint8Array(value)))).toEqual(indexes);
        const plan = planBuilder.buildPlan(
            Uint32Array.from(indexes),
            Uint32Array.from(indexes.toReversed()),
        );
        expect(plan.stringLengths).toHaveLength(values.length);
        expect(plan.expressionIndexes).toEqual(Uint32Array.from(indexes));
        expect(plan.readingIndexes).toEqual(Uint32Array.from(indexes.toReversed()));
        expect(decoder.decode(plan.stringsBuffer)).toBe(
            values.map((value) => decoder.decode(value)).join(''),
        );
    });

    test('builds a lookup index from a current interned record payload', () => {
        const payload = createRecordPayload(
            ['食べる', 'たべる', 'する'],
            [
                {expressionKey: 0, readingKey: 1, sequence: 10},
                {expressionKey: 2, readingKey: 0xffffffff, sequence: 11},
            ],
        );
        const index = parsePersistedTermLookupIndex(
            encodePersistedTermLookupIndexFromRecordPayload(payload, 2),
        );

        expect(findExactRows(index, bytes('食べる'), 'expression')).toEqual([0]);
        expect(findExactRows(index, bytes('たべる'), 'reading')).toEqual([0]);
        expect(findExactRows(index, bytes('する'), 'expression')).toEqual([1]);
        expect(findExactRows(index, bytes('する'), 'reading')).toEqual([]);
        expect(findSequenceRows(index, 10)).toEqual([0]);
        expect(findSequenceRows(index, 11)).toEqual([1]);
        expect(getPersistedTermKeyBytes(index, 1, 'reading')).toBeNull();
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
        const records = [
            {expressionKey: 0, readingKey: 1, sequence: 10},
            {expressionKey: 2, readingKey: 0xffffffff, sequence: 11},
        ];
        const payloadEncoded = encodePersistedTermLookupIndexFromRecordPayload(
            createRecordPayload(strings, records),
            records.length,
        );
        const planEncoded = encodePersistedTermLookupIndexFromPreinternedPlan(
            plan,
            new Uint8Array([0, 1]),
            new Int32Array([10, 11]),
            records.length,
        );

        expect(planEncoded).toEqual(payloadEncoded);
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
    });

    test('rejects malformed record-payload dimensions and key references', () => {
        const payload = createRecordPayload(
            ['食べる'],
            [{expressionKey: 0, readingKey: 0xffffffff, sequence: 1}],
        );
        const invalidReference = new Uint8Array(payload);
        new DataView(invalidReference.buffer).setUint32(payload.byteLength - 24, 1, true);

        expect(() => encodePersistedTermLookupIndexFromRecordPayload(payload, 2)).toThrow(
            'Invalid term-record string table for lookup index',
        );
        expect(() => encodePersistedTermLookupIndexFromRecordPayload(invalidReference, 1)).toThrow(
            'Invalid term-record lookup key reference',
        );
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
        expect(decoder.decode(getPersistedTermKeyBytes(index, 2, 'expression'))).toBe('飲む');
        expect(getPersistedTermKeyBytes(index, 3, 'expression')).toBeNull();
    });

    test('stores row-oriented lookup columns compactly as 16-bit values', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('食べる'), readingBytes: bytes('たべる'), sequence: 1},
            {expressionBytes: bytes('する'), readingBytes: null, sequence: null},
        ]);
        const header = new Uint32Array(encoded.buffer, encoded.byteOffset, 16);
        const index = parsePersistedTermLookupIndex(encoded);

        expect(header[6]).toBe(3);
        expect(index.expressionKeys).toBeInstanceOf(Uint16Array);
        expect(index.readingKeys).toBeInstanceOf(Uint16Array);
        expect(index.expressionPostingOffsets).toBeInstanceOf(Uint16Array);
        expect(index.expressionPostingRows).toBeInstanceOf(Uint16Array);
        expect(index.readingPostingOffsets).toBeInstanceOf(Uint16Array);
        expect(index.readingPostingRows).toBeInstanceOf(Uint16Array);
        expect(index.sequenceHeads).toBeInstanceOf(Uint16Array);
        expect(index.sequenceNext).toBeInstanceOf(Uint16Array);
        expect(index.readingKeys[1]).toBe(0xffff);
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
        expect(findSequenceRows(index, 42).sort((a, b) => a - b)).toEqual([0, 1]);
        expect(findSequenceRows(index, 7)).toEqual([2]);
        expect(findSequenceRows(index, -1)).toEqual([]);
        expect(findSequenceRows(index, 1.5)).toEqual([]);
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
        new Uint32Array(malformed.buffer, malformed.byteOffset, 16)[2] = 3;

        expect(() => parsePersistedTermLookupIndex(truncated)).toThrow('Invalid persisted term lookup index length');
        expect(() => parsePersistedTermLookupIndex(malformed)).toThrow('Invalid persisted term lookup index length');
    });

    test('rejects corrupt persisted key hash references and cycles', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: bytes('あるふぁ'), sequence: 1},
            {expressionBytes: bytes('beta'), readingBytes: bytes('べーた'), sequence: 2},
        ]);
        const header = new Uint32Array(encoded.buffer, encoded.byteOffset, 16);
        const keyCount = header[1];
        const keyBytesLength = header[2];
        const alignedKeyBytesLength = (keyBytesLength + 3) & ~3;
        const keySlotCount = header[3];
        const keyHeadsOffset = 64 + alignedKeyBytesLength + ((keyCount + 1) * 4);
        const keyNextOffset = keyHeadsOffset + (keySlotCount * 2);

        const invalidReference = new Uint8Array(encoded);
        new DataView(invalidReference.buffer).setUint16(keyHeadsOffset, keyCount, true);
        expect(() => parsePersistedTermLookupIndex(invalidReference)).toThrow(
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
    });

    test('rejects lookup keys assigned to the wrong hash bucket', () => {
        const encoded = encodePersistedTermLookupIndex([
            {expressionBytes: bytes('alpha'), readingBytes: null, sequence: null},
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const sourceSlot = index.keyHeads.findIndex((value) => value !== 0xffff);
        const targetSlot = index.keyHeads.indexOf(0xffff);
        const key = index.keyHeads[sourceSlot];
        index.keyHeads[sourceSlot] = index.keyNext[key];
        index.keyNext[key] = 0xffff;
        index.keyHeads[targetSlot] = key;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted term lookup hash bucket',
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
        index.expressionPostingRows[1] = firstRow;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
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
            {expressionBytes: bytes('beta'), readingBytes: null, sequence: null},
        ]);
        const index = parsePersistedTermLookupIndex(encoded);
        const sourceSlot = index.sequenceHeads.findIndex((value) => value !== 0xffff);
        const targetSlot = sourceSlot === 0 ? 1 : 0;
        const row = index.sequenceHeads[sourceSlot];
        index.sequenceHeads[sourceSlot] = index.sequenceNext[row];
        index.sequenceNext[row] = index.sequenceHeads[targetSlot];
        index.sequenceHeads[targetSlot] = row;

        expect(() => parsePersistedTermLookupIndex(encoded)).toThrow(
            'Invalid persisted sequence lookup hash chain',
        );
    });
});
