/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {beforeEach, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {encodeRawTermContentSharedGlossaryBinary} from '../ext/js/dictionary/raw-term-content.js';
import {TermContentBlockStore, wrapCompressedTermContentBlock} from '../ext/js/dictionary/term-content-block-store.js';
import {TermContentIntegrityError, TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js';
import {decompressTermContentZstd} from '../ext/js/dictionary/zstd-term-content.js';

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    decompressTermContentZstd: vi.fn((/** @type {Uint8Array} */ bytes) => bytes.slice(9)),
    resolveTermContentZstdDictName: vi.fn(() => null),
    compressTermContentZstd: vi.fn(),
    compressWrappedTermContentZstdBatch: vi.fn(),
    compressWrappedTermContentZstdSpansBatch: vi.fn(),
    beginCompressWrappedTermContentZstdSpansBatch: vi.fn(),
}));

/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentReadContext} ReadContext */
/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentResolvedFrame} Frame */
/** @typedef {import('../ext/js/dictionary/term-content-block-store.js').TermContentFrameIdentity} Identity */

/**
 *
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function rawFrame(payload) {
    if (payload.byteLength > 255) { throw new RangeError('Fixture frame is too large'); }
    const bytes = new Uint8Array(9 + payload.byteLength);
    bytes.set([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.byteLength]);
    const header = (payload.byteLength << 3) | 1;
    bytes.set([header & 255, (header >>> 8) & 255, header >>> 16], 6);
    bytes.set(payload, 9);
    return bytes;
}

/**
 *
 * @param {Uint8Array} bytes
 * @param {number} [logicalOffset]
 * @returns {Identity}
 */
function legacyIdentity(bytes, logicalOffset = 0) {
    return {kind: 'legacy-entry',
        logicalOffset,
        recordLength: 4096,
        sourceStoredLength: bytes.byteLength,
        originalCodecId: null,
        expectedDecodedLength: null,
        originalEnvelope: 'none'};
}

/**
 *
 * @param {Uint8Array} bytes
 * @returns {Identity}
 */
function sharedIdentity(bytes) {
    return {kind: 'shared-glossary',
        logicalOffset: 0,
        recordLength: bytes.byteLength,
        sourceStoredLength: bytes.byteLength,
        originalCodecId: null,
        expectedDecodedLength: 3,
        originalEnvelope: 'none'};
}

/**
 * @param {(identity: Identity) => Promise<Frame|null>} resolve
 * @param {{identity?: Identity, current?: (identity: Identity, physicalKey: string) => Promise<boolean>}} [options]
 * @returns {{acquire: () => ReadContext, counts: {live: number}, readSlice: ReturnType<typeof vi.fn>}}
 */
function leasedContext(resolve, {identity, current} = {}) {
    const counts = {live: 0};
    const readSlice = vi.fn(async () => { throw new Error('Retired original frame was read'); });
    /** @returns {ReadContext} */
    const acquire = () => {
        ++counts.live;
        let released = false;
        return {
            rootKey: 'test-root',
            logicalHighWater: 10000,
            readSlice,
            readSlicesDetailed: async () => [],
            findFrameOverride: async () => identity ?? null,
            resolveFrame: resolve,
            fork: acquire,
            isCurrentFrame: current,
            release: () => {
                expect(released).toBe(false);
                released = true;
                --counts.live;
            },
        };
    };
    return {acquire, counts, readSlice};
}

/**
 *
 * @param {Uint8Array} bytes
 * @param {string} [physicalKey]
 * @returns {Frame}
 */
function replacement(bytes, physicalKey = 'test-root:replacement') {
    return {bytes: wrapCompressedTermContentBlock(bytes),
        codecId: 'manabitan-zstd-' + 'a'.repeat(64),
        envelope: 'mbc2',
        decodedLength: 3,
        physicalKey,
        release: vi.fn()};
}

beforeEach(() => { vi.mocked(decompressTermContentZstd).mockClear(); });

