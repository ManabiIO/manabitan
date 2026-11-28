/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {beforeEach, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {encodeRawTermContentBlockReference} from '../ext/js/dictionary/raw-term-content.js';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentIntegrityError, TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {decompressTermContentZstd} from '../ext/js/dictionary/zstd-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    decompressTermContentZstd: vi.fn((/** @type {Uint8Array} */ bytes) => Uint8Array.from(bytes)),
    compressTermContentZstd: vi.fn(),
    compressWrappedTermContentZstdBatch: vi.fn(),
    compressWrappedTermContentZstdSpansBatch: vi.fn(),
    beginCompressWrappedTermContentZstdSpansBatch: vi.fn(),
}));

/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentReadContext} ReadContext */
/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentResolvedFrame} Frame */
/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentFrameIdentity} Identity */
let contextFactoryId = 0;

/**
 * @param {Map<number, Uint8Array>} references
 * @param {(identity: Identity) => Promise<Frame|null>} resolve
 * @param {{referenceGate?: Promise<unknown>, isCurrentFrame?: (identity: Identity, physicalKey: string) => Promise<boolean>, isCurrentFrameLayout?: (identity: Identity, layoutId: string) => Promise<boolean>, isCurrentRange?: (offset: number, length: number) => Promise<boolean>}} [options]
 * @returns {{acquire: () => ReadContext, counts: {live: number, acquired: number, forks: number, released: number}}}
 */
function contextFactory(references, resolve, {referenceGate, isCurrentFrame, isCurrentFrameLayout, isCurrentRange} = {}) {
    const counts = {live: 0, acquired: 0, forks: 0, released: 0};
    const rootKey = `test-root-${++contextFactoryId}`;
    /**
     * @returns {ReadContext}
     */
    const acquire = () => {
        ++counts.live;
        ++counts.acquired;
        let released = false;
        const assertOwned = () => {
            if (released) { throw new Error('Released context used'); }
        };
        /** @type {ReadContext} */
        const context = {
            rootKey,
            async readSlice(offset) {
                assertOwned();
                if (referenceGate) { await referenceGate; }
                assertOwned();
                return references.get(offset) ?? null;
            },
            async readSlicesDetailed(requests) {
                const settled = await Promise.allSettled(requests.map(({offset, length}) => context.readSlice(offset, length)));
                return settled.map((result) => {
                    if (result.status === 'rejected') { return {status: /** @type {const} */ ('error'), error: result.reason}; }
                    return result.value === null ?
                        {status: /** @type {const} */ ('unavailable')} :
                        {status: /** @type {const} */ ('ok'), bytes: result.value};
                });
            },
            async resolveFrame(identity) {
                assertOwned();
                const frame = await resolve(identity);
                assertOwned();
                return frame;
            },
            fork() {
                assertOwned();
                ++counts.forks;
                return acquire();
            },
            release() {
                expect(released).toBe(false);
                released = true;
                --counts.live;
                ++counts.released;
            },
            isCurrentFrame,
            isCurrentFrameLayout,
            isCurrentRange,
        };
        return context;
    };
    return {acquire, counts};
}

/**
 * @param {number} [offset]
 * @returns {Uint8Array}
 */
function reference(offset = 100) {
    return encodeRawTermContentBlockReference(offset, 15, 3, 0, 3);
}

/**
 * @param {string} key
 * @returns {Frame}
 */
function frame(key) {
    return {bytes: new Uint8Array([1, 2, 3]), codecId: null, envelope: 'none', decodedLength: 3, physicalKey: key, release: vi.fn()};
}

/**
 * @returns {TermContentBlockStore}
 */
function blockStore() {
    const contentStore = new TermContentOpfsStore();
    vi.spyOn(contentStore, 'readSlice').mockRejectedValue(new Error('Unleased fallback used'));
    vi.spyOn(contentStore, 'readSlicesDetailed').mockRejectedValue(new Error('Unleased batch fallback used'));
    return new TermContentBlockStore(contentStore);
}

beforeEach(() => { vi.mocked(decompressTermContentZstd).mockClear(); });

