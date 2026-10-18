/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {DynamicProperty} from '../ext/js/core/dynamic-property.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => { throw new Error('Uninitialized deferred'); };
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 12; ++i) { await Promise.resolve(); }
}

function makeAudio() {
    return {
        currentTime: 0,
        volume: 1,
        plays: 0,
        pauses: 0,
        async play() { ++this.plays; },
        pause() { ++this.pauses; },
    };
}

function setup() {
    // Construct the real player and progress dispatcher. Only the display shell
    // and audio/network boundaries are fixtures.
    vi.stubGlobal('document', {documentElement: {dataset: {}}, querySelector: () => ({})});
    const progress = new DynamicProperty(false);
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {
            enabled: true,
            autoPlay: false,
            fallbackSoundType: 'none',
            volume: 70,
            enableDefaultAudioSources: false,
            sources: [0, 1].map((index) => ({type: 'custom', url: `https://audio.example/${index}`, voice: ''})),
        },
    }));
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {}},
        frameVisible: true,
        getOptions: () => options,
        getLanguageSummary: () => ({iso: 'ja'}),
        dictionaryEntries: [{type: 'term', headwords: [{term: 'first', reading: 'first'}, {term: 'second', reading: 'second'}]}],
        dictionaryEntryNodes: [],
        progressIndicatorVisible: progress,
    }));
    const player = new DisplayAudio(display);
    player._onOptionsUpdated({options});
    const sources = player._audioSources;
    const fallback = makeAudio();
    Reflect.set(player._audioSystem, 'getFallbackAudio', () => fallback);
    /** @param {(term: string) => Promise<unknown>} callback */
    const setCreate = (callback) => { Reflect.set(player, '_createTermAudio', callback); };
    /**
     * @param {ReturnType<typeof makeAudio>} audio
     * @returns {{audio: ReturnType<typeof makeAudio>, source: import('display-audio').AudioSource, subIndex: number}}
     */
    const info = (audio) => ({audio, source: sources[0], subIndex: 0});
    return {player, sources, options, progress, fallback, info, setCreate};
}

for (const invalidation of ['hide', 'content', 'options', 'consent']) {
    test(`${invalidation} cancels audio whose play promise has not started playback yet`, async () => {
        const {player, sources, options, progress, info, setCreate} = setup();
        /** @type {{promise: Promise<void>, resolve: (value?: void) => void}} */
        const permission = deferred();
        let retired = false;
        let starts = 0;
        const audio = makeAudio();
        audio.play = async () => {
            await permission.promise;
            if (!retired) { ++starts; }
        };
        audio.pause = () => { retired = true; };
        player._dataTransmissionConsentRequired = true;
        player._setDataTransmissionConsentState('accepted');
        setCreate(async () => info(audio));
        const request = player._playAudio(0, 0, sources, null);
        await flush();
        switch (invalidation) {
            case 'hide': player._onFrameVisibilityChange({value: false}); break;
            case 'content': player._onContentClear(); break;
            case 'options': player._onOptionsUpdated({options}); break;
            default: player._setDataTransmissionConsentState('declined'); break;
        }
        expect(progress.overrideCount).toBe(0);
        permission.resolve();
        expect((await request).valid).toBe(false);
        expect(starts).toBe(0);
    });
}

