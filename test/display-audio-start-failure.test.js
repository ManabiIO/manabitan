/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';

// These tests retain the production playback/cache/selection methods. Only
// the display shell and asynchronous audio/network boundaries are controlled.
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = (_value) => { throw new Error('deferred not initialized'); };
    /** @type {(reason: unknown) => void} */
    let reject = (_reason) => { throw new Error('deferred not initialized'); };
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/**
 * @param {Promise<void>} [playPromise]
 * @returns {{currentTime: number, volume: number, plays: number, pauses: number, play: () => Promise<void>, pause: () => void}}
 */
function makeAudio(playPromise = Promise.resolve()) {
    return {
        currentTime: 1,
        volume: 1,
        plays: 0,
        pauses: 0,
        play() { ++this.plays; return playPromise; },
        pause() { ++this.pauses; },
    };
}

function setup() {
    vi.stubGlobal('document', {documentElement: {dataset: {}}});
    const sources = [0, 1].map((index) => ({
        index,
        type: /** @type {const} */ ('custom'),
        url: `https://audio.example/${index}`,
        voice: '',
        name: `Source ${index}`,
        nameIndex: index,
        nameUnique: false,
        isInOptions: true,
        downloadable: true,
    }));
    const options = {
        general: {language: 'ja'},
        audio: {enabled: true, autoPlay: false, fallbackSoundType: 'none', volume: 70, sources: sources.map((source) => ({...source})), enableDefaultAudioSources: false},
    };
    /** @type {Set<object>} */
    const progress = new Set();
    const buttons = [0, 1].map(() => ({title: 'unchanged', dataset: {titleDefault: 'Play'}, querySelector: () => null}));
    const fallback = makeAudio();
    const calls = {menuUpdates: 0, consentPrompts: 0};
    const player = /** @type {DisplayAudio} */ (Object.create(DisplayAudio.prototype));
    Object.assign(player, {
        _audioPlaying: null,
        _playbackToken: null,
        _playbackProgressToken: null,
        _primaryCardAudioToken: {},
        _playbackVolume: 0.7,
        _autoPlayAudioTimer: null,
        _fallbackSoundType: 'none',
        _audioSources: sources,
        _entriesToken: {},
        _cache: new Map(),
        _cacheMaxSize: 256,
        _openMenus: new Set(),
        _eventListeners: {removeAllEventListeners() {}},
        _dataTransmissionConsentRequired: false,
        _dataTransmissionConsentState: 'accepted',
        _audioSourceTypeNames: new Map([['custom', 'Custom URL']]),
        _audioSystem: {getFallbackAudio: () => fallback},
        _display: {
            application: {api: {}},
            frameVisible: true,
            getLanguageSummary: () => ({iso: 'ja'}),
            getOptions: () => options,
            dictionaryEntries: [{type: 'term', headwords: [{term: 'first', reading: 'first'}, {term: 'second', reading: 'second'}]}],
            progressIndicatorVisible: {
                setOverride() {
                    const token = {};
                    progress.add(token);
                    return token;
                },
                /** @param {object} token */
                clearOverride(token) { expect(progress.delete(token)).toBe(true); },
            },
        },
        /**
         * @param {number} _entry
         * @param {number} headword
         * @returns {typeof buttons}
         */
        _getAudioPlayButtons: (_entry, headword) => [buttons[headword]],
        _updateOpenMenu: () => { ++calls.menuUpdates; },
        _showDataTransmissionConsentModal: () => { ++calls.consentPrompts; },
    });
    /**
     * @param {number} index
     * @returns {HTMLElement}
     */
    const item = (index) => /** @type {HTMLElement} */ (/** @type {unknown} */ ({
        closest: () => ({dataset: {index: `${index}`, subIndex: '0'}}),
    }));
    /**
     * @param {ReturnType<typeof makeAudio>} audio
     * @param {number} [index]
     * @returns {{audio: ReturnType<typeof makeAudio>, source: import('display-audio').AudioSource, subIndex: number}}
     */
    const info = (audio, index = 0) => ({audio, source: sources[index], subIndex: 0});
    /** @param {(term: string, reading: string, selected: typeof sources) => Promise<unknown>} callback */
    const setCreate = (callback) => { Reflect.set(player, '_createTermAudio', callback); };
    return {player, sources, options, progress, buttons, fallback, calls, item, info, setCreate};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
}

for (const failure of ['rejected', 'thrown']) {
    test(`${failure} playback is not confirmed and releases the failed audio`, async () => {
        const {player, sources, info, setCreate, progress, buttons} = setup();
        const error = new Error('Playback unavailable');
        const audio = makeAudio();
        audio.play = () => {
            ++audio.plays;
            if (failure === 'thrown') { throw error; }
            return Promise.reject(error);
        };
        setCreate(async () => info(audio));
        let thrown = false;
        const result = await player._playAudio(0, 0, sources, null).catch(() => { thrown = true; return null; });
        expect(thrown).toBe(false);
        expect(result?.valid).toBe(false);
        expect(player._audioPlaying).toBe(null);
        expect(player._audioPlayPending).toBe(false);
        expect(audio.pauses).toBe(1);
        expect(progress.size).toBe(0);
        expect(buttons[0].title.includes('Could not play audio')).toBe(true);
    });

    test(`${failure} source-menu playback never automatically pins an unheard recording`, async () => {
        const {player, sources, info, setCreate, item} = setup();
        const audio = makeAudio();
        audio.play = () => {
            if (failure === 'thrown') { throw new Error('Cannot start'); }
            return Promise.reject(new Error('Cannot start'));
        };
        player._setPrimaryAudio(0, 0, {source: sources[1], subIndex: 0}, false);
        setCreate(async () => info(audio));
        await player._playAudioFromSource(0, 0, item(0));
        expect(player._getCacheItem('first', 'first', false)?.primaryCardAudio).toEqual({index: 1, subIndex: 0});
    });
}