test.each(['scalar', 'batch', 'nullable'])('normalizes a legacy frame at EOF through the %s API', async (mode) => {
    const content = new Uint8Array([1, 2, 3]);
    const stored = rawFrame(content);
    const contentStore = new TermContentOpfsStore();
    await contentStore.appendBatch([stored]);
    const readSlice = vi.spyOn(contentStore, 'readSlice');
    const store = new TermContentBlockStore(contentStore);
    // The original record length is larger than the entire stored stream.
    const result = mode === 'batch' ?
        (await store.readDetailedBatch([{contentOffset: 0, contentLength: 4096, contentDictName: ''}]))[0] :
        (mode === 'nullable' ? {status: 'ok', bytes: await store.read(0, 4096, '')} : await store.readDetailed(0, 4096, ''));
    expect(result).toEqual({status: 'ok', bytes: content});
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
    expect(decompressTermContentZstd).toHaveBeenCalledWith(stored, null, {defaultHeapSize: 4096, maxOutputSize: 128 * 1024 * 1024});
    expect(readSlice.mock.calls.every(([offset, length]) => offset + length <= stored.byteLength)).toBe(true);
});

test('reads exactly one legacy frame without including following raw media', async () => {
    const content = new Uint8Array([4, 5, 6]);
    const stored = rawFrame(content);
    const contentStore = new TermContentOpfsStore();
    await contentStore.appendBatch([stored, new Uint8Array([9, 8, 7, 6])]);
    const store = new TermContentBlockStore(contentStore);
    expect(await store.read(0, 4096, 'jmdict')).toEqual(content);
    expect(vi.mocked(decompressTermContentZstd).mock.calls[0][0]).toEqual(stored);
    expect(vi.mocked(decompressTermContentZstd).mock.calls[0][1]).toBe('jmdict');
    expect(await store.read(stored.byteLength, 4, 'raw')).toEqual(new Uint8Array([9, 8, 7, 6]));
});

test.each(['scalar', 'batch'])('resolves a replaced legacy entry before reading retired source bytes through %s', async (mode) => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const identity = legacyIdentity(stored);
    const frame = replacement(stored);
    const resolve = vi.fn(async () => frame);
    const leased = leasedContext(resolve, {identity});
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(leased.acquire);
    vi.mocked(decompressTermContentZstd).mockImplementationOnce((bytes, codec) => {
        expect(leased.counts.live).toBeGreaterThan(0);
        expect(frame.release).not.toHaveBeenCalled();
        expect(codec).toBe(frame.codecId);
        return bytes.slice(9);
    });
    const request = {contentOffset: 0, contentLength: 4096, contentDictName: ''};
    const result = mode === 'batch' ? (await store.readDetailedBatch([request]))[0] : await store.readDetailed(0, 4096, '');
    expect(result).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(resolve).toHaveBeenCalledWith(identity);
    expect(leased.readSlice).not.toHaveBeenCalled();
    expect(frame.release).toHaveBeenCalledOnce();
    expect(leased.counts.live).toBe(0);
    // A compression-only root publication preserves healthy canonical bytes.
    const current = leasedContext(async () => { throw new Error('Healthy decoded cache was discarded'); });
    store.setReadContextProvider(current.acquire);
    expect(await store.read(0, 4096, '')).toEqual(new Uint8Array([1, 2, 3]));
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
});

test('routes a shared artifact through its actual codec while keeping raw-v4 entry headers raw', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const stored = rawFrame(content);
    const frame = replacement(stored);
    const leased = leasedContext(async () => frame);
    const contentStore = new TermContentOpfsStore();
    const header = encodeRawTermContentSharedGlossaryBinary('', '', '', 0, 3, new TextEncoder());
    const [{offset}] = await contentStore.appendBatch([header]);
    const store = new TermContentBlockStore(contentStore);
    expect(await store.read(offset, header.byteLength, 'raw-v4')).toEqual(header);
    expect(decompressTermContentZstd).not.toHaveBeenCalled();
    store.setReadContextProvider(leased.acquire);
    expect(await store.readDecodedFrameDetailed(sharedIdentity(stored))).toEqual({status: 'ok', bytes: content});
    expect(decompressTermContentZstd).toHaveBeenCalledWith(stored, frame.codecId, {defaultHeapSize: 3, maxOutputSize: 3, codecSource: 'immutable-layout'});
    expect(leased.readSlice).not.toHaveBeenCalled();
    expect(leased.counts.live).toBe(0);
});

