/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryImportJournal} from '../ext/js/dictionary/dictionary-import-journal.js';
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';

/** @returns {Error} */
function notFound() {
    const error = new Error('Not found');
    error.name = 'NotFoundError';
    return error;
}

/** Small OPFS model: writable bytes become visible only when close completes. */
class Directory {
    constructor() {
        /** @type {Map<string, Uint8Array|Directory>} */
        this.children = new Map();
        this.kind = 'directory';
    }

    /**
     * @param {string} name
     * @param {{create?: boolean}} [options]
     * @returns {Promise<Directory>}
     */
    async getDirectoryHandle(name, {create = false} = {}) {
        let entry = this.children.get(name);
        if (typeof entry === 'undefined' && create) {
            entry = new Directory();
            this.children.set(name, entry);
        }
        if (!(entry instanceof Directory)) { throw notFound(); }
        return entry;
    }

    /**
     * @param {string} name
     * @param {{create?: boolean}} [options]
     * @returns {Promise<object>}
     */
    async getFileHandle(name, {create = false} = {}) {
        if (!this.children.has(name)) {
            if (!create) { throw notFound(); }
            this.children.set(name, new Uint8Array());
        }
        const children = this.children;
        return {
            kind: 'file',
            name,
            async getFile() {
                const value = children.get(name);
                if (!(value instanceof Uint8Array)) { throw new TypeError('Expected file bytes'); }
                return new Blob([value]);
            },
            async createWritable({keepExistingData = false} = {}) {
                let bytes = keepExistingData ? new Uint8Array(/** @type {Uint8Array} */ (children.get(name))) : new Uint8Array();
                let cursor = 0;
                return {
                    async seek(/** @type {number} */ offset) { cursor = offset; },
                    async write(/** @type {Uint8Array|Blob|string} */ data) {
                        const next = typeof data === 'string' ? new TextEncoder().encode(data) : (data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
                        const output = new Uint8Array(Math.max(bytes.length, cursor + next.length));
                        output.set(bytes);
                        output.set(next, cursor);
                        bytes = output;
                        cursor += next.length;
                    },
                    async truncate(/** @type {number} */ length) { bytes = bytes.slice(0, length); },
                    async close() { children.set(name, bytes); },
                    async abort() {},
                };
            },
        };
    }

    /**
     * @param {string} name
     * @param {{recursive?: boolean}} [_options]
     */
    async removeEntry(name, _options = {}) { if (!this.children.delete(name)) { throw notFound(); } }

    /** @yields {[string, unknown]} */
    async *entries() {
        for (const [name, value] of this.children) {
            yield [name, value instanceof Directory ? value : await this.getFileHandle(name)];
        }
    }
}

/** @returns {{root: Directory, store: TermContentOpfsStore}} */
function setup() {
    const root = new Directory();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => root}});
    return {root, store: new TermContentOpfsStore()};
}

/**
 * @param {TermContentOpfsStore} store
 * @returns {Promise<import('dictionary-import-journal').TermContentArenaCheckpoint>}
 */
async function checkpoint(store) {
    const value = await store.createImportCheckpoint();
    if (value.version !== 2) { throw new Error('Expected v2 checkpoint'); }
    return /** @type {import('dictionary-import-journal').TermContentArenaCheckpoint} */ (value);
}

afterEach(() => { vi.unstubAllGlobals(); });

test('activation preserves actual cumulative legacy offsets and never re-inventories active storage', async () => {
    const {root, store} = setup();
    root.children.set('manabitan-term-content.bin', new Uint8Array([1, 2, 3]));
    root.children.set('manabitan-term-content^1.bin', new Uint8Array([4, 5]));
    const inventory = await store.inventoryLegacyFiles();
    expect(inventory.map(({logicalStart, logicalEnd}) => [logicalStart, logicalEnd])).toEqual([[0, 3], [3, 5]]);
    await store.activateCommittedRoot({storageEpoch: 1, logicalHighWater: 5});
    await expect(store.inventoryLegacyFiles()).rejects.toThrow('after immutable activation');
    await expect(store.appendBatch([new Uint8Array([9])])).rejects.toThrow('unsealed import arena');
    await expect(store.rollbackImportSession({segments: []})).rejects.toThrow('forbidden');
    await expect(store.reset()).rejects.toThrow('SQL-owned');
    expect(root.children.get('manabitan-term-content.bin')).toEqual(new Uint8Array([1, 2, 3]));
});

test('checkpoint precedes file creation, importer overlay is private, and partial tail seals before adoption', async () => {
    const {root, store} = setup();
    await store.activateCommittedRoot({storageEpoch: 7, logicalHighWater: 19});
    const saved = await checkpoint(store);
    expect(root.children.size).toBe(0);
    const journal = new DictionaryImportJournal();
    await journal.write({version: 2, sessionId: 'session', createdAt: 1, contentCheckpoint: saved, recordCheckpoint: {shards: []}});
    expect((await journal.read())?.contentCheckpoint).toEqual(saved);
    await store.beginImportSession(saved);
    expect(await store.appendBatch([new Uint8Array([4, 5, 6])])).toEqual([{offset: 19, length: 3}]);
    expect(await store.readSlice(19, 3)).toBeNull();
    expect(await store.readImportSlice(19, 3)).toEqual(new Uint8Array([4, 5, 6]));
    const sealed = await store.sealImportArena();
    expect(sealed.logicalHighWater).toBe(22);
    expect(sealed.files).toEqual([{fileId: saved.arenaNamespace + '-0', path: 'manabitan-term-content-arenas-v1/' + saved.arenaNamespace + '/manabitan-term-content.bin', byteLength: 3, logicalStart: 19, logicalEnd: 22}]);
    await expect(store.appendBatch([new Uint8Array([7])])).rejects.toThrow('unsealed');
    await store.adoptImportArena(saved, {storageEpoch: 8, logicalHighWater: 22});
    await expect(store.rollbackImportSession(saved)).rejects.toThrow('published');
    expect(await store.readImportSlice(19, 3)).toBeNull();
    expect(store.getLogicalLength()).toBe(22);
});

