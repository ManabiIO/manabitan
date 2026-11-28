/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {readFile} from 'node:fs/promises';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js';

/** @typedef {import('../ext/js/dictionary/dictionary-database.js').TermContentMeta} Meta */
/** @typedef {import('../ext/js/dictionary/dictionary-database.js').ArtifactTermContentChunk} Chunk */

const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)));

/**
 * @param {DictionaryDatabase} database
 * @returns {Meta}
 */
function meta(database) {
    const value = Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 1, 2);
    if (typeof value === 'undefined') { throw new Error('Missing fixture metadata'); }
    return value;
}

/**
 * @param {DictionaryDatabase} database
 * @param {Uint8Array} bytes
 * @param {boolean} batch
 * @returns {Promise<Meta|undefined>}
 */
async function find(database, bytes, batch) {
    if (!batch) { return await Reflect.get(database, '_findMatchingTermEntryContentMeta').call(database, 1, 2, bytes); }
    const [result] = await Reflect.get(database, '_findMatchingPersistedTermEntryContentMetaBatch').call(database, [
        {hash1: 1, hash2: 2, contentBytes: bytes, primary: meta(database)},
    ]);
    return result.existingMeta;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Chunk}
 */
function chunk(bytes) {
    return {
        rowCount: 1,
        contentRowStart: 0,
        contentBytesList: [],
        contentHash1List: new Uint32Array(0),
        contentHash2List: new Uint32Array(0),
        contentBytesBuffer: bytes,
        contentBytesBaseOffset: 0,
        contentMetaList: Uint32Array.of(0, bytes.length, 1, 2),
        contentUniqueIndexList: Uint32Array.of(0),
        contentDictNameList: null,
        uniformContentDictName: 'raw',
        useResolvedContentReferences: true,
        contentDedupPlan: {
            uniqueCount: 1,
            sourceRowCount: 1,
            uniqueRowIndexes: Uint32Array.of(0),
            resolutionDeferred: true,
            resolvedFlags: new Uint8Array(0),
            resolvedOffsets: new Float64Array(0),
            resolvedLengths: new Uint32Array(0),
            resolvedDictNames: null,
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
            nextUnresolvedUniqueIndex: 0,
            persistedLookupRequired: null,
        },
    };
}

/**
 * @param {Uint8Array} bytes
 * @returns {{signature1: number, signature2: number, signature3: number}}
 */
function signatures(bytes) {
    const read = (/** @type {number} */ offset) => {
        let value = 0;
        for (let i = 0; i < 4 && offset + i < bytes.length; ++i) { value |= bytes[offset + i] << (8 * i); }
        return value >>> 0;
    };
    const last = Math.max(0, bytes.length - 4);
    return {signature1: read(0), signature2: read(Math.floor(last / 2)), signature3: read(last)};
}

