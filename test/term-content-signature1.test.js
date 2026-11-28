/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from 'node:fs/promises';
import {describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js';
import {TermContentMetadataArena, TERM_CONTENT_SIGNATURE1_MBR6 as MBR6} from '../ext/js/dictionary/term-content-metadata-arena.js';

/** @typedef {import('../ext/js/dictionary/term-content-canonical-scan.js').ScanContext} ScanContext */
/** @typedef {import('../ext/js/dictionary/term-content-canonical-scan.js').ScanHooks} ScanHooks */

const module = await WebAssembly.compile(await fs.readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)));

/**
 * @param {DictionaryDatabase} database
 * @returns {TermContentMetadataArena}
 */
function arenaOf(database) {
    const arena = Reflect.get(database, '_termContentMetadataArena');
    if (arena === null) { throw new Error('Expected allocated metadata'); }
    return arena;
}

/**
 * @param {DictionaryDatabase} database
 * @returns {Record<string, unknown>}
 */
function logicalSnapshot(database) {
    const arena = arenaOf(database);
    const names = [
        '_termEntryContentMetaHashPairTable',
        '_termEntryContentMetaHash1Table',
        '_termEntryContentMetaHash2Table',
        '_termEntryContentMetaStateTable',
        '_termEntryContentMetaLengthTable',
        '_termEntryContentMetaSignature2Table',
        '_termEntryContentMetaSignature3Table',
        '_termEntryContentMetaIdTable',
        '_termEntryContentMetaOffsetTable',
        '_termEntryContentMetaDictNameIdTable',
        '_termEntryContentMetaRecentSourceBatchIdTable',
        '_termEntryContentMetaRecentSourceOffsetTable',
    ];
    return {
        columns: names.map((name) => (name === '_termEntryContentMetaDictNameIdTable' ?
            Array.from({length: arena.state.length}, (_, i) => database._readTermEntryContentMetaDictNameId(i)) :
            [...Reflect.get(database, name)])),
        signature1: Array.from({length: arena.state.length}, (_, i) => arena.getSignature1(i)),
        signaturePresent: [...arena.signaturePresent].map((value) => (value === 2 ? 1 : value)),
        dense: Reflect.get(database, '_termEntryContentMetaDenseCount'),
        pending: Reflect.get(database, '_termEntryContentMetaHashPairPendingCount'),
        published: Reflect.get(database, '_termEntryContentMetaHashPairCount'),
        free: [...Reflect.get(database, '_termEntryContentMetaFreeIndexes')],
    };
}

/**
 * @param {number} [signature1]
 * @param {number} [offset]
 * @returns {{id: number, offset: number, length: number, dictName: string, signature1: number, signature2: number, signature3: number}}
 */
function metadata(signature1 = MBR6, offset = 100) {
    return {id: 0, offset, length: 12, dictName: 'raw', signature1, signature2: 22, signature3: 33};
}

/**
 * @param {number[]} words
 * @param {number} [first]
 * @returns {{database: DictionaryDatabase, context: ScanContext, adopted: Uint32Array[][]}}
 */
