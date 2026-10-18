/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

const languageSummary = /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'ja', iso639_3: 'jpn', name: 'Japanese'}));

/**
 * @param {(url: string, params?: RequestInit) => Promise<Response>} [fetchAnonymous]
 * @returns {AudioDownloader}
 */
function createDownloader(fetchAnonymous = async () => { throw new Error('Unexpected network request'); }) {
    const requestBuilder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({fetchAnonymous}));
    return new AudioDownloader(requestBuilder);
}

for (const term of ['お茶', 'A&B', 'C#', 'x?y', '1+1', 'a/b', '100%', '%2F', 'space word', '𠮷野家', 'x{reading}y']) {
    test(`custom audio preserves the literal query value ${JSON.stringify(term)}`, async () => {
        const downloader = createDownloader();
        const source = {type: /** @type {const} */ ('custom'), url: 'https://audio.example/{language}/audio?term={term}&reading={reading}&lang={language}&again={term}#original', voice: ''};
        const result = await downloader.getTermAudioInfoList(source, term, term, languageSummary);
        expect(result.length).toBe(1);
        const info = result[0];
        if (info.type !== 'url') { throw new Error('Expected URL audio'); }
        const url = new URL(info.url);
        expect(url.origin).toBe('https://audio.example');
        expect(url.pathname).toBe('/ja/audio');
        expect([...url.searchParams.keys()]).toEqual(['term', 'reading', 'lang', 'again']);
        expect(url.searchParams.get('term')).toBe(term);
        expect(url.searchParams.get('reading')).toBe(term);
        expect(url.searchParams.get('again')).toBe(term);
        expect(url.searchParams.get('lang')).toBe('ja');
        expect(url.hash).toBe('#original');
    });
}

for (const term of ['a/b', 'x?y', 'x#y', 'a%2Fb', '音/声#?']) {
    test(`custom audio preserves one path component for ${JSON.stringify(term)}`, () => {
        const downloader = createDownloader();
        const url = new URL(downloader._getCustomUrl(term, '読み', 'https://audio.example/{term}/{reading}.mp3', languageSummary));
        const components = url.pathname.split('/');
        expect(components.length).toBe(3);
        expect(decodeURIComponent(components[1])).toBe(term);
        expect(decodeURIComponent(components[2])).toBe('読み.mp3');
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
    });
}

test('custom interpolation encodes values only, preserves unknown markers, and does not expand replacement text', () => {
    const downloader = createDownloader();
    const url = downloader._getCustomUrl('{reading}&x=1', 'かな', 'https://audio.example/a%2Fb/{language}?term={term}&token=already%2Bencoded&unknown={other}&constructor={constructor}&prototype={__proto__}#keep', languageSummary);
    expect(url).toBe('https://audio.example/a%2Fb/ja?term=%7Breading%7D%26x%3D1&token=already%2Bencoded&unknown={other}&constructor={constructor}&prototype={__proto__}#keep');
});

test('empty values and templates without placeholders keep their existing behavior', () => {
    const downloader = createDownloader();
    expect(downloader._getCustomUrl('', '', 'https://audio.example/?term={term}&reading={reading}', languageSummary)).toBe('https://audio.example/?term=&reading=');
    const url = 'https://audio.example/a%2Fb?token=already%2Bencoded#keep';
    expect(downloader._getCustomUrl('A&B', 'C#', url, languageSummary)).toBe(url);
});

test('custom JSON requests use escaped values without rewriting the returned media URL', async () => {
    /** @type {string[]} */
    const requests = [];
    const responseJson = {audioSources: [{url: 'https://cdn.example/audio?token=a%2Bb&part=1', name: 'Recording'}]};
    const downloader = createDownloader(async (url) => {
        requests.push(url);
        return Response.json(responseJson);
    });
    let validations = 0;
    Reflect.set(downloader, '_customAudioListSchema', {
        /** @param {unknown} value */
        validate(value) {
            expect(value).toEqual(responseJson);
            ++validations;
        },
    });
    const source = {type: /** @type {const} */ ('custom-json'), url: 'https://audio.example/list?term={term}&reading={reading}', voice: ''};
    const result = await downloader.getTermAudioInfoList(source, 'A&B#C', '1+1?2', languageSummary);
    expect(requests.length).toBe(1);
    const url = new URL(requests[0]);
    expect(url.searchParams.get('term')).toBe('A&B#C');
    expect(url.searchParams.get('reading')).toBe('1+1?2');
    expect(url.hash).toBe('');
    expect(validations).toBe(1);
    expect(result).toEqual([{type: 'url', ...responseJson.audioSources[0]}]);
});

for (const term of ['A/B', 'C#', 'x?y', 'a%2Fb', 'お茶', '𠮷野家']) {
    test(`Jisho escapes its search path but retains the literal DOM identifier for ${JSON.stringify(term)}`, async () => {
        /** @type {string[]} */
        const requests = [];
        /** @type {string[]} */
        const identifiers = [];
        const downloader = createDownloader(async (url) => {
            requests.push(url);
            const response = new Response('fixture');
            Object.defineProperty(response, 'url', {value: url});
            return response;
        });
        Reflect.set(downloader, '_createSimpleDOMParser', () => ({
            /**
             * @param {string} id
             * @returns {object}
             */
            getElementById(id) {
                identifiers.push(id);
                return {};
            },
            getElementByTagName: () => ({}),
            getAttribute: () => '/audio/example.mp3',
        }));
        const reading = 'かな#?';
        const source = {type: /** @type {const} */ ('jisho'), url: '', voice: ''};
        const result = await downloader.getTermAudioInfoList(source, term, reading, languageSummary);
        expect(requests.length).toBe(1);
        const url = new URL(requests[0]);
        expect(url.pathname.split('/').length).toBe(3);
        expect(decodeURIComponent(url.pathname.substring('/search/'.length))).toBe(term);
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(identifiers).toEqual([`audio_${term}:${reading}`]);
        expect(result).toEqual([{type: 'url', url: 'https://jisho.org/audio/example.mp3'}]);
    });
}

test('custom query values round-trip a deterministic mix of Unicode and URL punctuation', () => {
    const downloader = createDownloader();
    const characters = ['&', '#', '?', '+', '%', '/', '=', ' ', 'あ', '𠮷', '{', '}', ':', '\\', 'x', '\n'];
    for (let i = 0; i < 256; ++i) {
        const term = `${characters[i % characters.length]}${characters[Math.floor(i / characters.length)]}`;
        const value = downloader._getCustomUrl(term, term, 'https://audio.example/?term={term}&reading={reading}', languageSummary);
        const url = new URL(value);
        expect([...url.searchParams]).toEqual([['term', term], ['reading', term]]);
        expect(url.hash).toBe('');
    }
});
