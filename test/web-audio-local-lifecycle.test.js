/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {WebAudioLocalAudio} from '../ext/js/media/web-audio-local-audio.js';

/** @type {{state: string}[]} */
const contextsToClose = [];
afterEach(() => {
    // Retire the module's shared context between tests without replacing the
    // implementation or relying on module-cache resets in the adapter.
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
    for (let i = 0; i < 24; ++i) { await Promise.resolve(); }
}

function setup(initialState = 'suspended') {
    const stats = {
        contexts: /** @type {FakeContext[]} */ ([]),
        resumes: /** @type {ReturnType<typeof deferred<void>>[]} */ ([]),
        starts: /** @type {{context: FakeContext, offset: number}[]} */ ([]),
        decodes: 0,
        stops: 0,
        sourceDisconnects: 0,
        gainDisconnects: 0,
        failStart: false,
    };
    class FakeContext {
        constructor() {
            this.state = initialState;
            this.destination = {};
            stats.contexts.push(this);
            contextsToClose.push(this);
        }

        /** @returns {Promise<{duration: number}>} */
        async decodeAudioData() {
            ++stats.decodes;
            if (this.state === 'closed') { throw new Error('Context closed'); }
            return {duration: 1};
        }

        /** @returns {Promise<void>} */
        resume() {
            /** @type {ReturnType<typeof deferred<void>>} */
            const pending = deferred();
            stats.resumes.push(pending);
            return pending.promise;
        }

        createBufferSource() {
            const context = this;
            return {
                buffer: null,
                onended: null,
                connect() {},
                /**
                 * @param {number} _when
                 * @param {number} offset
                 */
                start(_when, offset) {
                    if (stats.failStart) { throw new Error('Start failed'); }
                    stats.starts.push({context, offset});
                },
                stop() { ++stats.stops; },
                disconnect() { ++stats.sourceDisconnects; },
            };
        }

        createGain() {
            return {
                gain: {value: 1},
                connect() {},
                disconnect() { ++stats.gainDisconnects; },
            };
        }
    }
    vi.stubGlobal('AudioContext', FakeContext);
    return {audio: new WebAudioLocalAudio('AA==', 'audio/wav'), stats};
}

test('pause settles suspended playback without waiting for a future user gesture', async () => {
    const {audio, stats} = setup();
    await audio.prepare();
    let settled = false;
    const request = audio.play().then(() => { settled = true; });
    await flush();
    audio.pause();
    await flush();
    const settledBeforeGesture = settled;
    stats.resumes[0].resolve();
    await request;
    expect(settledBeforeGesture).toBe(true);
    expect(stats.starts.length).toBe(0);
});

test('an obsolete resume rejection cannot reject an already cancelled play', async () => {
    const {audio, stats} = setup();
    await audio.prepare();
    let outcome = 'pending';
    const request = audio.play().then(() => {
        outcome = 'fulfilled';
    }, () => {
        outcome = 'rejected';
    });
    audio.pause();
    await flush();
    const beforeRejection = outcome;
    stats.resumes[0].reject(new Error('Context closed after cancellation'));
    await request;
    expect(beforeRejection).toBe('fulfilled');
    expect(outcome).toBe('fulfilled');
    expect(stats.starts.length).toBe(0);
});

for (const completion of ['old-first', 'new-first']) {
    test(`replacement releases the old pending play with ${completion} resume completion`, async () => {
        const {audio, stats} = setup();
        await audio.prepare();
        let firstSettled = false;
        const first = audio.play().then(() => { firstSettled = true; });
        const second = audio.play();
        await flush();
        const settledBeforeResume = firstSettled;
        const order = completion === 'old-first' ? [0, 1] : [1, 0];
        for (const index of order) {
            stats.contexts[0].state = 'running';
            stats.resumes[index].resolve();
            await flush();
        }
        await Promise.all([first, second]);
        expect(settledBeforeResume).toBe(true);
        expect(stats.starts.length).toBe(1);
        audio.pause();
        expect(stats.sourceDisconnects).toBe(1);
        expect(stats.gainDisconnects).toBe(1);
    });
}

test('cancelled startup does not stop an independent wrapper sharing the context', async () => {
    const {audio, stats} = setup();
    const other = new WebAudioLocalAudio('AA==', 'audio/wav');
    await Promise.all([audio.prepare(), other.prepare()]);
    let firstSettled = false;
    const first = audio.play().then(() => { firstSettled = true; });
    const second = other.play();
    audio.pause();
    await flush();
    const settledBeforeResume = firstSettled;
    stats.contexts[0].state = 'running';
    for (const resume of stats.resumes) { resume.resolve(); }
    await Promise.all([first, second]);
    expect(settledBeforeResume).toBe(true);
    expect(stats.contexts.length).toBe(1);
    expect(stats.starts.length).toBe(1);
    expect(stats.stops).toBe(0);
    other.pause();
});

test('a cached decoded recording recovers after the shared context closes', async () => {
    const {audio, stats} = setup('running');
    await audio.prepare();
    const previous = stats.contexts[0];
    previous.state = 'closed';
    await audio.play();
    expect(stats.contexts.length).toBe(2);
    expect(stats.starts.length).toBe(1);
    expect(stats.starts[0].context === previous).toBe(false);
    expect(stats.starts[0].context.state).toBe('running');
    expect(stats.decodes).toBe(1);
    audio.pause();
});

test('several cached recordings reuse one replacement context without decoding again', async () => {
    const {audio, stats} = setup('running');
    const other = new WebAudioLocalAudio('AA==', 'audio/wav');
    await Promise.all([audio.prepare(), other.prepare()]);
    stats.contexts[0].state = 'closed';
    await audio.play();
    await other.play();
    expect(stats.contexts.length).toBe(2);
    expect(stats.starts[0].context).toBe(stats.starts[1].context);
    expect(stats.starts[0].context.state).toBe('running');
    expect(stats.decodes).toBe(2);
    audio.pause();
    other.pause();
});

test('preparation recovers when its context closed before decoding started', async () => {
    const {audio, stats} = setup('running');
    stats.contexts[0].state = 'closed';
    let outcome = 'pending';
    await audio.prepare().then(() => {
        outcome = 'fulfilled';
    }, () => {
        outcome = 'rejected';
    });
    expect(outcome).toBe('fulfilled');
    expect(stats.contexts.length).toBe(2);
    expect(audio.duration).toBe(1);
});

test('a current resume failure is still reported, and a later retry can play', async () => {
    const {audio, stats} = setup();
    await audio.prepare();
    const error = new Error('Resume rejected');
    const first = audio.play().then(() => null, (reason) => reason);
    stats.resumes[0].reject(error);
    expect(await first).toBe(error);
    stats.contexts[0].state = 'running';
    await audio.play();
    expect(stats.starts.length).toBe(1);
    audio.pause();
});

test('confirmed playback retains offset, volume, and cleanup behavior', async () => {
    const {audio, stats} = setup('running');
    await audio.prepare();
    audio.currentTime = 0.25;
    audio.volume = 0.4;
    await audio.play();
    expect(stats.starts[0].offset).toBe(0.25);
    expect(audio.volume).toBe(0.4);
    expect(stats.contexts.length).toBe(1);
    audio.pause();
    audio.pause();
    expect(stats.sourceDisconnects).toBe(1);
    expect(stats.gainDisconnects).toBe(1);
});

test('failed node startup disconnects both nodes and permits retry', async () => {
    const {audio, stats} = setup('running');
    await audio.prepare();
    stats.failStart = true;
    const failure = await audio.play().then(() => null, (reason) => reason);
    expect(failure instanceof Error).toBe(true);
    expect(stats.sourceDisconnects).toBe(1);
    expect(stats.gainDisconnects).toBe(1);
    stats.failStart = false;
    await audio.play();
    expect(stats.starts.length).toBe(1);
    audio.pause();
    expect(stats.sourceDisconnects).toBe(2);
    expect(stats.gainDisconnects).toBe(2);
});