test.each(['physical', 'layout'])('retries obsolete %s corruption thrown before acquiring a resolved frame', async (kind) => {
    const store = blockStore();
    const current = contextFactory(new Map([[1, reference()]]), async () => frame('current:file'));
    const changedMock = vi.fn(async (/** @type {Identity} */ _identity, /** @type {string} */ _source) => {
        store.setReadContextProvider(current.acquire);
        return false;
    });
    const changed = /** @type {NonNullable<ReadContext['isCurrentFrame']>} */ (/** @type {unknown} */ (changedMock));
    const old = contextFactory(new Map([[1, reference()]]), async () => {
        const error = new TermContentIntegrityError('Obsolete source is damaged');
        Reflect.set(error, kind === 'physical' ? 'physicalKey' : 'layoutId', kind === 'physical' ? 'old:file' : 'old-layout');
        throw error;
    }, {isCurrentFrame: changed, isCurrentFrameLayout: changed});
    store.setReadContextProvider(old.acquire);
    expect(await store.readDetailed(1, 3, 'raw-block-v1')).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(changedMock).toHaveBeenCalledOnce();
    expect(old.counts.live + current.counts.live).toBe(0);
});

test('an unchanged failed physical source remains corrupt without reading a replacement payload', async () => {
    const fresh = vi.fn();
    const old = contextFactory(new Map([[1, reference()]]), async () => {
        const error = new TermContentIntegrityError('Same damaged physical frame');
        Reflect.set(error, 'physicalKey', 'old:file');
        throw error;
    }, {isCurrentFrame: async () => true});
    const store = blockStore();
    store.setReadContextProvider(old.acquire);
    const pending = store.readDetailed(1, 3, 'raw-block-v1');
    store.setReadContextProvider(fresh);
    expect(await pending).toMatchObject({status: 'corrupt', reason: 'Same damaged physical frame'});
    expect(fresh).not.toHaveBeenCalled();
    expect(old.counts.live).toBe(0);
});

test('a new root does not join an obsolete root transient pending loader', async () => {
    const started = deferPromise();
    const gate = deferPromise();
    const old = contextFactory(new Map([[1, reference()]]), async () => {
        started.resolve(void 0);
        await gate.promise;
        throw new Error('Old read failed transiently');
    });
    const current = contextFactory(new Map([[1, reference()]]), async () => frame('current:file'));
    const store = blockStore();
    store.setReadContextProvider(old.acquire);
    const pending = store.readDetailed(1, 3, 'raw-block-v1');
    await started.promise;
    store.setReadContextProvider(current.acquire);
    const fresh = store.readDetailed(1, 3, 'raw-block-v1');
    try {
        await vi.waitFor(() => expect(current.counts.forks).toBe(1));
        expect(await fresh).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    } finally { gate.resolve(void 0); }
    expect(await pending).toMatchObject({status: 'temporarilyUnavailable', reason: 'Old read failed transiently'});
    expect(old.counts.live + current.counts.live).toBe(0);
});

test.each(['scalar', 'batch'])('retries an obsolete corrupt reference before returning %s dictionary health', async (mode) => {
    const store = blockStore();
    const current = contextFactory(new Map([[1, reference()]]), async () => frame('current:file'));
    const old = contextFactory(new Map([[1, new Uint8Array(24)]]), async () => { throw new Error('Invalid reference reached decode'); }, {
        isCurrentRange: async () => {
            store.setReadContextProvider(current.acquire);
            return false;
        },
    });
    store.setReadContextProvider(old.acquire);
    const result = mode === 'scalar' ?
await store.readDetailed(1, 3, 'raw-block-v1') :
        (await store.readDetailedBatch([{contentOffset: 1, contentLength: 3, contentDictName: 'raw-block-v1'}]))[0];
    expect(result).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(old.counts).toEqual({live: 0, acquired: 1, forks: 0, released: 1});
    expect(current.counts.live).toBe(0);
});

test('keeps an unchanged corrupt reference authoritative after an unrelated root append', async () => {
    const current = vi.fn();
    const old = contextFactory(new Map([[1, new Uint8Array(24)]]), async () => null, {
        isCurrentRange: async () => true,
    });
    const store = blockStore();
    store.setReadContextProvider(old.acquire);
    const pending = store.readDetailed(1, 3, 'raw-block-v1');
    store.setReadContextProvider(current);
    expect(await pending).toMatchObject({status: 'corrupt', reason: 'Term content block reference is invalid'});
    expect(current).not.toHaveBeenCalled();
    expect(old.counts.live).toBe(0);
});

