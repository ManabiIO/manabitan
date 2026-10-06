/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

const wav = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';
const wavBytes = Uint8Array.from(atob(wav), (char) => char.charCodeAt(0));
const language = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja'}));
const sources = ['first', 'second'].map((name) => ({type: /** @type {const} */ ('custom'), url: `https://audio.example/${name}`, voice: ''}));
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
function deferred() {
    let resolve = (/** @type {T} */ _value) => {};
    let reject = (/** @type {unknown} */ _error) => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 40; ++i) { await Promise.resolve(); }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {{status: string, value: T|null, error: unknown}}
 */
function observe(promise) {
    const result = {status: 'pending', value: /** @type {T|null} */ (null), error: /** @type {unknown} */ (null)};
    void promise.then((value) => {
        result.status = 'fulfilled';
        result.value = value;
    }, (error) => {
        result.status = 'rejected';
        result.error = error;
    });
    return result;
}

/**
 * @param {boolean} [stalledCancel]
 * @returns {{response: Response, stats: {cancels: number, reason: unknown}, close: () => void, complete: () => void, chunk: () => void, fail: (error: unknown) => void}}
 */
function body(stalledCancel = false) {
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
    let controller;
    const stats = {cancels: 0, reason: /** @type {unknown} */ (null)};
    const stream = new ReadableStream({
        start(value) { controller = value; },
        cancel(reason) {
            ++stats.cancels;
            stats.reason = reason;
            return stalledCancel ? new Promise(() => {}) : undefined;
        },
    });
    const response = new Response(stream, {headers: {'Content-Type': 'audio/wav'}});
    const close = () => {
        try { controller.close(); } catch (e) { /* Already cancelled */ }
    };
    const complete = () => {
        try {
            controller.enqueue(wavBytes);
            controller.close();
        } catch (e) { /* Already cancelled */ }
    };
    const chunk = () => { controller.enqueue(wavBytes); };
    const fail = (/** @type {unknown} */ error) => { controller.error(error); };
    return {response, stats, close, complete, chunk, fail};
}

/** @returns {Response} */
function healthy() { return new Response(wavBytes, {headers: {'Content-Type': 'audio/wav'}}); }

/**
 * @param {(url: string, init: RequestInit) => Promise<Response>} [fetcher]
 * @returns {{downloader: AudioDownloader, download: (idleTimeout?: number|null) => Promise<import('audio-downloader').AudioBinaryBase64>, fallback: () => Promise<import('audio-downloader').AudioBinaryBase64>, requests: {url: string, signal: AbortSignal|null|undefined}[], timers: Map<number, {callback: () => void, delay: number}>, expire: (id?: number) => void}}
 */
function setup(fetcher = async () => healthy()) {
    let nextId = 0;
    /** @type {Map<number, {callback: () => void, delay: number}>} */
    const timers = new Map();
    vi.stubGlobal('setTimeout', (/** @type {() => void} */ callback, /** @type {number} */ delay) => {
        const id = ++nextId;
        timers.set(id, {callback, delay});
        return id;
    });
    vi.stubGlobal('clearTimeout', (/** @type {number} */ id) => { timers.delete(id); });
    const expire = (id = [...timers.keys()][0]) => {
        const timer = timers.get(id);
        timers.delete(id);
        timer?.callback();
    };
    /** @type {{url: string, signal: AbortSignal|null|undefined}[]} */
    const requests = [];
    const requestBuilder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({
        async fetchAnonymous(/** @type {string} */ url, /** @type {RequestInit} */ init) {
            requests.push({url, signal: init.signal});
            return await fetcher(url, init);
        },
    }));
    const downloader = new AudioDownloader(requestBuilder);
    const download = (idleTimeout = /** @type {number|null} */ (100)) => downloader._downloadAudioFromUrl(sources[0].url, 'custom', idleTimeout);
    const fallback = () => downloader.downloadTermAudio(sources, null, '音', 'おと', 100, language, false);
    return {downloader, download, fallback, requests, timers, expire};
}

