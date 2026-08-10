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

import {describe, expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';
import {
    RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
    RAW_TERM_CONTENT_TOKEN_DICT_NAME,
} from '../ext/js/dictionary/raw-term-content.js';

/**
 * @param {Map<string, Uint8Array>} fileBytesByName
 * @param {{removeEntryFailures?: Map<string, number>}} [options]
 * @returns {FileSystemDirectoryHandle}
 */
function createFakeDirectoryHandle(fileBytesByName, {removeEntryFailures = new Map()} = {}) {
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        async getFileHandle(
            /** @type {string} */ name,
            /** @type {{create?: boolean}} */ options = {},
        ) {
            const create = options.create === true;
            if (!fileBytesByName.has(name)) {
                if (!create) {
                    throw new Error(`File not found: ${name}`);
                }
                fileBytesByName.set(name, new Uint8Array());
            }
            return /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
                kind: 'file',
                name,
                async isSameEntry() {
                    return false;
                },
                async createSyncAccessHandle() {
                    throw new Error('SyncAccessHandle not implemented in test double');
                },
                async getFile() {
                    const bytes = fileBytesByName.get(name) ?? new Uint8Array();
                    return {
                        size: bytes.byteLength,
                        slice(start = 0, end = bytes.byteLength) {
                            const sliceBytes = bytes.slice(start, end);
                            return {
                                async arrayBuffer() {
                                    return sliceBytes.buffer;
                                },
                            };
                        },
                        async arrayBuffer() {
                            return new Uint8Array(bytes).buffer;
                        },
                    };
                },
                async createWritable() {
                    let nextBytes = fileBytesByName.get(name) ?? new Uint8Array();
                    let cursor = nextBytes.byteLength;
                    return {
                        async seek(/** @type {number} */ position) {
                            cursor = Math.max(0, position);
                        },
                        async truncate(/** @type {number} */ length) {
                            nextBytes = nextBytes.slice(0, Math.max(0, length));
                            cursor = Math.min(cursor, nextBytes.byteLength);
                        },
                        async write(/** @type {FileSystemWriteChunkType} */ value) {
                            /** @type {Uint8Array|null} */
                            let bytes = null;
                            if (value instanceof ArrayBuffer) {
                                bytes = new Uint8Array(new Uint8Array(value));
                            } else if (ArrayBuffer.isView(value)) {
                                bytes = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
                            } else if (value instanceof Blob) {
                                bytes = new Uint8Array(await value.arrayBuffer());
                            }
                            if (bytes !== null) {
                                const requiredLength = cursor + bytes.byteLength;
                                if (requiredLength > nextBytes.byteLength) {
                                    const expanded = new Uint8Array(requiredLength);
                                    expanded.set(nextBytes, 0);
                                    nextBytes = expanded;
                                }
                                nextBytes.set(bytes, cursor);
                                cursor += bytes.byteLength;
                                return;
                            }
                            throw new Error(`Unsupported write value: ${String(value)}`);
                        },
                        async close() {
                            fileBytesByName.set(name, nextBytes);
                        },
                    };
                },
            }));
        },
        async removeEntry(/** @type {string} */ name) {
            const failuresRemaining = removeEntryFailures.get(name) ?? 0;
            if (failuresRemaining > 0) {
                removeEntryFailures.set(name, failuresRemaining - 1);
                throw new Error(`Injected removeEntry failure for ${name}`);
            }
            fileBytesByName.delete(name);
        },
        async *entries() {
            for (const name of fileBytesByName.keys()) {
                yield [name, await this.getFileHandle(name, {create: false})];
            }
        },
    }));
}