function nativeFixture(words, first = 0) {
    const database = new DictionaryDatabase();
    Reflect.get(database, '_ensureTermEntryContentMetaHashPairCapacity').call(database, words.length + 8);
    const count = words.length;
    const bytes = new Uint8Array(count * 12);
    const view = new DataView(bytes.buffer);
    const ids = Uint32Array.from({length: count}, (_, i) => i);
    const rows = new Uint32Array(ids);
    const metas = new Uint32Array(count * 4);
    const signatures = new Uint32Array(count * 3);
    for (let i = 0; i < count; ++i) {
        view.setUint32(i * 12, words[i], true);
        view.setUint32(i * 12 + 4, 20 + i, true);
        view.setUint32(i * 12 + 8, 40 + i, true);
        signatures.set([words[i], 20 + i, 40 + i], i * 3);
        metas.set([i * 12, 12, 100 + i, 200 + i], i * 4);
    }
    /** @type {Uint32Array[][]} */
    const adopted = [];
    /** @type {ScanContext} */
    const context = {
        chunk: {
            rowCount: count,
            contentRowStart: 0,
            contentBytesBaseOffset: 0,
            contentBytesBuffer: bytes,
            contentMetaList: metas,
            contentBytesList: [],
            contentHash1List: [],
            contentHash2List: [],
            contentDictNameList: null,
            uniformContentDictName: 'raw',
        },
        contentDedupPlan: {
            uniqueCount: count,
            sourceRowCount: count,
            resolvedFlags: new Uint8Array(count),
            resolvedOffsets: new Float64Array(count),
            resolvedLengths: new Uint32Array(count),
            resolvedDictNames: null,
            pendingEpochs: null,
            pendingIndexes: null,
            nextEpoch: 1,
        },
        uniqueIndexList: ids,
        uniqueRowIndexes: rows,
        uniqueSignatures: signatures,
        firstUniqueIndex: first,
        lastUniqueIndex: count,
        persistedLookupRequired: false,
        reserveMetadata: true,
        adoptPendingColumns({columns}, complete) {
            adopted.push(columns.map((column) => new Uint32Array(column)));
            return complete();
        },
        getPendingCount: () => adopted.reduce((sum, columns) => sum + columns[0].length, 0),
        exactCandidates: [],
        resolveExactCandidates: async () => {},
    };
    return {database, context, adopted};
}

/**
 * @param {ScanHooks} [hooks]
 * @returns {NativeCanonicalScanner}
 */
function scanner(hooks = {}) {
    return new NativeCanonicalScanner({loadModule: async () => module, hooks});
}

