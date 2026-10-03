/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {safePerformance} from '../ext/js/core/safe-performance.js';

/** @type {import('@sqlite.org/sqlite-wasm').Sqlite3Static} */
let sqlite3;
/** @type {Array<{connection: import('@sqlite.org/sqlite-wasm').Database, store: TermRecordOpfsStore}>} */
const owners = [];
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
afterEach(async () => {
    for (const {connection, store} of owners.splice(0)) {
        await store._awaitPersistentIndexRepairs();
        connection.close();
    }
    vi.restoreAllMocks();
});

/**
 * Commit-on-close storage boundary; production encoding, repair and reads stay real.
 * @param {Map<string, Uint8Array>} files
 * @returns {FileSystemDirectoryHandle}
 */
function directory(files) {
    const getFileHandle = async (/** @type {string} */ name, {create = false} = {}) => {
        if (!files.has(name)) {
            if (!create) { throw new DOMException('Missing file', 'NotFoundError'); }
            files.set(name, new Uint8Array());
        }
        return {
            kind: 'file',
            name,
            async getFile() { return new File([new Uint8Array(files.get(name) ?? new Uint8Array())], name); },
            async createWritable() {
                let bytes = new Uint8Array();
                let cursor = 0;
                return {
                    async seek(/** @type {number} */ offset) { cursor = offset; },
                    async truncate(/** @type {number} */ length) { bytes = bytes.slice(0, length); cursor = Math.min(cursor, length); },
                    async write(/** @type {FileSystemWriteChunkType} */ input) {
                        let value;
                        if (input instanceof Blob) {
                            value = new Uint8Array(await input.arrayBuffer());
                        } else if (input instanceof ArrayBuffer) {
                            value = new Uint8Array(input);
                        } else if (ArrayBuffer.isView(input)) {
                            value = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
                        } else {
                            throw new Error('Unexpected test write input');
                        }
                        const next = new Uint8Array(Math.max(bytes.length, cursor + value.byteLength));
                        next.set(bytes);
                        next.set(value, cursor);
                        cursor += value.byteLength;
                        bytes = next;
                    },
                    async close() { files.set(name, bytes); },
                    async abort() {},
                };
            },
        };
    };
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle,
        async *entries() {
            for (const name of files.keys()) { yield [name, await getFileHandle(name)]; }
        },
    }));
}

/** @returns {Promise<{database: DictionaryDatabase, store: TermRecordOpfsStore, files: Map<string, Uint8Array>, indexName: string, cleanIndex: Uint8Array}>} */
async function fixture() {
    const files = new Map();
    const recordsDirectory = directory(files);
    const writer = new TermRecordOpfsStore();
    Reflect.set(writer, '_recordsDirectoryHandle', recordsDirectory);
    await writer.beginImportSession();
    const encoder = new TextEncoder();
    for (const [dictionary, expression] of [['damaged-storage', 'recovered'], ['healthy-storage', 'healthy'], ['blocker-storage', 'blocker']]) {
        await writer.appendBatchFromArtifactChunkResolvedContent({
            dictionary,
            dictionaryTotalRows: 1000000,
            rowCount: 1,
            expressionBytesList: [encoder.encode(expression)],
            readingBytesList: [encoder.encode(`${expression}-reading`)],
            readingEqualsExpressionList: new Uint8Array([0]),
            scoreList: new Int32Array([1]),
            sequenceList: new Int32Array([1]),
        }, [0], [1], 'raw');
    }
    await writer.endImportSession();
    const indexName = `${writer._getShardSegmentFileName('damaged-storage', 'raw', 0)}.mbti`;
    const index = files.get(indexName);
    if (typeof index === 'undefined') { throw new Error('Missing test index'); }
    const cleanIndex = new Uint8Array(index);
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
    index[40 + 40 + 16 + view.getUint32(40 + 20, true) + 8] ^= 0xff;

    const connection = new sqlite3.oo1.DB(':memory:');
    const database = new DictionaryDatabase();
    const store = /** @type {TermRecordOpfsStore} */ (Reflect.get(database, '_termRecordStore'));
    owners.push({connection, store});
    Reflect.set(database, '_db', connection);
    connection.exec(`CREATE TABLE dictionaries(id INTEGER PRIMARY KEY, title TEXT, summaryJson TEXT);
        CREATE TABLE dictionaryStorageHealth(title TEXT PRIMARY KEY, generationId TEXT, reason TEXT);`);
    for (const [title, storage] of [['Damaged', 'damaged-storage'], ['Healthy', 'healthy-storage']]) {
        connection.exec({sql: 'INSERT INTO dictionaries(title, summaryJson) VALUES (?, ?)', bind: [title, JSON.stringify({title, termRecordStorageName: storage, storageGenerationId: `${storage}-generation`})]});
    }
    database._refreshTermRecordStorageNameMappings();
    Reflect.set(store, '_recordsDirectoryHandle', recordsDirectory);
    await store._loadShardFiles(false);
    // Content decoding is outside lookup availability; record IDs/fields and indexes are real.
    vi.spyOn(Reflect.get(database, '_termContentStore'), 'ensureLoadedForRead').mockResolvedValue(void 0);
    vi.spyOn(Reflect.get(database, '_termContentStore'), 'warmSlices').mockResolvedValue(void 0);
    vi.spyOn(database, '_deserializeTermRow').mockImplementation(async (row) => ({
        ...row, glossary: ['definition'], rules: '', definitionTags: '', termTags: '',
    }));
    return {database, store, files, indexName, cleanIndex};
}

