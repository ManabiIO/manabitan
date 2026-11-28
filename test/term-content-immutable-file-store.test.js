/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {TermContentImmutableFileStore} from '../ext/js/dictionary/term-content-immutable-file-store.js';

class MemoryFileHandle {
    constructor() { this.bytes = new Uint8Array(0); }
    async getFile() {
        const blob = new Blob([this.bytes]);
        return {size: blob.size, slice: blob.slice.bind(blob)};
    }

    async createWritable() {
        /** @type {Uint8Array[]} */
        const chunks = [];
        return {
            /** @param {Uint8Array} value */
            write: async (value) => { chunks.push(new Uint8Array(value)); },
            close: async () => {
                const joined = new Uint8Array(chunks.reduce((total, value) => total + value.byteLength, 0));
                let offset = 0;
                for (const value of chunks) {
                    joined.set(value, offset);
                    offset += value.byteLength;
                }
                this.bytes = joined;
            },
            abort: async () => { chunks.length = 0; },
        };
    }
}

class MemoryDirectoryHandle {
    constructor() { /** @type {Map<string, MemoryFileHandle>} */ this.files = new Map(); }
    /**
     * @param {string} name
     * @param {{create: boolean}} options
     * @returns {Promise<MemoryDirectoryHandle>}
     */
    async getDirectoryHandle(name, options) {
        const {create} = options;
        if (name !== 'manabitan-online-content-v1' || (create !== true && create !== false)) { throw new DOMException('Missing directory', 'NotFoundError'); }
        return this;
    }

    /**
     * @param {string} name
     * @param {{create: boolean}} options
     * @returns {Promise<MemoryFileHandle|undefined>}
     */
    async getFileHandle(name, options) {
        const {create} = options;
        if (!this.files.has(name)) {
            if (!create) { throw new DOMException('Missing file', 'NotFoundError'); }
            this.files.set(name, new MemoryFileHandle());
        }
        return this.files.get(name);
    }

    /** @param {string} name */
    async removeEntry(name) {
        if (!this.files.delete(name)) { throw new DOMException('Missing file', 'NotFoundError'); }
    }
}

afterEach(() => { vi.unstubAllGlobals(); });

test('writes and reads immutable OPFS files as bounded chunks with exact observed length', async () => {
    const directory = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}});
    const store = new TermContentImmutableFileStore();
    async function *chunks() {
        yield new Uint8Array([1, 2, 3]);
        yield new Uint8Array([4, 5]);
    }
    await expect(store.write('file-1', chunks(), {expectedByteLength: 5})).resolves.toBe(5);
    await expect(store.readSlice('file-1', 5, 1, 3)).resolves.toEqual(new Uint8Array([2, 3, 4]));
    const readback = [];
    for await (const chunk of store.readChunks('file-1', 5, 2)) { readback.push(...chunk); }
    expect(readback).toEqual([1, 2, 3, 4, 5]);
    await expect(store.readSlice('file-1', 4, 0, 1)).rejects.toThrow(/observed length changed/);
    await expect(store.readSlice('file-1', 5, 4, 2)).rejects.toThrow(RangeError);
    await expect(store.write('file-1', chunks(), {expectedByteLength: 5})).rejects.toThrow(/already contains bytes/);
    await store.remove('file-1');
    expect(directory.files.has('file-1.bin')).toBe(false);
});

test('rejects unsafe file identities, unbounded chunks and missing OPFS without fallback', async () => {
    const directory = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}});
    const store = new TermContentImmutableFileStore();
    await expect(store.readSlice('../escape', 1, 0, 1)).rejects.toThrow(/identity/);
    await expect(store.write('../escape', [], {expectedByteLength: 1})).rejects.toThrow(/identity/);
    expect(directory.files.size).toBe(0);
    await expect(store.readSlice('file', 1, 0, 4 * 1024 * 1024 + 1)).rejects.toThrow(RangeError);
    vi.stubGlobal('navigator', {});
    await expect(store.readSlice('file', 1, 0, 1)).rejects.toThrow(/Origin private file storage is unavailable/);
});

test('rejects a short physical range even when the file length is unchanged', async () => {
    const directory = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}});
    const store = new TermContentImmutableFileStore();
    await store.write('short-read', [new Uint8Array([1, 2, 3])], {expectedByteLength: 3});
    const handle = directory.files.get('short-read.bin');
    if (typeof handle === 'undefined') { throw new Error('Expected test file'); }
    vi.spyOn(handle, 'getFile').mockResolvedValue({
        size: 3,
        slice: () => ({arrayBuffer: async () => new Uint8Array([1, 2]).buffer}),
    });
    await expect(store.readSlice('short-read', 3, 0, 3)).rejects.toThrow(/short range/);
});

test('bounds individual writes while allowing larger streamed files', async () => {
    const directory = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}});
    const store = new TermContentImmutableFileStore();
    const chunkBytes = 4 * 1024 * 1024;
    await expect(store.write('oversized-chunk', [new Uint8Array(chunkBytes + 1)], {
        expectedByteLength: chunkBytes + 1,
    })).rejects.toThrow(/invalid or oversized chunk/);
    const oversized = directory.files.get('oversized-chunk.bin');
    expect(oversized?.bytes.byteLength).toBe(0);

    await expect(store.write('streamed-file', [new Uint8Array(chunkBytes), new Uint8Array([37])], {
        expectedByteLength: chunkBytes + 1,
    })).resolves.toBe(chunkBytes + 1);
    await expect(store.readSlice('streamed-file', chunkBytes + 1, chunkBytes, 1)).resolves.toEqual(new Uint8Array([37]));
});


test('observes without creation and preserves transient OPFS failures', async () => {
    const directory = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {storage: {getDirectory: async () => directory}});
    const store = new TermContentImmutableFileStore();
    expect(await store.observe('sample')).toBeNull();
    expect(directory.files.size).toBe(0);
    await store.write('sample', [new Uint8Array([1, 2])], {expectedByteLength: 2});
    expect(await store.observe('sample')).toBe(2);
    const error = new DOMException('Temporary access failure', 'UnknownError');
    vi.spyOn(directory, 'getFileHandle').mockRejectedValueOnce(error);
    await expect(store.observe('sample')).rejects.toBe(error);
    expect(directory.files.size).toBe(1);
    await expect(store.observe('../escape')).rejects.toThrow(/identity/);
});
