/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

afterEach(() => { vi.unstubAllGlobals(); });

const language = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja', iso639_3: 'jpn', name: 'Japanese'}));
const jsonSource = {type: /** @type {const} */ ('custom-json'), url: 'https://source.example/list?term={term}', voice: ''};
const recording = {type: /** @type {const} */ ('url'), url: 'https://source.example/recording.wav'};
const payload = {type: 'audioSourceList', audioSources: [{url: recording.url}]};

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 30; ++i) { await Promise.resolve(); }
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => { throw new Error('Uninitialized deferred'); };
    /** @type {(reason: unknown) => void} */
    let reject = () => { throw new Error('Uninitialized deferred'); };
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
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
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchAnonymous
 * @returns {{downloader: AudioDownloader, timers: Map<number, {at: number, callback: () => void}>, advance: (elapsed: number) => Promise<void>}}
 */
function setup(fetchAnonymous) {
    let now = 0;
    let next = 0;
    /** @type {Map<number, {at: number, callback: () => void}>} */
    const timers = new Map();
    /**
     * @param {() => void} callback
     * @param {number} delay
     * @returns {number}
     */
    const schedule = (callback, delay) => {
        const id = ++next;
        timers.set(id, {at: now + delay, callback});
        return id;
    };
    vi.stubGlobal('setTimeout', schedule);
    vi.stubGlobal('clearTimeout', /** @param {number} id */ (id) => { timers.delete(id); });
    /**
     * @param {number} elapsed
     * @returns {Promise<void>}
     */
    const advance = async (elapsed) => {
        now += elapsed;
        const pendingTimers = [...timers];
        for (const [id, {at, callback}] of pendingTimers) {
            if (at > now) { continue; }
            timers.delete(id);
            callback();
        }
        await flush();
    };
    const builder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({fetchAnonymous}));
    const downloader = new AudioDownloader(builder);
    Reflect.set(downloader, '_customAudioListSchema', {validate() {}});
    return {downloader, timers, advance};
}

for (const type of /** @type {const} */ (['custom-json', 'jisho', 'language-pod-101', 'lingua-libre', 'wiktionary'])) {
    test(`${type} discovery with stalled headers returns a miss and aborts its request`, async () => {
        const pending = deferred();
        /** @type {RequestInit[]} */
        const requests = [];
        const {downloader, timers, advance} = setup((_url, init) => {
            requests.push(init);
            return /** @type {Promise<Response>} */ (pending.promise);
        });
        const result = observe(downloader.getTermAudioInfoList({...jsonSource, type}, '漢字', 'かんじ', language));
        await advance(14999);
        expect(result.status).toBe('pending');
        await advance(1);
        expect(result.status).toBe('fulfilled');
        expect(result.value).toEqual([]);
        expect(requests[0].signal?.aborted).toBe(true);
        expect(timers.size).toBe(0);
    });
}

test('the deadline includes JSON body reading and is not restarted when headers arrive', async () => {
    const headers = deferred();
    const body = deferred();
    /** @type {RequestInit[]} */
    const requests = [];
    let reads = 0;
    const {downloader, advance, timers} = setup((_url, init) => {
        requests.push(init);
        return /** @type {Promise<Response>} */ (headers.promise);
    });
    const result = observe(downloader.getTermAudioInfoList(jsonSource, '漢字', 'かんじ', language));
    await advance(9000);
    const response = new Response('{}');
    // A transport that does not observe abort must not keep its caller blocked.
    response.json = () => {
        ++reads;
        return /** @type {Promise<unknown>} */ (body.promise);
    };
    headers.resolve(response);
    await flush();
    expect(reads).toBe(1);
    await advance(6000);
    expect(result.status).toBe('fulfilled');
    expect(result.value).toEqual([]);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(timers.size).toBe(0);
    body.resolve(payload);
    await flush();
    expect(result.value).toEqual([]);
});

test('a late response from a transport ignoring abort is discarded without parsing its body', async () => {
    const pending = deferred();
    let cancelled = 0;
    let reads = 0;
    const {downloader, advance} = setup(() => /** @type {Promise<Response>} */ (pending.promise));
    const result = observe(downloader.getTermAudioInfoList(jsonSource, '漢字', 'かんじ', language));
    await advance(15000);
    const response = new Response(new ReadableStream({cancel() { ++cancelled; }}));
    response.json = async () => {
        ++reads;
        return payload;
    };
    pending.resolve(response);
    await flush();
    expect(result.value).toEqual([]);
    expect(reads).toBe(0);
    expect(cancelled).toBe(1);
});

