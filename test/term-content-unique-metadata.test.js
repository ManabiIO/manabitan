/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {readFile} from 'node:fs/promises';
import {describe, expect, test} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js';

/** @typedef {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk} ContentChunk */
/** @typedef {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentDedupPlan} DedupPlan */

const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)));

/**
 * @param {{compact?: boolean, native?: boolean, uniqueCount?: number, repeats?: number, existing?: boolean, generic?: boolean, references?: boolean}} [options]
 * @returns {{database: DictionaryDatabase, scanner: NativeCanonicalScanner, chunk: ContentChunk, plan: DedupPlan, storage: Map<number, Uint8Array>}}
 */
function fixture({compact = false, native = false, uniqueCount = 8, repeats = 4, existing = false, generic = false, references = true} = {}) {
    const database = new DictionaryDatabase();
    const scanner = new NativeCanonicalScanner({loadModule: async () => {
        if (!native) { throw new Error('JavaScript oracle'); }
        return module;
    }});
    Reflect.set(database, '_nativeCanonicalScanner', scanner);
    Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 1);
    const rowCount = uniqueCount * repeats;
    const bytes = new Uint8Array(uniqueCount * 4 + 7);
    const metas = new Uint32Array((compact ? uniqueCount : rowCount) * 4);
    const ids = Uint32Array.from({length: rowCount}, (_, row) => Math.floor(row / repeats));
    const storage = new Map();
    for (let unique = 0; unique < uniqueCount; ++unique) {
        const value = Uint8Array.of(unique & 255, (unique >>> 8) & 255, 7, 9);
        bytes.set(value, 7 + unique * 4);
        if (compact) {
            metas.set([unique * 4, 4, unique + 1, unique + 100], unique * 4);
        } else {
            for (let repeat = 0; repeat < repeats; ++repeat) {
                metas.set([unique * 4, 4, unique + 1, unique + 100], (unique * repeats + repeat) * 4);
            }
        }
        if (existing && unique % 2 === 0) {
            storage.set(1000 + unique * 4, value);
            Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, unique + 1, unique + 100, {
                id: unique, offset: 1000 + unique * 4, length: 4, dictName: 'raw',
            });
        }
    }
    /** @type {DictionaryDatabase['_readTermEntryContentBytesDetailed']} */
    const readStoredBytes = async (offset) => {
        const stored = storage.get(offset);
        if (!(stored instanceof Uint8Array)) { throw new Error('Missing stored fixture content'); }
        return {status: 'ok', bytes: stored};
    };
    Reflect.set(database, '_readTermEntryContentBytesDetailed', readStoredBytes);
    /** @type {DedupPlan} */
    const plan = {
        uniqueCount,
        sourceRowCount: rowCount,
        uniqueRowIndexes: generic ? void 0 : Uint32Array.from({length: uniqueCount}, (_, unique) => unique * repeats),
        uniqueSignatures: new Uint32Array(uniqueCount * 3),
        resolvedFlags: new Uint8Array(uniqueCount),
        resolvedOffsets: new Float64Array(uniqueCount),
        resolvedLengths: new Uint32Array(uniqueCount),
        resolvedDictNames: null,
        pendingEpochs: null,
        pendingIndexes: null,
        nextEpoch: 1,
        persistedLookupRequired: existing,
    };
    return {
        database,
        scanner,
        plan,
        storage,
        chunk: {
            rowCount,
            contentRowStart: 0,
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: bytes,
            contentBytesBaseOffset: 7,
            contentMetaList: metas,
            contentMetaByUniqueIndex: compact,
            contentUniqueIndexList: ids,
            contentDedupPlan: plan,
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            useResolvedContentReferences: references,
        },
    };
}

/**
 * @param {ReturnType<typeof fixture>} value
 * @returns {ReturnType<DictionaryDatabase['_resolveArtifactTermContentDedup']>}
 */
async function resolve(value) {
    return await Reflect.get(value.database, '_resolveArtifactTermContentDedup').call(value.database, value.chunk, true);
}

/**
 * @param {ReturnType<typeof fixture>} value
 * @param {Awaited<ReturnType<typeof resolve>>} result
 * @returns {Record<string, unknown>}
 */
function snapshot(value, result) {
    const fields = ['contentOffsets',
        'contentLengths',
        'pendingContentBytes',
        'pendingContentHash1s',
        'pendingContentHash2s',
        'pendingContentDictNames',
        'pendingRowToUniqueIndex',
        'pendingContentCount',
        'pendingContentSpans',
        'uniformContentDictName',
        'pendingHitCount',
        'persistedHitCount',
        'exactFallbackCount',
        'pendingPlanUniqueIndexes',
        'pendingPlanUniqueStart',
        'resolvedContentDictNames'];
    const output = Object.fromEntries(fields.map((field) => [field, Reflect.get(result, field)]));
    output.pendingPlanUniqueIndexes = [...result.pendingPlanUniqueIndexes];
    for (const field of ['resolvedFlags', 'resolvedOffsets', 'resolvedLengths', 'resolvedDictNames', 'resolvedUniformDictName', 'pendingEpochs', 'pendingIndexes']) {
        output[field] = Reflect.get(value.plan, field);
    }
    for (const field of ['DenseCount', 'HashPairPendingCount', 'HashPairCount', 'Hash1Table', 'Hash2Table', 'StateTable', 'LengthTable', 'OffsetTable']) {
        output[field] = Reflect.get(value.database, `_termEntryContentMeta${field}`);
    }
    return output;
}

