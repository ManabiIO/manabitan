/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} PublicationState */

/**
 * @param {DictionaryDatabase} database
 * @returns {number[]}
 */
function logicalIds(database) {
    const count = Reflect.get(database, '_termEntryContentMetaStateTable').length;
    return Array.from({length: count}, (_, i) => database._readTermEntryContentMetaDictNameId(i) ?? -1);
}

/**
 * @param {DictionaryDatabase} database
 * @returns {Record<string, unknown>}
 */
function snapshot(database) {
    return {
        ids: logicalIds(database),
        prefixValue: Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixValue'),
        prefixEnd: Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd'),
        hashes: [...Reflect.get(database, '_termEntryContentMetaHash1Table')],
        states: [...Reflect.get(database, '_termEntryContentMetaStateTable')],
        offsets: [...Reflect.get(database, '_termEntryContentMetaOffsetTable')],
        rowIds: [...Reflect.get(database, '_termEntryContentMetaIdTable')],
        pending: Reflect.get(database, '_termEntryContentMetaHashPairPendingCount'),
        published: Reflect.get(database, '_termEntryContentMetaHashPairCount'),
        dense: Reflect.get(database, '_termEntryContentMetaDenseCount'),
        free: [...Reflect.get(database, '_termEntryContentMetaFreeIndexes')],
    };
}

/**
 * @param {number} [count]
 * @returns {{database: DictionaryDatabase, state: PublicationState, staged: NonNullable<PublicationState['stagedContentMetadata']>}}
 */
function harness(count = 3) {
    const database = new DictionaryDatabase();
    const hash1s = Uint32Array.from({length: count}, (_, i) => 10 + i);
    const hash2s = Uint32Array.from({length: count}, (_, i) => 20 + i);
    const bytes = Array.from({length: count}, (_, i) => Uint8Array.of(i + 1, 2, 3, 4));
    const staged = database._stageArtifactTermContentMetadata(hash1s, hash2s, bytes, null);
    const state = {
        count,
        contentOffsets: new Float64Array(count),
        contentLengths: new Uint32Array(count),
        resolvedContentDictNames: 'codec',
        pendingRowToUniqueIndex: Int32Array.from({length: count}, (_, i) => i),
        pendingContentBytes: bytes,
        pendingContentHash1s: hash1s,
        pendingContentHash2s: hash2s,
        pendingOffsets: Float64Array.from({length: count}, (_, i) => 100 + 4 * i),
        pendingLengths: new Uint32Array(count).fill(4),
        pendingResolvedDictNames: 'codec',
        pendingContentSpans: null,
        stagedContentMetadata: staged,
    };
    return {database, state, staged};
}

/**
 * @param {ReturnType<typeof harness>} value
 * @param {number} dictNameId
 * @returns {boolean}
 */
function tryPublish(value, dictNameId) {
    const {database, state, staged} = value;
    return database._tryPublishContiguousArtifactTermContentMetadata(
        staged,
        state.pendingContentHash1s,
        state.pendingContentHash2s,
        state.pendingOffsets,
        state.pendingLengths,
        dictNameId,
        false,
    );
}

