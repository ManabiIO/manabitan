/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js';

const meta = {id: 7, offset: 100, length: 3, dictName: 'raw', signature1: 1, signature2: 2, signature3: 3};

/** @returns {DictionaryDatabase} */
function createDatabase() {
    const database = new DictionaryDatabase();
    Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 10, 20, meta);
    return database;
}

/**
 * @param {DictionaryDatabase} database
 * @returns {TermContentMetadataArena}
 */
function getArena(database) {
    const arena = Reflect.get(database, '_termContentMetadataArena');
    if (arena === null) { throw new Error('Expected an allocated metadata arena'); }
    return arena;
}

describe('term content metadata arena ownership', () => {
    test('uses disjoint aligned columns in one fixed-capacity memory', () => {
        const arena = new TermContentMetadataArena(17, 64);
        const columns = [arena.slots, arena.hash1, arena.hash2, arena.state, arena.length, arena.signaturePresent, arena.signature1, arena.signature2, arena.signature3];
        for (let i = 0; i < columns.length; ++i) {
            const column = columns[i];
            expect(column.buffer).toBe(arena.memory.buffer);
            expect(column.byteOffset % column.BYTES_PER_ELEMENT).toBe(0);
            column.fill(i + 1);
        }
        for (let i = 0; i < columns.length; ++i) {
            expect([...columns[i]]).toEqual(new Array(columns[i].length).fill(i + 1));
        }
        expect(() => arena.memory.grow(1)).toThrow(RangeError);
        expect(arena.hash1.byteLength).toBe(17 * 4);
    });

    test.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity])('rejects invalid or oversized capacity %s before publishing memory', (capacity) => {
        expect(() => new TermContentMetadataArena(capacity, 16)).toThrow(RangeError);
        expect(() => new TermContentMetadataArena(16, capacity)).toThrow(RangeError);
    });

    test('allocates lazily and isolates database instances', () => {
        const first = new DictionaryDatabase();
        expect(Reflect.get(first, '_termContentMetadataArena')).toBeNull();
        const second = createDatabase();
        Reflect.get(first, '_setTermEntryContentMetaByHashPair').call(first, 10, 20, {...meta, offset: 200});
        const firstArena = getArena(first);
        const secondArena = getArena(second);
        expect(firstArena.memory).not.toBe(secondArena.memory);
        expect(Reflect.get(first, '_getTermEntryContentMetaByHashPair').call(first, 10, 20)).toMatchObject({offset: 200});
        expect(Reflect.get(second, '_getTermEntryContentMetaByHashPair').call(second, 10, 20)).toMatchObject({offset: 100});
    });

    test('preserves published and pending dense IDs through growth, rollback and reuse', () => {
        const database = createDatabase();
        const stage = Reflect.get(database, '_stageArtifactTermContentMetadata').bind(database);
        const staged = stage([30], [40], [Uint8Array.of(4, 5, 6)], null);
        const oldArena = getArena(database);
        const oldState = oldArena.state;
        const pendingIndex = staged.indexes[0];
        Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 2000);
        const nextArena = getArena(database);
        expect(nextArena).not.toBe(oldArena);
        expect(oldState.byteLength).toBeGreaterThan(0);
        expect(nextArena.state[pendingIndex]).toBe(oldState[pendingIndex]);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 30, 40)).toBeUndefined();
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)).toMatchObject(meta);
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, staged);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(stage([50], [60], [Uint8Array.of(7, 8, 9)], null).indexes[0]).toBe(pendingIndex);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)).toMatchObject(meta);
    });

    test.each(['memory', 'rehash'])('retains the complete previous generation after %s failure', (failure) => {
        const database = createDatabase();
        const previous = Reflect.get(database, '_termContentMetadataArena');
        const previousIdTable = Reflect.get(database, '_termEntryContentMetaIdTable');
        const previousMask = Reflect.get(database, '_termEntryContentMetaHashPairMask');
        const error = new Error('injected arena replacement failure');
        const fault = failure === 'memory' ?
            vi.spyOn(WebAssembly, 'Memory').mockImplementationOnce(function failMemoryAllocation() { throw error; }) :
            vi.spyOn(database, '_getTermEntryContentMetaHashPairSlot').mockImplementationOnce(() => { throw error; });
        try {
            expect(() => Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 2000)).toThrow(error);
        } finally { fault.mockRestore(); }
        expect(Reflect.get(database, '_termContentMetadataArena')).toBe(previous);
        expect(Reflect.get(database, '_termEntryContentMetaIdTable')).toBe(previousIdTable);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairMask')).toBe(previousMask);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)).toMatchObject(meta);
        Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 2000);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)).toMatchObject(meta);
    });

    test('clears the current generation and does not reuse its live views', () => {
        const database = createDatabase();
        const oldArena = getArena(database);
        Reflect.get(database, '_clearTermEntryContentMetaCaches').call(database);
        expect(Reflect.get(database, '_termContentMetadataArena')).toBeNull();
        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 10, 20, {...meta, offset: 200});
        expect(getArena(database).memory).not.toBe(oldArena.memory);
        expect(oldArena.state[0]).not.toBe(0);
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 10, 20)).toMatchObject({offset: 200});
    });
});
