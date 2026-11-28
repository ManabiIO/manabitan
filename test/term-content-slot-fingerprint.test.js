/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint-disable no-underscore-dangle -- Exercise the shared native/database metadata-owner ABI. */

import fs from 'node:fs/promises';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js';
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js';
import {CANONICAL_SCAN_ABI_VERSION, TERM_CONTENT_METADATA_SLOT_INDEX_MASK} from '../ext/js/dictionary/term-content-canonical-layout.js';

const nativeModule = await WebAssembly.compile(await fs.readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)));
const previousModule = await WebAssembly.compile(await fs.readFile(new URL('./data/term-content-canonical-scan-v1.wasm', import.meta.url)));

/**
 * @param {number} index
 * @returns {{id: number, offset: number, length: number, dictName: string}}
 */
function metadata(index) {
    return {id: index + 1, offset: 100 + index * 4, length: 4, dictName: 'raw'};
}

/**
 * @param {DictionaryDatabase} database
 * @param {number} hash1
 * @param {number} slot
 * @returns {[number, number]}
 */
function collidingPair(database, hash1, slot) {
    for (let hash2 = 0; hash2 < 65536; ++hash2) {
        if (database._getTermEntryContentMetaHashPairSlot(hash1, hash2, database._termEntryContentMetaHashPairMask) === slot) {
            return [hash1, hash2];
        }
    }
    throw new Error('No deterministic probe collision');
}

/**
 * @param {Array<[number, number]>} pairs
 * @returns {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk & {contentBytesBuffer: Uint8Array, contentUniqueIndexList: Uint32Array, contentDedupPlan: import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan}}
 */
function chunkFor(pairs) {
    const count = pairs.length;
    const bytes = new Uint8Array(count * 4);
    const contentMetaList = new Uint32Array(count * 4);
    for (let i = 0; i < count; ++i) {
        bytes.set([i, 11, 22, 33], i * 4);
        contentMetaList.set([i * 4, 4, ...pairs[i]], i * 4);
    }
    const identities = Uint32Array.from({length: count}, (_, i) => i);
    return {
        rowCount: count,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: [],
        contentHash2List: [],
        contentBytesBuffer: bytes,
        contentBytesBaseOffset: 0,
        contentMetaList,
        contentUniqueIndexList: identities,
        contentDictNameList: null,
        uniformContentDictName: 'raw',
        useResolvedContentReferences: true,
        contentDedupPlan: {
            uniqueCount: count,
            sourceRowCount: count,
            uniqueRowIndexes: identities.slice(),
            uniqueSignatures: new Uint32Array(count * 3),
            resolvedFlags: new Uint8Array(count),
            resolvedOffsets: new Float64Array(count),
            resolvedLengths: new Uint32Array(count),
            resolvedDictNames: null,
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
            persistedLookupRequired: true,
        },
    };
}

