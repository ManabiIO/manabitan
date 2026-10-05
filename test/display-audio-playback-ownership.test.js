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

test('a slower earlier request cannot stop or replace the latest pronunciation', async () => {
    const {player, sources, progress, buttons, info, setCreate} = setup();
    const old = deferred();
    const latest = deferred();
    setCreate((term) => (term === 'first' ? old.promise : latest.promise));
    const first = player._playAudio(0, 0, sources, null);
    const second = player._playAudio(0, 1, sources, null);
    const firstAudio = makeAudio();
    const secondAudio = makeAudio();
    latest.resolve(info(secondAudio));
    expect((await second).valid).toBe(true);
    old.resolve(info(firstAudio));
    expect((await first).valid).toBe(false);
    expect(firstAudio.plays).toBe(0);
    expect(secondAudio.plays).toBe(1);
    expect(secondAudio.pauses).toBe(0);
    expect(buttons[0].title).toBe('unchanged');
    expect(progress.size).toBe(0);
});

for (const invalidation of ['stop', 'content', 'hide', 'options', 'consent', 'consent-away-and-back']) {
    test(`pending playback is retired by ${invalidation}`, async () => {
        const {player, sources, options, progress, buttons, info, setCreate} = setup();
        const pending = deferred();
        setCreate(() => pending.promise);
        Reflect.set(player, '_dataTransmissionConsentRequired', true);
        const request = player._playAudio(0, 0, sources, null);
        switch (invalidation) {
            case 'stop': player.stopAudio(); break;
            case 'content': player._onContentClear(); break;
            case 'hide': player._onFrameVisibilityChange({value: false}); break;
            case 'options': player._onOptionsUpdated({options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ (options))}); break;
            default:
                player._setDataTransmissionConsentState('declined');
                if (invalidation === 'consent-away-and-back') { player._setDataTransmissionConsentState('accepted'); }
                break;
        }
        const audio = makeAudio();
        pending.resolve(info(audio));
        expect((await request).valid).toBe(false);
        expect(audio.plays).toBe(0);
        expect(buttons[0].title).toBe('unchanged');
        expect(progress.size).toBe(0);
    });
}

test('a cancelled miss does not play the fallback sound', async () => {
    const {player, sources, fallback, setCreate, progress} = setup();
    const pending = deferred();
    setCreate(() => pending.promise);
    const request = player._playAudio(0, 0, sources, null);
    player.stopAudio();
    pending.resolve(null);
    await request;
    expect(fallback.plays).toBe(0);
    expect(progress.size).toBe(0);
});

test('source-menu playback cannot bypass declined consent', async () => {
    const {player, calls, item, info, setCreate} = setup();
    let requests = 0;
    const audio = makeAudio();
    setCreate(async () => {
        ++requests;
        return info(audio);
    });
    Reflect.set(player, '_dataTransmissionConsentRequired', true);
    player._setDataTransmissionConsentState('declined');
    await player._playAudioFromSource(0, 0, item(0));
    expect(requests).toBe(0);
    expect(audio.plays).toBe(0);
    expect(calls.consentPrompts).toBe(1);
});

test('an older play promise cannot replace the newer primary Anki audio selection', async () => {
    const {player, sources, item, info, setCreate} = setup();
    /** @type {{promise: Promise<void>, resolve: (value?: void) => void, reject: (reason: unknown) => void}} */
    const oldPlay = deferred();
    const oldAudio = makeAudio(oldPlay.promise);
    const newAudio = makeAudio();
    setCreate(async (_term, _reading, selected) => info(selected[0] === sources[0] ? oldAudio : newAudio, selected[0].index));
    const first = player._playAudioFromSource(0, 0, item(0));
    await flush();
    await player._playAudioFromSource(0, 0, item(1));
    expect(player._getPrimaryCardAudio('first', 'first')?.index).toBe(1);
    oldPlay.resolve();
    await first;
    expect(player._getPrimaryCardAudio('first', 'first')?.index).toBe(1);
    expect(newAudio.pauses).toBe(0);
});

test('cancelled source discovery does not admit a second source or update menus', async () => {
    const {player, sources, calls, progress} = setup();
    const pending = deferred();
    let requests = 0;
    Reflect.set(player, '_getTermAudioInfoList', () => {
        ++requests;
        return pending.promise;
    });
    const request = player._playAudio(0, 0, sources, null);
    player.stopAudio();
    pending.resolve([]);
    await request;
    expect(requests).toBe(1);
    expect(calls.menuUpdates).toBe(0);
    expect(progress.size).toBe(0);
});

test('cancelled media failure does not start the next recording', async () => {
    const {player, sources, progress, calls} = setup();
    const pending = deferred();
    let requests = 0;
    Reflect.set(player, '_getTermAudioInfoList', async () => [0, 1].map(() => ({info: {type: 'url', url: 'https://audio.example/'}, audio: null, audioPromise: null, audioResolved: false})));
    Reflect.set(player, '_createAudioFromInfo', () => {
        ++requests;
        return pending.promise;
    });
    const request = player._playAudio(0, 0, sources, null);
    await flush();
    player.stopAudio();
    pending.reject(new Error('source unavailable'));
    await request;
    expect(requests).toBe(1);
    expect(calls.menuUpdates).toBe(0);
    expect(progress.size).toBe(0);
});

