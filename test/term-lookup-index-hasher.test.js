/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from 'node:fs';
import {afterEach, describe, expect, test, vi} from 'vitest';
import * as hasherModule from '../ext/js/dictionary/term-lookup-index-hasher.js';
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js';
import {encodePersistedTermLookupIndex, splitPersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(new URL('../dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm', import.meta.url))));

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function patternedBytes(length) {
    return Uint8Array.from({length}, (_, i) => (i * 29 + (i >>> 7)) & 255);
}

/** @returns {Promise<hasherModule.ImportLookupIndexHasher>} */
async function createHasher() {
    const hasher = await hasherModule.createImportLookupIndexHasher(async () => module);
    if (hasher === null) { throw new Error('Native lookup hasher did not initialize'); }
    return hasher;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('native lookup-sidecar checksum', () => {
    test.each([0, 1, 3, 4, 15, 16, 17, 1023, 1024, 1025, 65519, 65520, 65521, 65535, 65536, 65537, 131071, 131072, 131073, 2097169])(
        'matches existing XXH32 for %i bytes and unaligned views', async (length) => {
            const hasher = await createHasher();
            const allocation = patternedBytes(length + 31);
            for (const offset of [0, 1, 3, 15]) {
                const bytes = allocation.subarray(offset, offset + length);
                expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
            }
        },
    );

    test('hashes current bytes on repeated calls and keeps instances independent', async () => {
        const first = await createHasher();
        const second = await createHasher();
        const bytes = patternedBytes(65537);
        const before = first.hash(bytes);
        bytes[0] ^= 1;
        bytes[65536] ^= 127;
        expect(second.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        expect(first.hash(bytes)).toBe(second.hash(bytes));
        expect(first.hash(bytes)).not.toBe(before);
    });

    test('matches every trailing-byte count above the native threshold', async () => {
        const hasher = await createHasher();
        const allocation = patternedBytes(1063);
        for (let tail = 0; tail < 32; ++tail) {
            const bytes = allocation.subarray(7, 7 + 1024 + tail);
            expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        }
    });

    test('retains JS behavior for small, shared, resizable and subclass views', async () => {
        const hasher = await createHasher();
        class DerivedBytes extends Uint8Array {}
        const shared = new Uint8Array(new SharedArrayBuffer(2048));
        const resizable = new Uint8Array(Reflect.construct(ArrayBuffer, [2048, {maxByteLength: 4096}]));
        const derived = new DerivedBytes(2048);
        const small = patternedBytes(1023);
        const copy = vi.spyOn(Uint8Array.prototype, 'set');
        for (const bytes of [shared, resizable, derived, small]) {
            expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        }
        expect(copy).not.toHaveBeenCalled();
        const malformed = patternedBytes(2048);
        Object.defineProperty(malformed, 'byteLength', {value: 4096});
        expect(() => hasher.hash(malformed)).toThrow();
        expect(copy).not.toHaveBeenCalled();
    });

    test('a copy failure recomputes with JS and disables the failed native instance', async () => {
        const hasher = await createHasher();
        const bytes = patternedBytes(65537);
        const expected = hashTermKeyBytes(bytes);
        const copy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementationOnce(() => { throw new Error('Copy failure witness'); });
        expect(hasher.hash(bytes)).toBe(expected);
        expect(hasher.hash(bytes)).toBe(expected);
        expect(copy).toHaveBeenCalledTimes(1);
    });

    test('uses intrinsic backing-store checks for forged and shadowed buffer properties', async () => {
        const hasher = await createHasher();
        const forged = new SharedArrayBuffer(2048);
        Object.setPrototypeOf(forged, ArrayBuffer.prototype);
        const sharedBytes = new Uint8Array(forged);
        const resizable = Reflect.construct(ArrayBuffer, [2048, {maxByteLength: 4096}]);
        Object.defineProperty(resizable, 'resizable', {value: false});
        const resizableBytes = new Uint8Array(resizable);
        const fixed = patternedBytes(2048);
        const getter = vi.fn(() => { throw new Error('Shadowed getter witness'); });
        Object.defineProperty(fixed.buffer, 'resizable', {get: getter});
        const copy = vi.spyOn(Uint8Array.prototype, 'set');
        expect(hasher.hash(sharedBytes)).toBe(hashTermKeyBytes(sharedBytes));
        expect(hasher.hash(resizableBytes)).toBe(hashTermKeyBytes(resizableBytes));
        expect(copy).not.toHaveBeenCalled();
        expect(hasher.hash(fixed)).toBe(hashTermKeyBytes(fixed));
        expect(copy).toHaveBeenCalledTimes(1);
        expect(getter).not.toHaveBeenCalled();
    });

    test('retains JS element semantics for forged typed-array prototypes and ignores shadowed tags', async () => {
        const hasher = await createHasher();
        const forgedViews = [
            Uint16Array.from({length: 513}, (_, i) => (i * 29 + 173) & 255),
            Int8Array.from({length: 1025}, (_, i) => (i * 29 + 173) & 255),
        ];
        const spoofedTag = vi.fn(() => 'Uint8Array');
        const copy = vi.spyOn(Uint8Array.prototype, 'set');
        for (const view of forgedViews) {
            Object.setPrototypeOf(view, Uint8Array.prototype);
            Object.defineProperty(view, Symbol.toStringTag, {get: spoofedTag});
            const bytes = /** @type {Uint8Array} */ (/** @type {unknown} */ (view));
            expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        }
        expect(copy).not.toHaveBeenCalled();
        expect(spoofedTag).not.toHaveBeenCalled();
        const bytes = patternedBytes(1025);
        const shadowedTag = vi.fn(() => { throw new Error('Shadowed typed-array tag witness'); });
        Object.defineProperty(bytes, Symbol.toStringTag, {get: shadowedTag});
        expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        expect(copy).toHaveBeenCalledTimes(1);
        expect(shadowedTag).not.toHaveBeenCalled();
    });

    test('a native trap recomputes with JS and retires that instance', async () => {
        const Instance = WebAssembly.Instance;
        const trap = vi.fn(() => { throw new WebAssembly.RuntimeError('Native trap witness'); });
        vi.spyOn(WebAssembly, 'Instance').mockImplementationOnce(function instantiate(loaded, imports) {
            const instance = new Instance(loaded, imports);
            return {exports: {...instance.exports, lookup_hash_update: trap}};
        });
        const hasher = await createHasher();
        const bytes = patternedBytes(65537);
        expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        expect(hasher.hash(bytes)).toBe(hashTermKeyBytes(bytes));
        expect(trap).toHaveBeenCalledTimes(1);
    });

    test('declines unavailable, rejected, incompatible and unallocatable native modules', async () => {
        await expect(hasherModule.createImportLookupIndexHasher(async () => { throw new Error('Unavailable'); })).resolves.toBeNull();
        const empty = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        await expect(hasherModule.createImportLookupIndexHasher(async () => empty)).resolves.toBeNull();
        vi.spyOn(WebAssembly, 'Memory').mockImplementationOnce(function failAllocation() { throw new Error('Allocation failure'); });
        await expect(hasherModule.createImportLookupIndexHasher(async () => module)).resolves.toBeNull();
        vi.stubGlobal('WebAssembly', void 0);
        const load = vi.fn(async () => module);
        await expect(hasherModule.createImportLookupIndexHasher(load)).resolves.toBeNull();
        expect(load).not.toHaveBeenCalled();
    });

    test('native ABI bounds scratch, stripes and totals and rejects scanner-owned memory', () => {
        const memory = new WebAssembly.Memory({initial: 3, maximum: 3});
        const native = /** @type {Record<string, (length: number) => number>} */ (new WebAssembly.Instance(module, {env: {memory}}).exports);
        expect(memory.buffer.byteLength).toBe(192 * 1024);
        expect(() => native.lookup_hash_finish(0)).toThrow(WebAssembly.RuntimeError);
        native.lookup_hash_begin(65537);
        expect(() => native.lookup_hash_update(65537)).toThrow(WebAssembly.RuntimeError);
        expect(() => native.lookup_hash_update(17)).toThrow(WebAssembly.RuntimeError);
        expect(() => native.lookup_hash_finish(65536)).toThrow(WebAssembly.RuntimeError);
        native.lookup_hash_begin(16);
        expect(() => native.lookup_hash_update(32)).toThrow(WebAssembly.RuntimeError);
        const arena = new WebAssembly.Memory({initial: 128, maximum: 128});
        const scanner = /** @type {Record<string, (length: number) => number>} */ (new WebAssembly.Instance(module, {env: {memory: arena}}).exports);
        expect(() => scanner.lookup_hash_begin(16)).toThrow(WebAssembly.RuntimeError);
        expect(new Uint8Array(arena.buffer).some((value) => value !== 0)).toBe(false);
    });
});

describe('import checksum ownership and envelope bytes', () => {
    test('native envelope hashes current payload and fields while retaining validation', async () => {
        const nativeStore = new TermRecordOpfsStore();
        const jsStore = new TermRecordOpfsStore();
        const hasher = await createHasher();
        Reflect.set(nativeStore, '_importLookupIndexHasher', hasher);
        const encoder = new TextEncoder();
        const count = 128;
        const payload = encodePersistedTermLookupIndex(Array.from({length: count}, (_, i) => ({
            expressionBytes: encoder.encode(`term-${i}`), readingBytes: null, sequence: null,
        })));
        const fields = new Uint8Array(count * 12);
        const before = nativeStore._createLookupIndexChunk(1, count, 0, payload, fields);
        expect(before).toEqual(jsStore._createLookupIndexChunk(1, count, 0, payload, fields));
        fields[8] = 7;
        const {base, derived} = splitPersistedTermLookupIndex(payload);
        base[base.byteLength - 1] ^= 1;
        derived[derived.byteLength - 1] ^= 1;
        const after = nativeStore._createLookupIndexChunk(1, count, 0, payload, fields);
        expect(after).toEqual(jsStore._createLookupIndexChunk(1, count, 0, payload, fields));
        expect(after).not.toEqual(before);
        expect(() => nativeStore._createLookupIndexChunk(1, count, 0, payload, fields.subarray(1))).toThrow('Invalid authoritative term-record fields');
    });

    test.each(['finish', 'failed finish', 'rollback', 'reset', 'failed prepare'])(
        'releases private hasher ownership after %s', async (ending) => {
            const hasher = {hash: hashTermKeyBytes};
            vi.spyOn(hasherModule, 'createImportLookupIndexHasher').mockResolvedValue(hasher);
            const store = new TermRecordOpfsStore();
            vi.spyOn(store, '_ensureRecordsDirectoryHandle').mockResolvedValue();
            await store.beginImportSession();
            await Reflect.get(store, '_importLookupIndexHasherPromise');
            expect(Reflect.get(store, '_importLookupIndexHasher')).toBe(hasher);
            switch (ending) {
                case 'finish': await store.endImportSession(); break;
                case 'failed finish':
                    vi.spyOn(store, '_flushPendingWrites').mockRejectedValueOnce(new Error('Flush witness'));
                    await expect(store.endImportSession()).rejects.toThrow('Flush witness');
                    break;
                case 'rollback': await store._abandonImportWritesForRollback(); break;
                case 'reset': await store.reset(); break;
                case 'failed prepare':
                    vi.spyOn(store, '_closeAllWritables').mockRejectedValueOnce(new Error('Prepare witness'));
                    await expect(store._prepare()).rejects.toThrow('Prepare witness');
                    break;
            }
            expect(Reflect.get(store, '_importLookupIndexHasher')).toBeNull();
            expect(Reflect.get(store, '_importLookupIndexHasherPromise')).toBeNull();
        },
    );

    test('initialization does not delay setup or publish into a later import', async () => {
        const stale = {hash: hashTermKeyBytes};
        const current = {hash: hashTermKeyBytes};
        /** @type {(hasher: hasherModule.ImportLookupIndexHasher) => void} */
        let complete = () => {};
        /** @type {Promise<hasherModule.ImportLookupIndexHasher|null>} */
        const pending = new Promise((resolve) => { complete = resolve; });
        vi.spyOn(hasherModule, 'createImportLookupIndexHasher')
            .mockReturnValueOnce(pending).mockResolvedValueOnce(current);
        const store = new TermRecordOpfsStore();
        await store.beginImportSession();
        expect(Reflect.get(store, '_importLookupIndexHasher')).toBeNull();
        await store.endImportSession();
        await store.beginImportSession();
        await Reflect.get(store, '_importLookupIndexHasherPromise');
        expect(Reflect.get(store, '_importLookupIndexHasher')).toBe(current);
        complete(stale);
        await pending;
        expect(Reflect.get(store, '_importLookupIndexHasher')).toBe(current);
        await store.endImportSession();
    });
});
