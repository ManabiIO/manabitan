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

import {describe, expect, test} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME} from '../ext/js/dictionary/raw-term-content.js';

/**
 * @param {Map<string, Uint8Array>} fileBytesByName
 * @param {{removeEntryFailures?: Map<string, number>}} [options]
 * @returns {FileSystemDirectoryHandle}
 */
function createFakeDirectoryHandle(fileBytesByName, {removeEntryFailures = new Map()} = {}) {
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        async getFileHandle(/** @type {string} */ name, {create} = {create: false}) {
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
                        async arrayBuffer() {
                            return bytes.slice().buffer;
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
                                bytes = new Uint8Array(value.slice(0));
                            } else if (ArrayBuffer.isView(value)) {
                                bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
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
    test('encodes and decodes raw-v4 entry content dict names without falling back to custom strings', () => {
        const store = new TermRecordOpfsStore();
        const {meta, bytes} = store._encodeEntryContentDictNameMeta(RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME);
        const decoded = store._decodeEntryContentDictName(meta, new Uint8Array(), 0, 0);

        expect(meta & 0xff).not.toBe(0xff);
        expect(bytes).toBeNull();
        expect(decoded).toBe(RAW_TERM_CONTENT_COMPRESSED_SHARED_GLOSSARY_DICT_NAME);
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
        expect(Array.from(fileBytesByName.get(newFileName) ?? [])).toStrictEqual([1, 2, 3, 4]);
        expect(shardStateByFileName.has(oldFileName)).toBe(false);
        expect(shardStateByFileName.has(newFileName)).toBe(true);
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
        expect(Array.from(fileBytesByName.get(oldFileName) ?? [])).toStrictEqual([9, 8, 7, 6]);
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
        indexByDictionary.set('JMdict [2026-02-26]', /** @type {any} */ (new Set([2])));
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

        await expect(store.replaceDictionaryName('JMdict staging', 'JMdict [2026-02-26]')).rejects.toThrow(/Target shard file already exists/);

        expect(recordsById.get(1)?.dictionary).toBe('JMdict staging');
        expect(Array.from(fileBytesByName.get(oldFileName) ?? [])).toStrictEqual([1, 2, 3, 4]);
        expect(Array.from(fileBytesByName.get(newFileName) ?? [])).toStrictEqual([5, 6, 7, 8]);
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
        expect(Array.from(fileBytesByName.get(newFileName) ?? [])).toStrictEqual([1, 2, 3, 4]);
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
        indexByDictionary.set('JMdict [cutover abc123]', {expression: new Map(), reading: new Map(), expressionReverse: new Map(), readingReverse: new Map(), pair: new Map(), sequence: new Map()});
        indexByDictionary.set('JMdict', {expression: new Map(), reading: new Map(), expressionReverse: new Map(), readingReverse: new Map(), pair: new Map(), sequence: new Map()});

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

    test('builds reverse suffix indexes lazily after exact artifact index load', async () => {
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
        expect(index.expressionReverse.size).toBe(0);
        expect(index.readingReverse.size).toBe(0);

        const reverseIndex = readerStore.ensureDictionaryReverseIndex(dictionaryName, index);
        expect(reverseIndex).toBe(index);
        expect(index.expressionReverse.get('う食')).toHaveLength(1);
        expect(index.expressionReverse.get('るべ食')).toHaveLength(1);
        expect(index.readingReverse.get('うく')).toHaveLength(1);
        expect(index.readingReverse.get('るべた')).toHaveLength(1);
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
