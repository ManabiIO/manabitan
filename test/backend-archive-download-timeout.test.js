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
 * @returns {Backend}
 */
function createBackend() {
    return /** @type {Backend} */ (Object.create(Backend.prototype));
}

describe('Backend archive download deadline', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    test('keeps the deadline active when the fetch completes but the body stalls', async () => {
        vi.useFakeTimers();
        /** @type {AbortSignal|null} */
        let signal = null;
        vi.stubGlobal('fetch', vi.fn(async (/** @type {string} */ _url, /** @type {RequestInit} */ options) => {
            signal = options.signal instanceof AbortSignal ? options.signal : null;
            return new Response('pending');
        }));
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockImplementation(async () => (
            await new Promise((_resolve, reject) => {
                if (signal === null) { throw new Error('Missing fetch abort signal'); }
                signal.addEventListener('abort', () => reject(signal?.reason), {once: true});
            })
        ));
        const request = createBackend()._onApiDownloadDictionaryArchive({url: 'https://example.test/dictionary.zip'});
        const assertion = expect(request).rejects.toThrow('Timed out fetching dictionary archive');

        await vi.advanceTimersByTimeAsync(120_000);

        await assertion;
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears the deadline after a complete successful archive download', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', {status: 200, headers: {'Content-Type': 'application/zip'}})));
        vi.spyOn(RequestBuilder, 'readFetchResponseArrayBuffer').mockResolvedValue(new Uint8Array([1, 2, 3]));

        const result = await createBackend()._onApiDownloadDictionaryArchive({url: 'https://example.test/dictionary.zip'});

        expect(result).toStrictEqual({
            contentBase64: 'AQID',
            fileName: 'dictionary.zip',
            contentType: 'application/zip',
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears the deadline when the server returns an error status', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', {status: 503})));

        await expect(createBackend()._onApiDownloadDictionaryArchive({url: 'https://example.test/dictionary.zip'}))
            .rejects.toThrow('status=503');
        expect(vi.getTimerCount()).toBe(0);
    });
});