for (const lateResult of ['response', 'error']) {
    test(`stalled headers retire at the idle deadline before a late ${lateResult}`, async () => {
        /** @type {ReturnType<typeof deferred<Response>>} */
        const gate = deferred();
        const {download, requests, timers, expire} = setup(() => gate.promise);
        const result = observe(download());
        expire();
        await flush();
        const atDeadline = {...result};
        const late = body();
        if (lateResult === 'response') {
            gate.resolve(late.response);
        } else {
            gate.reject(new Error('Late transport failure'));
        }
        await flush();
        const lateCancels = late.stats.cancels;
        late.complete();
        await flush();
        expect(atDeadline.status).toBe('rejected');
        expect(atDeadline.error instanceof Error).toBe(true);
        expect(result.error).toBe(atDeadline.error);
        expect(requests[0].signal?.aborted).toBe(true);
        expect(timers.size).toBe(0);
        if (lateResult === 'response') { expect(lateCancels).toBe(1); }
    });
}

for (const stalledCancel of [false, true]) {
    test(`stalled body releases caller and lock, even with stalled cancellation=${stalledCancel}`, async () => {
        const stream = body(stalledCancel);
        const {download, requests, timers, expire} = setup(async () => stream.response);
        const result = observe(download());
        await flush();
        expire();
        await flush();
        const atDeadline = {...result};
        const wasUnlocked = stream.response.body?.locked === false;
        const cancels = stream.stats.cancels;
        stream.complete();
        await flush();
        expect(atDeadline.status).toBe('rejected');
        expect(result.error).toBe(atDeadline.error);
        expect(wasUnlocked).toBe(true);
        expect(cancels).toBe(1);
        expect(requests[0].signal?.aborted).toBe(true);
        expect(timers.size).toBe(0);
    });
}

for (const phase of ['headers', 'body']) {
    test(`Anki reaches the next provider without waiting for stalled ${phase}`, async () => {
        /** @type {ReturnType<typeof deferred<Response>>} */
        const gate = deferred();
        const stream = body();
        const {fallback, requests, timers, expire} = setup(async (url) => {
            if (url === sources[1].url) { return healthy(); }
            return phase === 'headers' ? await gate.promise : stream.response;
        });
        const result = observe(fallback());
        await flush();
        expire();
        await flush();
        const atDeadline = {...result};
        const requestUrls = requests.map(({url}) => url);
        gate.resolve(stream.response);
        stream.complete();
        await flush();
        expect(atDeadline.status).toBe('fulfilled');
        expect(atDeadline.value).toEqual({data: wav, contentType: 'audio/wav'});
        expect(requestUrls).toEqual(sources.map(({url}) => url));
        expect(requests[0].signal?.aborted).toBe(true);
        expect(requests[1].signal?.aborted).toBe(false);
        expect(timers.size).toBe(0);
    });
}

test('byte progress renews the idle budget rather than imposing a total request deadline', async () => {
    const stream = body();
    const {download, requests, timers, expire} = setup(async () => stream.response);
    const result = observe(download());
    await flush();
    let previousId = [...timers.keys()][0];
    for (let i = 0; i < 5; ++i) {
        stream.chunk();
        await flush();
        const [id, timer] = [...timers.entries()][0];
        expect(id > previousId).toBe(true);
        expect(timer.delay).toBe(100);
        expect(timers.size).toBe(1);
        expect(result.status).toBe('pending');
        previousId = id;
    }
    expect(requests[0].signal?.aborted).toBe(false);
    expire();
    await flush();
    const atDeadline = result.status;
    stream.close();
    await flush();
    expect(atDeadline).toBe('rejected');
    expect(timers.size).toBe(0);
});

test('a late timer callback cannot abort a successful download', async () => {
    const {download, requests, timers} = setup();
    const promise = download();
    const callbacks = [...timers.values()].map(({callback}) => callback);
    expect(await promise).toEqual({data: wav, contentType: 'audio/wav'});
    expect(timers.size).toBe(0);
    for (const callback of callbacks) { callback(); }
    await flush();
    expect(requests[0].signal?.aborted).toBe(false);
    expect(timers.size).toBe(0);
});

