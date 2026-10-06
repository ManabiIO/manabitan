/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AudioSystem} from '../ext/js/media/audio-system.js';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {isLocalhostUrl} from '../ext/js/core/utilities.js';

/** @type {{state: string}[]} */
const contextsToClose = [];
afterEach(() => {
    for (const context of contextsToClose.splice(0)) {
        context.state = 'closed';
    }
    vi.unstubAllGlobals();
});

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(error: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 32; ++i) { await Promise.resolve(); }
}

function setup() {
    /** @type {Map<number, {callback: () => void, delay: number}>} */
    const timers = new Map();
    let nextTimer = 0;
    vi.stubGlobal('setTimeout', (/** @type {() => void} */ callback, /** @type {number} */ delay) => {
        const id = ++nextTimer;
        timers.set(id, {callback, delay});
        return id;
    });
    vi.stubGlobal('clearTimeout', (/** @type {number} */ id) => { timers.delete(id); });
    const expire = () => {
        const current = [...timers.entries()];
        for (const [id, {callback}] of current) {
            if (!timers.delete(id)) { continue; }
            callback();
        }
    };
    const stats = {
        requests: 0,
        decodes: 0,
        contexts: 0,
        localStarts: 0,
        remoteStarts: 0,
        decode: async () => ({duration: 1}),
    };
    vi.stubGlobal('AudioContext', class {
        constructor() {
            this.state = 'running';
            this.destination = {};
            ++stats.contexts;
            contextsToClose.push(this);
        }

        /** @returns {Promise<{duration: number}>} */
        async decodeAudioData() {
            ++stats.decodes;
            return await stats.decode();
        }

        createBufferSource() {
            return {
                buffer: null,
                onended: null,
                connect() {},
                start() { ++stats.localStarts; },
                stop() {},
                disconnect() {},
            };
        }

        createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
    });
    vi.stubGlobal('Audio', class {
        constructor() {
            this.readyState = 2;
            /** @type {MediaError|null} */
            this.error = null;
            this.currentTime = 0;
            this.volume = 1;
        }
        async play() { ++stats.remoteStarts; }
        pause() {}
    });
    const payload = {data: 'AA==', contentType: 'audio/wav'};
    const api = {
        /** @returns {Promise<{data: string, contentType: string}|null>} */
        fetchLocalAudioData: async () => {
            ++stats.requests;
            return payload;
        },
        /**
         * @param {{url: string}} source
         * @returns {Promise<{type: 'url', url: string}[]>}
         */
        getTermAudioInfoList: async (source) => [{type: 'url', url: source.url}],
    };
    const system = new AudioSystem(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)));
    return {system, api, stats, payload, timers, expire};
}

test('a stalled localhost bridge reaches its deadline without awaiting the bridge', async () => {
    const {system, api, stats, payload, timers, expire} = setup();
    /** @type {ReturnType<typeof deferred<{data: string, contentType: string}>>} */
    const fetch = deferred();
    api.fetchLocalAudioData = () => fetch.promise;
    let outcome = 'pending';
    const request = system.createAudio('http://localhost:5050/a.mp3', 'custom').then(() => {
        outcome = 'fulfilled';
    }, () => {
        outcome = 'rejected';
    });
    expire();
    await flush();
    const atDeadline = outcome;
    fetch.resolve(payload);
    await request;
    expect(atDeadline).toBe('rejected');
    expect(outcome).toBe('rejected');
    expect(stats.contexts).toBe(0);
    expect(stats.decodes).toBe(0);
    expect(timers.size).toBe(0);
});

test('the same local preparation deadline includes decoding', async () => {
    const {system, stats, timers, expire} = setup();
    /** @type {ReturnType<typeof deferred<{duration: number}>>} */
    const decode = deferred();
    stats.decode = () => decode.promise;
    let outcome = 'pending';
    const request = system.createAudio('http://127.0.0.1/a.mp3', 'custom').then(() => {
        outcome = 'fulfilled';
    }, () => {
        outcome = 'rejected';
    });
    await flush();
    const deadlines = [...timers.values()].map(({delay}) => delay);
    expire();
    await flush();
    const atDeadline = outcome;
    decode.resolve({duration: 1});
    await request;
    expect(deadlines).toEqual([15000]);
    expect(atDeadline).toBe('rejected');
    expect(outcome).toBe('rejected');
    expect(stats.localStarts).toBe(0);
    expect(timers.size).toBe(0);
});

for (const phase of ['fetch', 'decode']) {
    test(`a late ${phase} rejection after timeout is owned and a later request can recover`, async () => {
        const {system, api, stats, payload, timers, expire} = setup();
        /** @type {ReturnType<typeof deferred<{data: string, contentType: string}>>} */
        const fetch = deferred();
        /** @type {ReturnType<typeof deferred<{duration: number}>>} */
        const decode = deferred();
        if (phase === 'fetch') { api.fetchLocalAudioData = () => fetch.promise; } else { stats.decode = () => decode.promise; }
        let failure = /** @type {unknown} */ (null);
        const first = system.createAudio('http://localhost/a.mp3', 'custom').then(() => {}, (error) => { failure = error; });
        await flush();
        expire();
        await flush();
        const failureAtDeadline = failure;
        const lateError = new Error(`Late ${phase} failure`);
        if (phase === 'fetch') { fetch.reject(lateError); } else { decode.reject(lateError); }
        await first;
        expect(failureAtDeadline instanceof Error).toBe(true);
        expect(failure === lateError).toBe(false);
        api.fetchLocalAudioData = async () => payload;
        stats.decode = async () => ({duration: 1});
        const retry = await system.createAudio('http://localhost/a.mp3', 'custom');
        await retry.play();
        expect(stats.localStarts).toBe(1);
        expect(timers.size).toBe(0);
        retry.pause();
    });
}

