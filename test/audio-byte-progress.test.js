/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {afterEach, test, vi} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

afterEach(() => { vi.unstubAllGlobals(); });

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 40; ++i) { await Promise.resolve(); }
}

function stream() {
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
    let controller;
    const state = {cancels: 0};
    const response = new Response(new ReadableStream({
        start(value) { controller = value; },
        cancel() { ++state.cancels; },
    }));
    /** @param {number[]} bytes */
    const chunk = (bytes) => { controller.enqueue(Uint8Array.from(bytes)); };
    const close = () => {
        try { controller.close(); } catch (e) { /* Already cancelled. */ }
    };
    return {response, state, chunk, close};
}

for (const contentLength of [null, '0', '16']) {
    test(`zero-byte chunks do not report byte progress with Content-Length=${contentLength}`, async () => {
        const {response, state, chunk, close} = stream();
        if (contentLength !== null) { response.headers.set('Content-Length', contentLength); }
        /** @type {boolean[]} */
        const progress = [];
        const reading = RequestBuilder.readFetchResponseArrayBuffer(response, (done) => { progress.push(done); });
        for (const bytes of [[], [], [1, 2], [], [3], [], []]) { chunk(bytes); }
        close();
        assert.deepEqual([...await reading], [1, 2, 3]);
        assert.deepEqual(progress, [false, false, true]);
        assert.equal(response.body?.locked, false);
        assert.equal(state.cancels, 0);
    });
}

test('an empty completed body still emits one completion notification', async () => {
    const {response, chunk, close} = stream();
    /** @type {boolean[]} */
    const progress = [];
    const reading = RequestBuilder.readFetchResponseArrayBuffer(response, (done) => { progress.push(done); });
    chunk([]);
    chunk([]);
    close();
    assert.deepEqual([...await reading], []);
    assert.deepEqual(progress, [true]);
    assert.equal(response.body?.locked, false);
});

test('a cancellable stream with only empty chunks does not emit progress or publish success', async () => {
    const {response, state, chunk, close} = stream();
    const abort = new AbortController();
    /** @type {boolean[]} */
    const progress = [];
    const reading = RequestBuilder.readFetchResponseArrayBuffer(response, (done) => { progress.push(done); }, abort.signal);
    const observed = reading.then(() => null, (error) => error);
    chunk([]);
    await flush();
    chunk([]);
    await flush();
    const failure = new Error('No bytes arrived');
    abort.abort(failure);
    assert.equal(await observed, failure);
    close();
    assert.deepEqual(progress, []);
    assert.equal(state.cancels, 1);
    assert.equal(response.body?.locked, false);
});

test('readers without progress retain their byte-preservation behavior', async () => {
    const {response, chunk, close} = stream();
    const reading = RequestBuilder.readFetchResponseArrayBuffer(response, null, new AbortController().signal);
    chunk([]);
    chunk([9, 8]);
    chunk([]);
    close();
    assert.deepEqual([...await reading], [9, 8]);
});

function downloadSetup() {
    let now = 0;
    let nextId = 0;
    /** @type {Map<number, {callback: () => void, at: number}>} */
    const timers = new Map();
    vi.stubGlobal('setTimeout', (/** @type {() => void} */ callback, /** @type {number} */ delay) => {
        const id = ++nextId;
        timers.set(id, {callback, at: now + delay});
        return id;
    });
    vi.stubGlobal('clearTimeout', (/** @type {number} */ id) => { timers.delete(id); });
    /** @param {number} elapsed */
    const advance = async (elapsed) => {
        now += elapsed;
        const pending = [...timers];
        for (const [id, timer] of pending) {
            if (timer.at > now || !timers.delete(id)) { continue; }
            timer.callback();
        }
        await flush();
    };
    const stalled = stream();
    const sources = ['stalled', 'healthy'].map((name) => ({type: /** @type {const} */ ('custom'), url: `https://audio.example/${name}`, voice: ''}));
    /** @type {string[]} */
    const requests = [];
    const transport = {
        /** @param {string} url */
        async fetchAnonymous(url) {
            requests.push(url);
            return url === sources[0].url ? stalled.response : new Response(Uint8Array.from([7, 8]), {headers: {'Content-Type': 'audio/wav'}});
        },
    };
    const downloader = new AudioDownloader(/** @type {RequestBuilder} */ (/** @type {unknown} */ (transport)));
    const language = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja'}));
    const fallback = () => downloader.downloadTermAudio(sources, null, '音声', 'おんせい', 100, language, false);
    return {stalled, sources, requests, downloader, fallback, timers, advance};
}

test('empty chunks cannot keep an unavailable provider ahead of Anki fallback forever', async () => {
    const {stalled, sources, requests, fallback, advance, timers} = downloadSetup();
    let settled = false;
    const download = fallback().then((value) => {
        settled = true;
        return value;
    });
    await flush();
    await advance(60);
    stalled.chunk([]);
    await flush();
    await advance(40);
    const atDeadline = {settled, requests: [...requests]};
    stalled.close();
    const result = await download;
    assert.deepEqual(atDeadline, {settled: true, requests: sources.map(({url}) => url)});
    assert.equal(result.data, 'Bwg=');
    assert.equal(stalled.state.cancels, 1);
    assert.equal(timers.size, 0);
});

test('empty chunks after real bytes do not renew the last byte-progress deadline', async () => {
    const {stalled, requests, sources, fallback, advance, timers} = downloadSetup();
    let settled = false;
    const download = fallback().then((value) => {
        settled = true;
        return value;
    });
    await flush();
    await advance(60);
    stalled.chunk([1]);
    await flush();
    await advance(60);
    stalled.chunk([]);
    await flush();
    await advance(40);
    const atDeadline = {settled, requests: [...requests]};
    stalled.close();
    const result = await download;
    assert.deepEqual(atDeadline, {settled: true, requests: sources.map(({url}) => url)});
    assert.equal(result.data, 'Bwg=');
    assert.equal(timers.size, 0);
});

test('positive byte progress retains the sliding idle budget rather than an absolute timeout', async () => {
    const {stalled, requests, sources, fallback, advance, timers} = downloadSetup();
    const download = fallback();
    await flush();
    for (let i = 0; i < 5; ++i) {
        await advance(60);
        stalled.chunk([i]);
        await flush();
    }
    stalled.close();
    const result = await download;
    assert.equal(result.data, 'AAECAwQ=');
    assert.deepEqual(requests, [sources[0].url]);
    assert.equal(stalled.state.cancels, 0);
    assert.equal(timers.size, 0);
});
