/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

/** @typedef {Parameters<DictionaryDatabase['_publishArtifactTermContentMetadata']>[0]} Publication */

/**
 * @param {number} [count=96]
 * @returns {{database: DictionaryDatabase, state: Publication, staged: {indexes: Int32Array, active: boolean}, source: Uint8Array}}
 */
function createPublication(count = 96) {
    const database = new DictionaryDatabase();
    Reflect.get(database, '_cacheTermEntryContentMeta').call(database, null, 50, 3, 'raw', 0, 11, 22);
    const source = Uint8Array.from({length: count * 8}, (_, i) => i & 0xff);
    const spans = {
        buffer: source,
        offsets: Uint32Array.from({length: count}, (_, i) => i * 8),
        lengths: new Uint32Array(count).fill(8),
    };
    const hash1s = Uint32Array.from({length: count}, (_, i) => 101 + i);
    const hash2s = Uint32Array.from({length: count}, (_, i) => 201 + i);
    const staged = Reflect.get(database, '_stageArtifactTermContentMetadata').call(database, hash1s, hash2s, [], spans);
    return {
        database,
        staged,
        source,
        state: {
            count,
            contentOffsets: new Float64Array(count),
            contentLengths: new Uint32Array(count),
            resolvedContentDictNames: 'raw',
            pendingRowToUniqueIndex: Int32Array.from({length: count}, (_, i) => i),
            pendingContentBytes: [],
            pendingContentHash1s: hash1s,
            pendingContentHash2s: hash2s,
            pendingOffsets: Float64Array.from({length: count}, (_, i) => 0x100000000 + i * 8),
            pendingLengths: spans.lengths,
            pendingResolvedDictNames: 'raw',
            pendingContentSpans: spans,
            stagedContentMetadata: staged,
        },
    };
}

/**
 * @param {DictionaryDatabase} database
 * @param {Publication} state
 */
function expectPublished(database, state) {
    for (let i = 0; i < state.pendingOffsets.length; ++i) {
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, state.pendingContentHash1s[i], state.pendingContentHash2s[i])).toMatchObject({
            offset: state.pendingOffsets[i],
            length: state.pendingLengths[i],
            dictName: Array.isArray(state.pendingResolvedDictNames) ? state.pendingResolvedDictNames[i] : state.pendingResolvedDictNames,
        });
        expect(state.contentOffsets[i]).toBe(state.pendingOffsets[i]);
        expect(state.contentLengths[i]).toBe(state.pendingLengths[i]);
    }
    expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(state.pendingOffsets.length + 1);
}

