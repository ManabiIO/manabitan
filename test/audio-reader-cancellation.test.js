/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';

afterEach(() => { vi.unstubAllGlobals(); });

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {{status: string, value: T|null, error: unknown}}
 */
function observe(promise) {
    const result = {status: 'pending', value: /** @type {T|null} */ (null), error: /** @type {unknown} */ (null)};
    void promise.then((value) => { result.status = 'fulfilled'; result.value = value; }, (error) => { result.status = 'rejected'; result.error = error; });
    return result;
}

/** @param {boolean} [stalledCancel] */
function setup(stalledCancel = false) {
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
    let streamController;
    const stats = {cancels: 0, reason: /** @type {unknown} */ (null), progress: /** @type {boolean[]} */ ([])};
    const response = new Response(new ReadableStream({
        start(controller) { streamController = controller; },
        cancel(reason) {
            ++stats.cancels;
            stats.reason = reason;
            return stalledCancel ? new Promise(() => {}) : undefined;
        },
    }));
    const abort = new AbortController();
    const {signal} = abort;
    let listeners = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { if (args[0] === 'abort') { ++listeners; } add(...args); };
    signal.removeEventListener = (...args) => { if (args[0] === 'abort') { --listeners; } remove(...args); };
    /** @param {boolean} done */
    const progress = (done) => { stats.progress.push(done); };
    const close = () => { try { streamController.close(); } catch (e) { /* Already cancelled */ } };
    /** @param {number[]} bytes */
    const chunk = (bytes) => { streamController.enqueue(Uint8Array.from(bytes)); };
    return {response, abort, stats, progress, close, chunk, listeners: () => listeners};
}

for (const withProgress of [false, true]) {
    test(`pre-aborted consumption fails without reading; progress=${withProgress}`, async () => {
        const {response, abort, stats, progress, close, listeners} = setup();
        const reason = new Error('Already cancelled');
        abort.abort(reason);
        const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, withProgress ? progress : null, abort.signal));
        await flush();
        const atAbort = {...observed};
        close();
        await flush();
        expect(atAbort.status).toBe('rejected');
        expect(atAbort.error).toBe(reason);
        expect(stats.progress).toEqual([]);
        expect(stats.cancels).toBe(1);
        expect(response.body?.locked).toBe(false);
        expect(listeners()).toBe(0);
    });

    for (const stalledCancel of [false, true]) {
        test(`abort releases a stalled stream; progress=${withProgress}, stalledCancel=${stalledCancel}`, async () => {
            const {response, abort, stats, progress, close, listeners} = setup(stalledCancel);
            const reason = new Error('Timed out');
            const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, withProgress ? progress : null, abort.signal));
            await flush();
            abort.abort(reason);
            await flush();
            const atAbort = {...observed};
            close();
            await flush();
            expect(atAbort.status).toBe('rejected');
            expect(atAbort.error).toBe(reason);
            expect(stats.cancels).toBe(1);
            expect(stats.reason).toBe(reason);
            expect(stats.progress).toEqual([]);
            expect(response.body?.locked).toBe(false);
            expect(listeners()).toBe(0);
        });
    }
}

test('abort between chunks never publishes a truncated success or completion progress', async () => {
    const {response, abort, stats, progress, chunk, close, listeners} = setup();
    const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, progress, abort.signal));
    chunk([1, 2]);
    await flush();
    const reason = new Error('No more bytes');
    abort.abort(reason);
    await flush();
    const atAbort = {...observed};
    close();
    await flush();
    expect(atAbort.status).toBe('rejected');
    expect(atAbort.error).toBe(reason);
    expect(stats.progress).toEqual([false]);
    expect(response.body?.locked).toBe(false);
    expect(listeners()).toBe(0);
});

