/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test, vi} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

/**
 * @param {(url: string) => Promise<Response>} fetchAnonymous
 * @returns {AudioDownloader}
 */
function createDownloader(fetchAnonymous) {
    return new AudioDownloader(/** @type {any} */ ({fetchAnonymous}));
}

/**
 * @param {unknown} value
 * @returns {Response}
 */
function jsonResponse(value) {
    return new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
}

describe('AudioDownloader Wikimedia Commons lookups', () => {
    test('Wiktionary search treats C++ as text, not regex syntax', async () => {
        const title = 'File:en-US-C++.ogg';
        const fetchAnonymous = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            if (params.get('list') === 'search') {
                expect(params.get('srsearch')).toContain('C\\+\\+');
                return jsonResponse({query: {search: [{title}]}});
            }
            expect(params.get('titles')).toBe(title);
            return jsonResponse({query: {pages: {1: {imageinfo: [{url: 'https://example.test/cpp.ogg', user: 'Speaker'}]}}}});
        });
        const downloader = createDownloader(fetchAnonymous);

        const result = await downloader.getTermAudioInfoList(
            /** @type {any} */ ({type: 'wiktionary'}), 'C++', '', /** @type {any} */ ({iso: 'en'}),
        );

        expect(result).toStrictEqual([{type: 'url', url: 'https://example.test/cpp.ogg', name: '(United States) Speaker'}]);
        expect(fetchAnonymous).toHaveBeenCalledTimes(2);
    });

    test('Lingua Libre encodes ampersands and validates regex metacharacters literally', async () => {
        const title = 'File:LL-Q123 (eng)-Uploader+(one)-a&b.wav';
        const fetchAnonymous = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            if (params.get('list') === 'search') {
                expect(params.get('srsearch')).toContain('a&b');
                expect(params.get('srsearch')).toContain('incategory:');
                return jsonResponse({query: {search: [{title}]}});
            }
            expect(params.get('titles')).toBe(title);
            return jsonResponse({query: {pages: {1: {imageinfo: [{url: 'https://example.test/a-b.wav', user: 'Uploader+(one)'}]}}}});
        });
        const downloader = createDownloader(fetchAnonymous);

        const result = await downloader.getTermAudioInfoList(
            /** @type {any} */ ({type: 'lingua-libre'}), 'a&b', '', /** @type {any} */ ({iso639_3: 'eng'}),
        );

        expect(result).toStrictEqual([{type: 'url', url: 'https://example.test/a-b.wav', name: 'Uploader+(one)'}]);
        expect(fetchAnonymous).toHaveBeenCalledTimes(2);
    });

    test('keeps valid files when another result lacks image info or fails', async () => {
        const valid = 'File:en-test.ogg';
        const missing = 'File:en-test1.ogg';
        const failed = 'File:en-test2.ogg';
        const fetchAnonymous = vi.fn(async (url) => {
            const params = new URL(url).searchParams;
            if (params.get('list') === 'search') {
                return jsonResponse({query: {search: [{title: missing}, {title: valid}, {title: failed}]}});
            }
            switch (params.get('titles')) {
                case valid:
                    return jsonResponse({query: {pages: {1: {imageinfo: [{url: 'https://example.test/test.ogg', user: 'Author'}]}}}});
                case missing:
                    return jsonResponse({query: {pages: {1: {}}}});
                default:
                    throw new Error('transient file metadata failure');
            }
        });
        const downloader = createDownloader(fetchAnonymous);

        const result = await downloader.getTermAudioInfoList(
            /** @type {any} */ ({type: 'wiktionary'}), 'test', '', /** @type {any} */ ({iso: 'en'}),
        );

        expect(result).toStrictEqual([{type: 'url', url: 'https://example.test/test.ogg', name: 'Author'}]);
        expect(fetchAnonymous).toHaveBeenCalledTimes(4);
    });
});