describe('contiguous term content metadata publication', () => {
    test.each([false, true])('preserves wide offsets, exact cache bytes and rollback (validated=%s)', async (metadataValidated) => {
        const {database, state, staged, source} = createPublication();
        const get = Reflect.get(database, '_getTermEntryContentMetaByHashPair').bind(database);
        expect(get(101, 201)).toBeUndefined();
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(state.count);

        Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, {...state, metadataValidated});
        expectPublished(database, state);
        const read = vi.fn(() => { throw new Error('Cached content should not be read from storage'); });
        Reflect.set(database, '_readTermEntryContentBytesDetailed', read);
        const exact = Reflect.get(database, '_findMatchingTermEntryContentMeta').bind(database);
        for (const i of [0, 48, 95]) {
            expect(await exact(101 + i, 201 + i, source.slice(i * 8, i * 8 + 8))).toMatchObject({offset: state.pendingOffsets[i]});
        }
        expect(read).not.toHaveBeenCalled();
        const rollback = Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').bind(database);
        rollback(staged);
        rollback(staged);
        for (let i = 0; i < state.count; ++i) { expect(get(101 + i, 201 + i)).toBeUndefined(); }
        expect(get(11, 22)).toMatchObject({offset: 50, length: 3});
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
        expect(Reflect.get(database, '_recentTermContentSourceBatchBytes')).toBe(0);
    });

    test.each([false, true])('preserves noncontiguous staged IDs (mixed codecs=%s)', (mixedCodecs) => {
        const {database, state, staged} = createPublication();
        staged.indexes.reverse();
        state.pendingContentHash1s.reverse();
        state.pendingContentHash2s.reverse();
        state.pendingContentSpans?.offsets.reverse();
        if (mixedCodecs) {
            state.pendingResolvedDictNames = Array.from({length: state.count}, (_, i) => (i % 2 === 0 ? 'raw' : 'raw-v3'));
        }
        Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, state);
        expectPublished(database, state);
    });

    test('preserves scalar offset semantics when source offsets alias metadata columns', () => {
        const {database, state} = createPublication();
        const expectedOffsets = new Float64Array(state.pendingOffsets);
        const offsetTable = Reflect.get(database, '_termEntryContentMetaOffsetTable');
        offsetTable.set(expectedOffsets, 2);
        state.pendingOffsets = offsetTable.subarray(2, 2 + state.count);
        Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, state);
        for (let i = 0; i < state.count; ++i) {
            expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 101 + i, 201 + i)).toMatchObject({offset: expectedOffsets[i], length: 8});
            expect(state.contentOffsets[i]).toBe(expectedOffsets[i]);
        }
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(state.count + 1);
    });

    test.each(['indexes', 'hash1s', 'hash2s', 'lengths'])('preserves interleaved metadata reads for aliased %s', (column) => {
        const outcomes = [];
        for (const scalar of [false, true]) {
            const {database, state, staged} = createPublication();
            const ids = Reflect.get(database, '_termEntryContentMetaIdTable');
            const aliased = column === 'indexes' ?
                new Int32Array(ids.buffer, ids.byteOffset, state.count) :
                new Uint32Array(ids.buffer, ids.byteOffset, state.count);
            switch (column) {
                case 'indexes': {
                    aliased.set(staged.indexes);
                    staged.indexes = /** @type {Int32Array} */ (aliased);

                    break;
                }
                case 'hash1s': {
                    aliased.set(state.pendingContentHash1s);
                    state.pendingContentHash1s = /** @type {Uint32Array} */ (aliased);

                    break;
                }
                case 'hash2s': {
                    aliased.set(state.pendingContentHash2s);
                    state.pendingContentHash2s = /** @type {Uint32Array} */ (aliased);

                    break;
                }
                default: {
                    aliased.set(state.pendingLengths);
                    state.pendingLengths = /** @type {Uint32Array} */ (aliased);
                }
            }
            if (scalar) { vi.spyOn(database, '_tryPublishContiguousArtifactTermContentMetadata').mockReturnValue(false); }
            let errorMessage = '';
            try {
                Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, state);
            } catch (error) {
                errorMessage = String(error);
            }
            outcomes.push({
                errorMessage,
                columns: [
                    '_termEntryContentMetaStateTable',
                    '_termEntryContentMetaIdTable',
                    '_termEntryContentMetaOffsetTable',
                    '_termEntryContentMetaLengthTable',
                    '_termEntryContentMetaHash1Table',
                    '_termEntryContentMetaHash2Table',
                    '_termEntryContentMetaRecentSourceBatchIdTable',
                    '_termEntryContentMetaRecentSourceOffsetTable',
                ].map((name) => [...Reflect.get(database, name)]),
                published: Reflect.get(database, '_termEntryContentMetaHashPairCount'),
                pending: Reflect.get(database, '_termEntryContentMetaHashPairPendingCount'),
                cacheBytes: Reflect.get(database, '_recentTermContentSourceBatchBytes'),
            });
        }
        expect(outcomes[0]).toEqual(outcomes[1]);
    });

    test('validates every offset before a batch can be accepted and retains rollback', () => {
        const {database, state, staged} = createPublication();
        state.pendingOffsets[80] = Number.MAX_SAFE_INTEGER + 1;
        expect(() => Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, state)).toThrow('Invalid term content metadata offset');
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, staged);
        for (let i = 0; i < state.count; ++i) {
            expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 101 + i, 201 + i)).toBeUndefined();
        }
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test.each([false, true])('rejects a late staged length mismatch (validated=%s)', (metadataValidated) => {
        const {database, state, staged} = createPublication();
        state.pendingLengths = new Uint32Array(state.pendingLengths);
        state.pendingLengths[80] = 9;
        expect(() => Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, {...state, metadataValidated})).toThrow('Invalid staged term content metadata length');
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, staged);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });

    test('retains hash-collision metadata when a dense reservation contains a collision', () => {
        const {database, state, staged} = createPublication();
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, staged);
        state.pendingContentHash1s[state.count - 1] = state.pendingContentHash1s[0];
        state.pendingContentHash2s[state.count - 1] = state.pendingContentHash2s[0];
        const collisionStage = Reflect.get(database, '_stageArtifactTermContentMetadata').call(database, state.pendingContentHash1s, state.pendingContentHash2s, [], state.pendingContentSpans);
        state.stagedContentMetadata = collisionStage;
        Reflect.get(database, '_publishArtifactTermContentMetadata').call(database, state);
        const collisions = Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair');
        expect(collisions.get('101:201')).toHaveLength(1);
        expect(collisions.get('101:201')[0]).toMatchObject({offset: state.pendingOffsets[state.count - 1], length: 8});
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 101, 201)).toMatchObject({offset: state.pendingOffsets[0]});
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, collisionStage);
        expect(collisions.size).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(1);
    });
});
