/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2017-2022  Yomichan Authors
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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {AudioDownloader} from '../ext/js/media/audio-downloader.js';

/**
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchAnonymous
 * @returns {AudioDownloader}
 */
function createDownloader(fetchAnonymous) {
    return new AudioDownloader(/** @type {import('../ext/js/background/request-builder.js').RequestBuilder} */ ({fetchAnonymous}));
}

/**
 * @param {(signal: AbortSignal) => Promise<Response>} handler
 * @returns {{downloader: AudioDownloader, getSignal: () => AbortSignal}}
 */
function createSignalCapturingDownloader(handler) {
    /** @type {?AbortSignal} */
    let signal = null;
    const downloader = createDownloader(async (_url, init) => {
        if (!(init.signal instanceof AbortSignal)) {
            throw new Error('Expected download abort signal');
        }
        signal = init.signal;
        return await handler(init.signal);
    });
    return {
        downloader,
        getSignal() {
            if (signal === null) { throw new Error('Request was not started'); }
            return signal;
        },
    };
}

describe('AudioDownloader idle timeout cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('clears the idle timer when the request rejects', async () => {
        const error = new Error('network failed');
        const {downloader, getSignal} = createSignalCapturingDownloader(async () => {
            throw error;
        });

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000)).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(getSignal().aborted).toBe(false);
    });

    test('clears the idle timer for an invalid HTTP response', async () => {
        const {downloader, getSignal} = createSignalCapturingDownloader(async () => new Response('', {status: 503}));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000)).rejects.toThrow('Invalid response: 503');
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(getSignal().aborted).toBe(false);
    });

    test('clears the idle timer when reading the response body fails', async () => {
        const error = new Error('stream failed');
        const {downloader, getSignal} = createSignalCapturingDownloader(async () => new Response(new ReadableStream({
            start(controller) {
                controller.error(error);
            },
        })));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000)).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(getSignal().aborted).toBe(false);
    });

    test('successful downloads leave no timeout behind', async () => {
        const {downloader, getSignal} = createSignalCapturingDownloader(async () => new Response(new Uint8Array([1, 2, 3]), {
            headers: {'Content-Type': 'audio/mpeg'},
        }));

        await expect(downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000)).resolves.toEqual({
            data: 'AQID',
            contentType: 'audio/mpeg',
        });
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(5000);
        expect(getSignal().aborted).toBe(false);
    });

    test('downloads without an idle timeout do not create a timer or signal', async () => {
        /** @type {RequestInit[]} */
        const requests = [];
        const downloader = createDownloader(async (_url, init) => {
            requests.push(init);
            return new Response(new Uint8Array([1]));
        });

        await downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', null);

        expect(requests).toHaveLength(1);
        expect(requests[0].signal).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a genuinely idle pending request still aborts at its deadline', async () => {
        const {downloader, getSignal} = createSignalCapturingDownloader((signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => { reject(signal.reason); }, {once: true});
        }));
        const result = downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000);
        const rejected = expect(result).rejects.toBe('Idle timeout');

        await vi.advanceTimersByTimeAsync(4999);
        expect(getSignal().aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(getSignal().aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('received bytes reset the idle deadline before a stalled stream aborts', async () => {
        /** @type {ReadableStreamDefaultController<Uint8Array>[]} */
        const controllers = [];
        const {downloader, getSignal} = createSignalCapturingDownloader(async (signal) => new Response(new ReadableStream({
            start(controller) {
                controllers.push(controller);
                signal.addEventListener('abort', () => { controller.error(signal.reason); }, {once: true});
            },
        })));
        const result = downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000);
        const rejected = expect(result).rejects.toBe('Idle timeout');

        await vi.advanceTimersByTimeAsync(4000);
        controllers[0].enqueue(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(4999);
        expect(getSignal().aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(getSignal().aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a stream failure after progress clears the replacement idle timer', async () => {
        const error = new Error('stream failed after a chunk');
        /** @type {ReadableStreamDefaultController<Uint8Array>[]} */
        const controllers = [];
        const {downloader, getSignal} = createSignalCapturingDownloader(async () => new Response(new ReadableStream({
            start(controller) { controllers.push(controller); },
        })));
        const result = downloader._downloadAudioFromUrl('https://example.test/audio.mp3', 'custom', 5000);
        const rejected = expect(result).rejects.toBe(error);

        await vi.advanceTimersByTimeAsync(4000);
        controllers[0].enqueue(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        controllers[0].error(error);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(getSignal().aborted).toBe(false);
    });
});