test('abort from the progress observer stops consumption before another read', async () => {
    const {response, abort, stats, chunk, close} = setup();
    const reason = new Error('Stop after first chunk');
    const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, (done) => {
        stats.progress.push(done);
        if (!done) { abort.abort(reason); }
    }, abort.signal));
    chunk([1, 2, 3]);
    await flush();
    const atAbort = {...observed};
    close();
    await flush();
    expect(atAbort.status).toBe('rejected');
    expect(atAbort.error).toBe(reason);
    expect(stats.progress).toEqual([false]);
    expect(response.body?.locked).toBe(false);
});

for (const contentLength of [null, '0', '2', '100', '-1', '99999999999999999999999999999']) {
    test(`healthy cancellable reads preserve bytes with Content-Length=${contentLength}`, async () => {
        const {response, abort, progress, stats, chunk, close, listeners} = setup();
        if (contentLength !== null) { response.headers.set('Content-Length', contentLength); }
        const promise = RequestBuilder.readFetchResponseArrayBuffer(response, progress, abort.signal);
        chunk([1, 2]);
        chunk([3, 4, 5]);
        close();
        expect(Array.from(await promise)).toEqual([1, 2, 3, 4, 5]);
        expect(stats.progress).toEqual([false, false, true]);
        expect(listeners()).toBe(0);
        expect(response.body?.locked).toBe(false);
        abort.abort(new Error('After success'));
        await flush();
        expect(stats.cancels).toBe(0);
        expect(stats.progress).toEqual([false, false, true]);
    });
}

test('a cancellation does not stop an unrelated response reader', async () => {
    const first = setup();
    const second = setup();
    const old = observe(RequestBuilder.readFetchResponseArrayBuffer(first.response, first.progress, first.abort.signal));
    const healthy = RequestBuilder.readFetchResponseArrayBuffer(second.response, second.progress, second.abort.signal);
    first.abort.abort(new Error('Only first'));
    second.chunk([8, 9]);
    second.close();
    await flush();
    const statusAtAbort = old.status;
    first.close();
    await flush();
    expect(statusAtAbort).toBe('rejected');
    expect(Array.from(await healthy)).toEqual([8, 9]);
    expect(second.stats.cancels).toBe(0);
    expect(first.listeners()).toBe(0);
    expect(second.listeners()).toBe(0);
});

test('consumer failure retains its error and removes the abort observer', async () => {
    const {response, abort, stats, chunk, listeners} = setup();
    const error = new Error('Progress callback failure');
    const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, () => { throw error; }, abort.signal));
    chunk([1]);
    await flush();
    expect(observed.status).toBe('rejected');
    expect(observed.error).toBe(error);
    expect(stats.cancels).toBe(1);
    expect(listeners()).toBe(0);
    expect(response.body?.locked).toBe(false);
});

test('an unavailable stream reader still permits prompt cancellation of arrayBuffer fallback', async () => {
    const {response, abort, stats, close, listeners} = setup();
    let finish = (/** @type {ArrayBuffer} */ _value) => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    Reflect.set(response.body, 'getReader', () => { throw new Error('Unavailable'); });
    response.arrayBuffer = () => /** @type {Promise<ArrayBuffer>} */ (pending);
    const observed = observe(RequestBuilder.readFetchResponseArrayBuffer(response, null, abort.signal));
    const reason = new Error('Cancel fallback');
    abort.abort(reason);
    await flush();
    const atAbort = {...observed};
    finish(new ArrayBuffer(2));
    close();
    await flush();
    expect(atAbort.status).toBe('rejected');
    expect(atAbort.error).toBe(reason);
    expect(observed.status).toBe('rejected');
    expect(stats.cancels).toBe(1);
    expect(listeners()).toBe(0);
});

test('the existing two-argument reader remains supported without cancellation', async () => {
    const response = new Response(Uint8Array.from([2, 4, 6]));
    expect(Array.from(await RequestBuilder.readFetchResponseArrayBuffer(response, null))).toEqual([2, 4, 6]);
});
