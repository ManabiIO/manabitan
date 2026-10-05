/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

const audioData = {data: 'Zml4dHVyZQ==', contentType: 'audio/mpeg'};
const custom = {type: /** @type {const} */ ('custom-json'), url: 'https://audio.example/list', voice: ''};

/**
 * @param {Record<string, string[]>} recordings
 * @param {string[]} failedUrls
 * @returns {{downloader: AudioDownloader, lookups: string[], downloads: string[]}}
 */
function setup(recordings, failedUrls) {
    const builder = /** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ (/** @type {unknown} */ ({}));
    const downloader = new AudioDownloader(builder);
    /** @type {string[]} */
    const lookups = [];
    /** @type {string[]} */
    const downloads = [];
    const failures = new Set(failedUrls);
    /**
     * @param {import('audio').AudioSourceInfo} source
     * @returns {Promise<import('audio-downloader').Info[]>}
     */
    const lookup = async (source) => {
        lookups.push(source.type);
        return (recordings[source.type] ?? []).map((url) => ({type: /** @type {const} */ ('url'), url}));
    };
    /**
     * @param {string} url
     * @returns {Promise<import('audio-downloader').AudioBinaryBase64>}
     */
    const download = async (url) => {
        downloads.push(url);
        if (failures.has(url)) { throw new Error(`Unavailable: ${url}`); }
        return audioData;
    };
    Reflect.set(downloader, 'getTermAudioInfoList', lookup);
    Reflect.set(downloader, '_downloadAudioFromUrl', download);
    return {downloader, lookups, downloads};
}

/**
 * @param {string} iso
 * @returns {import('language').LanguageSummary}
 */
function language(iso) {
    return /** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso}));
}

for (const [iso, fallbackType] of [['ja', 'jpod101'], ['en', 'lingua-libre']]) {
    test(`a preferred recording index does not exclude ${iso} default-source audio`, async () => {
        const {downloader, lookups, downloads} = setup({
            'custom-json': ['unselected', 'selected-unavailable'],
            [fallbackType]: ['default-recording'],
        }, ['selected-unavailable']);
        const result = await downloader.downloadTermAudio([custom], 1, 'term', 'reading', null, language(iso), true);
        expect(result).toEqual(audioData);
        expect(lookups).toEqual(['custom-json', fallbackType]);
        expect(downloads).toEqual(['selected-unavailable', 'default-recording']);
    });
}

test('a disappeared preferred recording can fall back without choosing a different explicit recording', async () => {
    const {downloader, downloads} = setup({'custom-json': ['unselected'], jpod101: ['default-recording']}, []);
    expect(await downloader.downloadTermAudio([custom], 2, 'term', 'reading', null, language('ja'), true)).toEqual(audioData);
    expect(downloads).toEqual(['default-recording']);
});

test('default fallback retains its own recording order rather than borrowing a custom-source index', async () => {
    const {downloader, downloads} = setup({
        'custom-json': ['unselected', 'selected-unavailable'],
        jpod101: ['default-first', 'default-second'],
    }, ['selected-unavailable']);
    await downloader.downloadTermAudio([custom], 1, 'term', 'reading', null, language('ja'), true);
    expect(downloads).toEqual(['selected-unavailable', 'default-first']);
});

test('a successful preferred recording does not query or download fallback sources', async () => {
    const {downloader, lookups, downloads} = setup({'custom-json': ['unselected', 'selected']}, []);
    expect(await downloader.downloadTermAudio([custom], 1, 'term', 'reading', null, language('ja'), true)).toEqual(audioData);
    expect(lookups).toEqual(['custom-json']);
    expect(downloads).toEqual(['selected']);
});

test('disabling default sources still reports a failed selected recording without silently switching', async () => {
    const {downloader, lookups, downloads} = setup({'custom-json': ['unselected', 'selected-unavailable'], jpod101: ['default-recording']}, ['selected-unavailable']);
    let failed = false;
    try {
        await downloader.downloadTermAudio([custom], 1, 'term', 'reading', null, language('ja'), false);
    } catch (error) {
        failed = true;
        expect(error instanceof Error).toBe(true);
        expect(/** @type {Error} */ (error).message).toBe('Could not download audio');
    }
    expect(failed).toBe(true);
    expect(lookups).toEqual(['custom-json']);
    expect(downloads).toEqual(['selected-unavailable']);
});

test('the existing preferred-index behavior of explicitly supplied sources remains unchanged', async () => {
    const {downloader, lookups, downloads} = setup({
        'custom-json': ['unselected-json', 'selected-json-unavailable'],
        custom: ['unselected-custom', 'selected-custom'],
    }, ['selected-json-unavailable']);
    const second = {type: /** @type {const} */ ('custom'), url: 'https://audio.example/{term}', voice: ''};
    await downloader.downloadTermAudio([custom, second], 1, 'term', 'reading', null, language('ja'), false);
    expect(lookups).toEqual(['custom-json', 'custom']);
    expect(downloads).toEqual(['selected-json-unavailable', 'selected-custom']);
});

test('without a preferred index, explicit-source ordering and fallback remain unchanged', async () => {
    const {downloader, lookups, downloads} = setup({'custom-json': ['first-unavailable', 'second']}, ['first-unavailable']);
    await downloader.downloadTermAudio([custom], null, 'term', 'reading', null, language('ja'), true);
    expect(lookups).toEqual(['custom-json']);
    expect(downloads).toEqual(['first-unavailable', 'second']);
});
