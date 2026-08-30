/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';

describe('authoritative term record encoder', () => {
    test('keeps exact strings distinct across typed hash collisions and table growth', () => {
        const builder = createTermRecordPreinternedPlanBuilder(16);
        const encoder = new TextEncoder();
        const indexes = [];
        for (let i = 0; i < 100; ++i) {
            indexes.push(builder.internStringBytesWithHash(encoder.encode(`term-${i}`), 123));
        }

        expect(new Set(indexes).size).toBe(100);
        expect(builder.internStringBytesWithHash(encoder.encode('term-42'), 123)).toBe(indexes[42]);
        const plan = builder.buildPlan(Uint32Array.from(indexes), Uint32Array.from(indexes));
        expect(plan.stringLengths).toHaveLength(100);
        expect(plan.stringHashes?.every((value) => value === 123)).toBe(true);
    });

    test('encodes unsigned offsets above 4 GiB without a legacy record payload', async () => {
        const base = 0x100000000 + 128;
        const records = [
            {
                id: 1,
                dictionary: 'Jitendex',
                expression: '食べる',
                reading: 'たべる',
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: base,
                entryContentLength: 131072,
                entryContentDictName: 'raw',
                score: 10,
                sequence: 100,
            },
            {
                id: 2,
                dictionary: 'Jitendex',
                expression: '同じ',
                reading: '同じ',
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: base + 0xfffffffe,
                entryContentLength: -1,
                entryContentDictName: 'raw',
                score: -20,
                sequence: null,
            },
        ];
        const store = new TermRecordOpfsStore();
        const encoded = await Reflect.get(store, '_encodeRecords').call(store, records);
        const fields = new DataView(
            encoded.recordFields.buffer,
            encoded.recordFields.byteOffset,
            encoded.recordFields.byteLength,
        );

        expect(encoded.contentOffsetBase).toBe(base);
        expect('bytes' in encoded).toBe(false);
        expect(encoded.recordFields).toHaveLength(records.length * 12);
        expect(fields.getUint32(0, true)).toBe(0);
        expect(fields.getUint32(4, true)).toBe(131072);
        expect(fields.getInt32(8, true)).toBe(10);
        expect(fields.getUint32(12, true)).toBe(0xfffffffe);
        expect(fields.getUint32(16, true)).toBe(0xffffffff);
        expect(fields.getInt32(20, true)).toBe(-20);
        expect(() => Reflect.get(store, '_createLookupIndexChunk').call(
            store,
            1,
            records.length,
            base,
            encoded.lookupIndexBytes,
            encoded.recordFields.subarray(1),
        )).toThrow('Invalid authoritative term-record fields');
    });
});