describe('fingerprinted metadata probe slots', () => {
    test('rejects capacities that could consume the fingerprint bits before memory allocation', () => {
        expect((TERM_CONTENT_METADATA_SLOT_INDEX_MASK + 1) * 26).toBeGreaterThan(0xffffffff);
        const memory = vi.spyOn(WebAssembly, 'Memory');
        try {
            expect(() => new TermContentMetadataArena(TERM_CONTENT_METADATA_SLOT_INDEX_MASK + 1, 0)).toThrow(RangeError);
            expect(memory).not.toHaveBeenCalled();
        } finally { memory.mockRestore(); }
    });

    test('distinguishes same-slot hashes across all high nibbles, including the signed boundary', () => {
        const database = new DictionaryDatabase();
        database._ensureTermEntryContentMetaHashPairCapacity(32);
        const pairs = Array.from({length: 16}, (_, i) => collidingPair(database, (i * 0x10000000 + 17) >>> 0, 5));
        for (const [i, pair] of pairs.entries()) { database._setTermEntryContentMetaByHashPair(...pair, metadata(i)); }
        for (const [i, pair] of pairs.entries()) {
            expect(database._getTermEntryContentMetaByHashPair(...pair)).toMatchObject({...metadata(i), tableIndex: i});
            const word = database._termEntryContentMetaHashPairTable[5 + i];
            expect(word >>> 28).toBe(i);
            expect(word & TERM_CONTENT_METADATA_SLOT_INDEX_MASK).toBe(i + 1);
        }
        database._setTermEntryContentMetaByHashPair(...pairs[8], {...metadata(8), offset: 500});
        expect(database._getTermEntryContentMetaByHashPair(...pairs[8])).toMatchObject({offset: 500, tableIndex: 8});
        expect(database._termEntryContentMetaHashPairCount).toBe(16);
    });

    test('still distinguishes full hashes sharing the same fingerprint and probe slot', () => {
        const database = new DictionaryDatabase();
        database._ensureTermEntryContentMetaHashPairCapacity(8);
        const pairs = [collidingPair(database, 0xf0000011, 5), collidingPair(database, 0xf0000022, 5)];
        database._setTermEntryContentMetaByHashPair(...pairs[0], metadata(0));
        database._insertTermEntryContentMetaByHashPairFast(...pairs[1], 200, 4, 'raw', 0, Uint8Array.of(1, 2, 3, 4));
        expect(database._getTermEntryContentMetaByHashPair(...pairs[0])).toMatchObject({offset: 100});
        expect(database._getTermEntryContentMetaByHashPair(...pairs[1])).toMatchObject({offset: 200});
        expect(database._getTermEntryContentMetaByHashPair(pairs[1][0], pairs[1][1] + 1)).toBeUndefined();
    });

    test('preserves pending collisions, rollback holes and reused IDs during dense and sparse rehash', () => {
        const database = new DictionaryDatabase();
        database._ensureTermEntryContentMetaHashPairCapacity(40);
        /** @type {Array<[number, number]>} */
        const pairs = Array.from({length: 32}, (_, i) => [(0x80000000 + i * 0x100001) >>> 0, i + 1]);
        for (const [i, pair] of pairs.entries()) { database._setTermEntryContentMetaByHashPair(...pair, metadata(i)); }
        database._rollbackStagedArtifactTermContentMetadata({
            indexes: Int32Array.from({length: 29}, (_, i) => i < 14 ? i + 1 : i + 2), active: true,
        });
        expect(database._termEntryContentMetaHashPairCount).toBe(3);
        expect(database._termEntryContentMetaHashPairTable.length).toBe(16);
        expect(database._termEntryContentMetaDenseCount).toBe(32);
        // The first rollback rehash scans dense IDs. This second rehash must
        // decode packed slots because the dense high-water mark exceeds 16.
        database._resizeTermContentMetadataArena(32, 32, true);
        for (const i of [0, 15, 31]) {
            expect(database._getTermEntryContentMetaByHashPair(...pairs[i])).toMatchObject({tableIndex: i});
        }
        const pending = database._stageArtifactTermContentMetadata([0xf0000001], [900], [Uint8Array.of(1, 2, 3, 4)], null);
        expect(pending.indexes[0]).toBe(30);
        expect(database._getTermEntryContentMetaByHashPair(0xf0000001, 900)).toBeUndefined();
        expect(database._reservePreparedArtifactTermContentMetadata(0xf0000001, 900, 4, 1, 2, 3)).toBe(-1);
        database._rollbackStagedArtifactTermContentMetadata(pending);
        expect(database._reservePreparedArtifactTermContentMetadata(0x70000001, 901, 4, 1, 2, 3)).toBe(30);
        for (const i of [0, 15, 31]) {
            expect(database._getTermEntryContentMetaByHashPair(...pairs[i])).toMatchObject({tableIndex: i});
        }
    });
});