test('a transient current-root frame failure replaces obsolete reference corruption', async () => {
    const store = blockStore();
    const current = contextFactory(new Map([[1, reference()]]), async () => { throw new Error('Current OPFS read is temporarily unavailable'); });
    const old = contextFactory(new Map([[1, new Uint8Array(24)]]), async () => null, {
        isCurrentRange: async () => {
            store.setReadContextProvider(current.acquire);
            return false;
        },
    });
    store.setReadContextProvider(old.acquire);
    expect(await store.readDetailed(1, 3, 'raw-block-v1')).toMatchObject({
        status: 'temporarilyUnavailable', reason: 'Current OPFS read is temporarily unavailable',
    });
    expect(old.counts.live + current.counts.live).toBe(0);
});

test('one request context spans reference, frame acquisition and decode, even when the provider changes', async () => {
    const gate = deferPromise();
    const selected = frame('old:file');
    const factory = contextFactory(new Map([[1, reference()]]), async () => selected, {referenceGate: gate.promise});
    const replacement = contextFactory(new Map(), async () => { throw new Error('Wrong root'); });
    const store = blockStore();
    const provider = vi.fn(factory.acquire);
    store.setReadContextProvider(provider);
    vi.mocked(decompressTermContentZstd).mockImplementationOnce((bytes) => {
        expect(factory.counts.live).toBe(2);
        expect(selected.release).not.toHaveBeenCalled();
        return Uint8Array.from(bytes);
    });
    const pending = store.readDetailed(1, 3, 'raw-block-v1:jmdict');
    expect(provider).toHaveBeenCalledOnce();
    expect(factory.counts.live).toBe(1);
    store.setReadContextProvider(replacement.acquire);
    gate.resolve(void 0);
    expect(await pending).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(factory.counts).toEqual({live: 0, acquired: 2, forks: 1, released: 2});
    expect(replacement.counts.acquired).toBe(0);
    expect(selected.release).toHaveBeenCalledOnce();
    expect(vi.mocked(decompressTermContentZstd).mock.calls[0][1]).toBeNull();
});

test('concurrent requests share one loader with its own fork until all frame work settles', async () => {
    const started = deferPromise();
    const gate = deferPromise();
    const resolve = vi.fn(async () => {
        started.resolve(void 0);
        await gate.promise;
        return frame('shared:file');
    });
    const factory = contextFactory(new Map([[1, reference()]]), resolve);
    const store = blockStore();
    store.setReadContextProvider(factory.acquire);
    const first = store.readDetailed(1, 3, 'raw-block-v1');
    const second = store.readDetailed(1, 3, 'raw-block-v1');
    await started.promise;
    expect(factory.counts.live).toBe(3);
    expect(factory.counts.forks).toBe(1);
    gate.resolve(void 0);
    expect((await Promise.all([first, second])).map(({status}) => status)).toEqual(['ok', 'ok']);
    expect(resolve).toHaveBeenCalledOnce();
    expect(factory.counts.live).toBe(0);
    expect(factory.counts.released).toBe(3);
});

test('a failing batch peer does not release the request context while another frame is pending', async () => {
    const started = deferPromise();
    const gate = deferPromise();
    const factory = contextFactory(new Map([[1, reference(100)], [2, reference(200)]]), async (identity) => {
        if (identity.logicalOffset === 100) { throw new TermContentIntegrityError('Broken frame'); }
        started.resolve(void 0);
        await gate.promise;
        return frame('healthy:file');
    });
    const store = blockStore();
    store.setReadContextProvider(factory.acquire);
    let finished = false;
    const pending = store.readDetailedBatch([
        {contentOffset: 1, contentLength: 3, contentDictName: 'raw-block-v1'},
        {contentOffset: 2, contentLength: 3, contentDictName: 'raw-block-v1'},
    ]).then((value) => { finished = true; return value; });
    await started.promise;
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(factory.counts.live).toBeGreaterThanOrEqual(2);
    gate.resolve(void 0);
    const results = await pending;
    expect(results[0]).toMatchObject({status: 'corrupt', reason: 'Broken frame'});
    expect(results[1]).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(factory.counts.live).toBe(0);
    expect(factory.counts.forks).toBe(2);
});