test.each(['legacy-entry', 'shared-glossary'])('retries obsolete %s corruption against the actual current frame', async (kind) => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const identity = kind === 'legacy-entry' ? legacyIdentity(stored) : sharedIdentity(stored);
    const bad = replacement(new Uint8Array([0]));
    bad.bytes[12] ^= 1;
    const good = replacement(stored, 'new-root:replacement');
    const current = leasedContext(async () => good, {identity});
    const old = leasedContext(async () => bad, {identity, current: async () => false});
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    const provider = vi.fn().mockImplementationOnce(old.acquire).mockImplementation(current.acquire);
    store.setReadContextProvider(provider);
    const result = kind === 'legacy-entry' ? await store.readDetailed(0, 4096, '') : await store.readDecodedFrameDetailed(identity);
    expect(result).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(provider).toHaveBeenCalledTimes(2);
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
    expect(old.counts.live + current.counts.live).toBe(0);
    expect(bad.release).toHaveBeenCalledOnce();
    expect(good.release).toHaveBeenCalledOnce();
});

test.each(['legacy-entry', 'shared-glossary'])('keeps unchanged %s corruption authoritative', async (kind) => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const identity = kind === 'legacy-entry' ? legacyIdentity(stored) : sharedIdentity(stored);
    const bad = replacement(new Uint8Array([0]));
    bad.bytes[12] ^= 1;
    const leased = leasedContext(async () => bad, {identity, current: async () => true});
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    const provider = vi.fn(leased.acquire);
    store.setReadContextProvider(provider);
    const result = kind === 'legacy-entry' ? await store.readDetailed(0, 4096, '') : await store.readDecodedFrameDetailed(identity);
    expect(result.status).toBe('corrupt');
    expect(provider).toHaveBeenCalledOnce();
    expect(decompressTermContentZstd).not.toHaveBeenCalled();
    expect(leased.counts.live).toBe(0);
});

test('keeps dictionary resource failures transient and retries without poisoning canonical caches', async () => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const identity = legacyIdentity(stored);
    const leased = leasedContext(async () => replacement(stored), {identity});
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(leased.acquire);
    const unavailable = new Error('Dictionary registry unavailable');
    unavailable.name = 'ZstdDictionaryUnavailableError';
    vi.mocked(decompressTermContentZstd).mockImplementationOnce(() => { throw unavailable; });
    expect((await store.readDetailed(0, 4096, '')).status).toBe('temporarilyUnavailable');
    expect(await store.readDetailed(0, 4096, '')).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(decompressTermContentZstd).toHaveBeenCalledTimes(2);
    expect(leased.counts.live).toBe(0);
});

test('settles all legacy batch peers before releasing the leased request', async () => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const started = deferPromise();
    const gate = deferPromise();
    const first = legacyIdentity(stored);
    const second = legacyIdentity(stored, 100);
    const leased = leasedContext(async (identity) => {
        if (identity.logicalOffset === 0) { throw new TermContentIntegrityError('Broken legacy frame'); }
        started.resolve(void 0);
        await gate.promise;
        expect(leased.counts.live).toBeGreaterThanOrEqual(2);
        return replacement(stored);
    });
    const acquire = () => ({...leased.acquire(), findFrameOverride: async (/** @type {{logicalOffset: number}} */ query) => (query.logicalOffset === 0 ? first : second)});
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(acquire);
    let finished = false;
    const pending = store.readDetailedBatch([0, 100].map((contentOffset) => ({contentOffset, contentLength: 4096, contentDictName: ''})))
        .then((results) => { finished = true; return results; });
    await started.promise;
    expect(finished).toBe(false);
    expect(leased.counts.live).toBeGreaterThanOrEqual(2);
    gate.resolve(void 0);
    const results = await pending;
    expect(results[0].status).toBe('corrupt');
    expect(results[1]).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(leased.counts.live).toBe(0);
});

