/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('AudioDownloader idle timeout cleanup', () => {
    test('clears the timer when fetching the audio fails', async () => {
        vi.useFakeTimers();
        const requestBuilder = {fetchAnonymous: vi.fn().mockRejectedValue(new Error('Network failed'))};
        const downloader = new AudioDownloader(/** @type {any} */ (requestBuilder));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'jisho', 5000))
            .rejects.toThrow('Network failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears the timer for unsuccessful HTTP responses', async () => {
        vi.useFakeTimers();
        const requestBuilder = {fetchAnonymous: vi.fn().mockResolvedValue(new Response('Unavailable', {status: 503}))};
        const downloader = new AudioDownloader(/** @type {any} */ (requestBuilder));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'jisho', 5000))
            .rejects.toThrow('Invalid response: 503');
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears the timer when response-body reading fails', async () => {
        vi.useFakeTimers();
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockRejectedValueOnce(new Error('Decode failed'));
        const requestBuilder = {fetchAnonymous: vi.fn().mockResolvedValue(new Response('bytes'))};
        const downloader = new AudioDownloader(/** @type {any} */ (requestBuilder));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'jisho', 5000))
            .rejects.toThrow('Decode failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    test('rejects timed-out requests and releases the timeout handle', async () => {
        vi.useFakeTimers();
        const requestBuilder = {
            fetchAnonymous: vi.fn((_url, /** @type {RequestInit} */ init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('request aborted')), {once: true});
            })),
        };
        const downloader = new AudioDownloader(/** @type {any} */ (requestBuilder));
        const pending = downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'jisho', 50);
        const assertion = expect(pending).rejects.toThrow('request aborted');

        await vi.advanceTimersByTimeAsync(50);

        await assertion;
        expect(vi.getTimerCount()).toBe(0);
    });
});