describe('implicit MBR6 first signature', () => {
    test('uses one stable signature snapshot from private metadata accessors', () => {
        const database = new DictionaryDatabase();
        const reads = [0, 0, 0];
        const incoming = {
            id: 0,
            offset: 100,
            length: 12,
            dictName: 'codec',
            get signature1() { return ++reads[0] === 1 ? MBR6 : 1234; },
            get signature2() { return ++reads[1] === 1 ? 22 : 2222; },
            get signature3() { return ++reads[2] === 1 ? 33 : 3333; },
        };
        database._setTermEntryContentMetaByHashPair(10, 20, incoming);
        expect(reads).toEqual([1, 1, 1]);
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject({signature1: MBR6, signature2: 22, signature3: 33});
        expect(arenaOf(database).signature1).toBeNull();
    });

    test('prepares the captured nonmagic word before an accessor replacement can mutate an entry', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        const before = logicalSnapshot(database);
        const reads = [0, 0, 0];
        const incoming = {
            id: 0,
            offset: 500,
            length: 12,
            dictName: 'other',
            get signature1() { return ++reads[0] === 1 ? 1234 : MBR6; },
            get signature2() { ++reads[1]; return 22; },
            get signature3() { ++reads[2]; return 33; },
        };
        const failure = new RangeError('injected captured signature allocation failure');
        const fault = vi.spyOn(database, '_materializeTermContentSignature1').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, incoming)).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(reads).toEqual([1, 1, 1]);
        expect(logicalSnapshot(database)).toEqual(before);
        expect(arenaOf(database).signature1).toBeNull();
    });

    test('samples all source words before metadata setters can mutate the source', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        const bytes = new TextEncoder().encode('MBR6abcdefgh');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const expected = [view.getUint32(0, true), view.getUint32(4, true), view.getUint32(8, true)];
        const assigned = [0, 0, 0];
        let reads = 0;
        const target = {
            tableIndex: 0,
            get signature1() { ++reads; return 0; },
            set signature1(value) { assigned[0] = value; bytes.fill(255); },
            get signature2() { ++reads; return 0; },
            set signature2(value) { assigned[1] = value; },
            get signature3() { ++reads; return 0; },
            set signature3(value) { assigned[2] = value; },
        };
        database._setTermContentSignatures(target, bytes);
        expect(assigned).toEqual(expected);
        expect(reads).toBe(0);
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject({signature1: expected[0], signature2: expected[1], signature3: expected[2]});
        expect(arenaOf(database).signature1).toBeNull();
    });

    test('refresh allocation failure leaves stored metadata unchanged after updating the caller object', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        const before = logicalSnapshot(database);
        const target = database._getTermEntryContentMetaByHashPair(10, 20);
        if (typeof target === 'undefined') { throw new Error('Missing published metadata'); }
        const bytes = new Uint8Array(12);
        new DataView(bytes.buffer).setUint32(0, 1234, true);
        const failure = new RangeError('injected refresh signature allocation failure');
        const fault = vi.spyOn(database, '_materializeTermContentSignature1').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermContentSignatures(target, bytes)).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(target.signature1).toBe(1234);
        expect(logicalSnapshot(database)).toEqual(before);
        expect(arenaOf(database).signature1).toBeNull();
    });

    test('keeps both ordinary metadata columns implicit through insertion and growth', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(), dictName: 'codec'});
        database._ensureTermEntryContentMetaHashPairCapacity(8);
        const bytes = new TextEncoder().encode('MBR6abcdefgh');
        database._insertTermEntryContentMetaByHashPairFast(11, 21, 200, bytes.length, 'codec', 1, bytes);
        database._ensureTermEntryContentMetaDenseCapacity(128);
        expect(arenaOf(database).signature1).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdPrefixEnd')).toBe(2);
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject({dictName: 'codec', signature1: MBR6});
        expect(database._getTermEntryContentMetaByHashPair(11, 21)).toMatchObject({dictName: 'codec', signature1: MBR6});
        expect(database._readTermEntryContentMetaDictNameId(2)).toBe(0);
        expect(database._readTermContentSignature1(2)).toBe(0);
    });

    test('a second optional-column allocation failure leaves every logical old word intact', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(), dictName: 'codec'});
        const before = logicalSnapshot(database);
        const failure = new RangeError('injected dictionary-name allocation failure');
        const fault = vi.spyOn(database, '_materializeTermEntryContentMetaDictNameIds').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(1234, 500), dictName: 'other'})).toThrow(failure);
        } finally { fault.mockRestore(); }
        // The first allocation may persist, but it cannot alter the old logical
        // entry or its marker while the second column cannot be prepared.
        expect(arenaOf(database).signature1).toBeInstanceOf(Uint32Array);
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(logicalSnapshot(database)).toEqual(before);
        database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(1234, 500), dictName: 'other'});
        expect(database._getTermEntryContentMetaByHashPair(10, 20)).toMatchObject({offset: 500, dictName: 'other', signature1: 1234});
    });

    test('the first optional-column allocation failure cannot reach dictionary-name preparation', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(), dictName: 'codec'});
        const before = logicalSnapshot(database);
        const failure = new RangeError('injected signature allocation failure');
        const dictionaryNames = vi.spyOn(database, '_prepareTermEntryContentMetaDictNameIds');
        const fault = vi.spyOn(database, '_materializeTermContentSignature1').mockImplementationOnce(() => { throw failure; });
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, {...metadata(1234, 500), dictName: 'other'})).toThrow(failure);
        } finally { fault.mockRestore(); }
        expect(dictionaryNames).not.toHaveBeenCalled();
        expect(arenaOf(database).signature1).toBeNull();
        expect(Reflect.get(database, '_termEntryContentMetaDictNameIdTable')).toBeNull();
        expect(logicalSnapshot(database)).toEqual(before);
    });

    test('omits exactly two MiB at the observed JMdict dense capacity', () => {
        const dense = 524288;
        const slots = 1048576;
        const arena = new TermContentMetadataArena(dense, slots);
        const formerBytes = 8388608 + slots * 4 + dense * 26;
        expect(arena.signature1).toBeNull();
        expect(formerBytes - arena.memory.buffer.byteLength).toBe(2097152);
        expect(arena.getSignature1(0)).toBe(0);
        expect(arena.getSignature1(dense - 1)).toBe(0);
    });

    test.each([-1, 0.5, Number.NaN, Infinity, -Infinity, 16])('keeps missing numeric index %s undefined', (index) => {
        const arena = new TermContentMetadataArena(16, 32);
        expect(arena.getSignature1(index)).toBeUndefined();
        arena.materializeSignature1();
        expect(arena.getSignature1(index)).toBeUndefined();
    });

    test('materializes implicit words in empty slots without mutating arena bytes', () => {
        const arena = new TermContentMetadataArena(32, 64);
        arena.signaturePresent[2] = 2;
        arena.signaturePresent[31] = 2;
        arena.state[2] = 1;
        const before = new Uint8Array(new Uint8Array(arena.memory.buffer));
        const physical = arena.materializeSignature1();
        expect(physical[2]).toBe(MBR6);
        expect(physical[31]).toBe(MBR6);
        expect(physical[30]).toBe(0);
        expect(new Uint8Array(arena.memory.buffer).every((byte, i) => byte === before[i])).toBe(true);
        expect(arena.getSignature1(31)).toBe(MBR6);
    });

    test('keeps ordinary signed insert, prepared reservation and post-read refresh implicit', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        database._ensureTermEntryContentMetaHashPairCapacity(8);
        const index = database._reservePreparedArtifactTermContentMetadata(11, 21, 12, MBR6, 44, 55);
        const value = database._getTermEntryContentMetaByHashPair(10, 20);
        if (typeof value === 'undefined') { throw new Error('Missing published metadata'); }
        const bytes = new TextEncoder().encode('MBR6abcdefgh');
        database._setTermContentSignatures(value, bytes);
        database._stageArtifactTermContentMetadata([12], [22], [bytes], null);
        database._insertTermEntryContentMetaByHashPairFast(13, 23, 300, bytes.length, 'raw', 0, bytes);
        expect(arenaOf(database).signature1).toBeNull();
        expect(arenaOf(database).signaturePresent[index]).toBe(2);
        expect(value.signature1).toBe(MBR6);
        expect(database._getTermEntryContentMetaByHashPair(10, 20)?.signature1).toBe(MBR6);
        expect(database._getTermEntryContentMetaByHashPair(13, 23)?.signature1).toBe(MBR6);
    });

    test.each([0, 1, 2, 3])('pads a logical %s-byte span without reading adjacent slab bytes', (length) => {
        const database = new DictionaryDatabase();
        const bytes = Uint8Array.of(99, 77, 66, 82, 54, 88);
        const expected = database._readTermContentSignature(bytes.subarray(1, 1 + length), 0);
        const staged = database._stageArtifactTermContentMetadata([10], [20], [], {
            buffer: bytes,
            offsets: new Uint32Array([1]),
            lengths: new Uint32Array([length]),
        });
        expect(arenaOf(database).getSignature1(staged.indexes[0])).toBe(expected);
        expect(arenaOf(database).signaturePresent[staged.indexes[0]]).toBe(1);
    });

    test.each([0, 0x3552424d, 0xffffffff, Number.NaN, MBR6 + 0x100000000])('preserves Uint32 coercion for %s', (value) => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata(value));
        expect(database._getTermEntryContentMetaByHashPair(10, 20)?.signature1).toBe(value >>> 0);
        expect(arenaOf(database).signature1 === null).toBe((value >>> 0) === MBR6);
    });

    test.each([false, true])('unsigned replacement preserves a stale implicit word; reused=%s', (reused) => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        if (reused) {
            database._rollbackStagedArtifactTermContentMetadata({indexes: new Int32Array([0]), active: true});
            expect(arenaOf(database).state[0]).toBe(0);
            expect(arenaOf(database).signaturePresent[0]).toBe(2);
        }
        const hash1 = reused ? 30 : 10;
        const hash2 = reused ? 40 : 20;
        database._setTermEntryContentMetaByHashPair(hash1, hash2, {id: 0, offset: 500, length: 3, dictName: 'raw'});
        expect(database._getTermEntryContentMetaByHashPair(hash1, hash2)).not.toHaveProperty('signature1');
        expect(arenaOf(database).signaturePresent[0]).toBe(0);
        expect(arenaOf(database).getSignature1(0)).toBe(MBR6);
        expect(arenaOf(database).signature1?.[0]).toBe(MBR6);
    });

    test('growth and generic rollback retain implicit free words and untouched zero tail', () => {
        const database = new DictionaryDatabase();
        for (let i = 0; i < 5; ++i) { database._setTermEntryContentMetaByHashPair(10 + i, 20 + i, metadata(MBR6, 100 + i)); }
        database._rollbackStagedArtifactTermContentMetadata({indexes: new Int32Array([2]), active: true});
        const previous = arenaOf(database);
        database._ensureTermEntryContentMetaDenseCapacity(128);
        const next = arenaOf(database);
        expect(next).not.toBe(previous);
        expect(next.signature1).toBeNull();
        expect(Array.from({length: 5}, (_, i) => next.getSignature1(i))).toEqual(new Array(5).fill(MBR6));
        expect(next.getSignature1(127)).toBe(0);
        expect(next.state[2]).toBe(0);
        expect(next.materializeSignature1()[2]).toBe(MBR6);
    });

    test('a failed materialization preserves every logical entry and permits retry', () => {
        const database = new DictionaryDatabase();
        database._setTermEntryContentMetaByHashPair(10, 20, metadata());
        const before = logicalSnapshot(database);
        const failure = new RangeError('injected first-word allocation failure');
        const original = Uint32Array;
        vi.stubGlobal('Uint32Array', new Proxy(original, {
            construct(target, args, newTarget) {
                if (args.length === 1 && args[0] === arenaOf(database).state.length) { throw failure; }
                return Reflect.construct(target, args, newTarget);
            },
        }));
        try {
            expect(() => database._setTermEntryContentMetaByHashPair(10, 20, metadata(1))).toThrow(failure);
        } finally { vi.unstubAllGlobals(); }
        expect(arenaOf(database).signature1).toBeNull();
        expect(logicalSnapshot(database)).toEqual(before);
        database._setTermEntryContentMetaByHashPair(10, 20, metadata(1));
        expect(database._getTermEntryContentMetaByHashPair(10, 20)?.signature1).toBe(1);
    });

    test('signature rejection adds no cold read for a different first word', async () => {
        const database = new DictionaryDatabase();
        const bytes = new TextEncoder().encode('MBR6abcdefghijklmnopqrst');
        database._cacheTermEntryContentMeta(null, 100, bytes.length, 'raw', 0, 10, 20, bytes);
        const primary = database._getTermEntryContentMetaByHashPair(10, 20);
        if (typeof primary === 'undefined') { throw new Error('Missing primary'); }
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailedBatch').mockRejectedValue(new Error('unexpected cold read'));
        const different = new Uint8Array(bytes);
        different[3] = 53;
        const result = await database._findMatchingPersistedTermEntryContentMetaBatch([{hash1: 10, hash2: 20, contentBytes: different, primary}]);
        expect(result).toEqual([{existingMeta: void 0, exactFallback: false}]);
        expect(read).not.toHaveBeenCalled();
        expect(arenaOf(database).signature1).toBeNull();
    });

    test('same-sample hash collisions keep ordered full-byte reads and all candidates', async () => {
        const database = new DictionaryDatabase();
        const first = new TextEncoder().encode('MBR6abcdefghijklmnopqrst');
        const second = new Uint8Array(first);
        second[5] ^= 1;
        database._cacheTermEntryContentMeta(null, 100, first.length, 'raw', 0, 10, 20, first);
        database._cacheTermEntryContentMeta(null, 200, second.length, 'raw', 0, 10, 20, second);
        const primary = database._getTermEntryContentMetaByHashPair(10, 20);
        if (typeof primary === 'undefined') { throw new Error('Missing primary'); }
        const read = vi.spyOn(database, '_readTermEntryContentBytesDetailedBatch').mockImplementation(async (requests) => requests.map(({contentOffset}) => ({status: 'ok', bytes: contentOffset === 100 ? first : second})));
        const [result] = await database._findMatchingPersistedTermEntryContentMetaBatch([{hash1: 10, hash2: 20, contentBytes: second, primary}]);
        expect(result.existingMeta?.offset).toBe(200);
        expect(read.mock.calls.map(([requests]) => requests.map(({contentOffset}) => contentOffset))).toEqual([[100], [200]]);
        expect(Reflect.get(database, '_termEntryContentMetaCollisionsByHashPair').get('10:20')).toHaveLength(1);
        expect(arenaOf(database).signature1).toBeNull();
    });
});