test('a rejected native play promise leaves cached preparation usable by a later user gesture', async () => {
    const {player, sources, progress, item} = setup();
    const audio = makeAudio();
    let attempts = 0;
    let metadata = 0;
    let preparations = 0;
    audio.play = async () => {
        ++attempts;
        if (attempts === 1) { throw new DOMException('Gesture required', 'NotAllowedError'); }
    };
    Reflect.set(player._display.application.api, 'getTermAudioInfoList', async () => {
        ++metadata;
        return [{type: 'url', url: 'https://audio.example/0'}];
    });
    Reflect.set(player._audioSystem, 'createAudio', async () => { ++preparations; return audio; });
    await player._playAudioFromSource(0, 0, item(0));
    expect(player._getCacheItem('first', 'first', false)?.primaryCardAudio).toBe(null);
    await player._playAudioFromSource(0, 0, item(0));
    expect(player._getCacheItem('first', 'first', false)?.primaryCardAudio).toEqual({index: 0, subIndex: 0});
    expect(metadata).toBe(1);
    expect(preparations).toBe(1);
    expect(attempts).toBe(2);
    expect(progress.size).toBe(0);
    expect(player._audioPlaying === audio).toBe(true);
    expect(player._audioPlayPending).toBe(false);
    expect(sources[0].downloadable).toBe(true);
});

test('a rejected older play cannot pause or clear the winning pronunciation', async () => {
    const {player, sources, info, setCreate, progress} = setup();
    /** @type {ReturnType<typeof deferred<void>>} */
    const rejected = deferred();
    const oldAudio = makeAudio(rejected.promise);
    const latestAudio = makeAudio();
    setCreate(async (term) => info(term === 'first' ? oldAudio : latestAudio));
    const old = player._playAudio(0, 0, sources, null);
    await flush();
    const latest = player._playAudio(0, 1, sources, null);
    await latest;
    rejected.reject(new Error('Obsolete failure'));
    expect((await old).valid).toBe(false);
    expect(latestAudio.pauses).toBe(0);
    expect(player._audioPlaying === latestAudio).toBe(true);
    expect(player._audioPlayPending).toBe(false);
    expect(progress.size).toBe(0);
});

test('confirmed playback still survives hide after an earlier failed attempt', async () => {
    const {player, sources, info, setCreate} = setup();
    const audio = makeAudio();
    let fails = true;
    audio.play = async () => { if (fails) { throw new Error('Try again'); } };
    setCreate(async () => info(audio));
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(false);
    fails = false;
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(true);
    const pauses = audio.pauses;
    player._onFrameVisibilityChange({value: false});
    expect(audio.pauses).toBe(pauses);
});

test('a failed fallback sound is released without becoming valid source audio', async () => {
    const {player, sources, setCreate, progress, fallback} = setup();
    setCreate(async () => null);
    fallback.play = async () => { throw new Error('No fallback decoder'); };
    const result = await player._playAudio(0, 0, sources, null);
    expect(result.valid).toBe(false);
    expect(player._audioPlaying).toBe(null);
    expect(player._audioPlayPending).toBe(false);
    expect(progress.size).toBe(0);
    expect(fallback.pauses).toBe(1);
});

test('a legacy synchronous successful play remains a confirmed success', async () => {
    const {player, sources, setCreate, info} = setup();
    const audio = makeAudio();
    Reflect.set(audio, 'play', () => {});
    setCreate(async () => info(audio));
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(true);
    expect(player._audioPlaying === audio).toBe(true);
    expect(player._audioPlayPending).toBe(false);
});


test('failure cleanup cannot overwrite a reentrant winner or its button title', async () => {
    const {player, sources, info, setCreate, progress, buttons} = setup();
    const failedAudio = makeAudio();
    const winnerAudio = makeAudio();
    failedAudio.play = async () => { throw new Error('Cannot start'); };
    /** @type {ReturnType<DisplayAudio['_playAudio']>|null} */
    let winner = null;
    failedAudio.pause = () => {
        ++failedAudio.pauses;
        buttons[0].title = 'new request';
        setCreate(async () => info(winnerAudio));
        winner = player._playAudio(0, 1, sources, null);
    };
    setCreate(async () => info(failedAudio));
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(false);
    await winner;
    expect(buttons[0].title).toBe('new request');
    expect(player._audioPlaying === winnerAudio).toBe(true);
    expect(winnerAudio.pauses).toBe(0);
    expect(progress.size).toBe(0);
});