describe('unique-indexed content metadata', () => {
    test.each([
        {native: true, existing: false},
        {native: true, existing: true},
        {native: false, existing: false},
        {native: false, existing: true},
        {native: false, existing: false, references: false},
        {native: false, existing: true, generic: true, references: false},
    ])('matches row metadata for %j', async (options) => {
        const baseline = fixture(options);
        const compact = fixture({...options, compact: true});
        expect(snapshot(compact, await resolve(compact))).toStrictEqual(snapshot(baseline, await resolve(baseline)));
        if (options.native) {
            expect(compact.scanner.stats.calls).toBeGreaterThan(0);
            expect(compact.scanner.stats.copiedInputBytes).toBe(8 * 37);
            expect(compact.scanner.stats.copiedInputBytes).toBeLessThan(baseline.scanner.stats.copiedInputBytes);
        }
    });

    test('preserves selected global row ranges and earlier resolved duplicates', async () => {
        const baseline = fixture({uniqueCount: 40, repeats: 2, existing: true});
        const compact = fixture({compact: true, native: true, uniqueCount: 40, repeats: 2, existing: true});
        for (const value of [baseline, compact]) {
            const {chunk, plan} = value;
            chunk.rowCount = 34;
            chunk.contentRowStart = 21;
            chunk.contentUniqueIndexList = chunk.contentUniqueIndexList?.subarray(21, 55);
            if (chunk.contentMetaByUniqueIndex !== true) { chunk.contentMetaList = chunk.contentMetaList?.subarray(21 * 4, 55 * 4); }
            plan.resolvedFlags[10] = 1;
            plan.resolvedOffsets[10] = 456;
            plan.resolvedLengths[10] = 4;
            plan.resolvedUniformDictName = 'raw';
        }
        expect(snapshot(compact, await resolve(compact))).toStrictEqual(snapshot(baseline, await resolve(baseline)));
        expect(compact.scanner.stats.calls).toBeGreaterThan(0);
        expect(compact.scanner.stats.copiedInputBytes).toBe(17 * 37);
    });

    test.each(['short metadata', 'missing plan', 'missing identities', 'short identities', 'missing slab'])('rejects %s before reservation', async (fault) => {
        const value = fixture({compact: true, native: true});
        if (fault === 'short metadata') { value.chunk.contentMetaList = new Uint32Array(31); }
        if (fault === 'missing plan') { value.chunk.contentDedupPlan = null; }
        if (fault === 'missing identities') { value.chunk.contentUniqueIndexList = null; }
        if (fault === 'short identities') { value.chunk.contentUniqueIndexList = new Uint32Array(31); }
        if (fault === 'missing slab') { value.chunk.contentBytesBuffer = void 0; }
        await expect(resolve(value)).rejects.toThrow('unique metadata is invalid');
        expect(value.scanner.stats.calls).toBe(0);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
    });

    test.each(['source', 'identity', 'row'])('rolls back compact %s failure and retries', async (fault) => {
        const value = fixture({compact: true, native: true});
        const {chunk, plan} = value;
        if (!(chunk.contentMetaList instanceof Uint32Array) || !(chunk.contentUniqueIndexList instanceof Uint32Array) || !(plan.uniqueRowIndexes instanceof Uint32Array)) {
            throw new Error('Missing fixture columns');
        }
        if (fault === 'source') { chunk.contentMetaList[7 * 4] = 0xffffffff; }
        if (fault === 'identity') { chunk.contentUniqueIndexList[7 * 4] = 0; }
        if (fault === 'row') { plan.uniqueRowIndexes[7] = 0; }
        await expect(resolve(value)).rejects.toThrow();
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(Reflect.get(value.database, '_termEntryContentMetaDenseCount')).toBe(0);
        expect(plan.resolvedFlags).toStrictEqual(new Uint8Array(8));
        chunk.contentMetaList[7 * 4] = 7 * 4;
        chunk.contentUniqueIndexList[7 * 4] = 7;
        plan.uniqueRowIndexes[7] = 7 * 4;
        expect((await resolve(value)).pendingContentCount).toBe(8);
    });

    test('keeps a late invalid identity after the 4096-candidate await boundary', async () => {
        const value = fixture({compact: true, native: true, uniqueCount: 4098, repeats: 2});
        for (let unique = 0; unique < 4096; ++unique) {
            Reflect.get(value.database, '_setTermEntryContentMetaByHashPair').call(value.database, unique + 1, unique + 100, {
                id: unique, offset: 1000 + unique * 4, length: 4, dictName: 'raw',
            });
        }
        value.plan.persistedLookupRequired = true;
        if (!(value.chunk.contentUniqueIndexList instanceof Uint32Array)) { throw new Error('Missing identities'); }
        value.chunk.contentUniqueIndexList[4097 * 2] = 0;
        let waves = 0;
        /** @type {DictionaryDatabase['_findMatchingPersistedTermEntryContentMetaBatch']} */
        const resolveExact = async (descriptors) => {
            ++waves;
            expect(descriptors).toHaveLength(4096);
            // Replacing the arena requires rebuilding the compact native inputs.
            Reflect.get(value.database, '_ensureTermEntryContentMetaHashPairCapacity').call(value.database, 32768);
            return descriptors.map((descriptor) => ({existingMeta: descriptor.primary, exactFallback: false}));
        };
        Reflect.set(value.database, '_findMatchingPersistedTermEntryContentMetaBatch', resolveExact);
        await expect(resolve(value)).rejects.toThrow();
        expect(waves).toBe(1);
        expect(value.plan.resolvedFlags.subarray(0, 4096)).toStrictEqual(new Uint8Array(4096).fill(1));
        expect(value.plan.resolvedFlags[4097]).toBe(0);
        expect(Reflect.get(value.database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        expect(value.scanner.stats.calls).toBe(2);
        value.chunk.contentUniqueIndexList[4097 * 2] = 4097;
        expect((await resolve(value)).pendingContentCount).toBe(2);
    });
});
