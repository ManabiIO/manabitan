/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

// A one-sample PCM WAV, not an empty body or a mocked download result.
const wav = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';
const wavBytes = Uint8Array.from(atob(wav), (char) => char.charCodeAt(0));
const language = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja'}));

/**
 * @param {() => Response} firstResponse
 * @param {() => Response} [secondResponse]
 * @returns {{downloader: AudioDownloader, requests: string[], sources: import('audio').AudioSourceInfo[]}}
 */
function setup(firstResponse, secondResponse = () => new Response(wavBytes, {headers: {'Content-Type': 'audio/wav'}})) {
    /** @type {string[]} */
    const requests = [];
    const requestBuilder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({
        /**
         * @param {string} url
         * @returns {Promise<Response>}
         */
        async fetchAnonymous(url) {
            requests.push(url);
            return url.endsWith('/first') ? firstResponse() : secondResponse();
        },
    }));
    const downloader = new AudioDownloader(requestBuilder);
    const sources = ['first', 'second'].map((name) => ({type: /** @type {const} */ ('custom'), url: `https://audio.example/${name}`, voice: ''}));
    return {downloader, requests, sources};
}

for (const status of [200, 204]) {
    for (const idleTimeout of [null, 1000]) {
        test(`an empty HTTP ${status} response falls through with idle timeout ${idleTimeout}`, async () => {
            const {downloader, requests, sources} = setup(() => new Response(null, {status, headers: {'Content-Type': 'audio/mpeg'}}));
            const result = await downloader.downloadTermAudio(sources, null, '音', 'おと', idleTimeout, language, false);
            expect(result).toEqual({data: wav, contentType: 'audio/wav'});
            expect(requests).toEqual(sources.map(({url}) => url));
        });
    }
}

for (const sourceType of /** @type {const} */ (['custom', 'jpod101'])) {
    test(`empty binary content is invalid for ${sourceType}`, async () => {
        const {downloader} = setup(() => new Response(null));
        expect(await downloader._isAudioBinaryValid(new ArrayBuffer(0), sourceType)).toBe(false);
    });
}

test('all-empty sources report unavailable audio rather than returning an empty Anki attachment', async () => {
    const {downloader, requests, sources} = setup(() => new Response(null), () => new Response(null));
    let message = '';
    try {
        await downloader.downloadTermAudio(sources, null, '音', 'おと', null, language, false);
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Could not download audio');
    expect(requests).toEqual(sources.map(({url}) => url));
});

test('a false zero Content-Length hint does not reject a nonempty response body', async () => {
    const {downloader, requests, sources} = setup(() => new Response(wavBytes, {headers: {'Content-Type': 'audio/wav', 'Content-Length': '0'}}));
    const result = await downloader.downloadTermAudio(sources, null, '音', 'おと', 1000, language, false);
    expect(result).toEqual({data: wav, contentType: 'audio/wav'});
    expect(requests).toEqual([sources[0].url]);
});

test('HTTP errors retain the existing fallback behavior', async () => {
    const {downloader, requests, sources} = setup(() => new Response('Unavailable', {status: 503}));
    const result = await downloader.downloadTermAudio(sources, null, '音', 'おと', null, language, false);
    expect(result).toEqual({data: wav, contentType: 'audio/wav'});
    expect(requests).toEqual(sources.map(({url}) => url));
});
