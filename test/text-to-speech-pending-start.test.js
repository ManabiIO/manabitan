/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {TextToSpeechAudio} from '../ext/js/media/text-to-speech-audio.js';

afterEach(() => { vi.unstubAllGlobals(); });

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

class FakeUtterance extends EventTarget {
    /** @param {string} text */
    constructor(text) {
        super();
        this.text = text;
        this.lang = '';
        this.volume = 1;
        /** @type {SpeechSynthesisVoice|null} */
        this.voice = null;
        /** @type {Map<string, Set<EventListenerOrEventListenerObject|null>>} */
        this.listeners = new Map();
    }

    /**
     * @param {string} name
     * @param {EventListenerOrEventListenerObject|null} listener
     */
    addEventListener(name, listener) {
        super.addEventListener(name, listener);
        let items = this.listeners.get(name);
        if (typeof items === 'undefined') {
            items = new Set();
            this.listeners.set(name, items);
        }
        items.add(listener);
    }

    /**
     * @param {string} name
     * @param {EventListenerOrEventListenerObject|null} listener
     */
    removeEventListener(name, listener) {
        super.removeEventListener(name, listener);
        const items = this.listeners.get(name);
        items?.delete(listener);
        if (items?.size === 0) { this.listeners.delete(name); }
    }
}

function setup() {
    /** @type {FakeUtterance[]} */
    const spoken = [];
    /** @type {FakeUtterance[]} */
    const queue = [];
    const stats = {starts: 0, cancels: 0, active: /** @type {FakeUtterance|null} */ (null)};
    const voice = /** @type {SpeechSynthesisVoice} */ (/** @type {unknown} */ ({voiceURI: 'fixture', lang: 'ja-JP'}));
    const synthesis = {
        getVoices: () => [voice],
        /** @param {FakeUtterance} utterance */
        speak(utterance) {
            spoken.push(utterance);
            queue.push(utterance);
        },
        cancel() {
            ++stats.cancels;
            queue.length = 0;
            stats.active = null;
            // Some engines omit cancellation events for not-yet-started speech.
        },
    };
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', synthesis);
    const startNext = () => {
        const utterance = queue.shift();
        if (typeof utterance === 'undefined') { return; }
        ++stats.starts;
        stats.active = utterance;
        utterance.dispatchEvent(new Event('start'));
    };
    return {audio: new TextToSpeechAudio('音声', voice), voice, synthesis, spoken, queue, stats, startNext};
}

function setupPlayer() {
    const speech = setup();
    const {voice} = speech;
    vi.stubGlobal('document', {documentElement: {dataset: {}}, querySelector: () => ({})});
    /** @type {Set<string>} */
    const overrides = new Set();
    let nextOverride = 0;
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {enabled: true, autoPlay: false, fallbackSoundType: 'none', volume: 70, enableDefaultAudioSources: false, sources: [{type: 'text-to-speech', url: '', voice: voice.voiceURI}]},
    }));
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {getTermAudioInfoList: async () => [{type: 'tts', text: '音声', voice: voice.voiceURI}]}},
        getOptions: () => options,
        getLanguageSummary: () => ({iso: 'ja'}),
        dictionaryEntries: [{type: 'term', headwords: [{term: '音声', reading: 'おんせい'}]}],
        dictionaryEntryNodes: [],
        progressIndicatorVisible: {
            setOverride() {
                const token = `progress-${++nextOverride}`;
                overrides.add(token);
                return token;
            },
            /** @param {string} token */
            clearOverride(token) { overrides.delete(token); },
        },
    }));
    const player = new DisplayAudio(display);
    player._dataTransmissionConsentRequired = true;
    player._setDataTransmissionConsentState('accepted');
    player._onOptionsUpdated({options});
    return {...speech, player, options, overrides};
}

test('play resolves on speech start, not when an utterance is merely queued', async () => {
    const {audio, spoken, startNext} = setup();
    let resolved = false;
    const promise = audio.play().then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    expect(spoken.length).toBe(1);
    startNext();
    await promise;
    expect(resolved).toBe(true);
    expect(spoken[0].listeners.size).toBe(0);
});

for (const cancellation of ['hide', 'content', 'options', 'consent']) {
    test(`${cancellation} retires queued speech before it starts through the real display/audio classes`, async () => {
        const {player, options, overrides, spoken, queue, stats, startNext} = setupPlayer();
        const request = player._playAudio(0, 0, player._audioSources, null);
        await flush();
        expect(spoken.length).toBe(1);
        switch (cancellation) {
            case 'hide': player._onFrameVisibilityChange({value: false}); break;
            case 'content': player._onContentClear(); break;
            case 'options': player._onOptionsUpdated({options}); break;
            default: player._setDataTransmissionConsentState('declined'); break;
        }
        startNext();
        expect(stats.starts).toBe(0);
        expect(queue.length).toBe(0);
        expect((await request).valid).toBe(false);
        expect(overrides.size).toBe(0);
        expect(spoken[0].listeners.size).toBe(0);
    });
}

test('repeated play retires the previous promise and ignores its delayed events', async () => {
    const {audio, spoken, startNext} = setup();
    const first = audio.play();
    await flush();
    let secondResolved = false;
    const second = audio.play().then(() => { secondResolved = true; });
    await first;
    spoken[0].dispatchEvent(new Event('start'));
    await flush();
    expect(secondResolved).toBe(false);
    expect(spoken[0] === spoken[1]).toBe(false);
    expect(spoken[0].listeners.size).toBe(0);
    startNext();
    await second;
    expect(secondResolved).toBe(true);
    expect(spoken[1].listeners.size).toBe(0);
});