test('diagnostic and term-row consumers receive canonical legacy bytes with one decode', async () => {
    const content = {rules: 'v1', definitionTags: 'tag', termTags: 'term', glossary: ['definition']};
    const payload = new TextEncoder().encode(JSON.stringify(content));
    const db = new DictionaryDatabase();
    db._termContentBlockStore.setOnlineFrameResolver(async () => null);
    const [{offset}] = await db._termContentStore.appendBatch([rawFrame(payload)]);
    expect(await db.readTermEntryContentBytesForDiagnostics(offset, payload.byteLength, '')).toEqual(payload);
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
    db._termContentBlockStore.clearCache();
    vi.mocked(decompressTermContentZstd).mockClear();
    const entry = await db._deserializeTermRow({dictionary: 'legacy',
        entryContentOffset: offset,
        entryContentLength: payload.byteLength,
        entryContentDictName: '',
        expression: 'test',
        reading: 'test'});
    expect(entry).toMatchObject(content);
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
});

test.each(['scalar', 'batch'])('uncached legacy %s dedupe compares canonical bytes and signatures', async (mode) => {
    const content = new Uint8Array([1, 2, 3]);
    const db = new DictionaryDatabase();
    db._termContentBlockStore.setOnlineFrameResolver(async () => null);
    const [{offset}] = await db._termContentStore.appendBatch([rawFrame(content)]);
    const meta = {id: 7, offset, length: content.byteLength, dictName: ''};
    expect(db._getMatchingPersistedTermEntryContentMetaCandidates(1, 2, content, meta)).toEqual([meta]);
    const result = mode === 'scalar' ?
await db._findMatchingPersistedTermEntryContentMeta([meta], content) :
        (await db._findMatchingPersistedTermEntryContentMetaBatch([{hash1: 1, hash2: 2, contentBytes: content, primary: meta}]))[0].existingMeta;
    expect(result).toBe(meta);
    expect(meta).toMatchObject({signature1: 0x030201, signature2: 0x030201, signature3: 0x030201});
    expect(decompressTermContentZstd).toHaveBeenCalledOnce();
});

test('reports a truncated legacy frame as corrupt before decoding', async () => {
    const stored = rawFrame(new Uint8Array([1, 2, 3])).subarray(0, 11);
    const contentStore = new TermContentOpfsStore();
    await contentStore.appendBatch([stored]);
    const store = new TermContentBlockStore(contentStore);
    expect((await store.readDetailed(0, 4096, '')).status).toBe('corrupt');
    expect(decompressTermContentZstd).not.toHaveBeenCalled();
});

test('defers oversized legacy decoded admission without labeling intact storage corrupt', async () => {
    // A single-segment frame declaring 128 MiB + 1; no large fixture allocation.
    const contentStore = new TermContentOpfsStore();
    await contentStore.appendBatch([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 1, 0, 0, 8, 1, 0, 0])]);
    const store = new TermContentBlockStore(contentStore);
    expect(await store.readDetailed(0, 4096, '')).toEqual({status: 'temporarilyUnavailable',
        reason: 'Legacy term content frame exceeds decoded resource admission'});
    expect(decompressTermContentZstd).not.toHaveBeenCalled();
    expect(store.getDiagnostics()).toMatchObject({cacheEntries: 0, inFlightBlocks: 0});
});

test('rejects a decoded shared artifact length mismatch and leaves no cached value', async () => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const leased = leasedContext(async () => replacement(stored));
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(leased.acquire);
    vi.mocked(decompressTermContentZstd).mockReturnValueOnce(new Uint8Array([1, 2]));
    expect((await store.readDecodedFrameDetailed(sharedIdentity(stored))).status).toBe('corrupt');
    expect(store.getDiagnostics()).toMatchObject({cacheEntries: 0, inFlightBlocks: 0});
    expect(leased.counts.live).toBe(0);
});


