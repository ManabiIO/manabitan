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

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function createGate() {
    let resolve = () => {};
    /** @type {Promise<void>} */
    const promise = new Promise((accept) => {
        resolve = () => { accept(); };
    });
    return {promise, resolve};
}

/**
 * Controlled storage operations establish ordering and byte parity only.
 * This test double does not model OPFS latency or durability performance.
 * @param {{beforeOpen?: (name: string) => Promise<void>, failure?: (name: string, operation: string) => Error|null}} [options]
 * @returns {{files: Map<string, Uint8Array>, trace: string[], directory: FileSystemDirectoryHandle}}
 */
function createStorage({beforeOpen = async () => {}, failure = () => null} = {}) {
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {string[]} */
    const trace = [];
    /**
     * @param {string} name
     * @param {string} operation
     */
    const record = (name, operation) => {
        trace.push(`${name}:${operation}`);
        const error = failure(name, operation);
        if (error !== null) { throw error; }
    };
    /**
     * @param {string} name
     * @returns {import('../ext/js/dictionary/term-record-import-index-writer.js').SyncAccessHandle & {seek: (at: number) => void, abort: () => void}}
     */
    const createWriter = (name) => {
        let bytes = new Uint8Array(files.get(name) ?? []);
        let position = 0;
        return {
            /** @param {number} at */
            seek(at) { record(name, 'seek'); position = at; },
            /** @param {number} size */
            truncate(size) { record(name, 'truncate'); bytes = bytes.slice(0, size); },
            /**
             * @param {Uint8Array} value
             * @param {{at?: number}} [options]
             * @returns {number}
             */
            write(value, options = {}) {
                record(name, 'write');
                const at = options.at ?? position;
                const requiredLength = at + value.byteLength;
                if (bytes.byteLength < requiredLength) {
                    const expanded = new Uint8Array(requiredLength);
                    expanded.set(bytes);
                    bytes = expanded;
                }
                bytes.set(value, at);
                position = requiredLength;
                return value.byteLength;
            },
            flush() { record(name, 'flush'); },
            close() { record(name, 'close'); files.set(name, bytes); },
            abort() { record(name, 'abort'); },
        };
    };
    const directory = {
        async getFileHandle(/** @type {string} */ name, /** @type {{create?: boolean}} */ options = {}) {
            if (!files.has(name)) {
                if (options.create !== true) { throw new Error(`Missing test file: ${name}`); }
                files.set(name, new Uint8Array());
            }
            return {
                kind: 'file',
                name,
                async getFile() { return new Blob([files.get(name) ?? new Uint8Array()]); },
                async createWritable() {
                    record(name, 'open');
                    await beforeOpen(name);
                    const writer = createWriter(name);
                    return {
                        ...writer,
                        /** @param {FileSystemWriteChunkType} value */
                        async write(value) {
                            if (value instanceof Uint8Array) {
                                writer.write(value);
                            } else if (value instanceof Blob) {
                                writer.write(new Uint8Array(await value.arrayBuffer()));
                            } else {
                                throw new Error('Unsupported test write');
                            }
                        },
                    };
                },
                async createSyncAccessHandle() {
                    record(name, 'sync-open');
                    return createWriter(name);
                },
            };
        },
        /** @param {string} name */
        async removeEntry(name) { record(name, 'remove'); files.delete(name); },
        async *entries() {
            for (const name of files.keys()) { yield [name, await this.getFileHandle(name)]; }
        },
    };
    return {files, trace, directory: /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ (directory))};
}

/**
 * @param {FileSystemDirectoryHandle} directory
 * @param {string[]} [dictionaryNames]
 * @returns {Promise<TermRecordOpfsStore>}
 */