describe('TermRecordOpfsStore', () => {
    test('keeps shard write failures sticky and does not restart queued writes', async () => {
        const store = new TermRecordOpfsStore();
        const state = Reflect.get(store, '_createShardState').call(
            store,
            'records.mbt4',
            /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({})),
            0,
        );
        const writeError = new Error('injected shard write failure');
        const deferredWrite = {
            /** @type {(error: Error) => void} */
            reject: () => {},
        };
        vi.spyOn(store, '_writeChunksForShard').mockImplementation(() => {
            return new Promise((_, reject) => {
                deferredWrite.reject = reject;
            });
        });
        state.queuedWriteChunks = [new Uint8Array([1])];
        state.queuedWriteBytes = 1;

        const drain = Reflect.get(store, '_drainQueuedWritesForShard').call(store, state);
        state.queuedWritePromise = drain;
        Reflect.get(store, '_queueWriteChunksForShard').call(
            store,
            state,
            [new Uint8Array([2])],
        );
        deferredWrite.reject(writeError);
        await expect(drain).rejects.toBe(writeError);

        expect(state.queuedWriteChunks).toStrictEqual([]);
        Reflect.get(store, '_queueWriteChunksForShard').call(store, state, [new Uint8Array([3])]);
        expect(state.queuedWriteChunks).toStrictEqual([]);
        await expect(Reflect.get(store, '_awaitQueuedWritesForShard').call(store, state)).rejects.toBe(writeError);
    });

    test('restores shard lengths and removes shards created after a checkpoint', async () => {
        const store = new TermRecordOpfsStore();
        const existingName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const createdName = store._getShardSegmentFileName('Jitendex', 'raw', 0);
        const fileBytesByName = new Map([[existingName, new Uint8Array([1, 2, 3])]]);
        const directory = createFakeDirectoryHandle(fileBytesByName);
        Reflect.set(store, '_recordsDirectoryHandle', directory);
        const checkpoint = await store.createImportCheckpoint();

        const existingWritable = await (await directory.getFileHandle(existingName)).createWritable({keepExistingData: true});
        await existingWritable.seek(3);
        await existingWritable.write(new Uint8Array([4, 5]));
        await existingWritable.close();
        const createdWritable = await (await directory.getFileHandle(createdName, {create: true})).createWritable();
        await createdWritable.write(new Uint8Array([9]));
        await createdWritable.close();

        await store.rollbackImportSession(checkpoint);

        expect(fileBytesByName.get(existingName)).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(fileBytesByName.has(createdName)).toBe(false);
    });

    test('rollback restores checkpoints after a queued write rejects', async () => {
        const store = new TermRecordOpfsStore();
        const existingName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const createdName = store._getShardSegmentFileName('Jitendex', 'raw', 0);
        const fileBytesByName = new Map([[existingName, new Uint8Array([1, 2, 3])]]);
        const directory = createFakeDirectoryHandle(fileBytesByName);
        Reflect.set(store, '_recordsDirectoryHandle', directory);
        await Reflect.get(store, '_loadShardFiles').call(store, false);
        const checkpoint = await store.createImportCheckpoint();

        const state = Reflect.get(store, '_shardStateByFileName').get(existingName);
        if (typeof state === 'undefined') {
            throw new Error('Expected existing shard state');
        }
        state.queuedWritePromise = Promise.reject(new Error('injected queued write failure'));
        state.queuedWriteChunks = [new Uint8Array([9])];
        state.queuedWriteBytes = 1;
        fileBytesByName.set(existingName, new Uint8Array([1, 2, 3, 4, 5]));
        fileBytesByName.set(createdName, new Uint8Array([9]));
        fileBytesByName.set(`${createdName}.mbti`, new Uint8Array([8]));

        await expect(store.rollbackImportSession(checkpoint)).resolves.toBeUndefined();
        expect(fileBytesByName.get(existingName)).toStrictEqual(new Uint8Array([1, 2, 3]));
        expect(fileBytesByName.has(createdName)).toBe(false);
        expect(fileBytesByName.has(`${createdName}.mbti`)).toBe(false);
    });

    test('rollback does not create empty files for missing checkpoint shards', async () => {
        const store = new TermRecordOpfsStore();
        const missingName = store._getShardSegmentFileName('Missing', 'raw', 0);
        const fileBytesByName = new Map();
        Reflect.set(store, '_recordsDirectoryHandle', createFakeDirectoryHandle(fileBytesByName));

        await expect(store.rollbackImportSession({
            shards: [{fileName: missingName, fileLength: 32}],
        })).rejects.toThrow(/Failed to roll back term-record import storage/);
        expect(fileBytesByName.has(missingName)).toBe(false);
    });

    test('does not reload existing dictionary shards when an import session begins', async () => {
        const store = new TermRecordOpfsStore();
        const loadShardStatesContents = vi.spyOn(store, '_loadShardStatesContents');
        Reflect.get(store, '_loadedDictionaryNames').add('JMdict');
        Reflect.set(store, '_allShardContentsLoaded', true);
        Reflect.set(store, '_recordsDirectoryHandle', createFakeDirectoryHandle(new Map()));

        await store.beginImportSession();
        await store.ensureDictionariesLoaded(['JMdict']);

        expect(loadShardStatesContents).not.toHaveBeenCalled();
        expect(Reflect.get(store, '_loadedDictionaryNames').has('JMdict')).toBe(true);
        expect(Reflect.get(store, '_allShardContentsLoaded')).toBe(true);

        await store.endImportSession();
    });

    test('does not reload a dictionary during an all-dictionary load', async () => {
        const store = new TermRecordOpfsStore();
        const jmFileName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const jitendexFileName = store._getShardSegmentFileName('Jitendex', 'raw', 0);
        const makeState = (fileName) => ({fileName});
        Reflect.set(store, '_recordsDirectoryHandle', createFakeDirectoryHandle(new Map()));
        Reflect.get(store, '_shardStateByFileName').set(jmFileName, makeState(jmFileName));
        Reflect.get(store, '_shardStateByFileName').set(jitendexFileName, makeState(jitendexFileName));
        const loadedFileNames = [];
        vi.spyOn(store, '_loadShardStatesContents').mockImplementation(async (states) => {
            loadedFileNames.push(states.map(({fileName}) => fileName));
            await Promise.resolve();
        });

        await store.ensureDictionariesLoaded(['JMdict']);
        await store.ensureAllDictionariesLoaded();

        expect(loadedFileNames).toEqual([[jmFileName], [jitendexFileName]]);
        expect(Reflect.get(store, '_allShardContentsLoaded')).toBe(true);
    });

    test('encodes and decodes raw-v4 entry content dict names without falling back to custom strings', () => {
        const store = new TermRecordOpfsStore();
        const {meta, bytes} = store._encodeEntryContentDictNameMeta(RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME);
        const decoded = store._decodeEntryContentDictName(meta, new Uint8Array(), 0, 0);

        expect(meta & 0xff).not.toBe(0xff);
        expect(bytes).toBeNull();
        expect(decoded).toBe(RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME);
    });

    test('encodes and decodes raw-v6 entry content dict names without custom strings', () => {
        const store = new TermRecordOpfsStore();
        const {meta, bytes} = store._encodeEntryContentDictNameMeta(RAW_TERM_CONTENT_TOKEN_DICT_NAME);
        const decoded = store._decodeEntryContentDictName(meta, new Uint8Array(), 0, 0);

        expect(meta & 0xff).not.toBe(0xff);
        expect(bytes).toBeNull();
        expect(decoded).toBe(RAW_TERM_CONTENT_TOKEN_DICT_NAME);
    });

    test('replaceDictionaryName renames shard files and in-memory records', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const activeAppendShardStateByKey = Reflect.get(store, '_activeAppendShardStateByKey');
        const oldFileName = store._getShardSegmentFileName('JMdict staging', 'raw', 0);
        const oldLogicalKey = store._getShardFileName('JMdict staging', 'raw');
        const fileBytesByName = new Map([[oldFileName, new Uint8Array([1, 2, 3, 4])]]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const fileHandle = await recordsDirectoryHandle.getFileHandle(oldFileName, {create: false});
        const shardState = store._createShardState(oldFileName, fileHandle, 4, 'raw', 0, oldLogicalKey);

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(oldFileName, shardState);
        activeAppendShardStateByKey.set(oldLogicalKey, shardState);
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict staging',
            expression: '暗記',
            reading: 'あんき',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        const renamedCount = await store.replaceDictionaryName('JMdict staging', 'JMdict [2026-02-26]');
        const newFileName = store._getShardSegmentFileName('JMdict [2026-02-26]', 'raw', 0);

        expect(renamedCount).toBe(1);
        expect(recordsById.get(1)?.dictionary).toBe('JMdict [2026-02-26]');
        expect(fileBytesByName.has(oldFileName)).toBe(false);
        expect(fileBytesByName.has(newFileName)).toBe(true);
        expect([...(fileBytesByName.get(newFileName) ?? [])]).toStrictEqual([1, 2, 3, 4]);
        expect(shardStateByFileName.has(oldFileName)).toBe(false);
        expect(shardStateByFileName.has(newFileName)).toBe(true);
    });

    test('replaceDictionaryName can preserve the source shard until an external transaction commits', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const oldFileName = store._getShardSegmentFileName('JMdict staging', 'raw', 0);
        const newDictionaryName = 'JMdict [2026-02-26]';
        const newFileName = store._getShardSegmentFileName(newDictionaryName, 'raw', 0);
        const oldLogicalKey = store._getShardFileName('JMdict staging', 'raw');
        const fileBytesByName = new Map([[oldFileName, new Uint8Array([1, 2, 3, 4])]]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const fileHandle = await recordsDirectoryHandle.getFileHandle(oldFileName, {create: false});

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(
            oldFileName,
            store._createShardState(oldFileName, fileHandle, 4, 'raw', 0, oldLogicalKey),
        );
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict staging',
            expression: '暗記',
            reading: 'あんき',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        await expect(store.replaceDictionaryName('JMdict staging', newDictionaryName, true)).resolves.toBe(1);

        expect(fileBytesByName.has(oldFileName)).toBe(true);
        expect(fileBytesByName.has(newFileName)).toBe(true);
        expect(recordsById.get(1)?.dictionary).toBe(newDictionaryName);

        await store.cleanupShardFilesByDictionaryPredicate((name) => name === 'JMdict staging');
        expect(fileBytesByName.has(oldFileName)).toBe(false);
        expect(fileBytesByName.has(newFileName)).toBe(true);
        expect(recordsById.get(1)?.dictionary).toBe(newDictionaryName);
    });

    test('dictionary index construction uses maintained record ids without duplicate stale ids', () => {
        const store = new TermRecordOpfsStore();
        const storeRecord = /** @type {(record: unknown) => void} */ (Reflect.get(store, '_storeRecord').bind(store));
        const deleteRecord = /** @type {(id: number) => boolean} */ (Reflect.get(store, '_deleteRecord').bind(store));

        storeRecord({
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: 100,
        });
        expect(deleteRecord(1)).toBe(true);
        storeRecord({
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: 100,
        });

        const index = store.getDictionaryIndex('JMdict');

        expect(index.expression.get('日本')).toEqual([1]);
        expect(index.reading.get('にほん')).toEqual([1]);
        expect(index.sequence.get(100)).toEqual([1]);
    });

    test('reports repeated records as already indexed', () => {
        const store = new TermRecordOpfsStore();
        const storeRecord = /** @type {(record: unknown) => boolean} */ (Reflect.get(store, '_storeRecord').bind(store));
        const record = {
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: 100,
        };

        expect(storeRecord(record)).toBe(true);
        expect(storeRecord({...record})).toBe(false);
    });

    test('dictionary id side index follows overwritten records across dictionaries', () => {
        const store = new TermRecordOpfsStore();
        const storeRecord = /** @type {(record: unknown) => void} */ (Reflect.get(store, '_storeRecord').bind(store));

        storeRecord({
            id: 7,
            dictionary: 'Old',
            expression: '古い',
            reading: 'ふるい',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        storeRecord({
            id: 7,
            dictionary: 'New',
            expression: '新しい',
            reading: 'あたらしい',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        expect(store.getDictionaryIndex('Old').expression.get('古い')).toBeUndefined();
        expect(store.getDictionaryIndex('New').expression.get('新しい')).toEqual([7]);
    });

    test('stale record ids are compacted only for affected dictionaries', () => {
        const store = new TermRecordOpfsStore();
        const storeRecord = /** @type {(record: unknown) => void} */ (Reflect.get(store, '_storeRecord').bind(store));
        const deleteRecord = /** @type {(id: number) => boolean} */ (Reflect.get(store, '_deleteRecord').bind(store));
        const staleDictionaryNames = /** @type {Set<string>} */ (Reflect.get(store, '_recordIdStaleDictionaryNames'));
        const idsByDictionary = /** @type {Map<string, number[]>} */ (Reflect.get(store, '_recordIdsByDictionary'));

        storeRecord({
            id: 1,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        storeRecord({
            id: 2,
            dictionary: 'Jitendex',
            expression: '猫',
            reading: 'ねこ',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        expect(deleteRecord(1)).toBe(true);
        storeRecord({
            id: 3,
            dictionary: 'JMdict',
            expression: '学校',
            reading: 'がっこう',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 8,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        expect(staleDictionaryNames.has('JMdict')).toBe(true);
        expect(staleDictionaryNames.has('Jitendex')).toBe(false);
        expect(store.getDictionaryIndex('Jitendex').expression.get('猫')).toEqual([2]);
        expect(staleDictionaryNames.has('JMdict')).toBe(true);

        expect(store.getDictionaryIndex('JMdict').expression.get('学校')).toEqual([3]);
        expect(staleDictionaryNames.has('JMdict')).toBe(false);
        expect(idsByDictionary.get('JMdict')).toEqual([3]);
    });

    test('dictionary indexes skip duplicate reading keys when reading equals expression', () => {
        const store = new TermRecordOpfsStore();
        const storeRecord = /** @type {(record: unknown) => void} */ (Reflect.get(store, '_storeRecord').bind(store));
        storeRecord({
            id: 1,
            dictionary: 'JMdict',
            expression: 'ヽ',
            reading: 'ヽ',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        storeRecord({
            id: 2,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        const index = store.getDictionaryIndex('JMdict');
        expect(index.expression.get('ヽ')).toEqual([1]);
        expect(index.reading.get('ヽ')).toBeUndefined();
        expect(index.expression.get('日本')).toEqual([2]);
        expect(index.reading.get('にほん')).toEqual([2]);

        store.ensureDictionaryReverseIndex('JMdict', index);
        expect(index.expressionReverse.get('ヽ')).toEqual([1]);
        expect(index.readingReverse.get('ヽ')).toBeUndefined();
        expect(index.expressionReverse.get('本日')).toEqual([2]);
        expect(index.readingReverse.get('んほに')).toEqual([2]);
    });

    test('lazy shard metadata scan prevents cold append id collisions', async () => {
        const sourceStore = new TermRecordOpfsStore();
        const sourceFileBytesByName = new Map();
        Reflect.set(sourceStore, '_recordsDirectoryHandle', createFakeDirectoryHandle(sourceFileBytesByName));
        Reflect.set(sourceStore, '_nextId', 42);
        await sourceStore.appendBatch([{
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        }]);
        const shardBytes = sourceFileBytesByName.get(sourceStore._getShardSegmentFileName('JMdict', 'raw', 0));
        expect(shardBytes).toBeInstanceOf(Uint8Array);
        const fileBytesByName = new Map([[sourceStore._getShardSegmentFileName('JMdict', 'raw', 0), /** @type {Uint8Array} */ (shardBytes)]]);
        const store = new TermRecordOpfsStore();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await Reflect.get(store, '_loadShardFiles').call(store, false);
        Reflect.set(store, '_nextIdMayNeedShardScan', true);

        await store.appendBatch([{
            dictionary: 'Jitendex',
            expression: '猫',
            reading: 'ねこ',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        }]);

        expect(store.getById(42)).toBeUndefined();
        expect(store.getById(43)?.dictionary).toBe('Jitendex');
        expect(store.getDictionaryIndex('Jitendex').expression.get('猫')).toEqual([43]);
    });

    test('current binary max-id scan reads appended shard chunks without materializing records', async () => {
        const sourceStore = new TermRecordOpfsStore();
        const sourceFileBytesByName = new Map();
        Reflect.set(sourceStore, '_recordsDirectoryHandle', createFakeDirectoryHandle(sourceFileBytesByName));
        Reflect.set(sourceStore, '_nextId', 42);
        await sourceStore.appendBatch([{
            id: 42,
            dictionary: 'JMdict',
            expression: '日本',
            reading: 'にほん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        }]);
        const shardBytes = sourceFileBytesByName.get(sourceStore._getShardSegmentFileName('JMdict', 'raw', 0));
        expect(shardBytes).toBeInstanceOf(Uint8Array);
        expect(sourceStore._scanCurrentBinaryMaxRecordId(/** @type {Uint8Array} */ (shardBytes))).toBe(42);
    });

    test('replaceDictionaryName restores original shard files and records when source removal fails', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const activeAppendShardStateByKey = Reflect.get(store, '_activeAppendShardStateByKey');
        const oldFileName = store._getShardSegmentFileName('JMdict staging', 'raw', 0);
        const oldLogicalKey = store._getShardFileName('JMdict staging', 'raw');
        const fileBytesByName = new Map([[oldFileName, new Uint8Array([9, 8, 7, 6])]]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName, {
            removeEntryFailures: new Map([[oldFileName, 1]]),
        });
        const fileHandle = await recordsDirectoryHandle.getFileHandle(oldFileName, {create: false});
        const shardState = store._createShardState(oldFileName, fileHandle, 4, 'raw', 0, oldLogicalKey);

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(oldFileName, shardState);
        activeAppendShardStateByKey.set(oldLogicalKey, shardState);
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict staging',
            expression: '暗記',
            reading: 'あんき',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        await expect(store.replaceDictionaryName('JMdict staging', 'JMdict [2026-02-26]')).rejects.toThrow(/Injected removeEntry failure/);

        const newFileName = store._getShardSegmentFileName('JMdict [2026-02-26]', 'raw', 0);
        expect(recordsById.get(1)?.dictionary).toBe('JMdict staging');
        expect(fileBytesByName.has(oldFileName)).toBe(true);
        expect(fileBytesByName.has(newFileName)).toBe(false);
        expect([...(fileBytesByName.get(oldFileName) ?? [])]).toStrictEqual([9, 8, 7, 6]);
        expect(shardStateByFileName.has(oldFileName)).toBe(true);
        expect(shardStateByFileName.has(newFileName)).toBe(false);
    });

    test('replaceDictionaryName preserves existing target shard files when live target records already exist', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const activeAppendShardStateByKey = Reflect.get(store, '_activeAppendShardStateByKey');
        const indexByDictionary = Reflect.get(store, '_indexByDictionary');
        const oldFileName = store._getShardSegmentFileName('JMdict staging', 'raw', 0);
        const oldLogicalKey = store._getShardFileName('JMdict staging', 'raw');
        const newFileName = store._getShardSegmentFileName('JMdict [2026-02-26]', 'raw', 0);
        const newLogicalKey = store._getShardFileName('JMdict [2026-02-26]', 'raw');
        const fileBytesByName = new Map([
            [oldFileName, new Uint8Array([1, 2, 3, 4])],
            [newFileName, new Uint8Array([5, 6, 7, 8])],
        ]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const oldFileHandle = await recordsDirectoryHandle.getFileHandle(oldFileName, {create: false});
        const newFileHandle = await recordsDirectoryHandle.getFileHandle(newFileName, {create: false});
        const oldShardState = store._createShardState(oldFileName, oldFileHandle, 4, 'raw', 0, oldLogicalKey);
        const newShardState = store._createShardState(newFileName, newFileHandle, 4, 'raw', 0, newLogicalKey);

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(oldFileName, oldShardState);
        shardStateByFileName.set(newFileName, newShardState);
        activeAppendShardStateByKey.set(oldLogicalKey, oldShardState);
        activeAppendShardStateByKey.set(newLogicalKey, newShardState);
        indexByDictionary.set('JMdict [2026-02-26]', {
            expression: new Map([['既存', [2]]]),
            reading: new Map(),
            expressionReverse: new Map(),
            readingReverse: new Map(),
            sequence: new Map(),
        });
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict staging',
            expression: '暗記',
            reading: 'あんき',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        recordsById.set(2, {
            id: 2,
            dictionary: 'JMdict [2026-02-26]',
            expression: '既存',
            reading: 'きそん',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 4,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        await expect(store.replaceDictionaryName('JMdict staging', 'JMdict [2026-02-26]')).rejects.toThrow(/Target shard file already exists/);

        expect(recordsById.get(1)?.dictionary).toBe('JMdict staging');
        expect([...(fileBytesByName.get(oldFileName) ?? [])]).toStrictEqual([1, 2, 3, 4]);
        expect([...(fileBytesByName.get(newFileName) ?? [])]).toStrictEqual([5, 6, 7, 8]);
        expect(shardStateByFileName.has(oldFileName)).toBe(true);
        expect(shardStateByFileName.has(newFileName)).toBe(true);
    });

    test('replaceDictionaryName removes stale colliding target shard files when no live target records exist', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const activeAppendShardStateByKey = Reflect.get(store, '_activeAppendShardStateByKey');
        const oldFileName = store._getShardSegmentFileName('JMdict staging', 'raw', 0);
        const oldLogicalKey = store._getShardFileName('JMdict staging', 'raw');
        const newFileName = store._getShardSegmentFileName('JMdict [2026-02-26]', 'raw', 0);
        const newLogicalKey = store._getShardFileName('JMdict [2026-02-26]', 'raw');
        const fileBytesByName = new Map([
            [oldFileName, new Uint8Array([1, 2, 3, 4])],
            [newFileName, new Uint8Array([9, 9, 9, 9])],
        ]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const oldFileHandle = await recordsDirectoryHandle.getFileHandle(oldFileName, {create: false});
        const staleTargetHandle = await recordsDirectoryHandle.getFileHandle(newFileName, {create: false});
        const oldShardState = store._createShardState(oldFileName, oldFileHandle, 4, 'raw', 0, oldLogicalKey);
        const staleTargetState = store._createShardState(newFileName, staleTargetHandle, 4, 'raw', 0, newLogicalKey);

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(oldFileName, oldShardState);
        shardStateByFileName.set(newFileName, staleTargetState);
        activeAppendShardStateByKey.set(oldLogicalKey, oldShardState);
        activeAppendShardStateByKey.set(newLogicalKey, staleTargetState);
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict staging',
            expression: '暗記',
            reading: 'あんき',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 4,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });

        const renamedCount = await store.replaceDictionaryName('JMdict staging', 'JMdict [2026-02-26]');

        expect(renamedCount).toBe(1);
        expect(recordsById.get(1)?.dictionary).toBe('JMdict [2026-02-26]');
        expect([...(fileBytesByName.get(newFileName) ?? [])]).toStrictEqual([1, 2, 3, 4]);
        expect(fileBytesByName.has(oldFileName)).toBe(false);
    });

    test('cleanupShardFilesByDictionaryPredicate removes transient shard files and state', async () => {
        const store = new TermRecordOpfsStore();
        const recordsById = Reflect.get(store, '_recordsById');
        const indexByDictionary = Reflect.get(store, '_indexByDictionary');
        const shardStateByFileName = Reflect.get(store, '_shardStateByFileName');
        const activeAppendShardStateByKey = Reflect.get(store, '_activeAppendShardStateByKey');
        const transientFileName = store._getShardSegmentFileName('JMdict [cutover abc123]', 'raw', 0);
        const transientLogicalKey = store._getShardFileName('JMdict [cutover abc123]', 'raw');
        const liveFileName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const liveLogicalKey = store._getShardFileName('JMdict', 'raw');
        const fileBytesByName = new Map([
            [transientFileName, new Uint8Array([1, 2, 3])],
            [liveFileName, new Uint8Array([4, 5, 6])],
        ]);
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const transientFileHandle = await recordsDirectoryHandle.getFileHandle(transientFileName, {create: false});
        const liveFileHandle = await recordsDirectoryHandle.getFileHandle(liveFileName, {create: false});
        const transientState = store._createShardState(transientFileName, transientFileHandle, 3, 'raw', 0, transientLogicalKey);
        const liveState = store._createShardState(liveFileName, liveFileHandle, 3, 'raw', 0, liveLogicalKey);

        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        shardStateByFileName.set(transientFileName, transientState);
        shardStateByFileName.set(liveFileName, liveState);
        activeAppendShardStateByKey.set(transientLogicalKey, transientState);
        activeAppendShardStateByKey.set(liveLogicalKey, liveState);
        recordsById.set(1, {
            id: 1,
            dictionary: 'JMdict [cutover abc123]',
            expression: '一',
            reading: 'いち',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 3,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        recordsById.set(2, {
            id: 2,
            dictionary: 'JMdict',
            expression: '二',
            reading: 'に',
            expressionReverse: null,
            readingReverse: null,
            entryContentOffset: 0,
            entryContentLength: 3,
            entryContentDictName: 'raw',
            score: 0,
            sequence: null,
        });
        indexByDictionary.set('JMdict [cutover abc123]', {expression: new Map(), reading: new Map(), expressionReverse: new Map(), readingReverse: new Map(), sequence: new Map()});
        indexByDictionary.set('JMdict', {expression: new Map(), reading: new Map(), expressionReverse: new Map(), readingReverse: new Map(), sequence: new Map()});

        const removed = await store.cleanupShardFilesByDictionaryPredicate((dictionaryName) => /\[cutover /.test(dictionaryName));

        expect(removed).toStrictEqual([transientFileName]);
        expect(fileBytesByName.has(transientFileName)).toBe(false);
        expect(fileBytesByName.has(liveFileName)).toBe(true);
        expect(shardStateByFileName.has(transientFileName)).toBe(false);
        expect(shardStateByFileName.has(liveFileName)).toBe(true);
        expect(activeAppendShardStateByKey.has(transientLogicalKey)).toBe(false);
        expect(activeAppendShardStateByKey.has(liveLogicalKey)).toBe(true);
        expect(recordsById.get(1)).toBeUndefined();
        expect(recordsById.get(2)?.dictionary).toBe('JMdict');
        expect(indexByDictionary.size).toBe(0);
    });

    test('round-trips artifact chunk records into the exact expression index', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Jitendex.org [2026-04-04]';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);

        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: 2,
                expressionBytesList: [textEncoder.encode('食う'), textEncoder.encode('食べる')],
                readingBytesList: [textEncoder.encode('くう'), textEncoder.encode('たべる')],
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([0, 0]),
                sequenceList: new Int32Array([1, 2]),
            },
            [0, 128],
            [128, 256],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);

        const index = readerStore.getDictionaryIndex(dictionaryName);
        expect(index.expression.get('食う')).toHaveLength(1);
        expect(index.reading.get('くう')).toHaveLength(1);

        const loadedRecord = readerStore.getById(index.expression.get('食う')?.[0] ?? -1);
        expect(loadedRecord?.expression).toBe('食う');
        expect(loadedRecord?.reading).toBe('くう');
    });

    test('streams lookup sidecar chunks before finalization without exposing a valid header', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Streamed lookup sidecar';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);

        await writerStore.beginImportSession();
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('一')],
                readingBytesList: [textEncoder.encode('いち')],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([1]),
                sequenceList: new Int32Array([1]),
            },
            [0],
            [16],
            'raw',
        );
        const state = [...Reflect.get(writerStore, '_shardStateByFileName').values()][0];
        await writerStore._flushPendingLookupIndexChunks(state);

        expect(state.pendingLookupIndexChunks).toHaveLength(0);
        expect(state.lookupIndexWritable).not.toBeNull();
        expect(state.lookupIndexChunkCount).toBe(1);
        const indexFileName = [...fileBytesByName.keys()].find((name) => name.endsWith('.mbti'));
        expect(indexFileName).toBeDefined();
        expect(fileBytesByName.get(indexFileName)?.byteLength).toBe(0);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('二')],
                readingBytesList: [textEncoder.encode('に')],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([2]),
                sequenceList: new Int32Array([2]),
            },
            [16],
            [16],
            'raw',
        );
        await writerStore.endImportSession();

        const finalizedIndexBytes = fileBytesByName.get(indexFileName);
        expect(new TextDecoder().decode(finalizedIndexBytes?.subarray(0, 8))).toBe('MBTIDX06');
        const finalizedIndexView = new DataView(
            finalizedIndexBytes.buffer,
            finalizedIndexBytes.byteOffset,
            finalizedIndexBytes.byteLength,
        );
        expect(finalizedIndexView.getUint32(16, true)).toBe(2);
        expect(finalizedIndexView.getUint32(20, true)).toBe(2);

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);
        const index = readerStore.getDictionaryIndex(dictionaryName);
        expect(index.expression.get('一')).toHaveLength(1);
        expect(index.expression.get('二')).toHaveLength(1);
    });

    test('rollback removes an unfinalized streamed lookup sidecar', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Rolled back streamed sidecar';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_recordsDirectoryHandle', recordsDirectoryHandle);
        const checkpoint = await store.createImportCheckpoint();

        await store.beginImportSession();
        await store.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('失敗')],
                readingBytesList: [textEncoder.encode('しっぱい')],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([0]),
                sequenceList: new Int32Array([-1]),
            },
            [0],
            [16],
            'raw',
        );
        const state = [...Reflect.get(store, '_shardStateByFileName').values()][0];
        await store._flushPendingLookupIndexChunks(state);
        expect([...fileBytesByName.keys()].some((name) => name.endsWith('.mbti'))).toBe(true);

        await store.rollbackImportSession(checkpoint);

        expect(fileBytesByName.size).toBe(0);
    });

    test('round-trips content offsets above 2 GiB, 4 GiB, and near the safe integer limit', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Large content offsets';
        const offsets = [
            0x80000000 + 17,
            0x100000000 + 29,
            Number.MAX_SAFE_INTEGER - 64,
        ];
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: offsets.length,
                expressionBytesList: offsets.map((_, index) => textEncoder.encode(`offset-${index}`)),
                readingBytesList: offsets.map((_, index) => textEncoder.encode(`offset-${index}`)),
                readingEqualsExpressionList: new Uint8Array(offsets.length).fill(1),
                scoreList: new Int32Array(offsets.length),
                sequenceList: new Int32Array(offsets.length).fill(-1),
            },
            offsets,
            new Uint32Array(offsets.length).fill(32),
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);

        const records = [...Reflect.get(readerStore, '_recordsById').values()];
        expect(records.map(({entryContentOffset}) => entryContentOffset)).toStrictEqual(offsets);
    });

    test('splits chunks when content offsets span more than one u32 delta range', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Split content offset ranges';
        const offsets = [0, 0x100000000, 8];
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: offsets.length,
                expressionBytesList: offsets.map((_, index) => textEncoder.encode(`span-${index}`)),
                readingBytesList: offsets.map((_, index) => textEncoder.encode(`span-${index}`)),
                readingEqualsExpressionList: new Uint8Array(offsets.length).fill(1),
                scoreList: new Int32Array(offsets.length),
                sequenceList: new Int32Array(offsets.length).fill(-1),
            },
            offsets,
            new Uint32Array(offsets.length).fill(8),
            'raw',
        );
        await writerStore._closeAllWritables();

        const shardBytes = [...fileBytesByName.values()][0];
        expect(new TextDecoder().decode(shardBytes.subarray(0, 8))).toBe('MBTRR12B');
        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);
        const records = [...Reflect.get(readerStore, '_recordsById').values()];
        expect(records.map(({entryContentOffset}) => entryContentOffset)).toStrictEqual(offsets);
    });

    test('rejects unsafe content offsets instead of truncating them', async () => {
        const textEncoder = new TextEncoder();
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_recordsDirectoryHandle', createFakeDirectoryHandle(new Map()));
        Reflect.set(store, '_wasmEncoderUnavailable', true);

        await expect(store.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: 'Unsafe content offset',
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('unsafe')],
                readingBytesList: [textEncoder.encode('unsafe')],
                readingEqualsExpressionList: new Uint8Array([1]),
                scoreList: new Int32Array([0]),
                sequenceList: new Int32Array([-1]),
            },
            [Number.MAX_SAFE_INTEGER + 1],
            [8],
            'raw',
        )).rejects.toThrow(/Invalid term content offset/);
    });

    test('loads persistent indexes without materializing shards and reads only matching records', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Persistent random lookup';
        const contentDictName = 'raw-block-v1:shared-content';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 3,
                expressionBytesList: ['食う', '食べる', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'たべる', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0, 0]),
                scoreList: new Int32Array([1, 2, 3]),
                sequenceList: new Int32Array([10, 20, 30]),
            },
            [0x100000000 + 10, 0x100000000 + 20, 0x100000000 + 30],
            [8, 9, 10],
            contentDictName,
        );
        await writerStore._closeAllWritables();
        const indexFileName = [...fileBytesByName.keys()].find((name) => name.endsWith('.mbti'));
        expect(indexFileName).toBeDefined();
        expect(
            new TextDecoder().decode(
                fileBytesByName.get(/** @type {string} */ (indexFileName))?.subarray(0, 8),
            ),
        ).toBe('MBTIDX06');

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);

        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
        const matchingId = readerStore.findTermIds(dictionaryName, '食べる', 'expression')[0] ?? -1;
        expect(matchingId).toBeGreaterThan(0);
        const persistentChunk = Reflect.get(readerStore, '_persistentRecordChunksByDictionary').get(dictionaryName)?.[0];
        expect(persistentChunk).toBeDefined();
        const getFile = persistentChunk?.fileHandle.getFile.bind(persistentChunk.fileHandle);
        let randomReadFileSnapshotCount = 0;
        if (typeof getFile === 'function' && typeof persistentChunk !== 'undefined') {
            Reflect.set(persistentChunk.fileHandle, 'getFile', async () => {
                ++randomReadFileSnapshotCount;
                return await getFile();
            });
        }
        const records = await readerStore.getByIdsAsync([matchingId]);
        expect(records.get(matchingId)).toMatchObject({
            expression: '食べる',
            reading: 'たべる',
            entryContentOffset: 0x100000000 + 20,
            entryContentLength: 9,
            entryContentDictName: contentDictName,
            score: 2,
            sequence: 20,
        });
        expect(randomReadFileSnapshotCount).toBe(1);
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(1);
    });

    test('gets cold MBTIDX06 dictionary counts and samples without materializing Maps', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Persistent metadata lookup';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 3,
                expressionBytesList: ['食う', '食べる', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'たべる', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0, 0]),
                scoreList: new Int32Array([1, 2, 3]),
                sequenceList: new Int32Array([10, 20, 30]),
            },
            [0, 8, 16],
            [8, 8, 8],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);

        expect(readerStore.getDictionaryRecordCount(dictionaryName)).toBe(3);
        expect(readerStore.getDictionarySampleIds(dictionaryName, 2)).toEqual([1, 2]);
        expect(readerStore.getDictionarySampleIds(dictionaryName, 0)).toEqual([]);
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
        expect(Reflect.get(readerStore, '_indexByDictionary').has(dictionaryName)).toBe(false);
    });

    test('coalesces concurrent persistent index loads for the same dictionary', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Coalesced persistent index load';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('食べる')],
                readingBytesList: [textEncoder.encode('たべる')],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([1]),
                sequenceList: new Int32Array([10]),
            },
            [0],
            [8],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        const loadPersistentDictionaryIndex = readerStore._loadPersistentDictionaryIndex.bind(readerStore);
        /** @type {() => void} */
        let releaseLoad = () => {};
        const loadMayFinish = new Promise((resolve) => { releaseLoad = resolve; });
        const persistentIndexLoad = vi.spyOn(readerStore, '_loadPersistentDictionaryIndex').mockImplementation(
            async (name, generation) => {
                await loadMayFinish;
                return await loadPersistentDictionaryIndex(name, generation);
            },
        );

        const first = readerStore.ensureDictionariesLoaded([dictionaryName]);
        const second = readerStore.ensureDictionariesLoaded([dictionaryName]);
        await vi.waitFor(() => expect(persistentIndexLoad).toHaveBeenCalledTimes(1));
        releaseLoad();
        await Promise.all([first, second]);

        expect(readerStore.hasPersistentTermLookupIndex(dictionaryName)).toBe(true);
        expect(persistentIndexLoad).toHaveBeenCalledTimes(1);
    });

    test('reads cold matching chunks concurrently across dictionaries', async () => {
        const textEncoder = new TextEncoder();
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        for (const [dictionary, expression, reading] of [
            ['JMdict', '食べる', 'たべる'],
            ['Jitendex', '食べる', 'たべる'],
        ]) {
            await writerStore.appendBatchFromArtifactChunkResolvedContent(
                {
                    dictionary,
                    dictionaryTotalRows: 1_000_000,
                    rowCount: 1,
                    expressionBytesList: [textEncoder.encode(expression)],
                    readingBytesList: [textEncoder.encode(reading)],
                    readingEqualsExpressionList: new Uint8Array([0]),
                    scoreList: new Int32Array([1]),
                    sequenceList: new Int32Array([10]),
                },
                [0],
                [16],
                'raw',
            );
        }
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded(['JMdict', 'Jitendex']);
        const chunksByDictionary = Reflect.get(readerStore, '_persistentRecordChunksByDictionary');
        const chunks = ['JMdict', 'Jitendex'].map((dictionary) => chunksByDictionary.get(dictionary)?.[0]);
        expect(chunks.every((chunk) => typeof chunk !== 'undefined')).toBe(true);
        let startedCount = 0;
        /** @type {() => void} */
        let releaseReads = () => {};
        const readsMayFinish = new Promise((resolve) => {
            releaseReads = resolve;
        });
        /** @type {() => void} */
        let reportBothStarted = () => {};
        const bothStarted = new Promise((resolve) => {
            reportBothStarted = resolve;
        });
        for (const chunk of chunks) {
            if (typeof chunk === 'undefined') { continue; }
            const getFile = chunk.fileHandle.getFile.bind(chunk.fileHandle);
            Reflect.set(chunk.fileHandle, 'getFile', async () => {
                if (++startedCount === chunks.length) { reportBothStarted(); }
                await readsMayFinish;
                return await getFile();
            });
        }
        const ids = ['JMdict', 'Jitendex'].map(
            (dictionary) => readerStore.findTermIds(dictionary, '食べる', 'expression')[0] ?? -1,
        );
        const read = readerStore.getByIdsAsync(ids);
        await bothStarted;
        releaseReads();
        const records = await read;

        expect(records.size).toBe(2);
    });

    test('loads persistent indexes concurrently across dictionaries', async () => {
        const textEncoder = new TextEncoder();
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        for (const dictionary of ['JMdict', 'Jitendex']) {
            await writerStore.appendBatchFromArtifactChunkResolvedContent(
                {
                    dictionary,
                    dictionaryTotalRows: 1_000_000,
                    rowCount: 1,
                    expressionBytesList: [textEncoder.encode('食べる')],
                    readingBytesList: [textEncoder.encode('たべる')],
                    readingEqualsExpressionList: new Uint8Array([0]),
                    scoreList: new Int32Array([1]),
                    sequenceList: new Int32Array([10]),
                },
                [0],
                [16],
                'raw',
            );
        }
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        const states = [...Reflect.get(readerStore, '_shardStateByFileName').values()];
        expect(states).toHaveLength(2);
        let startedCount = 0;
        /** @type {() => void} */
        let releaseReads = () => {};
        const readsMayFinish = new Promise((resolve) => {
            releaseReads = resolve;
        });
        /** @type {() => void} */
        let reportBothStarted = () => {};
        const bothStarted = new Promise((resolve) => {
            reportBothStarted = resolve;
        });
        for (const state of states) {
            const getFile = state.fileHandle.getFile.bind(state.fileHandle);
            Reflect.set(state.fileHandle, 'getFile', async () => {
                if (++startedCount === states.length) { reportBothStarted(); }
                await readsMayFinish;
                return await getFile();
            });
        }
        const load = readerStore.ensureDictionariesLoaded(['JMdict', 'Jitendex']);
        await bothStarted;
        releaseReads();
        await load;

        expect(readerStore.findTermIds('JMdict', '食べる', 'expression')).toHaveLength(1);
        expect(readerStore.findTermIds('Jitendex', '食べる', 'expression')).toHaveLength(1);
    });

    test('rebuilds persistent indexes after deleting and batch reimporting a large dictionary', async () => {
        const textEncoder = new TextEncoder();
        const fileBytesByName = new Map();
        const removeEntryFailures = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName, {removeEntryFailures});
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        const appendDictionary = async (dictionary, expression, reading, sequence) => {
            const expressionBytes = textEncoder.encode(expression);
            const readingBytes = textEncoder.encode(reading);
            const builder = createTermRecordPreinternedPlanBuilder(2);
            const expressionIndex = builder.internStringBytes(expressionBytes);
            const readingIndex = builder.internStringBytes(readingBytes);
            const plan = builder.buildPlan([expressionIndex], [readingIndex]);
            await writerStore.appendBatchFromArtifactChunkResolvedContent(
                {
                    dictionary,
                    dictionaryTotalRows: 1_000_000,
                    rowCount: 1,
                    expressionBytesList: [],
                    readingBytesList: [],
                    readingEqualsExpressionList: new Uint8Array([0]),
                    scoreList: new Int32Array([1]),
                    sequenceList: new Int32Array([sequence]),
                    termRecordPreinternedPlan: plan,
                },
                [sequence * 16],
                [16],
                'raw',
            );
        };

        await writerStore.beginImportSession();
        await appendDictionary('JMdict', '古い', 'ふるい', 1);
        await writerStore.endImportSession();
        for (const fileName of fileBytesByName.keys()) {
            if (fileName.includes(encodeURIComponent('JMdict'))) {
                removeEntryFailures.set(fileName, 1);
            }
        }
        await writerStore.deleteByDictionary('JMdict');

        await writerStore.beginImportSession();
        await appendDictionary('JMdict', '暗記', 'あんき', 2);
        await appendDictionary('JMnedict', '青木', 'あおき', 3);
        await writerStore.endImportSession();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded(['JMdict', 'JMnedict']);

        expect(readerStore.hasPersistentTermLookupIndex('JMdict')).toBe(true);
        expect(readerStore.hasPersistentTermLookupIndex('JMnedict')).toBe(true);
        expect(readerStore.findTermIds('JMdict', '古い', 'expression')).toEqual([]);
        expect(readerStore.findTermIds('JMdict', '暗記', 'expression')).toHaveLength(1);
        expect(readerStore.findTermIds('JMnedict', '青木', 'expression')).toHaveLength(1);
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
    });

    test('retries random-read chunk metadata after a transient file failure', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Transient random read';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 1,
                expressionBytesList: [textEncoder.encode('食う')],
                readingBytesList: [textEncoder.encode('くう')],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([1]),
                sequenceList: new Int32Array([10]),
            },
            [0],
            [16],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);
        const chunk = Reflect.get(readerStore, '_persistentRecordChunksByDictionary').get(dictionaryName)?.[0];
        expect(chunk).toBeDefined();
        if (typeof chunk === 'undefined') {
            throw new Error('Expected a persistent record chunk');
        }
        const fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ (chunk.fileHandle));
        const getFile = fileHandle.getFile.bind(fileHandle);
        let getFileCallCount = 0;
        Reflect.set(fileHandle, 'getFile', async () => {
            ++getFileCallCount;
            if (getFileCallCount === 1) {
                throw new Error('transient file snapshot failure');
            }
            return await getFile();
        });

        await expect(readerStore._loadRandomReadChunkMetadata(chunk)).rejects.toThrow(
            'transient file snapshot failure',
        );
        expect(Reflect.get(readerStore, '_randomReadChunkMetadataCache').size).toBe(0);
        await expect(readerStore._loadRandomReadChunkMetadata(chunk)).resolves.toMatchObject({
            firstId: chunk.firstId,
            count: chunk.count,
        });
        expect(getFileCallCount).toBe(2);
    });

    test('rejects a cold random read when record bytes no longer match the persistent index', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Corrupt random record';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: ['食う', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([1, 2]),
                sequenceList: new Int32Array([10, 20]),
            },
            [0, 16],
            [16, 16],
            'raw',
        );
        await writerStore._closeAllWritables();

        const shardFileName = [...fileBytesByName.keys()].find((name) => name.endsWith('.mbtr'));
        expect(shardFileName).toBeDefined();
        const shardBytes = fileBytesByName.get(/** @type {string} */ (shardFileName));
        expect(shardBytes).toBeDefined();
        const shardView = new DataView(
            /** @type {Uint8Array} */ (shardBytes).buffer,
            /** @type {Uint8Array} */ (shardBytes).byteOffset,
            /** @type {Uint8Array} */ (shardBytes).byteLength,
        );
        const stringTableOffset = 8 + 2 + 16;
        const stringCount = shardView.getUint32(stringTableOffset, true);
        const stringBytesLength = shardView.getUint32(stringTableOffset + 4, true);
        const recordsOffset = stringTableOffset + 8 + (stringCount * 2) + stringBytesLength;
        /** @type {Uint8Array} */ (shardBytes)[recordsOffset + 24 + 16] ^= 0xff;

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);
        const matchingId = readerStore.findTermIds(dictionaryName, '飲む', 'expression')[0] ?? -1;

        await expect(readerStore.getByIdsAsync([matchingId])).rejects.toThrow(
            /Term-record checksum mismatch/,
        );
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
    });

    test('ensureAllDictionariesLoaded materializes records behind persistent indexes exactly once', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Persistent count';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: ['食う', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([1, 2]),
                sequenceList: new Int32Array([10, 20]),
            },
            [0, 16],
            [16, 16],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);
        const randomId = readerStore.findTermIds(dictionaryName, '食う', 'expression')[0] ?? -1;
        await readerStore.getByIdsAsync([randomId]);
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(1);

        await readerStore.ensureAllDictionariesLoaded();
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(2);
        expect(readerStore.size).toBe(2);
        expect(readerStore.findTermIds(dictionaryName, '食う', 'expression')).toHaveLength(1);
        expect(readerStore.findTermIds(dictionaryName, '飲む', 'expression')).toHaveLength(1);
    });

    test('falls back to full shard loading when a persistent index is corrupt', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Corrupt persistent index';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: ['食う', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([1, 2]),
                sequenceList: new Int32Array([10, 20]),
            },
            [0, 16],
            [16, 16],
            'raw',
        );
        await writerStore._closeAllWritables();
        const indexFileName = [...fileBytesByName.keys()].find((name) => name.endsWith('.mbti'));
        expect(indexFileName).toBeDefined();
        const indexBytes = fileBytesByName.get(/** @type {string} */ (indexFileName));
        expect(indexBytes).toBeDefined();
        /** @type {Uint8Array} */ (indexBytes)[/** @type {Uint8Array} */ (indexBytes).byteLength - 1] ^= 0xff;

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);

        expect(Reflect.get(readerStore, '_recordsById').size).toBe(2);
        expect(readerStore.getDictionaryIndex(dictionaryName).expression.get('飲む')).toHaveLength(1);
    });

    test('drops a truncated fallback shard without publishing its first record', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Truncated fallback shard';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: ['食う', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([1, 2]),
                sequenceList: new Int32Array([10, 20]),
            },
            [0, 16],
            [16, 16],
            'raw',
        );
        await writerStore._closeAllWritables();

        const shardFileName = [...fileBytesByName.keys()].find((name) => !name.endsWith('.mbti'));
        expect(shardFileName).toBeDefined();
        const shardBytes = fileBytesByName.get(/** @type {string} */ (shardFileName));
        expect(shardBytes).toBeDefined();
        fileBytesByName.delete(`${shardFileName}.mbti`);
        fileBytesByName.set(
            /** @type {string} */ (shardFileName),
            /** @type {Uint8Array} */ (shardBytes).slice(0, -1),
        );

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);

        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
        expect(Reflect.get(readerStore, '_invalidShardFileNames')).toContain(shardFileName);
        expect(Reflect.get(readerStore, '_shardStateByFileName').has(shardFileName)).toBe(false);
        expect(fileBytesByName.has(/** @type {string} */ (shardFileName))).toBe(false);
    });

    test('renames persistent index sidecars and preserves cold random lookup', async () => {
        const textEncoder = new TextEncoder();
        const fromName = 'JMdict [update-staging test]';
        const toName = 'JMdict';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);
        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);
        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: fromName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: ['食う', '飲む'].map((value) => textEncoder.encode(value)),
                readingBytesList: ['くう', 'のむ'].map((value) => textEncoder.encode(value)),
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([1, 2]),
                sequenceList: new Int32Array([10, 20]),
            },
            [0x100000000, 0x100000010],
            [16, 16],
            'raw',
        );
        await writerStore._closeAllWritables();

        await expect(writerStore.replaceDictionaryName(fromName, toName)).resolves.toBe(2);
        expect([...fileBytesByName.keys()].some((name) => name.includes(encodeURIComponent(fromName)))).toBe(false);
        expect([...fileBytesByName.keys()].some((name) => name.endsWith('.mbti'))).toBe(true);

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([toName]);
        const matchingId = readerStore.findTermIds(toName, '飲む', 'expression')[0] ?? -1;
        expect(Reflect.get(readerStore, '_recordsById').size).toBe(0);
        expect((await readerStore.getByIdsAsync([matchingId])).get(matchingId)).toMatchObject({
            dictionary: toName,
            expression: '飲む',
            entryContentOffset: 0x100000010,
        });
    });

    test('retains live imported strings through the owned preinterned buffer', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'JMdict';
        const expressionBytes = textEncoder.encode('暗記');
        const readingBytes = textEncoder.encode('あんき');
        const builder = createTermRecordPreinternedPlanBuilder(2);
        const expressionIndex = builder.internStringBytes(expressionBytes);
        const readingIndex = builder.internStringBytes(readingBytes);
        const plan = builder.buildPlan([expressionIndex], [readingIndex]);
        const fileBytesByName = new Map();
        const store = new TermRecordOpfsStore();
        Reflect.set(store, '_recordsDirectoryHandle', createFakeDirectoryHandle(fileBytesByName));

        await store.beginImportSession();
        await store.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1,
                rowCount: 1,
                expressionBytesList: [expressionBytes],
                readingBytesList: [readingBytes],
                readingEqualsExpressionList: new Uint8Array([0]),
                scoreList: new Int32Array([1]),
                sequenceList: new Int32Array([10]),
                termRecordPreinternedPlan: plan,
            },
            [0],
            [64],
            'raw',
        );
        expressionBytes.fill(0);
        readingBytes.fill(0);
        await store.endImportSession();

        const index = store.getDictionaryIndex(dictionaryName);
        const record = store.getById(index.expression.get('暗記')?.[0] ?? -1);
        expect(record).toMatchObject({expression: '暗記', reading: 'あんき'});
    });

    test('round-trips preinterned artifact chunk records through JS fallback', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Jitendex.org [2026-04-04]';
        const expression0 = textEncoder.encode('為る');
        const reading0 = textEncoder.encode('する');
        const expression1 = textEncoder.encode('食べる');
        const reading1 = textEncoder.encode('たべる');
        const stringsBuffer = new Uint8Array(expression0.byteLength + reading0.byteLength + expression1.byteLength + reading1.byteLength);
        let cursor = 0;
        for (const bytes of [expression0, reading0, expression1, reading1]) {
            stringsBuffer.set(bytes, cursor);
            cursor += bytes.byteLength;
        }
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);

        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                rowCount: 2,
                expressionBytesList: [expression0, expression1],
                readingBytesList: [reading0, reading1],
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([10, 20]),
                sequenceList: new Int32Array([100, 200]),
                termRecordPreinternedPlan: {
                    stringLengths: Uint16Array.from([expression0.byteLength, reading0.byteLength, expression1.byteLength, reading1.byteLength]),
                    stringsBuffer,
                    expressionIndexes: Uint32Array.from([0, 2]),
                    readingIndexes: Uint32Array.from([1, 3]),
                },
            },
            [16, 128],
            [64, 256],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);

        const index = readerStore.getDictionaryIndex(dictionaryName);
        const firstRecord = readerStore.getById(index.expression.get('為る')?.[0] ?? -1);
        const secondRecord = readerStore.getById(index.reading.get('たべる')?.[0] ?? -1);
        expect(firstRecord).toMatchObject({expression: '為る', reading: 'する', entryContentOffset: 16, entryContentLength: 64, score: 10, sequence: 100});
        expect(secondRecord).toMatchObject({expression: '食べる', reading: 'たべる', entryContentOffset: 128, entryContentLength: 256, score: 20, sequence: 200});
    });

    test('splits compact artifact indexes at 30K rows and remaps only referenced strings', async () => {
        const textEncoder = new TextEncoder();
        const textDecoder = new TextDecoder();
        const firstExpression = textEncoder.encode('共通語');
        const firstReading = textEncoder.encode('きょうつうご');
        const finalExpression = textEncoder.encode('終端語');
        const finalReading = textEncoder.encode('しゅうたんご');
        const stringBytes = [firstExpression, firstReading, finalExpression, finalReading];
        const stringsBuffer = new Uint8Array(stringBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0));
        const stringLengths = new Uint16Array(stringBytes.length);
        const stringOffsets = new Uint32Array(stringBytes.length);
        let stringCursor = 0;
        for (let i = 0; i < stringBytes.length; ++i) {
            stringOffsets[i] = stringCursor;
            stringLengths[i] = stringBytes[i].byteLength;
            stringsBuffer.set(stringBytes[i], stringCursor);
            stringCursor += stringBytes[i].byteLength;
        }

        const rowCount = 30_001;
        const expressionIndexes = new Uint32Array(rowCount);
        const readingIndexes = new Uint32Array(rowCount);
        readingIndexes.fill(1);
        expressionIndexes[rowCount - 1] = 2;
        readingIndexes[rowCount - 1] = 3;
        const expressionBytesList = new Array(rowCount).fill(firstExpression);
        const readingBytesList = new Array(rowCount).fill(firstReading);
        expressionBytesList[rowCount - 1] = finalExpression;
        readingBytesList[rowCount - 1] = finalReading;

        const store = new TermRecordOpfsStore();
        /** @type {Array<import('../ext/js/dictionary/term-record-wasm-encoder.js').PreinternedTermRecordPlan|null>} */
        const encodedPlans = [];
        /** @type {number[]} */
        const encodedRowCounts = [];
        vi.spyOn(store, '_encodeArtifactChunkRecords').mockImplementation(async (chunk, _offsets, _lengths, plan) => {
            encodedRowCounts.push(chunk.rowCount);
            encodedPlans.push(plan ?? null);
            return {
                bytes: new Uint8Array([1]),
                contentOffsetBase: 0,
                lookupIndexBytes: new Uint8Array([2]),
                fixedFieldsHashes: null,
                validationMs: 0,
                wasmEncodeMs: 0,
                lookupIndexEncodeMs: 0,
            };
        });
        vi.spyOn(store, '_appendEncodedChunk').mockResolvedValue();

        const shardState = /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({});
        await store._encodeAndAppendArtifactChunkForState(
            shardState,
            {
                dictionary: 'Compact split test',
                rowCount,
                expressionBytesList,
                readingBytesList,
                readingEqualsExpressionList: new Uint8Array(rowCount),
                scoreList: new Int32Array(rowCount),
                sequenceList: new Int32Array(rowCount),
                fixedContentOffsetBase: 0,
                fixedContentLength: 16,
            },
            1,
            new Uint32Array(0),
            new Uint32Array(0),
            {
                stringLengths,
                stringOffsets,
                stringsBuffer,
                expressionIndexes,
                readingIndexes,
            },
        );

        expect(store._encodeArtifactChunkRecords).toHaveBeenCalledTimes(2);
        expect(store._appendEncodedChunk).toHaveBeenCalledTimes(2);
        expect(encodedRowCounts).toStrictEqual([30_000, 1]);
        expect(encodedPlans.map((plan) => plan?.stringLengths.length)).toStrictEqual([2, 2]);
        const firstPlan = encodedPlans[0];
        const finalPlan = encodedPlans[1];
        if (firstPlan === null || typeof firstPlan === 'undefined' || finalPlan === null || typeof finalPlan === 'undefined') {
            throw new Error('Expected compact preinterned plans for both artifact runs');
        }
        /**
         * @param {import('../ext/js/dictionary/term-record-wasm-encoder.js').PreinternedTermRecordPlan} plan
         * @returns {string[]}
         */
        const decodePlanStrings = (plan) => {
            if (!(plan.stringOffsets instanceof Uint32Array)) {
                throw new Error('Expected compact plan string offsets');
            }
            const offsets = plan.stringOffsets;
            return [...plan.stringLengths].map((length, index) => {
                const offset = offsets[index];
                return textDecoder.decode(plan.stringsBuffer.subarray(offset, offset + length));
            });
        };
        expect(decodePlanStrings(firstPlan)).toStrictEqual(['共通語', 'きょうつうご']);
        expect(decodePlanStrings(finalPlan)).toStrictEqual(['終端語', 'しゅうたんご']);
        expect([...finalPlan.expressionIndexes]).toStrictEqual([0]);
        expect([...finalPlan.readingIndexes]).toStrictEqual([1]);
        const compactionRemap = Reflect.get(store, '_preinternedCompactionRemap');
        expect(compactionRemap).toBeInstanceOf(Uint32Array);
        expect([...compactionRemap]).toStrictEqual(new Array(stringLengths.length).fill(0));
        await store.endImportSession();
        expect(Reflect.get(store, '_preinternedCompactionRemap')).toHaveLength(0);
    });

    test('round-trips fixed-span preinterned artifact chunk records without content offset arrays', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'VNDB Characters by Bee';
        const expression0 = textEncoder.encode('春日野穹');
        const reading0 = textEncoder.encode('かすがのそら');
        const expression1 = textEncoder.encode('遠野美凪');
        const reading1 = textEncoder.encode('とおのみなぎ');
        const stringsBuffer = new Uint8Array(expression0.byteLength + reading0.byteLength + expression1.byteLength + reading1.byteLength);
        let cursor = 0;
        for (const bytes of [expression0, reading0, expression1, reading1]) {
            stringsBuffer.set(bytes, cursor);
            cursor += bytes.byteLength;
        }
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);

        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        Reflect.set(writerStore, '_wasmEncoderUnavailable', true);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: [expression0, expression1],
                readingBytesList: [reading0, reading1],
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([30, 40]),
                sequenceList: new Int32Array([300, 400]),
                fixedContentOffsetBase: 1024,
                fixedContentLength: 32,
                termRecordPreinternedPlan: {
                    stringLengths: Uint16Array.from([expression0.byteLength, reading0.byteLength, expression1.byteLength, reading1.byteLength]),
                    stringsBuffer,
                    expressionIndexes: Uint32Array.from([0, 2]),
                    readingIndexes: Uint32Array.from([1, 3]),
                },
            },
            new Uint32Array(0),
            new Uint32Array(0),
            RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME,
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);

        const index = readerStore.getDictionaryIndex(dictionaryName);
        const firstRecord = readerStore.getById(index.expression.get('春日野穹')?.[0] ?? -1);
        const secondRecord = readerStore.getById(index.reading.get('とおのみなぎ')?.[0] ?? -1);
        expect(firstRecord).toMatchObject({expression: '春日野穹', reading: 'かすがのそら', entryContentOffset: 1024, entryContentLength: 32, score: 30, sequence: 300});
        expect(secondRecord).toMatchObject({expression: '遠野美凪', reading: 'とおのみなぎ', entryContentOffset: 1056, entryContentLength: 32, score: 40, sequence: 400});
    });

    test('queries persistent suffix indexes without materializing Maps', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Jitendex.org [2026-04-04]';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);

        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);

        await writerStore.appendBatchFromArtifactChunkResolvedContent(
            {
                dictionary: dictionaryName,
                dictionaryTotalRows: 1_000_000,
                rowCount: 2,
                expressionBytesList: [textEncoder.encode('食う'), textEncoder.encode('食べる')],
                readingBytesList: [textEncoder.encode('くう'), textEncoder.encode('たべる')],
                readingEqualsExpressionList: new Uint8Array([0, 0]),
                scoreList: new Int32Array([0, 0]),
                sequenceList: new Int32Array([1, 2]),
            },
            [0, 128],
            [128, 256],
            'raw',
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(false);
        await readerStore.ensureDictionariesLoaded([dictionaryName]);

        expect(Reflect.get(readerStore, '_indexByDictionary').has(dictionaryName)).toBe(false);
        expect(readerStore.findTermPrefixIdMatches(dictionaryName, 'う', 'expression', true)).toEqual([
            {id: 1, exact: false},
        ]);
        expect(readerStore.findTermPrefixIdMatches(dictionaryName, 'る', 'expression', true)).toEqual([
            {id: 2, exact: false},
        ]);
        expect(readerStore.findTermPrefixIdMatches(dictionaryName, 'う', 'reading', true)).toEqual([
            {id: 1, exact: false},
        ]);
        expect(readerStore.findTermPrefixIdMatches(dictionaryName, 'る', 'reading', true)).toEqual([
            {id: 2, exact: false},
        ]);
        expect(Reflect.get(readerStore, '_indexByDictionary').has(dictionaryName)).toBe(false);
    });

    test('preserves distinct byte-backed import rows when placeholder strings are empty', async () => {
        const textEncoder = new TextEncoder();
        const dictionaryName = 'Jitendex.org [2026-04-04]';
        const fileBytesByName = new Map();
        const recordsDirectoryHandle = createFakeDirectoryHandle(fileBytesByName);

        const writerStore = new TermRecordOpfsStore();
        Reflect.set(writerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);

        await writerStore.appendBatchFromResolvedImportTermEntries(
            [
                {
                    dictionary: dictionaryName,
                    expression: '',
                    reading: '',
                    expressionBytes: textEncoder.encode('食う'),
                    readingBytes: textEncoder.encode('くう'),
                    readingEqualsExpression: false,
                    expressionReverse: null,
                    readingReverse: null,
                    score: 0,
                    sequence: 1,
                },
                {
                    dictionary: dictionaryName,
                    expression: '',
                    reading: '',
                    expressionBytes: textEncoder.encode('食べる'),
                    readingBytes: textEncoder.encode('たべる'),
                    readingEqualsExpression: false,
                    expressionReverse: null,
                    readingReverse: null,
                    score: 0,
                    sequence: 2,
                },
            ],
            0,
            2,
            [0, 128],
            [128, 256],
            ['raw', 'raw'],
        );
        await writerStore._closeAllWritables();

        const readerStore = new TermRecordOpfsStore();
        Reflect.set(readerStore, '_recordsDirectoryHandle', recordsDirectoryHandle);
        await readerStore._loadShardFiles(true);

        const index = readerStore.getDictionaryIndex(dictionaryName);
        expect(index.expression.get('食う')).toHaveLength(1);
        expect(index.expression.get('食べる')).toHaveLength(1);
        expect(index.reading.get('くう')).toHaveLength(1);
        expect(index.reading.get('たべる')).toHaveLength(1);

        const kuuRecord = readerStore.getById(index.expression.get('食う')?.[0] ?? -1);
        const taberuRecord = readerStore.getById(index.expression.get('食べる')?.[0] ?? -1);
        expect(kuuRecord?.expression).toBe('食う');
        expect(kuuRecord?.reading).toBe('くう');
        expect(taberuRecord?.expression).toBe('食べる');
        expect(taberuRecord?.reading).toBe('たべる');
    });
});
