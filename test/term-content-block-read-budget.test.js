/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {test} from 'vitest';
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js';
import {encodeRawTermContentCompactBlockReference} from '../ext/js/dictionary/raw-term-content.js';

/** @typedef {{id: number, size: number, start?: number, length?: number}} Spec */
/** @typedef {NonNullable<ConstructorParameters<typeof TermContentBlockStore>[1]>} Options */

/**
 * Exercise the production reference reader, grouping, load scheduler and result
 * ownership. Only storage/decoded-block delivery is controlled. Actual codec
 * integrity remains covered by term-content-block-store.test.js.
 * @param {Spec[]} specs
 * @param {Options} [options]
 * @param {boolean} [manual]
 * @returns {{
 *   store: TermContentBlockStore,
 *   requests: Array<{contentOffset: number, contentLength: number, contentDictName: string}>,
 *   references: Uint8Array[],
 *   metrics: {active: number, bytes: number, peakActive: number, peakBytes: number},
 *   calls: Map<number, number>, blocks: Map<number, Uint8Array>, failures: Map<number, Error>,
 *   unavailable: Set<number>, release: () => void,
 * }}
 */
function fixture(specs, options = {}, manual = false) {
    const references = specs.map(({id, size, start = 0}) => encodeRawTermContentCompactBlockReference(100_000 + id * 100, 20, size, start));
    const requests = specs.map(({length = 1}, i) => ({contentOffset: i * 20, contentLength: length, contentDictName: 'raw-block-v2'}));
    const source = {
        async readSlice(/** @type {number} */ offset) { return references[offset / 20]; },
        async readSlicesDetailed(/** @type {{offset: number}[]} */ spans) {
            return spans.map(({offset}) => ({status: /** @type {const} */ ('ok'), bytes: references[offset / 20]}));
        },
    };
    const store = new TermContentBlockStore(
        /** @type {import('../ext/js/dictionary/term-content-opfs-store.js').TermContentOpfsStore} */ (/** @type {unknown} */ (source)),
        options,
    );
    const metrics = {active: 0, bytes: 0, peakActive: 0, peakBytes: 0};
    /** @type {Map<number, number>} */
    const calls = new Map();
    /** @type {Map<number, Uint8Array>} */
    const blocks = new Map();
    /** @type {Map<number, Error>} */
    const failures = new Map();
    /** @type {Set<number>} */
    const unavailable = new Set();
    /** @type {Array<() => void>} */
    const gates = [];
    store._loadBlock = async (key, reference) => {
        const generation = store._cacheGeneration;
        const id = (reference.blockOffset - 100_000) / 100;
        calls.set(id, (calls.get(id) ?? 0) + 1);
        ++metrics.active;
        metrics.bytes += reference.blockUncompressedLength;
        metrics.peakActive = Math.max(metrics.peakActive, metrics.active);
        metrics.peakBytes = Math.max(metrics.peakBytes, metrics.bytes);
        try {
            await (manual ?
                new Promise((resolve) => { gates.push(() => resolve(void 0)); }) :
                nextTurn());
            store._assertReadGeneration(generation);
            if (failures.has(id)) { throw failures.get(id); }
            if (unavailable.has(id)) { return null; }
            const bytes = Uint8Array.from({length: reference.blockUncompressedLength}, (_, i) => (id + i) % 251);
            blocks.set(id, bytes);
            store._cache.set(key, bytes);
            return bytes;
        } finally {
            --metrics.active;
            metrics.bytes -= reference.blockUncompressedLength;
        }
    };
    const release = () => {
        for (const resolve of gates.splice(0)) { resolve(); }
    };
    return {store, requests, references, metrics, calls, blocks, failures, unavailable, release};
}

/**
 * @param {Awaited<ReturnType<TermContentBlockStore['readDetailedBatch']>>} results
 * @returns {Set<ArrayBufferLike>}
 */
function buffers(results) {
    return new Set(results.map((result) => {
        assert.equal(result.status, 'ok');
        return result.bytes.buffer;
    }));
}

/** @param {TermContentBlockStore} store */
function assertIdle(store) {
    const diagnostics = store.getDiagnostics();
    assert.equal(diagnostics.inFlightBlocks, 0);
    assert.equal(diagnostics.activeBlockReads, 0);
    assert.equal(diagnostics.activeBlockReadBytes, 0);
    assert.equal(diagnostics.pendingBlockReads, 0);
}

/**
 * @param {number} count
 * @param {number} [size]
 * @returns {Spec[]}
 */
const specsFor = (count, size = 128) => Array.from({length: count}, (_, id) => ({id, size}));

