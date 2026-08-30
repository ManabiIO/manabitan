/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('term record WASM encoder', () => {
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
        expect(plan.stringHashes.every((value) => value === 123)).toBe(true);
    });

    test('matches the JS encoder for unsigned offsets above 4 GiB', async () => {
        vi.stubGlobal('fetch', async (/** @type {URL} */ url) => {
            return new Response(await readFile(fileURLToPath(url)));
        });
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
        const wasmStore = new TermRecordOpfsStore();
        const jsStore = new TermRecordOpfsStore();
        Reflect.set(jsStore, '_wasmEncoderUnavailable', true);

        const wasm = await Reflect.get(wasmStore, '_encodeRecords').call(wasmStore, records);
        const js = await Reflect.get(jsStore, '_encodeRecords').call(jsStore, records);

        expect(Reflect.get(wasmStore, '_wasmEncoderUnavailable')).toBe(false);
        expect(wasm.contentOffsetBase).toBe(base);
        expect(wasm.bytes).toStrictEqual(js.bytes);
        expect(wasm.recordFields).toHaveLength(records.length * 12);
        const sidecarWithPrecomputedFields = Reflect.get(wasmStore, '_createLookupIndexChunk').call(
            wasmStore,
            1,
            records.length,
            base,
            wasm.lookupIndexBytes,
            wasm.bytes,
            wasm.recordFields,
        );
        const sidecarWithScannedFields = Reflect.get(wasmStore, '_createLookupIndexChunk').call(
            wasmStore,
            1,
            records.length,
            base,
            wasm.lookupIndexBytes,
            wasm.bytes,
        );
        expect(sidecarWithPrecomputedFields).toStrictEqual(sidecarWithScannedFields);
    });
});
