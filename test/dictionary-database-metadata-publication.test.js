/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

const original = {id: 7, offset: 100, length: 3, dictName: 'raw', signature1: 1, signature2: 2, signature3: 3};
const replacement = {id: 8, offset: 200, length: 4, dictName: 'raw-v3', signature1: 4, signature2: 5, signature3: 6};
const invalidFields = [
    {field: 'id', value: -1},
    {field: 'offset', value: -1},
    {field: 'length', value: 0xffffffff},
];

/** @returns {{database: DictionaryDatabase, set: DictionaryDatabase['_setTermEntryContentMetaByHashPair'], get: DictionaryDatabase['_getTermEntryContentMetaByHashPair']}} */
function createFixture() {
    const database = new DictionaryDatabase();
    return {
        database,
        set: Reflect.get(database, '_setTermEntryContentMetaByHashPair').bind(database),
        get: Reflect.get(database, '_getTermEntryContentMetaByHashPair').bind(database),
    };
}

describe('term content metadata publication failures', () => {
    test.each(invalidFields)('rejects a new entry with invalid $field without publishing it', ({field, value}) => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        const previous = get(10, 20);

        expect(() => set(30, 40, {...replacement, [field]: value})).toThrow(`Invalid term content metadata ${field}`);

        expect(get(30, 40)).toBeUndefined();
        expect(get(10, 20)).toStrictEqual(previous);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    });

    test('retries a rejected insertion without leaking a dense index or undercounting entries', () => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        expect(() => set(30, 40, {...replacement, offset: -1})).toThrow('Invalid term content metadata offset');
        const allocatedCount = Reflect.get(database, '_termEntryContentMetaDenseCount');

        set(30, 40, replacement);

        expect(get(30, 40)).toMatchObject(replacement);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(2);
        expect(Reflect.get(database, '_termEntryContentMetaDenseCount')).toBe(allocatedCount);
        expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toStrictEqual([]);
    });

    test('returns a reused index after rejection without exposing its previous metadata', () => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        set(30, 40, replacement);
        const previousIndex = Reflect.get(database, '_findTermEntryContentMetaHashPairIndex').call(database, 30, 40);
        expect(previousIndex).toBeGreaterThanOrEqual(0);
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, {
            indexes: new Int32Array([previousIndex]),
            active: true,
        });

        expect(() => set(50, 60, {...original, offset: -1})).toThrow('Invalid term content metadata offset');

        expect(get(50, 60)).toBeUndefined();
        expect(get(30, 40)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toStrictEqual([previousIndex]);
        set(50, 60, original);
        expect(get(50, 60)).toMatchObject({...original, tableIndex: previousIndex});
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(2);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    });

    test.each(invalidFields)('preserves an existing entry when replacement $field is invalid', ({field, value}) => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        const previous = get(10, 20);

        expect(() => set(10, 20, {...replacement, [field]: value})).toThrow(`Invalid term content metadata ${field}`);

        expect(get(10, 20)).toStrictEqual(previous);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test('does not publish a new entry when dictionary-name interning throws', () => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        const error = new Error('injected dictionary-name interning failure');
        const intern = vi.spyOn(database, '_internTermEntryContentMetaDictName').mockImplementationOnce(() => { throw error; });
        try {
            expect(() => set(30, 40, replacement)).toThrow(error);
        } finally {
            intern.mockRestore();
        }

        expect(get(30, 40)).toBeUndefined();
        expect(get(10, 20)).toMatchObject(original);
        const allocatedCount = Reflect.get(database, '_termEntryContentMetaDenseCount');
        set(30, 40, replacement);
        expect(get(30, 40)).toMatchObject(replacement);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(2);
        expect(Reflect.get(database, '_termEntryContentMetaDenseCount')).toBe(allocatedCount);
    });

    test('preserves every field when replacement dictionary-name interning throws', () => {
        const {database, set, get} = createFixture();
        set(10, 20, original);
        const previous = get(10, 20);
        const error = new Error('injected dictionary-name interning failure');
        const intern = vi.spyOn(database, '_internTermEntryContentMetaDictName').mockImplementationOnce(() => { throw error; });
        try {
            expect(() => set(10, 20, replacement)).toThrow(error);
        } finally {
            intern.mockRestore();
        }

        expect(get(10, 20)).toStrictEqual(previous);
        set(10, 20, replacement);
        expect(get(10, 20)).toMatchObject(replacement);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });
});
