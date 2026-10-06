/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import {afterEach, test, vi} from 'vitest';
import {TextToSpeechAudio} from '../ext/js/media/text-to-speech-audio.js';

/** @type {TextToSpeechAudio[]} */
const players = [];
afterEach(() => {
    for (const player of players.splice(0)) { player.pause(); }
    vi.unstubAllGlobals();
});

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @param {boolean} [paused]
 * @returns {*}
 */
function setup(paused = true) {
    class Utterance extends EventTarget {
        /** @param {string} text */
        constructor(text) {
            super();
            this.text = text;
            this.lang = '';
            this.volume = 1;
            /** @type {SpeechSynthesisVoice|null} */
            this.voice = null;
        }
    }
    const stats = {
        cancels: 0,
        resumes: 0,
        failResume: false,
        starts: 0,
        spoken: /** @type {Utterance[]} */ ([]),
        queued: /** @type {Utterance|null} */ (null),
    };
    const engine = {
        paused,
        cancel() {
            ++stats.cancels;
            stats.queued = null;
            // Web Speech cancel clears the queue, not the paused state.
        },
        /** @param {Utterance} utterance */
        speak(utterance) {
            stats.spoken.push(utterance);
            stats.queued = utterance;
        },
        resume() {
            ++stats.resumes;
            if (stats.failResume) { throw new Error('Speech engine unavailable'); }
            engine.paused = false;
        },
    };
    const start = () => {
        if (engine.paused || stats.queued === null) { return; }
        ++stats.starts;
        stats.queued.dispatchEvent(new Event('start'));
    };
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', engine);
    const voice = /** @type {SpeechSynthesisVoice} */ ({lang: 'ja-JP', name: 'Fixture', voiceURI: 'fixture', default: true, localService: true});
    const create = () => {
        const player = new TextToSpeechAudio('音声', voice);
        players.push(player);
        return player;
    };
    return {player: create(), create, engine, stats, start};
}

test('explicit play resumes a paused speech engine but stays pending until speech starts', async () => {
    const {player, engine, stats, start} = setup();
    player.volume = 0.4;
    let settled = false;
    const playing = player.play().then(() => { settled = true; });
    await flush();
    const beforeStart = {resumes: stats.resumes, paused: engine.paused, settled};
    start();
    await flush();
    const afterStart = {settled, starts: stats.starts};
    player.pause();
    await playing;
    assert.deepEqual(beforeStart, {resumes: 1, paused: false, settled: false});
    assert.deepEqual(afterStart, {settled: true, starts: 1});
    assert.equal(stats.spoken[0].text, '音声');
    assert.equal(stats.spoken[0].lang, 'ja-JP');
    assert.equal(stats.spoken[0].volume, 0.4);
    assert.equal(player._playCleanup, null);
});

test('an already running speech engine is not resumed unnecessarily', async () => {
    const {player, stats, start} = setup(false);
    const playing = player.play();
    start();
    await playing;
    assert.equal(stats.resumes, 0);
    assert.equal(stats.starts, 1);
    assert.equal(player._playCleanup, null);
});

test('stop does not itself resume globally paused speech', () => {
    const {player, engine, stats} = setup();
    player.pause();
    assert.equal(engine.paused, true);
    assert.equal(stats.resumes, 0);
    assert.equal(stats.spoken.length, 0);
});

test('a resume failure releases the startup waiter and a later explicit play recovers', async () => {
    const {player, engine, stats, start} = setup();
    stats.failResume = true;
    let settled = false;
    const first = player.play().then(() => { settled = true; });
    await flush();
    const atFailure = {settled, resumes: stats.resumes, cleanup: player._playCleanup, queued: stats.queued};
    player.pause();
    await first;
    stats.failResume = false;
    const second = player.play();
    start();
    await flush();
    const recovered = !engine.paused && stats.starts === 1;
    player.pause();
    await second;
    assert.deepEqual(atFailure, {settled: true, resumes: 1, cleanup: null, queued: null});
    assert.equal(recovered, true);
    assert.equal(stats.resumes, 2);
});

test('cancelling a resumed but unstarted utterance prevents a later start', async () => {
    const {player, stats, start} = setup();
    const playing = player.play();
    player.pause();
    await playing;
    start();
    assert.equal(stats.resumes, 1);
    assert.equal(stats.starts, 0);
    assert.equal(player._utterance, null);
    assert.equal(player._playCleanup, null);
});

test('another wrapper can replace paused speech without an old start confirming its successor', async () => {
    const {player: first, create, engine, stats, start} = setup();
    const second = create();
    const old = first.play();
    const oldUtterance = stats.spoken[0];
    engine.paused = true;
    let settled = false;
    const latest = second.play().then(() => { settled = true; });
    await old;
    oldUtterance.dispatchEvent(new Event('start'));
    await flush();
    assert.equal(settled, false);
    start();
    await flush();
    const afterStart = {settled, starts: stats.starts, resumes: stats.resumes};
    second.pause();
    await latest;
    assert.deepEqual(afterStart, {settled: true, starts: 1, resumes: 2});
    assert.notEqual(stats.spoken[0], stats.spoken[1]);
});

test('a synchronous start after resuming is observed without retaining startup listeners', async () => {
    const {player, engine, stats, start} = setup();
    const speak = engine.speak.bind(engine);
    engine.speak = (/** @type {SpeechSynthesisUtterance} */ utterance) => {
        speak(utterance);
        start();
    };
    let settled = false;
    const playing = player.play().then(() => { settled = true; });
    await flush();
    const afterResume = {settled, cleanup: player._playCleanup, starts: stats.starts};
    player.pause();
    await playing;
    assert.deepEqual(afterResume, {settled: true, cleanup: null, starts: 1});
});