test('sparse batch results retain requested bytes rather than every decoded block', async () => {
    const f = fixture(specsFor(32), {cacheMaxBytes: 512});
    const results = await f.store.readDetailedBatch(f.requests);
    assert.equal([...buffers(results)].reduce((sum, buffer) => sum + buffer.byteLength, 0), 32);
    for (const [i, result] of results.entries()) {
        assert.deepEqual(result, {status: 'ok', bytes: Uint8Array.of(i)});
    }
    assertIdle(f.store);
});

test('the distinct-load count is bounded independently of the byte budget', async () => {
    const f = fixture(specsFor(20), {maxConcurrentBlockReads: 3, maxInFlightBlockBytes: 8192});
    await f.store.readDetailedBatch(f.requests);
    assert.equal(f.metrics.peakActive, 3);
    assertIdle(f.store);
});

test('declared expanded-byte reservations bound heterogeneous block reads', async () => {
    const f = fixture([300, 120, 250, 110, 60, 200].map((size, id) => ({id, size})), {
        maxConcurrentBlockReads: 4, maxInFlightBlockBytes: 400,
    });
    await f.store.readDetailedBatch(f.requests);
    assert.ok(f.metrics.peakBytes <= 400, String(f.metrics.peakBytes));
    assert.ok(f.metrics.peakActive <= 4);
    assertIdle(f.store);
});

test('overlapping batches and scalar reads share limits and one pending block', async () => {
    const f = fixture(specsFor(6), {cacheMaxBytes: 0, maxConcurrentBlockReads: 2, maxInFlightBlockBytes: 256});
    const first = f.requests[0];
    const results = await Promise.all([
        f.store.readDetailedBatch(f.requests.slice(0, 4)),
        f.store.readDetailedBatch([first, ...f.requests.slice(4)]),
        f.store.readDetailed(first.contentOffset, first.contentLength, first.contentDictName),
    ]);
    assert.equal(f.calls.get(0), 1);
    assert.equal(f.calls.size, 6);
    assert.ok(f.metrics.peakActive <= 2);
    assert.ok(f.metrics.peakBytes <= 256);
    assert.equal(results[2].status, 'ok');
    assertIdle(f.store);
});

test('an oversized block runs alone and does not strand later readers', async () => {
    const f = fixture([{id: 0, size: 500}, {id: 1, size: 100}, {id: 2, size: 100}], {
        maxConcurrentBlockReads: 2, maxInFlightBlockBytes: 300,
    }, true);
    const promise = f.store.readDetailedBatch(f.requests);
    await nextTurn();
    const initial = [...f.calls.keys()];
    f.release();
    await nextTurn();
    f.release();
    const results = await promise;
    assert.deepEqual(initial, [0]);
    assert.equal(f.metrics.peakBytes, 500);
    assert.equal(results.length, 3);
    buffers(results);
    assertIdle(f.store);
});

test('failed and unavailable loads release reservations and settle valid peers', async () => {
    const f = fixture(specsFor(5), {maxConcurrentBlockReads: 1, maxInFlightBlockBytes: 128});
    f.failures.set(0, new Error('injected read failure'));
    f.unavailable.add(2);
    const results = await f.store.readDetailedBatch(f.requests);
    assert.deepEqual(results[0], {status: 'temporarilyUnavailable', reason: 'injected read failure'});
    assert.equal(results[2].status, 'temporarilyUnavailable');
    for (const i of [1, 3, 4]) { assert.deepEqual(results[i], {status: 'ok', bytes: Uint8Array.of(i)}); }
    assertIdle(f.store);
});

test('invalidation rejects queued old work without resetting active reservations', async () => {
    const f = fixture(specsFor(4), {maxConcurrentBlockReads: 2, maxInFlightBlockBytes: 256}, true);
    const old = f.store.readDetailedBatch(f.requests);
    await nextTurn();
    f.store.clearCache();
    const afterClear = f.store.getDiagnostics();
    const fresh = f.store.readDetailedBatch([f.requests[0]]);
    await nextTurn();
    const beforeRelease = [...f.calls.entries()];
    f.release();
    await nextTurn();
    f.release();
    const [oldResults, newResults] = await Promise.all([old, fresh]);
    assert.equal(afterClear.activeBlockReads, 2);
    assert.equal(afterClear.activeBlockReadBytes, 256);
    assert.equal(afterClear.pendingBlockReads, 0);
    assert.deepEqual(beforeRelease, [[0, 1], [1, 1]]);
    assert.ok(oldResults.every(({status}) => status === 'temporarilyUnavailable'));
    assert.deepEqual(newResults, [{status: 'ok', bytes: Uint8Array.of(0)}]);
    assert.equal(f.calls.get(0), 2);
    assert.equal(f.calls.has(2), false);
    assert.equal(f.calls.has(3), false);
    assertIdle(f.store);
});