test('abort joins pending writes and removes only the exact unpublished namespace', async () => {
    const {root, store} = setup();
    root.children.set('manabitan-term-content.bin', new Uint8Array([1]));
    await store.activateCommittedRoot({storageEpoch: 2, logicalHighWater: 1});
    const saved = await checkpoint(store);
    await store.beginImportSession(saved);
    await store.appendBatch([new Uint8Array([2, 3])]);
    const arenas = await root.getDirectoryHandle('manabitan-term-content-arenas-v1');
    const other = await arenas.getDirectoryHandle('other', {create: true});
    other.children.set('precious', new Uint8Array([7]));
    await store.rollbackImportSession(saved);
    expect(arenas.children.has(saved.arenaNamespace)).toBe(false);
    expect(other.children.has('precious')).toBe(true);
    expect(root.children.get('manabitan-term-content.bin')).toEqual(new Uint8Array([1]));
    expect(store.getLogicalLength()).toBe(1);
});

test('recovery is idempotent and committed receipt adoption retains an arena after lost acknowledgement', async () => {
    const {root, store} = setup();
    await store.activateCommittedRoot({storageEpoch: 2, logicalHighWater: 0});
    const saved = await checkpoint(store);
    await store.beginImportSession(saved);
    await store.appendBatch([new Uint8Array([8])]);
    await store.sealImportArena();
    const recovered = new TermContentOpfsStore();
    await recovered.adoptImportArena(saved, {storageEpoch: 3, logicalHighWater: 1});
    await expect(recovered.rollbackImportSession(saved)).rejects.toThrow('published');
    const arenas = await root.getDirectoryHandle('manabitan-term-content-arenas-v1');
    expect(arenas.children.has(saved.arenaNamespace)).toBe(true);
    const abandoned = {...saved, arenaNamespace: 'absent-arena'};
    await recovered.rollbackImportSession(abandoned);
    await recovered.rollbackImportSession(abandoned);
    expect(recovered.getLogicalLength()).toBe(1);
});

test('zero-byte imports seal without adding a logical region and future imports use fresh namespaces', async () => {
    const {store} = setup();
    await store.activateCommittedRoot({storageEpoch: 4, logicalHighWater: 23});
    const saved = await checkpoint(store);
    await store.beginImportSession(saved);
    const sealed = await store.sealImportArena();
    expect(sealed.files).toEqual([]);
    expect(sealed.logicalHighWater).toBe(23);
    await store.adoptImportArena(saved, {storageEpoch: 4, logicalHighWater: 23});
    expect((await checkpoint(store)).arenaNamespace).not.toBe(saved.arenaNamespace);
});

test('malformed checkpoints and existing namespaces are rejected before opening a writer', async () => {
    const {root, store} = setup();
    await store.activateCommittedRoot({storageEpoch: 4, logicalHighWater: 3});
    const saved = await checkpoint(store);
    await expect(store.beginImportSession({...saved, arenaNamespace: '../bad'})).rejects.toThrow('Invalid');
    await expect(store.rollbackImportSession({...saved, arenaNamespace: '../bad'})).rejects.toThrow('Invalid');
    expect(root.children.size).toBe(0);
    const arenas = await root.getDirectoryHandle('manabitan-term-content-arenas-v1', {create: true});
    const existing = await arenas.getDirectoryHandle(saved.arenaNamespace, {create: true});
    existing.children.set('manabitan-term-content.bin', new Uint8Array([9]));
    await expect(store.beginImportSession(saved)).rejects.toThrow('already exists');
    expect(existing.children.get('manabitan-term-content.bin')).toEqual(new Uint8Array([9]));
});

test('journal validates v2 safe offsets and namespace while preserving v1 records', async () => {
    setup();
    const journal = new DictionaryImportJournal();
    const v1 = {version: /** @type {const} */ (1), sessionId: 'legacy', createdAt: 1, contentCheckpoint: {segments: [{fileName: 'manabitan-term-content.bin', fileLength: 3}]}, recordCheckpoint: {shards: []}};
    await journal.write(v1);
    expect(await journal.read()).toEqual(v1);
    const v2 = {...v1, version: /** @type {const} */ (2), contentCheckpoint: {version: /** @type {const} */ (2), storageEpoch: 1, logicalHighWater: 3, arenaNamespace: 'safe-arena', segments: /** @type {[]} */ ([])}};
    await journal.write(v2);
    expect(await journal.read()).toEqual(v2);
    await expect(journal.write({...v2, contentCheckpoint: {...v2.contentCheckpoint, logicalHighWater: Number.MAX_SAFE_INTEGER + 1}})).rejects.toThrow('Invalid');
    await expect(journal.write({...v2, contentCheckpoint: {...v2.contentCheckpoint, arenaNamespace: '../bad'}})).rejects.toThrow('Invalid');
});