describe('native implicit first-signature publication', () => {
    test('leaves an ordinary MBR6 generation unallocated through adoption', async () => {
        const f = nativeFixture([MBR6, MBR6, MBR6]);
        const native = scanner({beforeAdopt: () => expect(arenaOf(f.database).signature1).toBeNull()});
        expect(await native.scan(f.database, f.context, {})).toBe(0);
        expect(native.stats.calls).toBe(1);
        expect([...arenaOf(f.database).signaturePresent.subarray(0, 3)]).toEqual([2, 2, 2]);
        expect(f.adopted[0][5]).toEqual(new Uint32Array([0, 1, 2]));
    });

    test('maps nonzero first, resolved rows and same-hash pending collisions from the native snapshot', async () => {
        const f = nativeFixture([9, 8, MBR6, 7, 0x3552424d, MBR6, 123, MBR6], 2);
        f.context.contentDedupPlan.resolvedFlags[3] = 1;
        f.context.chunk.contentMetaList.set(f.context.chunk.contentMetaList.subarray(4 * 4 + 2, 4 * 4 + 4), 6 * 4 + 2);
        const native = scanner({beforeOutputView: () => {
            // JS source mutations after the call must not replace the copied SIGS witness.
            f.context.uniqueSignatures?.fill(0);
        }});
        expect(await native.scan(f.database, f.context, {})).toBe(1);
        expect(f.adopted[0][4]).toEqual(new Uint32Array([2, 4, 5, 6, 7]));
        expect(f.adopted[0][5]).toEqual(new Uint32Array([0, 1, 2, 0xffffffff, 3]));
        expect(Array.from({length: 4}, (_, i) => arenaOf(f.database).getSignature1(i))).toEqual([MBR6, 0x3552424d, MBR6, MBR6]);
        expect([...arenaOf(f.database).signaturePresent.subarray(0, 4)]).toEqual([1, 1, 1, 1]);
    });

    test('overwrites a stale physical word when a later native insertion is MBR6', async () => {
        const f = nativeFixture([MBR6]);
        const physical = f.database._materializeTermContentSignature1();
        physical[0] = 123;
        const native = scanner({beforeAdopt: () => {
            expect(physical[0]).toBe(MBR6);
            expect(arenaOf(f.database).signaturePresent[0]).toBe(1);
        }});
        await native.scan(f.database, f.context, {});
        expect(native.stats.inserted).toBe(1);
    });

    test.each(['allocation', 'adoption', 'trap'])('rolls back native logical words after %s failure', async (fault) => {
        const f = nativeFixture([MBR6, 0x3552424d, MBR6]);
        f.database._setTermEntryContentMetaByHashPair(1, 2, metadata());
        const before = logicalSnapshot(f.database);
        const failure = new Error('injected native first-word failure');
        const allocation = fault === 'allocation' ? vi.spyOn(f.database, '_materializeTermContentSignature1').mockImplementationOnce(() => { throw failure; }) : null;
        const native = scanner({
            trapAfter: fault === 'trap' ? 2 : 0,
            beforeAdopt: fault === 'adoption' ? () => { throw failure; } : void 0,
        });
        try {
            await expect(native.scan(f.database, f.context, {})).rejects.toThrow();
        } finally { allocation?.mockRestore(); }
        expect(logicalSnapshot(f.database)).toEqual(before);
        expect(f.adopted).toEqual([]);
        expect(native.stats.synchronousRollbacks).toBe(1);
        expect(arenaOf(f.database).getSignature1(0)).toBe(MBR6);
        expect(arenaOf(f.database).getSignature1(1)).toBe(0);
    });

    test('rejects an old entry-only module before any mutation', async () => {
        // One () -> i32 function returning zero, exported only as scan_canonical.
        const name = [...new TextEncoder().encode('scan_canonical')];
        const exports = [1, name.length, ...name, 0, 0];
        const bytes = Uint8Array.from([
            0,
            97,
            115,
            109,
            1,
            0,
            0,
            0,
            1,
            5,
            1,
            96,
            0,
            1,
            127,
            3,
            2,
            1,
            0,
            7,
            exports.length,
            ...exports,
            10,
            6,
            1,
            4,
            0,
            65,
            0,
            11,
        ]);
        const oldModule = await WebAssembly.compile(bytes);
        const f = nativeFixture([MBR6, 1]);
        const before = logicalSnapshot(f.database);
        const native = new NativeCanonicalScanner({loadModule: async () => oldModule});
        expect(await native.scan(f.database, f.context, {})).toBeNull();
        expect(native.stats.calls).toBe(0);
        expect(native.stats.fallbackUnsupported).toBe(1);
        expect(logicalSnapshot(f.database)).toEqual(before);
    });
});