for (const action of ['stop', 'replace']) {
    test(`a synchronous ${action} during previous progress cleanup wins over the interrupted play request`, async () => {
        const {player, sources, progress, info, setCreate} = setup();
        const pending = deferred();
        const olderAudio = makeAudio();
        const newestAudio = makeAudio();
        /** @type {string[]} */
        const preparations = [];
        setCreate((term) => {
            preparations.push(term);
            return term === 'first' ? pending.promise : Promise.resolve(info(newestAudio));
        });
        const first = player._playAudio(0, 0, sources, null);
        let observed = false;
        const state = {replacement: /** @type {Promise<import('display-audio').PlayAudioResult>|null} */ (null)};
        progress.on('change', ({value}) => {
            if (value || observed) { return; }
            observed = true;
            if (action === 'stop') {
                player.stopAudio();
            } else {
                state.replacement = player._playAudio(0, 1, sources, null);
            }
        });
        const interrupted = player._playAudio(0, 0, sources, null);
        await flush();
        pending.resolve(info(olderAudio));
        const results = await Promise.all([first, interrupted]);
        const replacementResult = await state.replacement;
        expect(results.map(({valid}) => valid)).toEqual([false, false]);
        expect(olderAudio.plays).toBe(0);
        expect(newestAudio.plays).toBe(action === 'replace' ? 1 : 0);
        expect(replacementResult?.valid ?? false).toBe(action === 'replace');
        expect(preparations).toEqual(action === 'replace' ? ['first', 'second'] : ['first']);
        expect(progress.overrideCount).toBe(0);
    });
}

test('an empty metadata result is refreshed on the next request without losing its failure badge', async () => {
    const {player, sources, fallback, progress} = setup();
    const audio = makeAudio();
    let lookups = 0;
    Reflect.set(player, '_getTermAudioInfoList', async () => {
        // AudioDownloader also returns [] for provider/HTTP discovery failures.
        if (++lookups === 1) { return []; }
        return [{info: {type: 'url', url: sources[0].url}, audio, audioPromise: null, audioResolved: true}];
    });
    expect((await player._playAudio(0, 0, [sources[0]], null)).valid).toBe(false);
    expect(player._getMenuItemEntries(sources[0], 'first', 'first')).toEqual([{valid: false, index: null, name: null}]);
    expect((await player._playAudio(0, 0, [sources[0]], null)).valid).toBe(true);
    expect(lookups).toBe(2);
    expect(audio.plays).toBe(1);
    expect(fallback.plays).toBe(1);
    expect(progress.overrideCount).toBe(0);
});

test('a formerly unavailable preferred source can recover ahead of a cached fallback source', async () => {
    const {player, sources, progress} = setup();
    const audios = sources.map(() => makeAudio());
    const lookups = [0, 0];
    /**
     * @param {import('display-audio').AudioSource} source
     * @returns {Promise<import('display-audio').AudioInfoList>}
     */
    const lookup = async (source) => {
        if (++lookups[source.index] === 1 && source.index === 0) { return []; }
        return [{info: {type: 'url', url: source.url}, audio: /** @type {import('display-audio').GenericAudio} */ (/** @type {unknown} */ (audios[source.index])), audioPromise: null, audioResolved: true}];
    };
    Reflect.set(player, '_getTermAudioInfoList', lookup);
    expect((await player._playAudio(0, 0, sources, null)).source?.index).toBe(1);
    expect((await player._playAudio(0, 0, sources, null)).source?.index).toBe(0);
    expect(lookups).toEqual([2, 1]);
    expect(progress.overrideCount).toBe(0);
});

test('overlapping metadata retries still share a single request after an empty result', async () => {
    const {player, sources, progress} = setup();
    const pending = deferred();
    const audio = makeAudio();
    let lookups = 0;
    Reflect.set(player, '_getTermAudioInfoList', () => (++lookups === 1 ? Promise.resolve([]) : pending.promise));
    await player._playAudio(0, 0, [sources[0]], null);
    const first = player._playAudio(0, 0, [sources[0]], null);
    const last = player._playAudio(0, 0, [sources[0]], null);
    pending.resolve([{info: {type: 'url', url: sources[0].url}, audio, audioPromise: null, audioResolved: true}]);
    const results = await Promise.all([first, last]);
    expect(results.map(({valid}) => valid)).toEqual([false, true]);
    expect(lookups).toBe(2);
    expect(audio.plays).toBe(1);
    expect(progress.overrideCount).toBe(0);
});