test('a timed-out provider can recover on the next call with a fresh signal and no retained timer', async () => {
    const pending = deferred();
    /** @type {RequestInit[]} */
    const requests = [];
    const {downloader, advance, timers} = setup(async (_url, init) => {
        requests.push(init);
        return requests.length === 1 ? await /** @type {Promise<Response>} */ (pending.promise) : Response.json(payload);
    });
    const first = observe(downloader.getTermAudioInfoList(jsonSource, '漢字', 'かんじ', language));
    await advance(15000);
    expect(first.status).toBe('fulfilled');
    const second = await downloader.getTermAudioInfoList(jsonSource, '漢字', 'かんじ', language);
    expect(second).toEqual([recording]);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    expect(requests[0].signal === requests[1].signal).toBe(false);
    expect(timers.size).toBe(0);
    pending.reject(new Error('Late network error'));
    await flush();
});

for (const type of /** @type {const} */ (['jisho', 'language-pod-101'])) {
    test(`${type} does not parse error-page audio and cancels a non-success response body`, async () => {
        let cancelled = 0;
        let parses = 0;
        const {downloader, timers} = setup(async () => new Response(new ReadableStream({cancel() { ++cancelled; }}), {status: 503}));
        Reflect.set(downloader, '_createSimpleDOMParser', () => {
            ++parses;
            throw new Error('Error pages must not reach the provider parser');
        });
        const result = observe(downloader.getTermAudioInfoList({...jsonSource, type}, '漢字', 'かんじ', language));
        await flush();
        expect(result.status).toBe('fulfilled');
        expect(result.value).toEqual([]);
        expect(parses).toBe(0);
        expect(cancelled).toBe(1);
        expect(timers.size).toBe(0);
    });
}

test('one stalled Commons file request does not discard valid recordings or change their order', async () => {
    const pending = deferred();
    /** @type {RequestInit[]} */
    const requests = [];
    const titles = ['File:first.wav', 'File:stalled.wav', 'File:last.wav'];
    const {downloader, advance, timers} = setup(async (url, init) => {
        requests.push(init);
        const title = new URL(url).searchParams.get('titles');
        if (title === null) { return Response.json({query: {search: titles.map((title) => ({title}))}}); }
        if (title === titles[1]) { return await /** @type {Promise<Response>} */ (pending.promise); }
        return Response.json({query: {pages: {1: {title, imageinfo: [{url: `https://media.example/${title}`, user: title}]}}}});
    });
    const result = observe(downloader._getInfoWikimediaCommons('https://commons.wikimedia.org/w/api.php?action=query', () => true));
    await flush();
    expect(requests.length).toBe(4);
    await advance(15000);
    expect(result.status).toBe('fulfilled');
    expect(result.value).toEqual([titles[0], titles[2]].map((title) => ({type: 'url', url: `https://media.example/${title}`, name: title})));
    expect(requests.map(({signal}) => signal?.aborted)).toEqual([false, false, true, false]);
    expect(timers.size).toBe(0);
});

test('concurrent metadata requests own separate deadlines', async () => {
    const requests = [deferred(), deferred()];
    /** @type {RequestInit[]} */
    const inits = [];
    const {downloader, advance, timers} = setup((_url, init) => {
        inits.push(init);
        return /** @type {Promise<Response>} */ (requests[inits.length - 1].promise);
    });
    const first = observe(downloader.getTermAudioInfoList(jsonSource, 'first', '', language));
    await advance(10000);
    const second = observe(downloader.getTermAudioInfoList(jsonSource, 'second', '', language));
    await advance(5000);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('pending');
    expect(inits[0].signal?.aborted).toBe(true);
    expect(inits[1].signal?.aborted).toBe(false);
    requests[1].resolve(Response.json(payload));
    await flush();
    expect(second.value).toEqual([recording]);
    expect(timers.size).toBe(0);
});

for (const outcome of ['success', 'invalid-json', 'http-error', 'transport-error']) {
    test(`${outcome} settlement clears the metadata deadline`, async () => {
        const {downloader, timers} = setup(async () => {
            if (outcome === 'transport-error') { throw new Error('Offline'); }
            if (outcome === 'invalid-json') { return new Response('not JSON'); }
            if (outcome === 'http-error') { return new Response('error', {status: 503}); }
            return Response.json(payload);
        });
        const result = await downloader.getTermAudioInfoList(jsonSource, '漢字', 'かんじ', language);
        expect(result).toEqual(outcome === 'success' ? [recording] : []);
        expect(timers.size).toBe(0);
    });
}