describe('uniform dictionary-name prefix', () => {
    test('keeps ordinary contiguous publication virtual with a zero capacity tail', () => {
        const value = harness();
        const fast = vi.spyOn(value.database, '_tryPublishContiguousArtifactTermContentMetadata');
        value.database._publishArtifactTermContentMetadata(value.state);
        expect(fast.mock.results[0]).toMatchObject({type: 'return', value: true});
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(3);
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdPrefixValue')).toBe(1);
        expect(logicalIds(value.database)).toEqual([1, 1, 1, ...new Array(13).fill(0)]);
        expect(value.database._getTermEntryContentMetaByHashPair(10, 20)?.dictName).toBe('codec');
    });

    test('extends or rewrites the same prefix without allocation', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        for (let i = 0; i < 6; ++i) {
            database._setTermEntryContentMetaByHashPair(10 + i, 20 + i, {id: 0, offset: 200 + i, length: 4, dictName: 'codec'});
        }
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(6);
        expect(logicalIds(database).slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 0]);
    });

    test('keeps zero writes virtual and materializes before a nonzero write after a gap', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        database._setTermEntryContentMetaByHashPair(30, 40, {id: 0, offset: 300, length: 4, dictName: 'raw'});
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(3);
        database._setTermEntryContentMetaByHashPair(31, 41, {id: 0, offset: 304, length: 4, dictName: 'codec'});
        const table = Reflect.get(database, '_termEntryContentMetaDictNameIdTable');
        expect(table).toBeInstanceOf(Uint32Array);
        expect(logicalIds(database).slice(0, 6)).toEqual([1, 1, 1, 0, 1, 0]);
        database._setTermEntryContentMetaByHashPair(30, 40, {id: 0, offset: 308, length: 4, dictName: 'codec'});
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBe(table);
    });

    test('materializes a different prefix value once and retains the backing until reset', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'});
        const physical = Reflect.get(database, '_termEntryContentMetaDictNameIdTable');
        expect(physical).toBeInstanceOf(Uint32Array);
        expect(logicalIds(database).slice(0, 4)).toEqual([2, 1, 1, 0]);
        database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 504, length: 4, dictName: 'codec'});
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBe(physical);
        database._clearTermEntryContentMetaCaches();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(0);
        expect(database._readTermEntryContentMetaDictNameId(0)).toBeUndefined();
    });

    test.each([-1, 0.5, Number.NaN, Infinity, -Infinity, 16])('preserves missing numeric index %s in both representations', (index) => {
        const {database} = harness();
        expect(database._readTermEntryContentMetaDictNameId(index)).toBeUndefined();
        database._materializeTermEntryContentMetaDictNameIds();
        expect(database._readTermEntryContentMetaDictNameId(index)).toBeUndefined();
    });

    test.each([0, -1, 1.5, 256, 0x100000001, Number.NaN, Infinity])('preserves Uint32 coercion for direct fast ID %s', (dictNameId) => {
        const database = new DictionaryDatabase();
        database._ensureTermEntryContentMetaHashPairCapacity(1);
        database._insertTermEntryContentMetaByHashPairFast(10, 20, 100, 4, 'raw', dictNameId, Uint8Array.of(1, 2, 3, 4));
        expect(database._readTermEntryContentMetaDictNameId(0)).toBe(dictNameId >>> 0);
        expect(database._readTermEntryContentMetaDictNameId(1)).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
    });

    test.each([0, -1, 1.5, 256, 0x100000001, Number.NaN])('preserves Uint32 fill coercion for direct range ID %s', (dictNameId) => {
        const value = harness();
        expect(tryPublish(value, dictNameId)).toBe(true);
        expect(logicalIds(value.database).slice(0, 4)).toEqual([dictNameId >>> 0, dictNameId >>> 0, dictNameId >>> 0, 0]);
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
    });

    test('preserves stale free IDs through virtual growth and same-name reuse', () => {
        const {database, state, staged} = harness();
        database._publishArtifactTermContentMetadata(state);
        database._rollbackStagedArtifactTermContentMetadata({indexes: new Int32Array([1]), active: true});
        database._ensureTermEntryContentMetaDenseCapacity(128);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(logicalIds(database).slice(0, 4)).toEqual([1, 1, 1, 0]);
        database._setTermEntryContentMetaByHashPair(50, 60, {id: 0, offset: 500, length: 4, dictName: 'codec'});
        expect(database._getTermEntryContentMetaByHashPair(50, 60)?.tableIndex).toBe(staged.indexes[1]);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(3);
    });

    test('copies only the dense high-water prefix on growth while retaining free entries', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        database._rollbackStagedArtifactTermContentMetadata({indexes: new Int32Array([1]), active: true});
        // Like writing an unused physical tail, this must not survive a grow
        // whose established copy contract stops at the dense high-water mark.
        database._prepareTermEntryContentMetaDictNameIds(3, 8, 1);
        database._fillTermEntryContentMetaDictNameIds(3, 8, 1);
        expect(database._readTermEntryContentMetaDictNameId(7)).toBe(1);
        database._ensureTermEntryContentMetaDenseCapacity(128);
        expect(logicalIds(database).slice(0, 9)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0]);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(3);
    });

    test('failed whole-range validation cannot allocate or advance a prefix', () => {
        const value = harness();
        const before = snapshot(value.database);
        const materialize = vi.spyOn(value.database, '_materializeTermEntryContentMetaDictNameIds');
        value.state.pendingContentHash1s[2] = 999;
        expect(tryPublish(value, 7)).toBe(false);
        expect(snapshot(value.database)).toEqual(before);
        expect(materialize).not.toHaveBeenCalled();
    });

    test('allocation failure preserves a replacement and its complete logical prefix', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        const before = snapshot(database);
        const failure = new RangeError('injected dictionary-name allocation failure');
        const fault = vi.spyOn(database, '_materializeTermEntryContentMetaDictNameIds').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'})).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(snapshot(database)).toEqual(before);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'});
        expect(database._getTermEntryContentMetaByHashPair(10, 20)?.dictName).toBe('other');
    });

    test('a failed Uint32 allocation never publishes a partial materialized column', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        const before = snapshot(database);
        const failure = new RangeError('injected Uint32 allocation failure');
        let caught;
        vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {
            construct() { throw failure; },
        }));
        try {
            database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'});
        } catch (error) { caught = error; } finally { vi.unstubAllGlobals(); }
        expect(caught).toBe(failure);
        expect(snapshot(database)).toEqual(before);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'});
        expect(logicalIds(database).slice(0, 4)).toEqual([2, 1, 1, 0]);
    });

    test('a whole-range allocation failure leaves a nonrepresentable hole unpublished', () => {
        const value = harness(6);
        const staged = {...value.staged, indexes: value.staged.indexes.subarray(3)};
        const state = {
            ...value.state,
            pendingContentHash1s: value.state.pendingContentHash1s.slice(3),
            pendingContentHash2s: value.state.pendingContentHash2s.slice(3),
            pendingOffsets: value.state.pendingOffsets.slice(3),
            pendingLengths: value.state.pendingLengths.slice(3),
        };
        const before = snapshot(value.database);
        const failure = new RangeError('injected dictionary-name allocation failure');
        const fault = vi.spyOn(value.database, '_materializeTermEntryContentMetaDictNameIds').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => tryPublish({...value, state, staged}, 1)).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(snapshot(value.database)).toEqual(before);
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(tryPublish({...value, state, staged}, 1)).toBe(true);
        expect(logicalIds(value.database).slice(0, 7)).toEqual([0, 0, 0, 1, 1, 1, 0]);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(3);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairCount')).toBe(3);
    });

    test('scalar publication advances only the prefix written before a later error', () => {
        const value = harness();
        value.state.pendingLengths[1] = 3;
        expect(() => value.database._publishArtifactTermContentMetadata(value.state)).toThrow('Invalid staged term content metadata length');
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(1);
        expect(logicalIds(value.database).slice(0, 4)).toEqual([1, 0, 0, 0]);
        expect([...Reflect.get(value.database, '_termEntryContentMetaOffsetTable').subarray(0, 3)]).toEqual([100, 0, 0]);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(2);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test('failed new-entry allocation returns its index for retry without changing old words', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        const failure = new RangeError('injected dictionary-name allocation failure');
        const fault = vi.spyOn(database, '_materializeTermEntryContentMetaDictNameIds').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(50, 60, {id: 0, offset: 500, length: 4, dictName: 'other'})).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(Reflect.get(database, '_termEntryContentMetaFreeIndexes')).toEqual([3]);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(3);
        expect(logicalIds(database).slice(0, 4)).toEqual([1, 1, 1, 0]);
        database._setTermEntryContentMetaByHashPair(50, 60, {id: 0, offset: 500, length: 4, dictName: 'other'});
        expect(database._getTermEntryContentMetaByHashPair(50, 60)?.tableIndex).toBe(3);
        expect(logicalIds(database).slice(0, 4)).toEqual([1, 1, 1, 2]);
    });

    test('an interner failure leaves the prefix and every metadata field untouched', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        const before = snapshot(database);
        const failure = new Error('injected interner failure');
        const fault = vi.spyOn(database, '_internTermEntryContentMetaDictName').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, {id: 0, offset: 500, length: 4, dictName: 'other'})).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(snapshot(database)).toEqual(before);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
    });

    test('a failed grow keeps the old virtual prefix until replacement publication', () => {
        const {database, state} = harness();
        database._publishArtifactTermContentMetadata(state);
        const before = snapshot(database);
        const oldArena = Reflect.get(database, '_termContentMetadataArena');
        const failure = new Error('injected rehash failure');
        const fault = vi.spyOn(database, '_getTermEntryContentMetaHashPairSlot').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._ensureTermEntryContentMetaHashPairCapacity(128)).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(Reflect.get(database, '_termContentMetadataArena')).toBe(oldArena);
        expect(snapshot(database)).toEqual(before);
        database._ensureTermEntryContentMetaHashPairCapacity(128);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(logicalIds(database).slice(0, 4)).toEqual([1, 1, 1, 0]);
    });

    test('retains an exposed physical backing and the original aliased scalar writes', () => {
        const value = harness();
        const physical = value.database._materializeTermEntryContentMetaDictNameIds();
        const indexes = new Int32Array(physical.buffer, physical.byteOffset, 3);
        indexes.set(value.staged.indexes);
        value.staged.indexes = indexes;
        Reflect.get(value.database, '_termEntryContentMetaDictNameIdByValue').set('codec', 256);
        Reflect.get(value.database, '_termEntryContentMetaDictNames')[256] = 'codec';
        const before = snapshot(value.database);
        expect(tryPublish(value, 256)).toBe(false);
        expect(snapshot(value.database)).toEqual(before);
        value.database._publishArtifactTermContentMetadata(value.state);
        expect(Reflect.get(value.database, '_termEntryContentMetaDictNameIdTable')).toBe(physical);
        expect([...indexes]).toEqual([256, 256, 256]);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairCount')).toBe(3);
    });
});
