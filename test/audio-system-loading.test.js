/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AudioSystem} from '../ext/js/media/audio-system.js';

afterEach(() => { vi.unstubAllGlobals(); });

class FakeAudio extends EventTarget {
    /** @param {string} url */
    constructor(url) {
        super();
        this.src = url;
        this.readyState = 0;
        /** @type {Error|null} */
        this.error = null;
        this.duration = 1;
        this.pauses = 0;
        this.loads = 0;
        /** @type {Map<string, Set<EventListenerOrEventListenerObject|null>>} */
        this.listeners = new Map();
    }

    /**
     * @param {string} type
     * @param {EventListenerOrEventListenerObject|null} listener
     * @param {boolean|AddEventListenerOptions} [options]
     */
    addEventListener(type, listener, options) {
        super.addEventListener(type, listener, options);
        let listeners = this.listeners.get(type);
        if (typeof listeners === 'undefined') {
            listeners = new Set();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    /**
     * @param {string} type
     * @param {EventListenerOrEventListenerObject|null} listener
     * @param {boolean|EventListenerOptions} [options]
     */
    removeEventListener(type, listener, options) {
        super.removeEventListener(type, listener, options);
        const listeners = this.listeners.get(type);
        listeners?.delete(listener);
        if (listeners?.size === 0) { this.listeners.delete(type); }
    }

    pause() { ++this.pauses; }

    /** @param {string} name */
    removeAttribute(name) {
        if (name === 'src') { this.src = ''; }
    }

    load() {
        ++this.loads;
        // Resetting the native element may deliver a subsequent abort event.
        this.dispatchEvent(new Event('abort'));
    }
}

function setup(initialize = /** @type {(audio: FakeAudio) => void} */ (() => {})) {
    /** @type {FakeAudio[]} */
    const audios = [];
    /** @type {Map<number, {callback: () => void, delay: number}>} */
    const timers = new Map();
    let nextTimer = 0;
    vi.stubGlobal('Audio', class extends FakeAudio {
        /** @param {string} url */
        constructor(url) {
            super(url);
            initialize(this);
            audios.push(this);
        }
    });
    /**
     * @param {() => void} callback
     * @param {number} delay
     * @returns {number}
     */
    const scheduleTimeout = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, {callback, delay});
        return id;
    };
    vi.stubGlobal('setTimeout', scheduleTimeout);
    vi.stubGlobal('clearTimeout', /** @param {number} id */ (id) => { timers.delete(id); });
    const expire = () => {
        const pending = [...timers.values()];
        timers.clear();
        for (const {callback} of pending) { callback(); }
    };
    return {system: new AudioSystem(null), audios, timers, expire};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 6; ++i) { await Promise.resolve(); }
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

test('successful media loading removes both completion listeners and its timer', async () => {
    const {system, audios, timers} = setup();
    const result = observe(system.createAudio('https://audio.example/ok.mp3', 'custom'));
    audios[0].dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(result.status).toBe('fulfilled');
    expect(result.value).toBe(audios[0]);
    expect(audios[0].listeners.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(audios[0].pauses).toBe(0);
    expect(audios[0].loads).toBe(0);
});

for (const event of ['error', 'abort']) {
    test(`${event} settles loading and releases the failed media resource`, async () => {
        const {system, audios, timers} = setup();
        const result = observe(system.createAudio('https://audio.example/fail.mp3', 'custom'));
        const error = new Error('network failure');
        audios[0].error = error;
        audios[0].dispatchEvent(new Event(event));
        await flush();
        expect(result.status).toBe('rejected');
        expect(result.error instanceof Error).toBe(true);
        if (event === 'error') { expect(result.error).toBe(error); }
        expect(audios[0].listeners.size).toBe(0);
        expect(timers.size).toBe(0);
        expect(audios[0].src).toBe('');
        expect(audios[0].pauses).toBe(1);
        expect(audios[0].loads).toBe(1);
    });
}

test('a source that emits neither loadeddata nor error cannot block fallback indefinitely', async () => {
    const {system, audios, timers, expire} = setup();
    const result = observe(system.createAudio('https://audio.example/stall.mp3', 'custom'));
    expect([...timers.values()].map(({delay}) => delay)).toEqual([15000]);
    expire();
    await flush();
    expect(result.status).toBe('rejected');
    expect(result.error instanceof Error).toBe(true);
    expect(audios[0].listeners.size).toBe(0);
    expect(audios[0].src).toBe('');
    expect(audios[0].loads).toBe(1);
    audios[0].dispatchEvent(new Event('loadeddata'));
    expect(timers.size).toBe(0);
    expect(audios[0].loads).toBe(1);
});

test('already-loaded audio does not wait for an event that has already fired', async () => {
    const {system, audios, timers} = setup((audio) => { audio.readyState = 2; });
    const result = observe(system.createAudio('https://audio.example/cached.mp3', 'custom'));
    await flush();
    expect(result.status).toBe('fulfilled');
    expect(audios[0].listeners.size).toBe(0);
    expect(timers.size).toBe(0);
});

test('pre-existing media errors are rejected without waiting for another error event', async () => {
    const error = new Error('cached failure');
    const {system, audios, timers} = setup((audio) => { audio.error = error; });
    const result = observe(system.createAudio('https://audio.example/bad.mp3', 'custom'));
    await flush();
    expect(result.status).toBe('rejected');
    expect(result.error).toBe(error);
    expect(audios[0].listeners.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(audios[0].loads).toBe(1);
});

test('a rejected provider placeholder is released after its data loads', async () => {
    const {system, audios, timers} = setup((audio) => { audio.duration = 5.694694; });
    const result = observe(system.createAudio('https://audio.example/placeholder.mp3', 'jpod101'));
    audios[0].dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(result.status).toBe('rejected');
    expect(audios[0].src).toBe('');
    expect(audios[0].listeners.size).toBe(0);
    expect(audios[0].loads).toBe(1);
    expect(timers.size).toBe(0);
});

test('independent media loads cannot cancel each other’s deadlines or resources', async () => {
    const {system, audios, timers, expire} = setup();
    const first = observe(system.createAudio('https://audio.example/first.mp3', 'custom'));
    const second = observe(system.createAudio('https://audio.example/second.mp3', 'custom'));
    audios[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(second.status).toBe('fulfilled');
    expect(timers.size).toBe(1);
    expire();
    await flush();
    expect(first.status).toBe('rejected');
    expect(audios[0].loads).toBe(1);
    expect(audios[1].loads).toBe(0);
    expect(audios[1].pauses).toBe(0);
});

test('a later request can recover after a stalled request times out', async () => {
    const {system, audios, expire} = setup();
    const first = observe(system.createAudio('https://audio.example/retry.mp3', 'custom'));
    expire();
    await flush();
    expect(first.status).toBe('rejected');
    const retry = observe(system.createAudio('https://audio.example/retry.mp3', 'custom'));
    audios[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(retry.status).toBe('fulfilled');
    expect(audios[1].loads).toBe(0);
});

test('an error event without a MediaError still rejects with a useful error', async () => {
    const {system, audios} = setup();
    const result = observe(system.createAudio('https://audio.example/error.mp3', 'custom'));
    audios[0].dispatchEvent(new Event('error'));
    await flush();
    expect(result.status).toBe('rejected');
    expect(result.error instanceof Error).toBe(true);
    expect(audios[0].listeners.size).toBe(0);
});