async function createImport(directory, dictionaryNames = ['Finalization']) {
    const store = new TermRecordOpfsStore();
    Reflect.set(store, '_recordsDirectoryHandle', directory);
    vi.spyOn(store, '_createShardGenerationId').mockImplementation(() => new Uint8Array(16).fill(7));
    await store.beginImportSession();
    for (const dictionary of dictionaryNames) {
        await store.appendBatch([
            {
                dictionary,
                expression: '一',
                reading: 'いち',
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: 100,
                entryContentLength: 11,
                entryContentDictName: 'raw',
                score: -7,
                sequence: 123,
            },
            {
                dictionary,
                expression: '二',
                reading: 'に',
                expressionReverse: null,
                readingReverse: null,
                entryContentOffset: 200,
                entryContentLength: 13,
                entryContentDictName: 'raw',
                score: 6543,
                sequence: null,
            },
        ]);
    }
    return store;
}

describe('term-record import finalization overlap', () => {
    test('finishes the index while descriptor opening is blocked and keeps the session active', async () => {
        const gate = createGate();
        const storage = createStorage({beforeOpen: async () => await gate.promise});
        const store = await createImport(storage.directory);
        const descriptor = store._getShardFileName('Finalization', 'raw');
        const index = `${descriptor}.mbti`;
        let settled = false;
        const ending = store.endImportSession().finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(storage.trace).toContain(`${index}:close`));
            expect(storage.trace).toContain(`${descriptor}:open`);
            expect(storage.trace).not.toContain(`${descriptor}:seek`);
            expect(storage.trace).not.toContain(`${descriptor}:write`);
            expect(settled).toBe(false);
            expect(store.getDiagnostics().importSessionActive).toBe(true);
        } finally {
            gate.resolve();
            await ending;
        }
        expect(storage.trace.slice(-3)).toEqual([`${descriptor}:seek`, `${descriptor}:write`, `${descriptor}:close`]);
        expect(store.getDiagnostics().importSessionActive).toBe(false);
        expect(storage.trace.filter((event) => event === `${index}:flush`)).toHaveLength(1);
        const metrics = store.getLastEndImportSessionMetrics();
        expect(metrics).toMatchObject({writeCallCount: 1, lookupIndexWriteCallCount: 1});
        expect(metrics?.closeWritableMs).toBeGreaterThanOrEqual(0);
    });

    test('preserves exact descriptor and index bytes from the sequential finalization order', async () => {
        const baseline = createStorage();
        const candidate = createStorage();
        const before = await createImport(baseline.directory);
        const after = await createImport(candidate.directory);
        await before._flushPendingWrites();
        await before._awaitQueuedWrites();
        await before._closeAllWritables();
        await after.endImportSession();
        expect(candidate.files).toEqual(baseline.files);
        const reader = new TermRecordOpfsStore();
        Reflect.set(reader, '_recordsDirectoryHandle', candidate.directory);
        await reader._loadShardFiles(true);
        expect(reader.findTermIds('Finalization', '一', 'expression')).toEqual([1]);
        expect(reader.findTermIds('Finalization', '二', 'expression')).toEqual([2]);
    });

    test('preserves sequential pending-write handling outside an active import', async () => {
        const gate = createGate();
        const storage = createStorage({beforeOpen: async () => await gate.promise});
        const store = await createImport(storage.directory);
        Reflect.set(store, '_importSessionActive', false);
        const descriptor = store._getShardFileName('Finalization', 'raw');
        const ending = store.endImportSession();
        try {
            await vi.waitFor(() => expect(storage.trace).toContain(`${descriptor}:open`));
            expect(storage.trace.some((event) => event.startsWith(`${descriptor}.mbti:`))).toBe(false);
        } finally {
            gate.resolve();
            await ending;
        }
        expect(storage.trace.indexOf(`${descriptor}.mbti:open`)).toBeGreaterThan(storage.trace.indexOf(`${descriptor}:write`));
        expect(new TextDecoder().decode(storage.files.get(`${descriptor}.mbti`)?.subarray(0, 8))).toBe('MBTIDX11');
    });

    test.each(['open', 'write'])('drains and rolls back both files after descriptor %s failure', async (operation) => {
        const error = new Error(`injected descriptor ${operation} failure`);
        const storage = createStorage({failure: (name, event) => (!name.endsWith('.mbti') && event === operation ? error : null)});
        const store = await createImport(storage.directory);
        const descriptor = store._getShardFileName('Finalization', 'raw');
        const index = `${descriptor}.mbti`;
        await expect(store.endImportSession()).rejects.toBe(error);
        expect(storage.trace).toContain(`${index}:flush`);
        expect(storage.trace).toContain(`${index}:close`);
        if (operation === 'write') { expect(storage.trace).toContain(`${descriptor}:close`); }
        await store.rollbackImportSession({shards: []});
        expect(storage.files.size).toBe(0);
        expect(store.getDiagnostics().importSessionActive).toBe(false);
    });

    test('does not reject a failed index flush before the descriptor owner settles', async () => {
        const gate = createGate();
        const error = new Error('injected index flush failure');
        const storage = createStorage({
            beforeOpen: async () => await gate.promise,
            failure: (name, operation) => (name.endsWith('.mbti') && operation === 'flush' ? error : null),
        });
        const store = await createImport(storage.directory);
        const descriptor = store._getShardFileName('Finalization', 'raw');
        let settled = false;
        const ending = store.endImportSession().finally(() => { settled = true; });
        void ending.catch(() => {});
        try {
            await vi.waitFor(() => expect(storage.trace).toContain(`${descriptor}.mbti:close`));
            expect(settled).toBe(false);
            expect(store.getDiagnostics().importSessionActive).toBe(true);
        } finally {
            gate.resolve();
        }
        await expect(ending).rejects.toBe(error);
        expect(storage.trace).toContain(`${descriptor}:close`);
    });

    test('aggregates independent descriptor-open and index-flush failures before rollback', async () => {
        const descriptorError = new Error('injected descriptor open failure');
        const indexError = new Error('injected index flush failure');
        const storage = createStorage({failure: (name, operation) => {
            if (name.endsWith('.mbti')) { return operation === 'flush' ? indexError : null; }
            return operation === 'open' ? descriptorError : null;
        }});
        const store = await createImport(storage.directory);
        await expect(store.endImportSession()).rejects.toMatchObject({
            name: 'AggregateError', errors: [descriptorError, indexError],
        });
        await store.rollbackImportSession({shards: []});
        expect(storage.files.size).toBe(0);
    });

    test('reports the same sticky descriptor error once when flush and drain both observe it', async () => {
        const storage = createStorage();
        const store = await createImport(storage.directory);
        const error = new Error('injected sticky descriptor error');
        const state = [...Reflect.get(store, '_shardStateByFileName').values()][0];
        state.queuedWriteError = error;
        await expect(store.endImportSession()).rejects.toBe(error);
        expect(storage.trace).toContain(`${state.fileName}:close`);
        expect(storage.trace).toContain(`${state.fileName}.mbti:close`);
    });

    test('keeps shard pairs sequential while joining both owners within each pair', async () => {
        const gate = createGate();
        const storage = createStorage({beforeOpen: async (name) => {
            if (name.includes('First')) { await gate.promise; }
        }});
        const store = await createImport(storage.directory, ['First', 'Second']);
        const first = store._getShardFileName('First', 'raw');
        const second = store._getShardFileName('Second', 'raw');
        const ending = store.endImportSession();
        try {
            await vi.waitFor(() => expect(storage.trace).toContain(`${first}.mbti:close`));
            expect(storage.trace.some((event) => event.startsWith(`${second}:`) || event.startsWith(`${second}.mbti:`))).toBe(false);
        } finally {
            gate.resolve();
            await ending;
        }
        expect(storage.trace.indexOf(`${second}:open`)).toBeGreaterThan(storage.trace.indexOf(`${first}:close`));
        expect(storage.trace).toContain(`${second}.mbti:flush`);
    });
});