for (const origin of ['http://localhost', 'https://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://[0:0:0:0:0:0:0:1]']) {
    test(`successful local preparation clears its deadline and preserves playback at ${origin}`, async () => {
        const {system, stats, timers, expire} = setup();
        const url = `${origin}/a.mp3`;
        // Keep URL classification in this integration test rather than masking
        // routing errors with a mocked helper or a direct private-method call.
        expect(isLocalhostUrl(url)).toBe(true);
        const audio = await system.createAudio(url, 'custom');
        expect(stats.requests).toBe(1);
        expect(stats.decodes).toBe(1);
        expect(timers.size).toBe(0);
        expire();
        await audio.play();
        expect(stats.localStarts).toBe(1);
        expect(stats.remoteStarts).toBe(0);
        audio.pause();
    });
}

for (const phase of ['fetch', 'decode']) {
    test(`current ${phase} failures retain their original error and release the timer`, async () => {
        const {system, api, stats, timers} = setup();
        const expectedError = new Error(`${phase} failed`);
        if (phase === 'fetch') { api.fetchLocalAudioData = async () => { throw expectedError; }; } else { stats.decode = async () => { throw expectedError; }; }
        const error = await system.createAudio('http://localhost/a.mp3', 'custom').then(() => null, (reason) => reason);
        expect(error).toBe(expectedError);
        expect(timers.size).toBe(0);
    });
}

test('a missing local response still fails without leaving a timer', async () => {
    const {system, api, timers} = setup();
    api.fetchLocalAudioData = async () => null;
    const error = await system.createAudio('http://localhost/a.mp3', 'custom').then(() => null, (reason) => reason);
    expect(error instanceof Error).toBe(true);
    expect(timers.size).toBe(0);
});

test('a successful remote request is unaffected by an unrelated local deadline', async () => {
    const {system, api, payload, stats, timers, expire} = setup();
    /** @type {ReturnType<typeof deferred<{data: string, contentType: string}>>} */
    const fetch = deferred();
    api.fetchLocalAudioData = () => fetch.promise;
    let outcome = 'pending';
    const local = system.createAudio('http://localhost/a.mp3', 'custom').then(() => {
        outcome = 'fulfilled';
    }, () => {
        outcome = 'rejected';
    });
    const remote = await system.createAudio('https://audio.example/a.mp3', 'custom');
    await remote.play();
    expire();
    await flush();
    const atDeadline = outcome;
    fetch.resolve(payload);
    await local;
    expect(atDeadline).toBe('rejected');
    expect(stats.remoteStarts).toBe(1);
    expect(stats.decodes).toBe(0);
    expect(timers.size).toBe(0);
});

test('local timeout permits real display source fallback and the next click retries local audio', async () => {
    const {system, api, payload, stats, timers, expire} = setup();
    /** @type {ReturnType<typeof deferred<{data: string, contentType: string}>>} */
    const fetch = deferred();
    api.fetchLocalAudioData = () => fetch.promise;
    vi.stubGlobal('document', {documentElement: {dataset: {}}, querySelector: () => ({})});
    /** @type {Set<string>} */
    const progress = new Set();
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {
            enabled: true, autoPlay: false, fallbackSoundType: 'none', volume: 70, enableDefaultAudioSources: false,
            sources: ['http://localhost/a.mp3', 'https://audio.example/a.mp3'].map((url) => ({type: 'custom', url, voice: ''})),
        },
    }));
    let nextProgress = 0;
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api},
        getOptions: () => options,
        getLanguageSummary: () => ({iso: 'ja'}),
        dictionaryEntries: [{type: 'term', headwords: [{term: '音声', reading: 'おんせい'}]}],
        dictionaryEntryNodes: [],
        progressIndicatorVisible: {
            setOverride() {
                const token = `progress-${++nextProgress}`;
                progress.add(token);
                return token;
            },
            /** @param {string} token */
            clearOverride(token) { progress.delete(token); },
        },
    }));
    const player = new DisplayAudio(display);
    player._audioSystem = system;
    player._onOptionsUpdated({options});
    let selectedIndex = -1;
    const first = player._playAudio(0, 0, player._audioSources, null).then((result) => { selectedIndex = result.source?.index ?? -1; });
    await flush();
    expire();
    await flush();
    const selectedAtDeadline = selectedIndex;
    // Always settle the intentional baseline's bridge so a failing assertion
    // does not turn into a cancelled test or retain unobserved promises.
    fetch.resolve(payload);
    await first;
    expect(selectedAtDeadline).toBe(1);
    expect(stats.remoteStarts).toBe(1);
    expect(progress.size).toBe(0);
    api.fetchLocalAudioData = async () => payload;
    const retry = await player._playAudio(0, 0, player._audioSources, null);
    expect(retry.source?.index).toBe(0);
    expect(stats.localStarts).toBe(1);
    expect(timers.size).toBe(0);
    expect(progress.size).toBe(0);
    player.stopAudio();
});
