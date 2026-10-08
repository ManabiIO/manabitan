/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {downloadDefaultDictionary} from '../ext/web/presets.js';

const URL_BASE = 'https://reader.example.test/';
const download = () => downloadDefaultDictionary(new URL('default.zip', URL_BASE));

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('location', new URL(URL_BASE));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

test('default archive fetch aborts when response headers stall', async () => {
    /** @type {{signal?: AbortSignal}} */
    const request = {};
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
        const signal = /** @type {AbortSignal | undefined} */ (init.signal);
        if (!signal) {throw new Error('Missing fetch AbortSignal');}
        request.signal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    })));
    const result = download().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).code).toBe('download_timeout');
    expect(request.signal?.aborted).toBe(true);
});

test('default archive read aborts after initial body progress stalls', async () => {
    /** @type {{signal?: AbortSignal}} */
    const request = {};
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const signal = /** @type {AbortSignal | undefined} */ (init.signal);
        if (!signal) {throw new Error('Missing fetch AbortSignal');}
        request.signal = signal;
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1]));
                signal.addEventListener('abort', () => controller.error(signal.reason), {once: true});
            },
        });
        return new Response(stream);
    }));
    const result = download().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).code).toBe('download_timeout');
});

test('slow trickle cannot bypass the total archive transfer deadline', async () => {
    /** @type {{signal?: AbortSignal}} */
    const request = {};
    let sent = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const signal = /** @type {AbortSignal | undefined} */ (init.signal);
        if (!signal) {throw new Error('Missing fetch AbortSignal');}
        request.signal = signal;
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let ticker;
        const stream = new ReadableStream({
            start(controller) {
                ticker = setInterval(() => {
                    ++sent;
                    controller.enqueue(new Uint8Array([1]));
                }, 30_000);
                signal.addEventListener('abort', () => {
                    clearInterval(ticker);
                    controller.error(signal.reason);
                }, {once: true});
            },
            cancel() {
                clearInterval(ticker);
            },
        });
        return new Response(stream);
    }));
    const result = download().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect((await result).code).toBe('download_timeout');
    expect(sent).toBeGreaterThan(10);
    expect(request.signal?.aborted).toBe(true);
});

test('explicit caller cancellation is not misreported as a download timeout', async () => {
    const controller = new AbortController();
    /** @type {{signal?: AbortSignal}} */
    const request = {};
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
        const signal = /** @type {AbortSignal | undefined} */ (init.signal);
        if (!signal) {throw new Error('Missing fetch AbortSignal');}
        request.signal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    })));
    const result = downloadDefaultDictionary(new URL('default.zip', URL_BASE), {signal: controller.signal})
        .then(() => null, (error) => error);
    controller.abort(new DOMException('User cancelled download', 'AbortError'));
    const error = await result;
    expect(error.name).toBe('AbortError');
    expect(error.code).toBeUndefined();
    expect(request.signal?.aborted).toBe(true);
});