/** @returns {{entered: PromiseWithResolvers<void>, resume: PromiseWithResolvers<void>}} */
function gate() {
    return {entered: Promise.withResolvers(), resume: Promise.withResolvers()};
}

describe('DB lookup availability with real term-record storage', () => {
    test.each(/** @type {const} */ (['bulk', 'exact', 'sequence']))('%s retains request availability when repair finishes during healthy content read', async (method) => {
        const {database, store} = await fixture();
        const repairGate = gate();
        const contentGate = gate();
        const rebuild = store._rebuildLookupIndexForShard.bind(store);
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async (...args) => {
            repairGate.entered.resolve();
            await repairGate.resume.promise;
            return await rebuild(...args);
        });
        const fetch = database._fetchTermRowsByIds.bind(database);
        vi.spyOn(database, '_fetchTermRowsByIds').mockImplementationOnce(async (ids) => {
            const requestedIds = [...ids];
            expect(requestedIds).toEqual([2]);
            contentGate.entered.resolve();
            await contentGate.resume.promise;
            return await fetch(requestedIds);
        });
        /**
         * @param {import('dictionary-database').DictionaryAvailability[]} observed
         * @returns {Promise<import('dictionary-database').TermEntry[]>}
         */
        const lookup = (observed) => {
            const dictionaries = new Set(['Damaged', 'Healthy']);
            if (method === 'bulk') {
                return database.findTermsBulk(['recovered', 'healthy'], dictionaries, 'exact', observed);
            }
            if (method === 'exact') {
                return database.findTermsExactBulk([
                    {term: 'recovered', reading: 'recovered-reading'},
                    {term: 'healthy', reading: 'healthy-reading'},
                ], dictionaries, observed);
            }
            return database.findTermsBySequenceBulk([
                {dictionary: 'Damaged', query: 1},
                {dictionary: 'Healthy', query: 1},
            ], observed);
        };
        /** @type {import('dictionary-database').DictionaryAvailability[]} */
        const observed = [];
        const degraded = [{
            dictionary: 'Damaged',
            generationId: 'damaged-storage-generation',
            status: 'repairing',
            reason: null,
        }];
        let finished = false;
        const first = lookup(observed).then((rows) => {
            finished = true;
            return rows;
        });
        try {
            await Promise.all([repairGate.entered.promise, contentGate.entered.promise]);
            expect(observed).toEqual(degraded);
            expect(database.getDictionaryAvailability(['Damaged', 'Healthy'])).toEqual(degraded);
            repairGate.resume.resolve();
            await store._awaitPersistentIndexRepairs();
            expect(finished).toBe(false);
            expect(database.getDictionaryAvailability(['Damaged', 'Healthy'])).toEqual([]);
            expect(observed).toEqual(degraded);
        } finally {
            repairGate.resume.resolve();
            contentGate.resume.resolve();
            await Promise.all([first, store._awaitPersistentIndexRepairs()]);
        }
        expect(await first).toMatchObject([{dictionary: 'Healthy', term: 'healthy', id: 2}]);
        expect(await first).toHaveLength(1);
        expect(observed).toEqual(degraded);
        /** @type {import('dictionary-database').DictionaryAvailability[]} */
        const freshObserved = [];
        const fresh = await lookup(freshObserved);
        expect(fresh.map(({dictionary, term, id}) => ({dictionary, term, id}))).toEqual([
            {dictionary: 'Damaged', term: 'recovered', id: 1},
            {dictionary: 'Healthy', term: 'healthy', id: 2},
        ]);
        expect(freshObserved).toEqual([]);
        expect(observed).toEqual(degraded);
    });

    test.each(/** @type {const} */ (['repairPending', 'repairing']))('%s avoids fallback and preserves healthy sibling lookup', async (status) => {
        const {database, store} = await fixture();
        const blocker = gate();
        const rebuild = store._rebuildLookupIndexForShard.bind(store);
        const blockedName = store._getShardSegmentFileName(status === 'repairPending' ? 'blocker-storage' : 'damaged-storage', 'raw', 0);
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockImplementation(async (...args) => {
            if (args[0].fileName === blockedName) {
                blocker.entered.resolve();
                await blocker.resume.promise;
            }
            return await rebuild(...args);
        });
        const ensure = vi.spyOn(store, 'ensureDictionariesLoaded');
        const fallback = vi.spyOn(store, 'ensureDictionaryIndexes');
        const materialize = vi.spyOn(store, '_loadShardStateContents');
        try {
            if (status === 'repairPending') {
                store._tryRepairPersistentDictionaryIndex('blocker-storage');
                await blocker.entered.promise;
            }
            const found = await database.findTermsBulk(['healthy'], new Set(['Damaged', 'Healthy']), 'exact');
            await blocker.entered.promise;
            expect(ensure).toHaveBeenCalledWith(['damaged-storage', 'healthy-storage'], {repairMode: 'background'});
            expect(found).toMatchObject([{dictionary: 'Healthy', term: 'healthy', id: 2, matchSource: 'term'}]);
            expect(found).toHaveLength(1);
            const degraded = database.getDictionaryAvailability(['Damaged', 'Healthy']);
            expect(degraded).toEqual([{
                dictionary: 'Damaged',
                generationId: 'damaged-storage-generation',
                status,
                reason: status === 'repairPending' ? 'Dictionary lookup index needs repair' : null,
            }]);
            expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Damaged')).toBe(false);
            expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Healthy')).toBe(true);
            await expect(database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact')).resolves.toEqual([]);
            expect(fallback).not.toHaveBeenCalled();
            expect(materialize).not.toHaveBeenCalled();
        } finally {
            blocker.resume.resolve();
            await store._awaitPersistentIndexRepairs();
        }
        expect(database.getDictionaryAvailability(['Damaged', 'Healthy'])).toEqual([]);
        const recovered = await database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact');
        expect(recovered).toMatchObject([{dictionary: 'Damaged', term: 'recovered', id: 1}]);
        expect(recovered).toHaveLength(1);
    });

    test.each(/** @type {const} */ (['repairPending', 'repairing', 'temporarilyUnavailable']))('%s clears affected readiness and shared negative caches; same DB reloads recovery', async (status) => {
        const {database, store, files, indexName, cleanIndex} = await fixture();
        files.set(indexName, cleanIndex);
        await database._ensureDirectTermIndexesLoaded(['Damaged', 'Healthy']);
        await expect(database.findTermsBulk(['absent'], new Set(['Damaged', 'Healthy']), 'exact')).resolves.toEqual([]);
        await expect(database.findTermsBulk(['absent'], new Set(['Damaged', 'Healthy']), 'prefix')).resolves.toEqual([]);
        expect(Reflect.get(database, '_termExactPresenceCache').size).toBeGreaterThan(0);
        expect(Reflect.get(database, '_termPrefixNegativeCache').size).toBeGreaterThan(0);
        const damagedIndex = store.getDictionaryIndex('damaged-storage');
        const healthyIndex = store.getDictionaryIndex('healthy-storage');
        Reflect.get(database, '_directTermIndexByDictionary').set('Damaged', damagedIndex);
        Reflect.get(database, '_directTermIndexByDictionary').set('Healthy', healthyIndex);
        const generation = Reflect.get(database, '_directTermIndexGeneration');

        store._invalidatePersistentLookupState('damaged-storage');
        store._setDictionaryHealth('damaged-storage', status, 'Transient index loss');
        expect(Reflect.get(database, '_termExactPresenceCache').size).toBe(0);
        expect(Reflect.get(database, '_termPrefixNegativeCache').size).toBe(0);
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Damaged')).toBe(false);
        expect(Reflect.get(database, '_directTermIndexByDictionary').has('Damaged')).toBe(false);
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Healthy')).toBe(true);
        expect(Reflect.get(database, '_directTermIndexByDictionary').get('Healthy')).toBe(healthyIndex);
        expect(Reflect.get(database, '_directTermIndexGeneration')).toBe(generation);

        const load = vi.spyOn(store, '_loadPersistentDictionaryIndex');
        const found = await database.findTermsBulk(['recovered', 'healthy'], new Set(['Damaged', 'Healthy']), 'exact');
        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0][0]).toBe('damaged-storage');
        expect(found.map(({dictionary, term, id}) => ({dictionary, term, id}))).toEqual([
            {dictionary: 'Damaged', term: 'recovered', id: 1},
            {dictionary: 'Healthy', term: 'healthy', id: 2},
        ]);
        expect(database.getDictionaryAvailability(['Damaged', 'Healthy'])).toEqual([]);
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Damaged')).toBe(true);
    });

    test('a valid recovered index can be explicitly loaded before repair retry-at', async () => {
        const {database, store, files, indexName, cleanIndex} = await fixture();
        vi.spyOn(store, '_rebuildLookupIndexForShard').mockRejectedValue(new Error('Transient write failure'));
        await database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact');
        await store._awaitPersistentIndexRepairs();
        expect(store.getDictionaryHealth('damaged-storage').status).toBe('temporarilyUnavailable');
        const retry = Reflect.get(store, '_persistentIndexRepairRetryByDictionary').get('damaged-storage');
        if (typeof retry === 'undefined') { throw new Error('Expected pending repair retry'); }
        expect(retry.retryAt).toBeGreaterThan(Date.now());
        files.set(indexName, cleanIndex);
        await store.ensureDictionariesLoaded(['damaged-storage']);
        expect(Reflect.get(store, '_persistentIndexRepairRetryByDictionary').has('damaged-storage')).toBe(false);
        expect(store.getDictionaryHealth('damaged-storage').status).toBe('available');
        const found = await database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact');
        expect(found).toMatchObject([{dictionary: 'Damaged', term: 'recovered', id: 1}]);
        expect(found).toHaveLength(1);
        expect(database.getDictionaryAvailability(['Damaged'])).toEqual([]);
    });

    test('available health notification clears stale readiness and a negative result before same-instance reload', async () => {
        const {database, store, files, indexName, cleanIndex} = await fixture();
        files.set(indexName, cleanIndex);
        await database._ensureDirectTermIndexesLoaded(['Damaged', 'Healthy']);
        store._invalidatePersistentLookupState('damaged-storage');
        store._setDictionaryHealth('damaged-storage', 'temporarilyUnavailable', 'Transient failure');
        // Simulate query state retained by an older request while recovery finishes.
        const key = database._createTermExactPresenceCacheKey(database._getDictionaryCacheKey(['Damaged']), 'recovered');
        Reflect.get(database, '_termExactPresenceCache').set(key, false);
        Reflect.get(database, '_termPrefixNegativeCache').set('stale prefix', true);
        Reflect.get(database, '_directTermIndexLoadedDictionaryNames').add('Damaged');
        Reflect.get(database, '_directTermIndexByDictionary').set('Damaged', store.getDictionaryIndex('damaged-storage'));
        store._setDictionaryHealth('damaged-storage', 'available');
        expect(Reflect.get(database, '_termExactPresenceCache').size).toBe(0);
        expect(Reflect.get(database, '_termPrefixNegativeCache').size).toBe(0);
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Damaged')).toBe(false);
        expect(Reflect.get(database, '_directTermIndexByDictionary').has('Damaged')).toBe(false);
        expect(Reflect.get(database, '_directTermIndexLoadedDictionaryNames').has('Healthy')).toBe(true);
        const load = vi.spyOn(store, '_loadPersistentDictionaryIndex');
        const found = await database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact');
        expect(load).toHaveBeenCalledTimes(1);
        expect(found).toMatchObject([{dictionary: 'Damaged', term: 'recovered', id: 1}]);
        expect(found).toHaveLength(1);
    });

    test('real rebuild yields a task and mutation cancels before durable replacement', async () => {
        const {database, store, files, indexName} = await fixture();
        const index = files.get(indexName);
        if (typeof index === 'undefined') { throw new Error('Expected damaged index bytes'); }
        const damagedBytes = new Uint8Array(index);
        const yielded = gate();
        let time = 0;
        vi.spyOn(safePerformance, 'now').mockImplementation(() => {
            time += 9;
            return time;
        });
        const schedule = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
            if (args[1] === 0) { yielded.entered.resolve(); }
            return schedule(...args);
        });
        const callback = vi.fn(async () => {
            expect(files.get(indexName)).toEqual(damagedBytes);
            expect(Reflect.get(store, '_persistentIndexRepairPromiseByDictionary').size).toBe(0);
        });
        let mutation = Promise.resolve();
        try {
            await database.findTermsBulk(['recovered'], new Set(['Damaged']), 'exact');
            await yielded.entered.promise;
            mutation = store._runExclusiveStorageMutation(callback);
            await mutation;
        } finally {
            await Promise.all([mutation, store._awaitPersistentIndexRepairs()]);
        }
        expect(callback).toHaveBeenCalledTimes(1);
        expect(files.get(indexName)).toEqual(damagedBytes);
        expect(store.getDictionaryHealth('damaged-storage').status).toBe('repairPending');
    });
});