describe('demand-driven content rejection samples', () => {
    const cases = ['recent', 'inflight'].flatMap((source) => [false, true].flatMap((batch) => (
        [0, 1, 2, 3, 20].map((length) => ({source, batch, length}))
    )));
    test.each(cases)('hydrates $source samples at exact comparison; batch=$batch length=$length', async ({source, batch, length}) => {
        const database = new DictionaryDatabase();
        const bytes = Uint8Array.from({length}, (_, i) => i + 1);
        const slab = Uint8Array.of(90, 91, ...bytes, 92, 93, 94, 95);
        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 1, 2, {id: 0, offset: 100, length, dictName: 'raw'});
        const span = {buffer: slab, offset: 2, length};
        const recent = vi.fn(() => (source === 'recent' ? span : void 0));
        const inflight = vi.fn(() => (source === 'inflight' ? span : void 0));
        Reflect.set(database, '_findRecentTermContentSource', recent);
        Reflect.set(database, '_findInFlightTermContentSource', inflight);
        const read = vi.fn(() => { throw new Error('An available source must avoid storage'); });
        Reflect.set(database, '_readTermEntryContentBytesDetailed', read);
        Reflect.set(database, '_readTermEntryContentBytesDetailedBatch', read);
        expect(meta(database).signature1).toBeUndefined();

        if (length > 0) {
            const collision = Uint8Array.from(bytes);
            // Length 20 keeps all three samples equal, before and after hydration.
            collision[length === 20 ? 5 : 0] ^= 0xff;
            expect(await find(database, collision, batch)).toBeUndefined();
            expect(meta(database)).toMatchObject(signatures(bytes));
            expect(await find(database, collision, batch)).toBeUndefined();
        }
        expect(await find(database, Uint8Array.from(bytes), batch)).toMatchObject({offset: 100, length});
        if (length === 0) {
            expect(recent).not.toHaveBeenCalled();
            expect(inflight).not.toHaveBeenCalled();
        } else {
            const calls = recent.mock.calls.length + inflight.mock.calls.length;
            const rejectedSample = Uint8Array.from(bytes);
            rejectedSample[0] ^= 0xff;
            expect(await find(database, rejectedSample, batch)).toBeUndefined();
            expect(recent.mock.calls.length + inflight.mock.calls.length).toBe(calls);
            expect(meta(database)).toMatchObject(signatures(bytes));
        }
        expect(read).not.toHaveBeenCalled();
    });

    const failures = [false, true].flatMap((batch) => ['temporarilyUnavailable', 'corrupt'].map((status) => ({batch, status})));
    test.each(failures)('fails closed when unsampled storage is $status; batch=$batch', async ({batch, status}) => {
        const database = new DictionaryDatabase();
        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 1, 2, {id: 0, offset: 100, length: 4, dictName: 'raw'});
        const result = {status, reason: 'injected read failure'};
        Reflect.set(database, '_readTermEntryContentBytesDetailed', async () => result);
        Reflect.set(database, '_readTermEntryContentBytesDetailedBatch', async () => [result]);
        await expect(find(database, Uint8Array.of(1, 2, 3, 4), batch)).rejects.toMatchObject({name: 'TermContentLookupReadError', status});
        expect(meta(database).signature1).toBeUndefined();
    });

    test('preserves hydrated samples through growth and hides them after rollback and ID reuse', async () => {
        const database = new DictionaryDatabase();
        const bytes = Uint8Array.of(1, 2, 3);
        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 1, 2, {id: 0, offset: 100, length: 3, dictName: 'raw'});
        Reflect.set(database, '_findRecentTermContentSource', () => ({buffer: bytes, offset: 0, length: bytes.length}));
        expect(await find(database, bytes, true)).toMatchObject(signatures(bytes));
        const index = meta(database).tableIndex;
        if (typeof index !== 'number') { throw new Error('Missing fixture metadata index'); }
        const before = Reflect.get(database, '_termContentMetadataArena');
        Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, 4096);
        expect(Reflect.get(database, '_termContentMetadataArena')).not.toBe(before);
        expect(meta(database)).toMatchObject(signatures(bytes));
        Reflect.get(database, '_rollbackStagedArtifactTermContentMetadata').call(database, {indexes: Int32Array.of(index), active: true});
        expect(Reflect.get(database, '_getTermEntryContentMetaByHashPair').call(database, 1, 2)).toBeUndefined();
        Reflect.get(database, '_setTermEntryContentMetaByHashPair').call(database, 1, 2, {id: 0, offset: 200, length: 1, dictName: 'raw'});
        expect(meta(database).tableIndex).toBe(index);
        expect(meta(database).signature1).toBeUndefined();
        expect(meta(database).signature2).toBeUndefined();
        expect(meta(database).signature3).toBeUndefined();
    });

    test('rolls back every lazy native reservation before retry', async () => {
        const database = new DictionaryDatabase();
        const scanner = new NativeCanonicalScanner({loadModule: async () => module, hooks: {trapAfter: 1}});
        Reflect.set(database, '_nativeCanonicalScanner', scanner);
        await expect(Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, chunk(Uint8Array.of(1, 2, 3)), true)).rejects.toThrow();
        expect(scanner.stats.synchronousRollbacks).toBe(1);
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0);
        for (const column of ['SignaturePresent', 'Signature1', 'Signature2', 'Signature3']) {
            expect(Reflect.get(database, `_termEntryContentMeta${column}Table`)[0]).toBe(0);
        }
        const retry = new NativeCanonicalScanner({loadModule: async () => module});
        Reflect.set(database, '_nativeCanonicalScanner', retry);
        const result = await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, chunk(Uint8Array.of(1, 2, 3)), true);
        expect(result.pendingContentCount).toBe(1);
        expect(retry.stats.calls).toBe(1);
        expect(retry.stats.copiedInputBytes).toBe(25);
        expect(Reflect.get(database, '_termEntryContentMetaSignaturePresentTable')[0]).toBe(0);
    });

    test.each([0, 1, 2, 3, 20])('keeps the native-unavailable fallback exact and bounded at length %s', async (length) => {
        const database = new DictionaryDatabase();
        const scanner = new NativeCanonicalScanner({loadModule: async () => { throw new Error('unavailable module'); }});
        Reflect.set(database, '_nativeCanonicalScanner', scanner);
        const bytes = Uint8Array.from({length}, (_, i) => i + 1);
        const input = chunk(Uint8Array.of(90, ...bytes, 91, 92, 93));
        input.contentMetaList = Uint32Array.of(1, length, 1, 2);
        const result = await Reflect.get(database, '_resolveArtifactTermContentDedup').call(database, input, true);
        expect(result.pendingContentCount).toBe(1);
        expect(scanner.stats.fallbackAsset).toBe(1);
        expect(scanner.stats.calls).toBe(0);
        const index = result.stagedContentMetadata.indexes[0];
        expect(Reflect.get(database, '_termEntryContentMetaSignaturePresentTable')[index]).toBe(1);
        for (const [key, value] of Object.entries(signatures(bytes))) {
            expect(Reflect.get(database, `_termEntryContentMeta${key[0].toUpperCase()}${key.slice(1)}Table`)[index]).toBe(value);
        }
    });
});