test('dense and exactly half-block results retain the existing zero-copy path', async () => {
    const f = fixture([{id: 0, size: 128, length: 64}, {id: 1, size: 128, start: 10, length: 100}]);
    const results = await f.store.readDetailedBatch(f.requests);
    for (const [i, result] of results.entries()) {
        assert.equal(result.status, 'ok');
        assert.equal(result.bytes.buffer, f.blocks.get(i)?.buffer);
    }
    assertIdle(f.store);
});

test('sparse duplicate and overlapping spans preserve bytes and request order', async () => {
    const specs = [
        {id: 1, size: 512, start: 12, length: 10},
        {id: 0, size: 512, start: 2, length: 3},
        {id: 1, size: 512, start: 12, length: 10},
        {id: 1, size: 512, start: 15, length: 10},
    ];
    const f = fixture(specs);
    const results = await f.store.readDetailedBatch(f.requests);
    for (const [i, result] of results.entries()) {
        const {id, start, length} = specs[i];
        assert.deepEqual(result, {status: 'ok', bytes: Uint8Array.from({length}, (_, j) => (id + start + j) % 251)});
    }
    assert.equal(f.calls.get(1), 1);
    assert.equal([...buffers(results)].reduce((sum, buffer) => sum + buffer.byteLength, 0), 33);
});

test('sparse cached results are independent of cache lifetime and cached block mutation', async () => {
    const f = fixture([{id: 0, size: 128}]);
    const first = f.requests[0];
    await f.store.readDetailed(first.contentOffset, first.contentLength, first.contentDictName);
    const [result] = await f.store.readDetailedBatch(f.requests);
    if (result.status !== 'ok') { throw new Error(result.reason); }
    result.bytes[0] = 99;
    assert.equal(f.blocks.get(0)?.[0], 0);
    f.store.clearCache();
    assert.equal(result.bytes[0], 99);
    assert.equal(f.calls.get(0), 1);
});

test('malformed references do not start block work or corrupt valid peer results', async () => {
    const f = fixture(specsFor(3));
    f.references[1] = new Uint8Array(20);
    const results = await f.store.readDetailedBatch(f.requests);
    assert.equal(results[1].status, 'corrupt');
    assert.equal(f.calls.has(1), false);
    assert.deepEqual(results[2], {status: 'ok', bytes: Uint8Array.of(2)});
    assertIdle(f.store);
});

test('raw requests and empty batches do not consume decoded-block reservations', async () => {
    const f = fixture(specsFor(1));
    assert.deepEqual(await f.store.readDetailedBatch([]), []);
    const [result] = await f.store.readDetailedBatch([{contentOffset: 0, contentLength: 20, contentDictName: 'raw'}]);
    assert.deepEqual(result, {status: 'ok', bytes: f.references[0]});
    assert.equal(f.calls.size, 0);
    assertIdle(f.store);
});

for (const field of /** @type {const} */ (['maxConcurrentBlockReads', 'maxInFlightBlockBytes'])) {
    test(`${field} rejects invalid limits instead of hanging the queue`, () => {
        for (const value of [0, -1, 0.5, Number.NaN, Infinity, 2 ** 53]) {
            assert.throws(() => fixture(specsFor(0), {[field]: value}), RangeError);
        }
    });
}

test('mixed sparse/dense batches match an independent byte oracle under cache eviction', async () => {
    let state = 919;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    };
    const specs = Array.from({length: 600}, () => {
        const id = random() % 101;
        const size = 64 + id * 17;
        const start = random() % size;
        return {id, size, start, length: 1 + random() % (size - start)};
    });
    const f = fixture(specs, {cacheMaxBytes: 256, maxConcurrentBlockReads: 3, maxInFlightBlockBytes: 2048});
    const results = await f.store.readDetailedBatch(f.requests);
    for (const [i, result] of results.entries()) {
        const {id, start, length} = specs[i];
        assert.deepEqual(result, {status: 'ok', bytes: Uint8Array.from({length}, (_, j) => (id + start + j) % 251)});
    }
    const requestedBytes = specs.reduce((sum, {length}) => sum + length, 0);
    assert.ok([...buffers(results)].reduce((sum, buffer) => sum + buffer.byteLength, 0) <= requestedBytes * 2);
    assert.ok(f.metrics.peakActive <= 3);
    assert.ok(f.metrics.peakBytes <= 2048);
    assertIdle(f.store);
});
