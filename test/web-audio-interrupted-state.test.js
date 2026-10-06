/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {afterEach, test, vi} from 'vitest';
import {WebAudioLocalAudio} from '../ext/js/media/web-audio-local-audio.js';

/** @type {{state: string}[]} */
const contexts = [];
afterEach(() => {
    for (const context of contexts.splice(0)) { context.state = 'closed'; }
    vi.unstubAllGlobals();
});

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (reason: unknown) => void}} */
function deferred() {
    let resolve = () => {};
    let reject = (/** @type {unknown} */ _reason) => {};
    /** @type {Promise<void>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @param {string} [initialState]
 * @returns {*}
 */
function setup(initialState = 'interrupted') {
    const stats = {starts: 0, stops: 0, decodes: 0, sourceDisconnects: 0, gainDisconnects: 0};
    class Context {
        constructor() {
            this.state = initialState;
            this.destination = {};
            /** @type {ReturnType<typeof deferred>[]} */
            this.resumes = [];
            contexts.push(this);
        }

        async decodeAudioData() {
            ++stats.decodes;
            return {duration: 2};
        }

        resume() {
            const pending = deferred();
            this.resumes.push(pending);
            return pending.promise;
        }

        createBufferSource() {
            return {
                buffer: null,
                onended: null,
                connect() {},
                start() { ++stats.starts; },
                stop() { ++stats.stops; },
                disconnect() { ++stats.sourceDisconnects; },
            };
        }

        createGain() {
            return {gain: {value: 1}, connect() {}, disconnect() { ++stats.gainDisconnects; }};
        }
    }
    vi.stubGlobal('AudioContext', Context);
    const audio = new WebAudioLocalAudio('AQID', 'audio/wav');
    const context = /** @type {Context} */ (/** @type {unknown} */ (audio._audioContext));
    return {audio, context, stats};
}

for (const initialState of ['interrupted', 'suspended']) {
    test(`${initialState} preparation waits for a resumed context before confirming playback`, async () => {
        const {audio, context, stats} = setup(initialState);
        await audio.prepare();
        let settled = false;
        const playing = audio.play().then(() => { settled = true; });
        await flush();
        const beforeResume = {settled, resumes: context.resumes.length, starts: stats.starts};
        context.state = 'running';
        context.resumes[0]?.resolve();
        await playing;
        assert.deepEqual(beforeResume, {settled: false, resumes: 1, starts: 0});
        assert.equal(stats.starts, 1);
        assert.equal(stats.decodes, 1);
        audio.pause();
    });

    test(`${initialState} cancellation settles before resume and cannot start obsolete audio`, async () => {
        const {audio, context, stats} = setup(initialState);
        await audio.prepare();
        let settled = false;
        const playing = audio.play().then(() => { settled = true; });
        audio.pause();
        await flush();
        const afterCancel = {settled, starts: stats.starts, resumes: context.resumes.length};
        context.state = 'running';
        context.resumes[0]?.resolve();
        await playing;
        assert.deepEqual(afterCancel, {settled: true, starts: 0, resumes: 1});
        assert.equal(stats.starts, 0);
        assert.equal(audio._bufferSource, null);
        assert.equal(audio._playCleanup, null);
    });
}

test('an interrupted resume failure rejects with its cause and the same decoded audio is retryable', async () => {
    const {audio, context, stats} = setup();
    await audio.prepare();
    const failure = new Error('Audio device unavailable');
    const observed = audio.play().then(() => null, (/** @type {unknown} */ error) => error);
    context.resumes[0]?.reject(failure);
    const error = await observed;
    const startsBeforeRetry = stats.starts;
    context.state = 'running';
    await audio.play();
    assert.equal(error, failure);
    assert.equal(startsBeforeRetry, 0);
    assert.equal(stats.starts, 1);
    assert.equal(stats.decodes, 1);
    audio.pause();
});

test('the newer interrupted playback owns startup after the old resume fails', async () => {
    const {audio, context, stats} = setup();
    await audio.prepare();
    const first = audio.play();
    const second = audio.play();
    await flush();
    const beforeResume = stats.starts;
    context.state = 'running';
    context.resumes[1]?.resolve();
    await second;
    context.resumes[0]?.reject(new Error('Obsolete resume'));
    await first;
    await flush();
    assert.equal(beforeResume, 0);
    assert.equal(context.resumes.length, 2);
    assert.equal(stats.starts, 1);
    assert.equal(stats.stops, 0);
    audio.pause();
});

test('running playback neither resumes nor decodes an already prepared buffer again', async () => {
    const {audio, context, stats} = setup('running');
    await audio.prepare();
    await audio.play();
    await audio.play();
    assert.equal(context.resumes.length, 0);
    assert.equal(stats.starts, 2);
    assert.equal(stats.decodes, 1);
    assert.equal(stats.stops, 1);
    audio.pause();
});

test('an unprepared interrupted recording does not request playback permission', async () => {
    const {audio, context, stats} = setup();
    await audio.play();
    assert.equal(context.resumes.length, 0);
    assert.equal(stats.starts, 0);
});

test('resuming one interrupted wrapper does not revive a cancelled peer sharing its context', async () => {
    const {audio: first, context, stats} = setup();
    const second = new WebAudioLocalAudio('BAUG', 'audio/wav');
    await Promise.all([first.prepare(), second.prepare()]);
    const cancelled = first.play();
    const winner = second.play();
    first.pause();
    await flush();
    const beforeResume = stats.starts;
    context.state = 'running';
    for (const resume of context.resumes) { resume.resolve(); }
    await Promise.all([cancelled, winner]);
    assert.equal(beforeResume, 0);
    assert.equal(stats.starts, 1);
    assert.equal(first._bufferSource, null);
    assert.notEqual(second._bufferSource, null);
    second.pause();
});
