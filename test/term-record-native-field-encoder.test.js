/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import fs from 'node:fs/promises';
import {NativeRecordFieldEncoder} from '../ext/js/dictionary/term-record-field-encoder.js';
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js';
import {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';

/** @typedef {Parameters<TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']>[0]} ArtifactChunk */
/** @typedef {NonNullable<ArtifactChunk['resolvedContentReferences']>} ContentReferences */
/** @typedef {ArtifactChunk & {resolvedContentReferences: ContentReferences}} OwnedChunk */

const wasmModule = await WebAssembly.compile(new Uint8Array(await fs.readFile(new URL('../ext/lib/term-record-fields-v1.wasm', import.meta.url))));
/** @type {Set<NativeRecordFieldEncoder>} */
const controllers = new Set();
const contentBase = 2 ** 40;

/**
 * @param {number} [count=128]
 * @returns {OwnedChunk}
 */
function fixture(count = 128) {
    const expression = new TextEncoder().encode('辞書');
    const builder = createTermRecordPreinternedPlanBuilder(1);
    builder.internStringBytes(expression);
    const keys = new Uint32Array(count);
    const values = [-2147483648, -50000, -257, -256, 0, 255, 256, 50000, 2147483647];
    return createArtifactTermRecordChunkWithResolvedContent(
        {
            dictionary: 'Native record fields',
            rowCount: count,
            expressionBytesList: Array.from({length: count}, () => expression),
            readingBytesList: Array.from({length: count}, () => expression),
            readingEqualsExpressionList: new Uint8Array(count).fill(1),
            scoreList: Int32Array.from({length: count}, (_, index) => values[index % values.length]),
            sequenceList: new Int32Array(count).fill(-1),
            termRecordPreinternedPlan: builder.buildPlan(keys, keys),
        },
        Uint32Array.from({length: count}, (_, index) => index),
        Float64Array.from({length: count}, (_, index) => contentBase + index * 19),
        Uint32Array.from({length: count}, (_, index) => index % 31),
    );
}

/**
 * @param {() => Promise<WebAssembly.Module>} [loadModule]
 * @returns {NativeRecordFieldEncoder}
 */
function controller(loadModule = async () => wasmModule) {
    const result = new NativeRecordFieldEncoder({loadModule});
    controllers.add(result);
    return result;
}

/**
 * @param {boolean} native
 * @param {(() => void|Promise<void>)|null} [afterAppend=null]
 */
async function createStore(native, afterAppend = null) {
    const store = new TermRecordOpfsStore();
    const encoder = controller(native ? async () => wasmModule : async () => { throw new Error('JavaScript oracle'); });
    store._nativeRecordFieldEncoder = encoder;
    expect(await encoder.prepare()).toBe(native);
    // Observe only completed append bytes; admission, slicing, field encoding
    // and lookup encoding remain the production implementations.
    const append = vi.spyOn(store, '_appendEncodedChunk').mockImplementation(async () => { await afterAppend?.(); });
    return {store, encoder, append};
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 */
async function appendChunk(store, chunk) {
    await store._encodeAndAppendArtifactChunkForState(
        /** @type {Parameters<TermRecordOpfsStore['_encodeAndAppendArtifactChunkForState']>[0]} */ ({}),
        chunk,
        1,
        [],
        [],
        chunk.termRecordPreinternedPlan ?? null,
        'raw',
        chunk.preparedLookupIndexes ?? null,
    );
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {ArtifactChunk} chunk
 * @returns {Uint8Array}
 */
function fields(store, chunk) {
    return store._encodeArtifactRecordFields(chunk, [], [], contentBase);
}

afterEach(() => {
    for (const encoder of controllers) { encoder.release(); }
    controllers.clear();
    vi.restoreAllMocks();
});

describe('native compact record fields in the production store', () => {
    test('preserves complete field bytes and owned outputs while re-reading mutable columns', async () => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        chunk.resolvedContentReferences.offsets[2] = -1;
        chunk.resolvedContentReferences.lengths[3] = 65534;
        chunk.resolvedContentReferences.uniqueIndexList[4] = 3;
        const first = fields(candidate.store, chunk);
        const saved = first.slice();
        expect(first).toEqual(fields(baseline.store, chunk));
        expect(candidate.encoder.stats.successes).toBe(1);
        expect(first.buffer.byteLength).toBe(first.byteLength);

        chunk.scoreList.fill(-901);
        chunk.resolvedContentReferences.offsets.fill(contentBase + 2048);
        chunk.resolvedContentReferences.lengths.fill(42);
        const second = fields(candidate.store, chunk);
        expect(second).toEqual(fields(baseline.store, chunk));
        expect(second).not.toEqual(first);
        expect(second.buffer).not.toBe(first.buffer);
        expect(first).toEqual(saved);
        candidate.encoder.release();
        expect(candidate.encoder.stats.memoryBytes).toBe(0);
        expect(first).toEqual(saved);
    });

    test.each([65535, 65536, 0xffffffff])('keeps exact legacy fields for length %i', async (length) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        chunk.resolvedContentReferences.lengths[7] = length;
        const actual = fields(candidate.store, chunk);
        expect(actual).toEqual(fields(baseline.store, chunk));
        expect(actual.byteLength).toBe(chunk.rowCount * 12);
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test.each([64, 65534, 65535])('keeps exact high-cardinality fallback for %i distinct scores', async (count) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture(count);
        chunk.scoreList = Int32Array.from({length: count}, (_, index) => index - 32768);
        const actual = fields(candidate.store, chunk);
        expect(actual).toEqual(fields(baseline.store, chunk));
        expect(actual.byteLength).toBe(count * 12);
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test('preserves Float64 values including negative zero', async () => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        chunk.scoreList = Float64Array.from({length: chunk.rowCount}, (_, index) => index % 2 === 0 ? 1.5 : -0);
        const actual = fields(candidate.store, chunk);
        expect(actual).toEqual(fields(baseline.store, chunk));
        expect(actual.byteLength).toBe(chunk.rowCount * 16);
        const view = new DataView(actual.buffer);
        expect(view.getFloat64(8, true)).toBe(1.5);
        expect(Object.is(view.getFloat64(24, true), -0)).toBe(true);
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test('rejects oversized unused reference capacity before copying into bounded native memory', async () => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        chunk.resolvedContentReferences.offsets = new Float64Array(500000).fill(contentBase);
        chunk.resolvedContentReferences.lengths = new Uint32Array(500000).fill(20);
        expect(fields(candidate.store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(candidate.encoder.stats.successes).toBe(0);
        expect(candidate.encoder.stats.copiedInputBytes).toBe(0);
        expect(candidate.encoder.stats.memoryBytes).toBe(4 * 1024 * 1024);
    });

    test.each([false, true])('preserves invalid reference errors after legacy selection=%s', async (legacy) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        if (legacy) { chunk.resolvedContentReferences.lengths[0] = 65535; }
        chunk.resolvedContentReferences.uniqueIndexList[127] = 128;
        expect(() => fields(baseline.store, chunk)).toThrow('Invalid resolved term content reference index: 128');
        expect(() => fields(candidate.store, chunk)).toThrow('Invalid resolved term content reference index: 128');
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test('uses intrinsic view coordinates without observing a spoofed byteOffset getter', async () => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        const chunk = fixture();
        const scores = new Int32Array(new ArrayBuffer((chunk.rowCount + 8) * 4), 16, chunk.rowCount);
        scores.set(chunk.scoreList);
        const get = vi.fn(() => { throw new Error('Spoofed byteOffset was read'); });
        Object.defineProperty(scores, 'byteOffset', {get});
        chunk.scoreList = scores;
        expect(fields(candidate.store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(get).not.toHaveBeenCalled();
        expect(candidate.encoder.stats.successes).toBe(1);
    });

    test.each(['chunk-proxy', 'reference-proxy', 'score-proxy', 'score-accessor', 'offset-accessor'])('preserves observer counts and bytes for %s fallback', async (kind) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        /** @param {TermRecordOpfsStore} store */
        const encode = (store) => {
            let chunk = fixture();
            const reads = {get: 0, prototype: 0, descriptor: 0};
            /** @template {object} T @param {T} value @returns {T} */
            const proxy = (value) => new Proxy(value, {
                get(target, key) { ++reads.get; return Reflect.get(target, key, target); },
                getPrototypeOf(target) { ++reads.prototype; return Reflect.getPrototypeOf(target); },
                getOwnPropertyDescriptor(target, key) { ++reads.descriptor; return Reflect.getOwnPropertyDescriptor(target, key); },
            });
            if (kind === 'chunk-proxy') { chunk = proxy(chunk); }
            if (kind === 'reference-proxy') { chunk.resolvedContentReferences = proxy(chunk.resolvedContentReferences); }
            if (kind === 'score-proxy') { chunk.scoreList = proxy(chunk.scoreList); }
            if (kind === 'score-accessor') {
                const scores = chunk.scoreList;
                Object.defineProperty(chunk, 'scoreList', {get() { ++reads.get; return scores; }});
            }
            if (kind === 'offset-accessor') {
                const references = chunk.resolvedContentReferences;
                const offsets = references.offsets;
                Object.defineProperty(references, 'offsets', {get() { ++reads.get; return offsets; }});
            }
            return {bytes: fields(store, chunk), reads};
        };
        expect(encode(candidate.store)).toEqual(encode(baseline.store));
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test.each(['shared', 'subclass', 'foreign', 'fixed'])('preserves %s input fallback', async (kind) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        let chunk = fixture();
        if (kind === 'shared') {
            const scores = new Int32Array(new SharedArrayBuffer(chunk.rowCount * 4));
            scores.set(chunk.scoreList);
            chunk.scoreList = scores;
        }
        if (kind === 'subclass') {
            class Scores extends Int32Array {}
            chunk.scoreList = new Scores(chunk.scoreList);
        }
        if (kind === 'foreign') { chunk = {...chunk}; }
        if (kind === 'fixed') { Object.assign(chunk, {fixedContentOffsetBase: contentBase, fixedContentLength: 17}); }
        expect(fields(candidate.store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test.each(['buffer-accessor', 'constructor-instanceof', 'inherited-instanceof'])('preserves %s observations after the existing selector runs', async (kind) => {
        const baseline = await createStore(false);
        const candidate = await createStore(true);
        /** @param {TermRecordOpfsStore} store */
        const encode = (store) => {
            const chunk = fixture();
            let reads = 0;
            const target = kind === 'buffer-accessor' ? Int32Array.prototype :
                kind === 'constructor-instanceof' ? Int32Array : Object.getPrototypeOf(Int32Array);
            const property = kind === 'buffer-accessor' ? 'buffer' : Symbol.hasInstance;
            const previous = Object.getOwnPropertyDescriptor(target, property);
            expect(previous).toBeUndefined();
            if (kind === 'buffer-accessor') {
                const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Int32Array.prototype), 'buffer')?.get;
                expect(typeof getter).toBe('function');
                Object.defineProperty(target, property, {
                    configurable: true,
                    get() { ++reads; return getter?.call(this); },
                });
            } else {
                const original = Function.prototype[Symbol.hasInstance];
                Object.defineProperty(target, property, {
                    configurable: true,
                    /** @param {unknown} value */
                    value(value) { ++reads; return original.call(this, value); },
                });
            }
            try { return {bytes: fields(store, chunk), reads}; }
            finally { Reflect.deleteProperty(target, property); }
        };
        const expected = encode(baseline.store);
        expect(expected.reads).toBeGreaterThan(0);
        expect(encode(candidate.store)).toEqual(expected);
        expect(candidate.encoder.stats.successes).toBe(0);
    });

    test('preserves full record and lookup bytes across offset splits and post-await mutations', async () => {
        /** @param {boolean} native */
        const encode = async (native) => {
            const chunk = fixture();
            const references = chunk.resolvedContentReferences;
            references.uniqueIndexList.fill(0, 0, 64);
            references.uniqueIndexList.fill(1, 64);
            references.offsets[0] = contentBase;
            references.offsets[1] = contentBase + 0xffffffff;
            let appends = 0;
            const result = await createStore(native, async () => {
                if (++appends !== 1) { return; }
                await Promise.resolve();
                chunk.scoreList.fill(9999, 64);
                references.offsets[1] += 7;
                references.lengths[1] = 42;
            });
            await appendChunk(result.store, chunk);
            expect(result.append.mock.calls.map((args) => args[2])).toEqual([64, 64]);
            return result;
        };
        const baseline = await encode(false);
        const candidate = await encode(true);
        expect(candidate.append.mock.calls).toEqual(baseline.append.mock.calls);
        expect(candidate.encoder.stats.successes).toBe(2);
    });

    test.each(['offset', 'length', 'index', 'replacement'])('revalidates %s corruption after an awaited encoded split', async (kind) => {
        /** @param {boolean} native */
        const encode = async (native) => {
            const chunk = fixture();
            const references = chunk.resolvedContentReferences;
            references.uniqueIndexList.fill(0, 0, 64);
            references.uniqueIndexList.fill(1, 64);
            references.offsets[0] = contentBase;
            references.offsets[1] = contentBase + 0xffffffff;
            const result = await createStore(native, async () => {
                await Promise.resolve();
                if (kind === 'offset') { references.offsets[1] = Number.NaN; }
                if (kind === 'length') { references.lengths[1] = 0xffffffff; }
                if (kind === 'index') { references.uniqueIndexList[64] = references.offsets.length; }
                if (kind === 'replacement') {
                    const offsets = new Float64Array(references.offsets);
                    offsets[1] = Number.NaN;
                    chunk.resolvedContentReferences = {...references, offsets};
                }
            });
            await expect(appendChunk(result.store, chunk)).rejects.toThrow(/Invalid (term content|resolved term content reference)/);
            expect(result.append).toHaveBeenCalledTimes(1);
            return result;
        };
        const baseline = await encode(false);
        const candidate = await encode(true);
        expect(candidate.append.mock.calls).toEqual(baseline.append.mock.calls);
        expect(candidate.encoder.stats.successes).toBe(1);
    });
});

describe('native record encoder availability and import lifetime', () => {
    test('coalesces preparation and refuses adoption after release during loading', async () => {
        /** @type {(value: WebAssembly.Module) => void} */
        let finish = () => {};
        /** @type {Promise<WebAssembly.Module>} */
        const pending = new Promise((resolve) => { finish = resolve; });
        const load = vi.fn(async () => await pending);
        const encoder = controller(load);
        const first = encoder.prepare();
        const second = encoder.prepare();
        await Promise.resolve();
        expect(load).toHaveBeenCalledTimes(1);
        encoder.release();
        finish(wasmModule);
        expect(await first).toBe(false);
        expect(await second).toBe(false);
        expect(encoder.stats.memoryBytes).toBe(0);
        expect(await encoder.prepare()).toBe(true);
        expect(load).toHaveBeenCalledTimes(2);
        expect(encoder.stats.memoryBytes).toBe(4 * 1024 * 1024);
    });

    test('keeps imports working after module failure and retries only after a new session', async () => {
        const store = new TermRecordOpfsStore();
        const load = vi.fn().mockRejectedValueOnce(new Error('Unavailable WASM asset')).mockResolvedValue(wasmModule);
        const encoder = controller(load);
        store._nativeRecordFieldEncoder = encoder;
        const baseline = await createStore(false);
        const chunk = fixture();
        await store.beginImportSession();
        expect(encoder.stats.memoryBytes).toBe(0);
        expect(fields(store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(encoder.stats.successes).toBe(0);
        await store.beginImportSession();
        expect(load).toHaveBeenCalledTimes(1);
        await store.endImportSession();
        await store.beginImportSession();
        expect(load).toHaveBeenCalledTimes(2);
        expect(fields(store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(encoder.stats.successes).toBe(1);
        await store.endImportSession();
        expect(encoder.stats.memoryBytes).toBe(0);
    });

    test('rejects an incompatible WASM module and preserves JS field bytes', async () => {
        const empty = await WebAssembly.compile(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
        const store = new TermRecordOpfsStore();
        const encoder = controller(async () => empty);
        store._nativeRecordFieldEncoder = encoder;
        expect(await encoder.prepare()).toBe(false);
        expect(encoder.stats.memoryBytes).toBe(0);
        const baseline = await createStore(false);
        const chunk = fixture();
        expect(fields(store, chunk)).toEqual(fields(baseline.store, chunk));
        expect(encoder.stats.successes).toBe(0);
    });

    test.each(['end', 'rollback', 'prepare'])('releases native memory at the %s lifecycle boundary', async (boundary) => {
        const {store, encoder} = await createStore(true);
        const chunk = fixture();
        const output = fields(store, chunk);
        const saved = output.slice();
        expect(encoder.stats.memoryBytes).toBe(4 * 1024 * 1024);
        if (boundary === 'end') { await store.endImportSession(); }
        if (boundary === 'rollback') { await store._abandonImportWritesForRollback(); }
        if (boundary === 'prepare') { await store.prepare(); }
        expect(encoder.stats.memoryBytes).toBe(0);
        expect(output).toEqual(saved);
    });

    test('releases native memory even if end-import fails', async () => {
        const {store, encoder} = await createStore(true);
        vi.spyOn(store, '_endImportSession').mockRejectedValue(new Error('Injected flush failure'));
        await expect(store.endImportSession()).rejects.toThrow('Injected flush failure');
        expect(encoder.stats.memoryBytes).toBe(0);
    });
});