test('superseded callers may share a cached decode without pausing the winning audio', async () => {
    const {player, sources, progress} = setup();
    const pending = deferred();
    let requests = 0;
    Reflect.set(player, '_getTermAudioInfoList', async () => [{info: {type: 'url', url: 'https://audio.example/'}, audio: null, audioPromise: null, audioResolved: false}]);
    Reflect.set(player, '_createAudioFromInfo', () => {
        ++requests;
        return pending.promise;
    });
    const first = player._playAudio(0, 0, sources, null);
    await flush();
    const second = player._playAudio(0, 0, sources, null);
    await flush();
    const audio = makeAudio();
    pending.resolve(audio);
    const results = await Promise.all([first, second]);
    expect(results.map(({valid}) => valid)).toEqual([false, true]);
    expect(requests).toBe(1);
    expect(audio.plays).toBe(1);
    expect(audio.pauses).toBe(0);
    expect(progress.size).toBe(0);
});

test('hiding or clearing the popup preserves already-started audio, and stop still pauses it', async () => {
    const {player, sources, info, setCreate} = setup();
    const audio = makeAudio();
    setCreate(async () => info(audio));
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(true);
    player._onFrameVisibilityChange({value: false});
    player._onContentClear();
    expect(audio.pauses).toBe(0);
    player.stopAudio();
    expect(audio.pauses).toBe(1);
});

test('a fresh request works after stop and healthy misses retain fallback behavior', async () => {
    const {player, sources, fallback, info, setCreate, progress} = setup();
    player.stopAudio();
    const audio = makeAudio();
    setCreate(async () => info(audio));
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(true);
    expect(audio.plays).toBe(1);
    setCreate(async () => null);
    expect((await player._playAudio(0, 0, sources, null)).valid).toBe(false);
    expect(fallback.plays).toBe(1);
    expect(audio.pauses).toBe(1);
    expect(progress.size).toBe(0);
});

test('source-menu caller rechecks ownership after the playback method has returned', async () => {
    const {player, item, info, setCreate} = setup();
    /** @type {{promise: Promise<void>, resolve: (value?: void) => void, reject: (reason: unknown) => void}} */
    const play = deferred();
    setCreate(async () => info(makeAudio(play.promise)));
    const request = player._playAudioFromSource(0, 0, item(0));
    await flush();
    play.resolve();
    // Resume after _playAudio has returned, but before its caller resumes.
    await Promise.resolve();
    player.stopAudio();
    await request;
    expect(player._getPrimaryCardAudio('first', 'first')).toBe(null);
});

test('a rejected source lookup falls through and is retryable on the next request', async () => {
    const {player, sources, progress} = setup();
    const firstAudio = makeAudio();
    const secondAudio = makeAudio();
    const lookups = [0, 0];
    /**
     * @param {import('display-audio').AudioSource} source
     * @returns {Promise<import('display-audio').AudioInfoList>}
     */
    const getAudioInfoList = async (source) => {
        const attempt = ++lookups[source.index];
        if (source.index === 0 && attempt === 1) { throw new Error('background worker restarted'); }
        return [{info: {type: 'url', url: source.url}, audio: null, audioPromise: null, audioResolved: false}];
    };
    Reflect.set(player, '_getTermAudioInfoList', getAudioInfoList);
    /**
     * @param {import('audio-downloader').Info} _info
     * @param {import('display-audio').AudioSource} source
     * @returns {Promise<ReturnType<typeof makeAudio>>}
     */
    const createAudio = async (_info, source) => (source.index === 0 ? firstAudio : secondAudio);
    Reflect.set(player, '_createAudioFromInfo', createAudio);
    const first = await player._playAudio(0, 0, sources, null);
    expect(first.source?.index).toBe(1);
    expect(secondAudio.plays).toBe(1);
    const retry = await player._playAudio(0, 0, sources, null);
    expect(retry.source?.index).toBe(0);
    expect(firstAudio.plays).toBe(1);
    expect(lookups).toEqual([2, 1]);
    expect(progress.size).toBe(0);
});

test('a cancelled source rejection is contained without admitting fallback requests', async () => {
    const {player, sources, fallback, progress} = setup();
    const pending = deferred();
    let requests = 0;
    Reflect.set(player, '_getTermAudioInfoList', () => {
        ++requests;
        return pending.promise;
    });
    const request = player._playAudio(0, 0, sources, null);
    player.stopAudio();
    pending.reject(new Error('transport closed'));
    expect((await request).valid).toBe(false);
    expect(requests).toBe(1);
    expect(fallback.plays).toBe(0);
    expect(progress.size).toBe(0);
});

for (const consent of ['accepted', 'declined']) {
    test(`autoplay rechecks ${consent} consent after options initialize with unknown consent`, () => {
        const {player, options} = setup();
        options.audio.autoPlay = true;
        Reflect.set(player, '_dataTransmissionConsentRequired', true);
        player._setDataTransmissionConsentState('unknown');
        player._onOptionsUpdated({options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ (options))});
        player.autoPlayAudioDelay = 0;
        let requests = 0;
        Reflect.set(player, 'playAudio', async () => { ++requests; });
        player._onContentUpdateComplete();
        expect(requests).toBe(0);
        player._setDataTransmissionConsentState(consent);
        player._onContentUpdateComplete();
        expect(requests).toBe(consent === 'accepted' ? 1 : 0);
    });
}
