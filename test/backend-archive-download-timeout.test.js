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

const {Backend} = await import('../ext/js/background/backend.js');

/**
 * @param {string} url
 * @returns {Promise<{contentBase64: string, fileName: string, contentType: string|null}>}
 */
async function downloadArchive(url = 'https://example.test/dictionary.zip') {
    return await Reflect.get(Backend.prototype, '_onApiDownloadDictionaryArchive').call({}, {url});
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('backend dictionary archive download deadline', () => {
    test('enforces timeout when response headers arrive but the body stalls', async () => {
        vi.useFakeTimers();
        /** @type {AbortSignal|null} */
        let requestSignal = null;
        const fetchMock = vi.fn(async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
            requestSignal = init.signal instanceof AbortSignal ? init.signal : null;
            return new Response('partial data');
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockImplementation(async () => {
            return await new Promise((_resolve, reject) => {
                if (requestSignal === null) { throw new Error('No abort signal'); }
                requestSignal.addEventListener('abort', () => reject(requestSignal?.reason), {once: true});
            });
        });

        const pending = downloadArchive();
        const assertion = expect(pending).rejects.toThrow('Timed out fetching dictionary archive after 120000ms');

        await vi.advanceTimersByTimeAsync(120000);

        await assertion;
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears timeout after the entire archive body has been read', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data', {
            headers: {'Content-Type': 'application/zip'},
        })));
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockResolvedValue(
            Uint8Array.from([1, 2, 3]).buffer,
        );

        await expect(downloadArchive()).resolves.toStrictEqual({
            contentBase64: 'AQID',
            fileName: 'dictionary.zip',
            contentType: 'application/zip',
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears timeout when reading an archive response body fails', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data')));
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockRejectedValue(new Error('Body read failed'));

        await expect(downloadArchive()).rejects.toThrow('Body read failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    test('rejects unsuccessful HTTP responses without reading their body', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unavailable', {status: 503})));
        const read = vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer');

        await expect(downloadArchive()).rejects.toThrow('status=503');
        expect(read).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