test('direct custom URLs and text-to-speech do not start metadata deadlines or network requests', async () => {
    let requests = 0;
    const {downloader, timers} = setup(async () => {
        ++requests;
        throw new Error('Unexpected request');
    });
    const custom = await downloader.getTermAudioInfoList({...jsonSource, type: 'custom'}, '漢字', 'かんじ', language);
    const tts = await downloader.getTermAudioInfoList({...jsonSource, type: 'text-to-speech', voice: 'voice'}, '漢字', 'かんじ', language);
    expect(custom).toEqual([{type: 'url', url: 'https://source.example/list?term=%E6%BC%A2%E5%AD%97'}]);
    expect(tts).toEqual([{type: 'tts', text: '漢字', voice: 'voice'}]);
    expect(timers.size).toBe(0);
    expect(requests).toBe(0);
});

for (const type of /** @type {const} */ (['jisho', 'language-pod-101'])) {
    test(`${type} retains redirected media bases and anonymous request settings`, async () => {
        /** @type {RequestInit[]} */
        const requests = [];
        const {downloader, timers} = setup(async (_url, init) => {
            requests.push(init);
            const response = new Response('provider HTML fixture');
            Object.defineProperty(response, 'url', {value: 'https://final.example/redirect/lookup/index'});
            return response;
        });
        Reflect.set(downloader, '_createSimpleDOMParser', () => ({
            getElementsByClassName: () => [{}],
            getElementById: () => ({}),
            getElementByTagName: () => ({}),
            getAttribute: () => '../voice.mp3',
            getTextContent: () => 'かな',
        }));
        expect(await downloader.getTermAudioInfoList({...jsonSource, type}, 'A&B', 'かな', language)).toEqual([{type: 'url', url: 'https://final.example/redirect/voice.mp3'}]);
        const init = requests[0];
        expect(init.credentials).toBe('omit');
        expect(init.referrerPolicy).toBe('no-referrer');
        expect(init.redirect).toBe('follow');
        expect(init.signal?.aborted ?? false).toBe(false);
        if (type === 'language-pod-101') {
            expect(init.method).toBe('POST');
            expect(init.body instanceof URLSearchParams).toBe(true);
            expect(/** @type {URLSearchParams} */ (init.body).get('search_query')).toBe('A&B');
            expect(init.headers).toEqual({'Content-Type': 'application/x-www-form-urlencoded'});
        } else {
            expect(init.method).toBe('GET');
        }
        expect(timers.size).toBe(0);
    });
}

for (const type of /** @type {const} */ (['jisho', 'language-pod-101'])) {
    test(`${type} body consumption shares the request deadline`, async () => {
        const body = deferred();
        let parses = 0;
        let reads = 0;
        const {downloader, advance, timers} = setup(async () => {
            const response = new Response('');
            response.text = () => {
                ++reads;
                return /** @type {Promise<string>} */ (body.promise);
            };
            return response;
        });
        Reflect.set(downloader, '_createSimpleDOMParser', () => {
            ++parses;
            throw new Error('Expired body must not reach the parser');
        });
        const result = observe(downloader.getTermAudioInfoList({...jsonSource, type}, '漢字', 'かんじ', language));
        await flush();
        expect(reads).toBe(1);
        await advance(15000);
        expect(result.status).toBe('fulfilled');
        expect(result.value).toEqual([]);
        body.resolve('late HTML');
        await flush();
        expect(parses).toBe(0);
        expect(timers.size).toBe(0);
    });
}

test('Anki download proceeds to the next metadata provider after a discovery timeout', async () => {
    const stalled = deferred();
    /** @type {string[]} */
    const requests = [];
    const firstSource = {...jsonSource, url: 'https://first.example/list'};
    const secondSource = {...jsonSource, url: 'https://second.example/list'};
    const {downloader, advance, timers} = setup(async (url) => {
        requests.push(url);
        if (url === firstSource.url) { return await /** @type {Promise<Response>} */ (stalled.promise); }
        if (url === secondSource.url) { return Response.json(payload); }
        return new Response(new Uint8Array([1, 2, 3]), {headers: {'Content-Type': 'audio/mpeg'}});
    });
    const result = observe(downloader.downloadTermAudio([firstSource, secondSource], null, '漢字', 'かんじ', null, language, false));
    await advance(15000);
    expect(result.status).toBe('fulfilled');
    expect(result.value).toEqual({data: 'AQID', contentType: 'audio/mpeg'});
    expect(requests).toEqual([firstSource.url, secondSource.url, recording.url]);
    expect(timers.size).toBe(0);
});