test('a null idle timeout preserves an explicitly unbounded download', async () => {
    const stream = body();
    const {download, requests, timers, expire} = setup(async () => stream.response);
    const result = observe(download(null));
    await flush();
    expire();
    expect(result.status).toBe('pending');
    expect(timers.size).toBe(0);
    expect(typeof requests[0].signal).toBe('undefined');
    stream.complete();
    await flush();
    expect(result.status).toBe('fulfilled');
    expect(result.value).toEqual({data: wav, contentType: 'audio/wav'});
});

for (const phase of ['transport', 'body']) {
    test(`a current ${phase} failure retains its original error and releases the timer`, async () => {
        const stream = body();
        const error = new Error(`Original ${phase} error`);
        const {download, timers} = setup(async () => {
            if (phase === 'transport') { throw error; }
            return stream.response;
        });
        const result = observe(download());
        await flush();
        if (phase === 'body') { stream.fail(error); }
        await flush();
        expect(result.status).toBe('rejected');
        expect(result.error).toBe(error);
        expect(timers.size).toBe(0);
    });
}

test('an HTTP error is cancelled and fallback still succeeds', async () => {
    const failed = body();
    const errorResponse = new Response(failed.response.body, {status: 503});
    const {fallback, requests, timers} = setup(async (url) => (url === sources[0].url ? errorResponse : healthy()));
    expect(await fallback()).toEqual({data: wav, contentType: 'audio/wav'});
    expect(failed.stats.cancels).toBe(1);
    expect(requests.map(({url}) => url)).toEqual(sources.map(({url}) => url));
    expect(timers.size).toBe(0);
});

test('a timed-out stream cannot renew timers after its late completion', async () => {
    const stream = body();
    const {download, timers, expire} = setup(async () => stream.response);
    const result = observe(download());
    await flush();
    expire();
    await flush();
    const atDeadline = {...result};
    stream.complete();
    await flush();
    expect(atDeadline.status).toBe('rejected');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe(atDeadline.error);
    expect(timers.size).toBe(0);
});

test('one stalled request does not cancel a concurrent healthy response', async () => {
    const failed = body();
    const good = body();
    const {downloader, requests, timers, expire} = setup(async (url) => (url === sources[0].url ? failed.response : good.response));
    const first = observe(downloader._downloadAudioFromUrl(sources[0].url, 'custom', 100));
    const second = observe(downloader._downloadAudioFromUrl(sources[1].url, 'custom', 100));
    await flush();
    expire([...timers.keys()][0]);
    good.complete();
    await flush();
    const firstStatus = first.status;
    failed.complete();
    await flush();
    expect(firstStatus).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect(requests[1].signal?.aborted).toBe(false);
    expect(good.stats.cancels).toBe(0);
    expect(timers.size).toBe(0);
});

test('binary validation after successful consumption does not consume idle budget', async () => {
    /** @type {ReturnType<typeof deferred<boolean>>} */
    const validation = deferred();
    const {downloader, download, requests, timers, expire} = setup();
    downloader._isAudioBinaryValid = () => validation.promise;
    const result = observe(download());
    await flush();
    expect(timers.size).toBe(0);
    expire();
    expect(result.status).toBe('pending');
    validation.resolve(true);
    await flush();
    expect(result.status).toBe('fulfilled');
    expect(requests[0].signal?.aborted).toBe(false);
});

test('all timed-out providers report failure with both owned causes', async () => {
    const first = deferred();
    const second = deferred();
    const {fallback, requests, timers, expire} = setup(async (url) => /** @type {Promise<Response>} */ (url === sources[0].url ? first.promise : second.promise));
    const result = observe(fallback());
    await flush();
    expire();
    await flush();
    expire();
    await flush();
    const atDeadline = {...result};
    first.reject(new Error('Late first'));
    second.reject(new Error('Late second'));
    await flush();
    expect(atDeadline.status).toBe('rejected');
    const error = /** @type {Error & {data: {errors: unknown[]}}} */ (atDeadline.error);
    expect(error.message).toBe('Could not download audio');
    expect(error.data.errors.length).toBe(2);
    expect(error.data.errors.every((cause) => cause instanceof Error)).toBe(true);
    expect(requests.length).toBe(2);
    expect(timers.size).toBe(0);
});