describe('native and JavaScript fingerprint interoperability', () => {
    test.each(['native', 'old ABI'])('resolves JS entries and publishes %s entries', async (mode) => {
        const module = mode === 'native' ? nativeModule : previousModule;
        const database = new DictionaryDatabase();
        const scanner = new NativeCanonicalScanner({loadModule: async () => module});
        database._nativeCanonicalScanner = scanner;
        database._ensureTermEntryContentMetaHashPairCapacity(8);
        const pairs = [0x00000011, 0x70000011, 0x80000011, 0xf0000011].map((hash1) => collidingPair(database, hash1, 5));
        const chunk = chunkFor(pairs);
        database._setTermEntryContentMetaByHashPair(...pairs[0], metadata(0));
        database._setTermEntryContentMetaByHashPair(...pairs[2], metadata(2));
        database._readTermEntryContentBytesDetailed = async (offset) => ({status: 'ok', bytes: chunk.contentBytesBuffer.subarray(offset - 100, offset - 96)});
        const resolved = await database._resolveArtifactTermContentDedup(chunk, true);
        expect(resolved.persistedHitCount).toBe(2);
        expect(resolved.pendingContentCount).toBe(2);
        const offsets = Float64Array.of(300, 400);
        const lengths = Uint32Array.of(4, 4);
        database._publishResolvedArtifactTermContentPlan(
            chunk.contentDedupPlan, resolved.pendingPlanUniqueStart, resolved.pendingPlanUniqueIndexes, offsets, lengths, 'raw',
        );
        database._publishArtifactTermContentMetadata({
            ...resolved, count: 4, pendingOffsets: offsets, pendingLengths: lengths, pendingResolvedDictNames: 'raw',
            contentUniqueIndexList: chunk.contentUniqueIndexList, useResolvedContentReferences: true,
        });
        for (const [i, pair] of pairs.entries()) {
            expect(database._getTermEntryContentMetaByHashPair(...pair)).toMatchObject({offset: [100, 300, 108, 400][i]});
        }
        if (mode === 'native') {
            expect(scanner.stats.nativePendingRows).toBe(2);
            expect(scanner.stats.fallbacks).toBe(0);
        } else {
            expect(scanner.stats.calls).toBe(0);
            expect(scanner.stats.fallbackUnsupported).toBe(1);
        }
    });

    test.each([0xf0000000, 0xf0000011])('rejects malformed packed slot %s before fingerprint filtering', async (word) => {
        const database = new DictionaryDatabase();
        const chunk = chunkFor([[17, 29]]);
        database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => nativeModule, hooks: {
            beforeNative: ({a}) => {
                const slot = database._getTermEntryContentMetaHashPairSlot(17, 29, a.slots.length - 1);
                a.slots[slot] = word;
            },
        }});
        await expect(database._resolveArtifactTermContentDedup(chunk, true)).rejects.toThrow('Native canonical scan error -4');
        expect(database._termEntryContentMetaDenseCount).toBe(0);
        expect(database._termEntryContentMetaHashPairPendingCount).toBe(0);
    });

    test('rejects an oversized native identity capacity before mutation', async () => {
        const database = new DictionaryDatabase();
        database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => nativeModule, hooks: {
            beforeNative: ({a}) => { new Uint32Array(a.memory.buffer, 1088, 22)[10] = TERM_CONTENT_METADATA_SLOT_INDEX_MASK + 1; },
        }});
        await expect(database._resolveArtifactTermContentDedup(chunkFor([[0xf0000011, 29]]), true)).rejects.toThrow('Native canonical scan error -1');
        expect(database._termEntryContentMetaDenseCount).toBe(0);
        expect(database._termEntryContentMetaHashPairPendingCount).toBe(0);
    });

    test('restores packed probe chains after a native insertion trap and can retry', async () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(0x80000001, 9, metadata(0));
        database._ensureTermEntryContentMetaHashPairCapacity(8);
        const before = database._termEntryContentMetaHashPairTable.slice();
        const chunk = chunkFor([[0xf0000011, 29], [0x70000011, 31]]);
        database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => nativeModule, hooks: {trapAfter: 1}});
        await expect(database._resolveArtifactTermContentDedup(chunk, true)).rejects.toThrow();
        expect(database._termEntryContentMetaHashPairTable).toEqual(before);
        expect(database._termEntryContentMetaDenseCount).toBe(1);
        expect(database._termEntryContentMetaHashPairPendingCount).toBe(0);
        expect(database._getTermEntryContentMetaByHashPair(0x80000001, 9)).toMatchObject(metadata(0));
        database._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => nativeModule});
        expect((await database._resolveArtifactTermContentDedup(chunk, true)).pendingContentCount).toBe(2);
        expect(CANONICAL_SCAN_ABI_VERSION).toBe(2);
    });
});
