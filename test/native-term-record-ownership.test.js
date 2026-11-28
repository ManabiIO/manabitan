/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {admitNativeTermRecordLease, assertNativeTermRecordLease, hasNativeTermRecordLease, NativeTermRecordImportOwner, registerReceivedNativeTermRecordChunk} from '../ext/js/dictionary/native-term-record-ownership.js';
import {createNativeRecordFixture, receiveNativeRecordFixture} from './util/native-term-record-fixture.js';

describe('private native record ownership', () => {
    test('requires both genuine receiver origin and a private callback owner', () => {
        const {source} = createNativeRecordFixture();
        const owner = new NativeTermRecordImportOwner(() => {});
        expect(owner.bind(source, {...source})).toBeNull();
        expect(registerReceivedNativeTermRecordChunk(source)).toBe(true);
        expect(owner.claim(source)).toBeNull();
        expect(hasNativeTermRecordLease({}, source)).toBe(false);
    });

    test('binds once across the importer spread and admits one database append', () => {
        const {source} = createNativeRecordFixture();
        const {owner, lease, chunk} = receiveNativeRecordFixture(source);
        expect(hasNativeTermRecordLease(lease, chunk)).toBe(true);
        expect(hasNativeTermRecordLease(lease, source)).toBe(false);
        expect(owner.claim(chunk)).toBeNull();
        expect(owner.bind(source, {...source})).toBeNull();
        admitNativeTermRecordLease(lease, chunk);
        expect(() => admitNativeTermRecordLease(lease, chunk)).toThrow('already admitted');
        owner.release(lease);
        expect(hasNativeTermRecordLease(lease, chunk)).toBe(false);
    });

    test('close immediately revokes a claimed lease', () => {
        const {owner, lease, chunk} = receiveNativeRecordFixture(createNativeRecordFixture().source);
        owner.close();
        expect(hasNativeTermRecordLease(lease, chunk)).toBe(false);
        expect(() => assertNativeTermRecordLease(lease, chunk)).toThrow('ownership changed');
        owner.release(lease);
    });

    test('can retire an unclaimed lease when the private callback fails', () => {
        const {source} = createNativeRecordFixture();
        registerReceivedNativeTermRecordChunk(source);
        const owner = new NativeTermRecordImportOwner(() => {});
        const target = {...source};
        const lease = owner.bind(source, target);
        owner.release(lease);
        expect(owner.claim(target)).toBeNull();
    });

    test.each(['scoreList', 'sequenceList', 'readingEqualsExpressionList', 'contentUniqueIndexList'])('rejects replacement of %s', (field) => {
        const {lease, chunk} = receiveNativeRecordFixture(createNativeRecordFixture().source);
        Reflect.set(chunk, field, structuredClone(Reflect.get(chunk, field)));
        expect(() => assertNativeTermRecordLease(lease, chunk)).toThrow('ownership changed');
    });

    test.each(['dictionary', 'dictionaryTotalRows', 'rowCount'])('rejects changed %s metadata', (field) => {
        const {lease, chunk} = receiveNativeRecordFixture(createNativeRecordFixture().source);
        Reflect.set(chunk, field, 'changed');
        expect(() => assertNativeTermRecordLease(lease, chunk)).toThrow('ownership changed');
    });

    test('rejects replacing the complete native map or its prepared payload', () => {
        for (const replaceMap of [true, false]) {
            const {lease, chunk} = receiveNativeRecordFixture(createNativeRecordFixture().source);
            const indexes = /** @type {NonNullable<typeof chunk.preparedLookupIndexes>} */ (chunk.preparedLookupIndexes);
            if (replaceMap) {
                chunk.preparedLookupIndexes = new Map(indexes);
            } else {
                const prepared = /** @type {NonNullable<ReturnType<typeof indexes.get>>} */ (indexes.get(`0:${chunk.rowCount}`));
                prepared.bytes = new Uint8Array(prepared.bytes);
            }
            expect(() => assertNativeTermRecordLease(lease, chunk)).toThrow('ownership changed');
        }
    });

    test('rejects shared, borrowed, and explicit per-row record columns', () => {
        for (const shape of ['shared', 'borrowed', 'explicit']) {
            const {source} = createNativeRecordFixture();
            if (shape === 'shared') { source.scoreList = new Int32Array(new SharedArrayBuffer(source.rowCount * 4)); }
            if (shape === 'borrowed') { source.releaseBorrowedContent = () => {}; }
            if (shape === 'explicit') { source.expressionBytesList = [new Uint8Array([1])]; }
            expect(registerReceivedNativeTermRecordChunk(source)).toBe(false);
        }
    });

    test('checks the private import owner after admission', () => {
        let active = true;
        const {lease, chunk} = receiveNativeRecordFixture(createNativeRecordFixture().source, () => {
            if (!active) { throw new Error('cancelled import'); }
        });
        admitNativeTermRecordLease(lease, chunk);
        active = false;
        expect(() => assertNativeTermRecordLease(lease, chunk)).toThrow('cancelled import');
    });
});