for (const event of ['start', 'end']) {
    test(`${event} settles the speech promise and removes all startup listeners`, async () => {
        const {audio, spoken} = setup();
        const promise = audio.play();
        spoken[0].dispatchEvent(new Event(event));
        await promise;
        expect(spoken[0].listeners.size).toBe(0);
    });
}

test('a pre-start error rejects playback and removes all startup listeners', async () => {
    const {audio, spoken} = setup();
    const promise = audio.play();
    spoken[0].dispatchEvent(new Event('error'));
    const error = await promise.then(() => null, (reason) => reason);
    expect(error instanceof Error).toBe(true);
    expect(error?.message).toBe('Speech synthesis failed before playback started');
    expect(spoken[0].listeners.size).toBe(0);
    expect(audio._utterance).toBe(null);
});

test('display does not confirm speech that errors before it starts', async () => {
    const {player, spoken, overrides} = setupPlayer();
    const request = player._playAudio(0, 0, player._audioSources, null);
    await flush();
    spoken[0].dispatchEvent(new Event('error'));
    const result = await request;
    expect(result.valid).toBe(false);
    expect(player._audioPlaying).toBe(null);
    expect(player._audioPlayPending).toBe(false);
    expect(overrides.size).toBe(0);
    expect(spoken[0].listeners.size).toBe(0);
});

test('pause settles a queued play even without an engine cancellation event', async () => {
    const {audio, spoken, queue} = setup();
    const promise = audio.play();
    audio.pause();
    await promise;
    expect(queue.length).toBe(0);
    expect(spoken[0].listeners.size).toBe(0);
});

test('synchronous speak failure rejects with its cause and cleans up', async () => {
    const {audio, synthesis, spoken} = setup();
    const failure = new Error('Speech service unavailable');
    synthesis.speak = (utterance) => {
        spoken.push(utterance);
        throw failure;
    };
    const error = await audio.play().then(() => null, (reason) => reason);
    expect(error).toBe(failure);
    expect(spoken[0].listeners.size).toBe(0);
    expect(audio._utterance).toBe(null);
});

test('voice, text and volume are retained across a new speech attempt', async () => {
    const {audio, voice, spoken, startNext} = setup();
    audio.volume = 0.4;
    const first = audio.play();
    expect(spoken[0].text).toBe('音声');
    expect(spoken[0].lang).toBe('ja-JP');
    expect(spoken[0].voice).toBe(voice);
    expect(spoken[0].volume).toBe(0.4);
    startNext();
    await first;
    audio.pause();
    audio.volume = 0.2;
    const second = audio.play();
    expect(spoken[1].volume).toBe(0.2);
    startNext();
    await second;
});

for (const action of ['hide', 'content']) {
    test(`${action} preserves speech that the engine has already started`, async () => {
        const {player, stats, startNext, overrides} = setupPlayer();
        const request = player._playAudio(0, 0, player._audioSources, null);
        await flush();
        startNext();
        expect((await request).valid).toBe(true);
        const active = stats.active;
        const cancels = stats.cancels;
        if (action === 'hide') {
            player._onFrameVisibilityChange({value: false});
        } else {
            player._onContentClear();
        }
        expect(stats.active).toBe(active);
        expect(stats.cancels).toBe(cancels);
        expect(overrides.size).toBe(0);
        player.stopAudio();
        expect(stats.active).toBe(null);
    });
}

test('overlapping display requests start only the winning cached speech attempt', async () => {
    const {player, spoken, queue, stats, startNext, overrides} = setupPlayer();
    const first = player._playAudio(0, 0, player._audioSources, null);
    await flush();
    const second = player._playAudio(0, 0, player._audioSources, null);
    await flush();
    expect(queue.length).toBe(1);
    spoken[0].dispatchEvent(new Event('start'));
    await flush();
    expect(player._audioPlayPending).toBe(true);
    startNext();
    expect((await first).valid).toBe(false);
    expect((await second).valid).toBe(true);
    expect(stats.starts).toBe(1);
    expect(overrides.size).toBe(0);
});

test('pause still releases the pending promise if the native cancel call throws', async () => {
    const {audio, synthesis, spoken} = setup();
    const request = audio.play();
    synthesis.cancel = () => { throw new Error('Speech service disconnected'); };
    audio.pause();
    await request;
    expect(spoken[0].listeners.size).toBe(0);
});

for (const action of ['play', 'pause']) {
    test(`another speech wrapper's ${action} settles a globally cancelled startup`, async () => {
        const {audio, voice, spoken, startNext} = setup();
        let firstSettled = false;
        const first = audio.play().then(() => { firstSettled = true; });
        const other = new TextToSpeechAudio('別の音声', voice);
        const second = action === 'play' ? other.play() : null;
        if (action === 'pause') { other.pause(); }
        await flush();
        expect(firstSettled).toBe(true);
        expect(spoken[0].listeners.size).toBe(0);
        if (second !== null) {
            spoken[0].dispatchEvent(new Event('start'));
            await flush();
            startNext();
            await second;
            expect(spoken[1].listeners.size).toBe(0);
        }
        await first;
    });
}
