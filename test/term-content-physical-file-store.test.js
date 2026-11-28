/* SPDX-License-Identifier: GPL-3.0-or-later */

import {afterEach, expect, test, vi} from 'vitest';
import {ContentPhysicalFileIntegrityError, parseContentPhysicalFile, TermContentPhysicalFileStore} from '../ext/js/dictionary/term-content-physical-file-store.js';

/** @typedef {{getDirectoryHandle: (name: string, options: {create: boolean}) => Promise<MockDirectory>, getFileHandle: (name: string, options: {create: boolean}) => Promise<{getFile: () => Promise<Blob>}>, removeEntry: (name: string) => Promise<void>}} MockDirectory */

/**
 * @param {string} target
 * @param {Uint8Array} [contents]
 * @returns {{store: TermContentPhysicalFileStore, calls: Array<{type: string, path: string, options?: {create: boolean}}>, getFile: import('vitest').Mock<() => Promise<Blob>>, getDirectory: import('vitest').Mock<() => Promise<MockDirectory>>, contents: Uint8Array}}
 */
function fixture(target, contents = new Uint8Array([3, 5, 7, 11])) {
    /** @type {Array<{type: string, path: string, options?: {create: boolean}}>} */
    const calls = [];
    const getFile = vi.fn(async () => new Blob([contents]));
    /**
     * @param {string[]} components
     * @returns {MockDirectory}
     */
    const directory = (components) => ({
        getDirectoryHandle: vi.fn(async (name, options) => {
            calls.push({type: 'directory', path: [...components, name].join('/'), options});
            if (options.create !== false) { throw new Error('Read adapter attempted directory creation'); }
            return directory([...components, name]);
        }),
        getFileHandle: vi.fn(async (name, options) => {
            calls.push({type: 'file', path: [...components, name].join('/'), options});
            if (options.create !== false || [...components, name].join('/') !== target) { throw new Error('Unexpected physical file'); }
            return {getFile};
        }),
        removeEntry: vi.fn(async (name) => {
            calls.push({type: 'remove', path: [...components, name].join('/')});
            if ([...components, name].join('/') !== target) { throw new Error('Unexpected removal'); }
        }),
    });
    const getDirectory = vi.fn(async () => directory([]));
    vi.stubGlobal('navigator', {storage: {getDirectory}});
    return {store: new TermContentPhysicalFileStore(), calls, getFile, getDirectory, contents};
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test.each([
    ['legacy-identity', 'manabitan-term-content.bin', 'legacy'],
    ['legacy-segment-3', 'manabitan-term-content^3.bin', 'legacy'],
    ['arena-file-7', 'manabitan-term-content-arenas-v1/import-1/manabitan-term-content^7.bin', 'arena'],
    ['pack-1', 'manabitan-online-content-v1/pack-1.bin', 'optimizer'],
])('reads %s using its actual catalog locator rather than fabricating a filename', async (fileId, path, kind) => {
    const f = fixture(path);
    const file = {fileId, path, byteLength: 4};
    expect(parseContentPhysicalFile(file).kind).toBe(kind);
    await expect(f.store.readSlice(file, 1, 2)).resolves.toEqual(new Uint8Array([5, 7]));
    expect(f.calls.at(-1)).toEqual({type: 'file', path, options: {create: false}});
    const collected = [];
    for await (const chunk of f.store.readChunks(file, 2)) { collected.push(...chunk); }
    expect(collected).toEqual([...f.contents]);
    await f.store.remove(file);
    expect(f.calls.at(-1)).toEqual({type: 'remove', path});
});

test.each([
    '../manabitan-term-content.bin',
    '/manabitan-term-content.bin',
    'manabitan-term-content^0.bin',
    'manabitan-term-content^01.bin',
    'manabitan-term-content^9007199254740992.bin',
    'manabitan/sqlite-sahpool-v1/dict.sqlite3',
    'manabitan-online-content-v1/other.bin',
    'manabitan-term-content-arenas-v1/../manabitan-term-content.bin',
    'manabitan-term-content-arenas-v1/a/nested/manabitan-term-content.bin',
    'manabitan-term-content-arenas-v1/a/foreign.bin',
])('rejects noncanonical or foreign path %s before storage access', async (path) => {
    const f = fixture(path);
    const file = {fileId: 'pack-1', path, byteLength: 4};
    await expect(f.store.readSlice(file, 0, 1)).rejects.toBeInstanceOf(TypeError);
    await expect(f.store.remove(file)).rejects.toBeInstanceOf(TypeError);
    expect(f.getDirectory).not.toHaveBeenCalled();
});

test('range and identifier validation happen before any OPFS access', async () => {
    const f = fixture('manabitan-term-content.bin');
    const file = {fileId: 'legacy-1', path: 'manabitan-term-content.bin', byteLength: 4};
    for (const [offset, length] of [[-1, 1], [0, 5], [4, 1], [0, 4194305], [Number.NaN, 1], [0.5, 1]]) {
        await expect(f.store.readSlice(file, offset, length)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(f.store.readSlice({...file, fileId: '../invalid'}, 0, 1)).rejects.toBeInstanceOf(TypeError);
    await expect(f.store.readSlice({...file, byteLength: 2 ** 40 + 1}, 0, 1)).rejects.toBeInstanceOf(TypeError);
    expect(f.getDirectory).not.toHaveBeenCalled();
});

test('confirmed physical loss retains the exact immutable identity for current-root fencing', async () => {
    const f = fixture('manabitan-term-content.bin');
    const file = {fileId: 'legacy-1', path: 'manabitan-term-content.bin', byteLength: 5};
    await expect(f.store.readSlice(file, 0, 1)).rejects.toMatchObject({
        name: 'ContentPhysicalFileIntegrityError', physicalFile: file,
    });
    f.getFile.mockResolvedValueOnce(/** @type {Blob} */ (/** @type {unknown} */ ({size: 5, slice: () => new Blob([new Uint8Array(0)])})));
    await expect(f.store.readSlice(file, 0, 1)).rejects.toBeInstanceOf(ContentPhysicalFileIntegrityError);
});

test('transient reads and absent OPFS remain unavailable without a storage fallback', async () => {
    const f = fixture('manabitan-term-content.bin');
    const file = {fileId: 'legacy-1', path: 'manabitan-term-content.bin', byteLength: 4};
    const transient = new Error('Temporary OPFS read failure');
    f.getFile.mockRejectedValueOnce(transient);
    await expect(f.store.readSlice(file, 0, 1)).rejects.toBe(transient);
    vi.stubGlobal('navigator', {});
    await expect(f.store.readSlice(file, 0, 1)).rejects.toThrow(/Origin private file storage is unavailable/);
});


test('coalesces adjacent and concurrent immutable reads without sharing mutable result bytes', async () => {
    const contents = new Uint8Array(131072);
    for (let index = 0; index < contents.length; ++index) { contents[index] = index % 251; }
    const f = fixture('manabitan-term-content.bin', contents);
    const slice = vi.fn((start, end) => new Blob([contents.subarray(start, end)]));
    f.getFile.mockResolvedValue(/** @type {Blob} */ (/** @type {unknown} */ ({size: contents.length, slice})));
    const file = {fileId: 'legacy-cache', path: 'manabitan-term-content.bin', byteLength: contents.length};
    const [first, adjacent, boundary] = await Promise.all([
        f.store.readSlice(file, 4, 8), f.store.readSlice(file, 12, 8), f.store.readSlice(file, 65530, 12),
    ]);
    expect(f.getFile).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenCalledTimes(2);
    expect(first).toEqual(contents.slice(4, 12));
    expect(adjacent).toEqual(contents.slice(12, 20));
    expect(boundary).toEqual(contents.slice(65530, 65542));
    first.fill(255);
    await expect(f.store.readSlice(file, 4, 8)).resolves.toEqual(contents.slice(4, 12));
    expect(slice).toHaveBeenCalledTimes(2);
});

test('failed page reads can retry without negative caching or reopening healthy immutable snapshots', async () => {
    const f = fixture('manabitan-term-content.bin');
    const transient = new Error('Temporary slice failure');
    const arrayBuffer = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue(new Uint8Array(f.contents).buffer);
    const slice = vi.fn(() => ({arrayBuffer}));
    f.getFile.mockResolvedValue(/** @type {Blob} */ (/** @type {unknown} */ ({size: 4, slice})));
    const file = {fileId: 'legacy-retry', path: 'manabitan-term-content.bin', byteLength: 4};
    await expect(f.store.readSlice(file, 0, 1)).rejects.toBe(transient);
    await expect(f.store.readSlice(file, 1, 2)).resolves.toEqual(new Uint8Array([5, 7]));
    expect(f.getFile).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenCalledTimes(2);
});

test('invalidation during a snapshot load prevents the old snapshot populating page caches', async () => {
    const f = fixture('manabitan-term-content.bin');
    /** @type {(value: Blob) => void} */
    let resolve = () => {};
    /** @type {Promise<Blob>} */
    const pending = new Promise((complete) => { resolve = complete; });
    f.getFile.mockReturnValueOnce(pending);
    const file = {fileId: 'legacy-fenced', path: 'manabitan-term-content.bin', byteLength: 4};
    const oldRead = f.store.readSlice(file, 0, 2);
    await vi.waitFor(() => { expect(f.getFile).toHaveBeenCalledTimes(1); });
    f.store.invalidate(file);
    resolve(new Blob([f.contents]));
    await expect(oldRead).resolves.toEqual(new Uint8Array([3, 5]));
    f.getFile.mockResolvedValue(new Blob([new Uint8Array([17, 19, 23, 29])]));
    await expect(f.store.readSlice(file, 0, 2)).resolves.toEqual(new Uint8Array([17, 19]));
    expect(f.getFile).toHaveBeenCalledTimes(2);
});

test('remove and full reset invalidate successful snapshots and pages', async () => {
    const f = fixture('manabitan-term-content.bin');
    const file = {fileId: 'legacy-reset', path: 'manabitan-term-content.bin', byteLength: 4};
    await f.store.readSlice(file, 0, 2);
    await f.store.remove(file);
    f.getFile.mockResolvedValue(new Blob([new Uint8Array([31, 37, 41, 43])]));
    await expect(f.store.readSlice(file, 0, 2)).resolves.toEqual(new Uint8Array([31, 37]));
    f.store.invalidate();
    await f.store.readSlice(file, 0, 2);
    expect(f.getFile).toHaveBeenCalledTimes(3);
});

test('zero length reads avoid OPFS and large reads retain the 4 MiB bound', async () => {
    const f = fixture('manabitan-term-content.bin');
    const file = {fileId: 'legacy-empty', path: 'manabitan-term-content.bin', byteLength: 4};
    await expect(f.store.readSlice(file, 4, 0)).resolves.toEqual(new Uint8Array(0));
    expect(f.getDirectory).not.toHaveBeenCalled();
});


test('snapshot and page eviction keep storage reads bounded by fixed cache capacities', async () => {
    const contents = new Uint8Array(129 * 65536);
    const f = fixture('manabitan-term-content.bin', contents);
    const slice = vi.fn((start, end) => new Blob([contents.subarray(start, end)]));
    f.getFile.mockResolvedValue(/** @type {Blob} */ (/** @type {unknown} */ ({size: contents.length, slice})));
    const file = {fileId: 'legacy-pages', path: 'manabitan-term-content.bin', byteLength: contents.length};
    for (let index = 0; index < 129; ++index) { await f.store.readSlice(file, index * 65536, 1); }
    await f.store.readSlice(file, 0, 1);
    expect(slice).toHaveBeenCalledTimes(130);
    expect(f.getFile).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 32; ++index) { await f.store.readSlice({...file, fileId: 'alias-' + index}, 0, 1); }
    await f.store.readSlice(file, 0, 1);
    expect(f.getFile).toHaveBeenCalledTimes(34);
});