test.each(['scalar', 'batch'])('legacy %s inspection retries a healthy override without reading a decoded-length physical range', async (mode) => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const identity = legacyIdentity(stored);
    const next = leasedContext(async () => replacement(stored), {identity});
    const old = leasedContext(async () => { throw new Error('Invalid original frame must not decode'); });
    let switched = false;
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(() => {
        if (switched) { return {...next.acquire(), rootKey: 'next-root'}; }
        return {...old.acquire(),
            rootKey: 'old-root',
            logicalHighWater: stored.byteLength,
            findFrameOverride: async () => null,
            readSlice: async (offset, length) => { switched = true; return new Uint8Array(length); },
            isCurrentRange: async () => { throw new Error('Removed original range must not be compared'); }};
    });
    const result = mode === 'scalar' ?
await store.readDetailed(0, 4096, '') :
        (await store.readDetailedBatch([{contentOffset: 0, contentLength: 4096, contentDictName: ''}]))[0];
    expect(result).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(old.counts.live).toBe(0);
    expect(next.counts.live).toBe(0);
});

test.each(['scalar', 'batch'])('legacy %s corruption stays authoritative after an unrelated append', async (mode) => {
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    const old = leasedContext(async () => null);
    const next = leasedContext(async () => null);
    /** @type {Array<{offset: number, length: number}>} */
    const ranges = [];
    let switched = false;
    store.setReadContextProvider(() => (switched ?
{...next.acquire(), rootKey: 'append-root'} :
        {...old.acquire(),
            rootKey: 'old-root',
            logicalHighWater: 12,
            findFrameOverride: async () => null,
            readSlice: async (offset, length) => { switched = true; return new Uint8Array(length); },
            isCurrentRange: async (offset, length) => { ranges.push({offset, length}); return true; }}));
    const result = mode === 'scalar' ?
await store.readDetailed(0, 4096, '') :
        (await store.readDetailedBatch([{contentOffset: 0, contentLength: 4096, contentDictName: ''}]))[0];
    expect(result.status).toBe('corrupt');
    expect(ranges).toHaveLength(1);
    expect(ranges.every(({offset, length}) => offset + length <= 12)).toBe(true);
    expect(decompressTermContentZstd).not.toHaveBeenCalled();
    expect(old.counts.live + next.counts.live).toBe(0);
});

test('legacy retry preserves current metadata unavailability after an old invalid header', async () => {
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    const old = leasedContext(async () => null);
    const next = leasedContext(async () => null);
    let switched = false;
    store.setReadContextProvider(() => (switched ?
{...next.acquire(),
    rootKey: 'next-root',
    findFrameOverride: async () => { throw new Error('Current metadata is unavailable'); }} :
        {...old.acquire(),
            rootKey: 'old-root',
            logicalHighWater: 12,
            findFrameOverride: async () => null,
            readSlice: async (offset, length) => { switched = true; return new Uint8Array(length); }}));
    expect(await store.readDetailed(0, 4096, '')).toEqual({status: 'temporarilyUnavailable', reason: 'Current metadata is unavailable'});
    expect(old.counts.live + next.counts.live).toBe(0);
});


test.each(['unrecognized-label', '任意の自作辞書'])('canonical legacy reads normalize stored label %s before immutable frame resolution', async (label) => {
    const stored = rawFrame(new Uint8Array([1, 2, 3]));
    const resolved = /** @type {Identity[]} */ ([]);
    const leased = leasedContext(async (identity) => {
        resolved.push(identity);
        return {bytes: stored,
            codecId: identity.originalCodecId,
            envelope: 'none',
            decodedLength: 3,
            physicalKey: 'root:original',
            release: () => {}};
    });
    const store = new TermContentBlockStore(new TermContentOpfsStore());
    store.setReadContextProvider(() => ({...leased.acquire(),
        logicalHighWater: stored.byteLength,
        findFrameOverride: async () => null,
        readSlice: async (offset, length) => stored.slice(offset, offset + length)}));
    expect(await store.readDetailed(0, 4096, label)).toEqual({status: 'ok', bytes: new Uint8Array([1, 2, 3])});
    expect(resolved[0].originalCodecId).toBeNull();
    expect(vi.mocked(decompressTermContentZstd).mock.calls[0][1]).toBeNull();
    expect(leased.counts.live).toBe(0);
});
