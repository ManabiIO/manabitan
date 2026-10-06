/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DisplayAudio} from '../ext/js/display/display-audio.js';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @param {boolean} consentRequired
 * @param {'unknown'|'accepted'|'declined'} state
 * @param {boolean} [defaults]
 * @returns {{player: DisplayAudio, options: import('settings').ProfileOptions, requests: string[], downloader: AudioDownloader}}
 */
function setup(consentRequired, state, defaults = true) {
    vi.stubGlobal('document', {documentElement: {dataset: {}}, querySelector: () => ({})});
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        audio: {
            enabled: true,
            autoPlay: false,
            fallbackSoundType: 'none',
            volume: 100,
            enableDefaultAudioSources: defaults,
            sources: [{type: 'custom', url: 'https://audio.example/{term}', voice: ''}],
        },
    }));
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {}},
        getOptions: () => options,
        getOptionsContext: () => ({depth: 0, url: 'https://reader.example/'}),
        dictionaryEntries: [{type: 'term', headwords: [{term: '漢字', reading: 'かんじ'}]}],
        progressIndicatorVisible: {clearOverride() {}},
    }));
    const player = new DisplayAudio(display);
    player._dataTransmissionConsentRequired = consentRequired;
    player._setDataTransmissionConsentState(state);
    player._onOptionsUpdated({options});
    /** @type {string[]} */
    const requests = [];
    const requestBuilder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({
        /**
         * @param {string} url
         * @returns {Promise<Response>}
         */
        async fetchAnonymous(url) {
            requests.push(url);
            return new Response(new Uint8Array([1, 2, 3]), {headers: {'Content-Type': 'audio/mpeg'}});
        },
    }));
    const downloader = new AudioDownloader(requestBuilder);
    return {player, options, requests, downloader};
}

for (const state of /** @type {const} */ (['unknown', 'declined'])) {
    for (const defaults of [false, true]) {
        for (const pinned of [false, true]) {
            test(`${state} consent prevents Anki audio requests (defaults=${defaults}, pinned=${pinned})`, async () => {
                const {player, downloader, requests} = setup(true, state, defaults);
                if (pinned) {
                    player._setPrimaryAudio(0, 0, {source: player._audioSources[0], subIndex: 0}, false);
                }
                const details = player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ');
                const language = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja'}));
                let downloaded = false;
                try {
                    await downloader.downloadTermAudio(details.sources, details.preferredAudioIndex, '漢字', 'かんじ', null, language, details.enableDefaultAudioSources);
                    downloaded = true;
                } catch (_) {
                    // No eligible source is the expected downloader result.
                }
                expect(requests).toEqual([]);
                expect(downloaded).toBe(false);
                expect(details).toEqual({sources: [], preferredAudioIndex: null, enableDefaultAudioSources: false});
            });
        }
    }
}

for (const defaults of [false, true]) {
    test(`accepted consent preserves configured and pinned Anki source choices (defaults=${defaults})`, () => {
        const {player} = setup(true, 'accepted', defaults);
        const sources = [{type: 'custom', url: 'https://audio.example/{term}', voice: ''}];
        expect(player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ')).toEqual({sources, preferredAudioIndex: null, enableDefaultAudioSources: defaults});
        player._setPrimaryAudio(0, 0, {source: player._audioSources[0], subIndex: 2}, false);
        expect(player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ')).toEqual({sources, preferredAudioIndex: 2, enableDefaultAudioSources: defaults});
        player._setDataTransmissionConsentState('declined');
        expect(player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ').sources).toEqual([]);
        player._setDataTransmissionConsentState('accepted');
        expect(player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ').preferredAudioIndex).toBe(2);
    });
}

for (const state of /** @type {const} */ (['unknown', 'accepted', 'declined'])) {
    test(`browsers without the consent requirement retain Anki behavior for ${state} stored state`, () => {
        const {player, options} = setup(false, state);
        // Disabling pronunciation buttons has historically been independent
        // of including audio on cards; do not conflate it with consent.
        options.audio.enabled = false;
        player._onOptionsUpdated({options});
        expect(player.getAnkiNoteMediaAudioDetails('漢字', 'かんじ')).toEqual({
            sources: [{type: 'custom', url: 'https://audio.example/{term}', voice: ''}],
            preferredAudioIndex: null,
            enableDefaultAudioSources: true,
        });
    });
}