test('healthy logical decoded cache survives a physical root publication', async () => {
    const old = contextFactory(new Map([[1, reference()]]), async () => frame('old:file'));
    const resolveNew = vi.fn(async () => { throw new Error('Healthy decoded cache was discarded'); });
    const current = contextFactory(new Map([[1, reference()]]), resolveNew);
    const store = blockStore();
    store.setReadContextProvider(old.acquire);
    expect((await store.readDetailed(1, 3, 'raw-block-v1')).status).toBe('ok');
    store.setReadContextProvider(current.acquire);
    expect((await store.readDetailed(1, 3, 'raw-block-v1')).status).toBe('ok');
    expect(resolveNew).not.toHaveBeenCalled();
    expect(current.counts).toEqual({live: 0, acquired: 1, forks: 0, released: 1});
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
});

test('old physical corruption retries once only after the physical identity actually changed', async () => {
    const selected = frame('old:broken');
    selected.envelope = 'mbc2';
    const isCurrent = vi.fn(async (/** @type {Identity} */ _identity, /** @type {string} */ physicalKey) => {
        expect(physicalKey).toBe('old:broken');
        return false;
    });
    const isCurrentFrame = /** @type {NonNullable<ReadContext['isCurrentFrame']>} */ (/** @type {unknown} */ (isCurrent));
    const old = contextFactory(new Map([[1, reference()]]), async () => selected, {isCurrentFrame});
    const current = contextFactory(new Map([[1, reference()]]), async () => frame('current:healthy'));
    const store = blockStore();
    const provider = vi.fn().mockImplementationOnce(old.acquire).mockImplementation(current.acquire);
    store.setReadContextProvider(provider);
    expect(await store.readDetailed(1, 3, 'raw-block-v1')).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(isCurrent).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(old.counts.live).toBe(0);
    expect(current.counts.live).toBe(0);
});

test('an unrelated root append retaining the same bad physical frame remains corruption', async () => {
    const selected = frame('same:broken');
    selected.envelope = 'mbc2';
    const factory = contextFactory(new Map([[1, reference()]]), async () => selected, {isCurrentFrame: async () => true});
    const store = blockStore();
    const provider = vi.fn(factory.acquire);
    store.setReadContextProvider(provider);
    expect((await store.readDetailed(1, 3, 'raw-block-v1')).status).toBe('corrupt');
    expect(provider).toHaveBeenCalledOnce();
    expect(factory.counts.live).toBe(0);
});

test('the current replacement transient failure keeps its own taxonomy after a stale corruption retry', async () => {
    const selected = frame('old:broken');
    selected.envelope = 'mbc2';
    const old = contextFactory(new Map([[1, reference()]]), async () => selected, {isCurrentFrame: async () => false});
    const current = contextFactory(new Map(), async () => { throw new Error('Dictionary registry temporarily unavailable'); });
    const store = blockStore();
    const provider = vi.fn().mockImplementationOnce(old.acquire).mockImplementation(current.acquire);
    store.setReadContextProvider(provider);
    expect(await store.readDetailed(1, 3, 'raw-block-v1')).toEqual({status: 'temporarilyUnavailable', reason: 'Dictionary registry temporarily unavailable'});
    expect(provider).toHaveBeenCalledTimes(2);
    expect(old.counts.live + current.counts.live).toBe(0);
});

test('raw scalar and batch reads use a single leased context without frame loaders', async () => {
    const resolve = vi.fn(async () => { throw new Error('Raw bytes unexpectedly resolved as a frame'); });
    const factory = contextFactory(new Map([[1, new Uint8Array([7])]]), resolve);
    const store = blockStore();
    store.setReadContextProvider(factory.acquire);
    expect(await store.readDetailed(1, 1, 'raw')).toEqual({status: 'ok', bytes: new Uint8Array([7])});
    expect(await store.readDetailedBatch([{contentOffset: 1, contentLength: 1, contentDictName: 'raw'}])).toEqual([{status: 'ok', bytes: new Uint8Array([7])}]);
    expect(factory.counts).toEqual({live: 0, acquired: 2, forks: 0, released: 2});
    expect(resolve).not.toHaveBeenCalled();
});

test('provider failures remain temporary and null providers preserve legacy reads', async () => {
    const store = blockStore();
    store.setReadContextProvider(() => { throw new Error('Lease admission unavailable'); });
    expect(await store.readDetailed(0, 1, 'raw')).toEqual({status: 'temporarilyUnavailable', reason: 'Lease admission unavailable'});
    store.setReadContextProvider(() => null);
    expect(await store.readDetailed(0, 1, 'raw')).toEqual({status: 'temporarilyUnavailable', reason: 'Unleased fallback used'});
});
