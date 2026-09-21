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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/**
 * @param {Map<string, Uint8Array>} fileBytesByName
 * @returns {FileSystemDirectoryHandle}
 */
function createMutableDirectory(fileBytesByName) {
    /**
     * @param {string} name
     * @param {{create?: boolean}} [options]
     * @returns {Promise<FileSystemFileHandle>}
     */
    const getFileHandle = async (name, options = {}) => {
        if (!fileBytesByName.has(name)) {
            if (options.create !== true) {
                const error = new Error(`File not found: ${name}`);
                error.name = 'NotFoundError';
                throw error;
            }
            fileBytesByName.set(name, new Uint8Array());
        }
        return /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
            kind: 'file',
            name,
            async getFile() {
                return new Blob([new Uint8Array(fileBytesByName.get(name) ?? new Uint8Array())]);
            },
            async createWritable() {
                let bytes = new Uint8Array(fileBytesByName.get(name) ?? new Uint8Array());
                return {
                    async truncate(/** @type {number} */ length) {
                        const next = new Uint8Array(length);
                        next.set(bytes.subarray(0, length));
                        bytes = next;
                    },
                    async close() {
                        fileBytesByName.set(name, bytes);
                    },
                    async abort() {},
                };
            },
        }));
    };
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle,
        async removeEntry(/** @type {string} */ name) {
            fileBytesByName.delete(name);
        },
        async *entries() {
            for (const name of fileBytesByName.keys()) {
                yield [name, await getFileHandle(name)];
            }
        },
    }));
}

/**
 * @param {Record<string, number>} sizes
 * @returns {FileSystemDirectoryHandle}
 */
function createSizedDirectory(sizes) {
    return /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        async *entries() {
            for (const [name, size] of Object.entries(sizes)) {
                yield [name, {
                    kind: 'file',
                    async getFile() { return {size} },;
                }];
            }
        },
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('import checkpoint storage integrity', () => {
    test('term-content rollback rejects foreign checkpoint files before abandoning writes', async () => {
        const fileName = 'manabitan-term-content.bin';
        const fileBytesByName = new Map([[fileName, new Uint8Array([1, 2, 3])]]);
        const root = createMutableDirectory(fileBytesByName);
        vi.stubGlobal('navigator', {storage: {getDirectory: vi.fn(async () => root)}});
        const store = new TermContentOpfsStore();
        await store.prepare();
        Reflect.set(store, '_importSessionActive', true);
        Reflect.set(store, '_pendingWriteBytes', 1);
        Reflect.set(store, '_pendingWriteChunks', [new Uint8Array([9])]);

        await expect(store.rollbackImportSession({
            segments: [{fileName: 'foreign.bin', fileLength: 3}],
        })).rejects.toThrow(/invalid checkpoint segment/);

        expect(Reflect.get(store, '_importSessionActive')).toBe(true);
        expect(Reflect.get(store, '_pendingWriteBytes')).toBe(1);
        expect(Reflect.get(store, '_pendingWriteChunks')).toStrictEqual([new Uint8Array([9])]);
        expect(fileBytesByName.get(fileName)).toStrictEqual(new Uint8Array([1, 2, 3]));
    });

    test('term-record rollback rejects foreign checkpoint files before abandoning writes', async () => {
        const store = new TermRecordOpfsStore();
        const recordName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const fileBytesByName = new Map([
            [recordName, new Uint8Array([1, 2, 3])],
            ['foreign.bin', new Uint8Array([4, 5, 6])],
        ]);
        Reflect.set(store, '_recordsDirectoryHandle', createMutableDirectory(fileBytesByName));
        Reflect.set(store, '_importSessionActive', true);

        await expect(store.rollbackImportSession({
            shards: [{fileName: 'foreign.bin', fileLength: 3}],
        })).rejects.toThrow(/Invalid term-record import checkpoint shard/);

        expect(Reflect.get(store, '_importSessionActive')).toBe(true);
        expect(fileBytesByName.get(recordName)).toStrictEqual(new Uint8Array([1, 2, 3]));
    });

    test('term-record rollback never manufactures missing committed bytes', async () => {
        const store = new TermRecordOpfsStore();
        const recordName = store._getShardSegmentFileName('JMdict', 'raw', 0);
        const fileBytesByName = new Map([[recordName, new Uint8Array([1, 2, 3])]]);
        Reflect.set(store, '_recordsDirectoryHandle', createMutableDirectory(fileBytesByName));

        await expect(store.rollbackImportSession({
            shards: [{fileName: recordName, fileLength: 5}],
        })).rejects.toThrow(/Failed to roll back term-record import storage/);

        expect(fileBytesByName.get(recordName)).toStrictEqual(new Uint8Array([1, 2, 3]));
    });

    test('term-record discovery rejects noncanonical segment aliases', async () => {
        const store = new TermRecordOpfsStore();
        const canonicalName = store._getShardSegmentFileName('JMdict', 'raw', 1);
        const noncanonicalName = canonicalName.replace('^1.mbtr', '^01.mbtr');
        const fileBytesByName = new Map([[noncanonicalName, new Uint8Array([1])]]);
        Reflect.set(store, '_recordsDirectoryHandle', createMutableDirectory(fileBytesByName));

        await expect(Reflect.get(store, '_loadShardFiles').call(store, false))
            .rejects.toThrow(/Invalid term-record storage file name/);
        expect(Reflect.get(store, '_shardStateByFileName').size).toBe(0);
    });
});
