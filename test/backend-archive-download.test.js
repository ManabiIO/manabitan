/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

/**
 * @param {string} [url]
 * @returns {Promise<{contentBase64: string, fileName: string, contentType: string|null}>}
 */
function download(url = 'https://example.com/download') {
    const backend = Object.create(Backend.prototype);
    return Reflect.get(backend, '_onApiDownloadDictionaryArchive').call(backend, {url});
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('backend dictionary archive download lifetime', () => {
    test('the deadline covers a stalled body after successful response headers', async () => {
        vi.useFakeTimers();
        /** @type {AbortSignal|undefined} */
        let signal;
        /** @type {ReadableStreamDefaultController<Uint8Array>|undefined} */
        let controller;
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            signal = options.signal;
            const body = new ReadableStream({start(streamController) { controller = streamController; }});
            signal?.addEventListener('abort', () => { controller?.error(signal?.reason); }, {once: true});
            return new Response(body, {status: 200});
        }));
        const pending = download().then((result) => ({result, error: null}), (error) => ({result: null, error}));
        await vi.advanceTimersByTimeAsync(120_000);
        const timedOut = signal?.aborted;
        // Drain the old implementation too: a regression must fail, not hang the test runner.
        if (!timedOut) { controller?.close(); }
        const result = await pending;
        expect(timedOut).toBe(true);
        expect(result.result).toBeNull();
        expect(result.error).toMatchObject({message: expect.stringContaining('Timed out fetching dictionary archive')});
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each([false, true])('a rejected HTTP response cancels its unread body (cancel rejects: %s)', async (cancelRejects) => {
        vi.useFakeTimers();
        const cancel = vi.fn(() => {
            if (cancelRejects) { throw new Error('Cancellation failed'); }
        });
        const response = new Response(new ReadableStream({cancel}), {status: 503});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(download()).rejects.toThrow('status=503');
        await Promise.resolve();
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each(['fetch', 'body'])('a %s failure preserves its error and removes the deadline', async (phase) => {
        vi.useFakeTimers();
        const error = new Error('Network interrupted');
        const fetch = phase === 'fetch' ?
            vi.fn().mockRejectedValue(error) :
            vi.fn().mockResolvedValue(new Response(new ReadableStream({start(controller) { controller.error(error); }})));
        vi.stubGlobal('fetch', fetch);
        await expect(download()).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('successful binary content retains every byte and clears its deadline', async () => {
        vi.useFakeTimers();
        const bytes = new Uint8Array([0, 128, 255, 1]);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, {headers: {'Content-Type': 'application/zip'}})));
        expect(await download()).toEqual({contentBase64: 'AID/AQ==', fileName: 'download', contentType: 'application/zip'});
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('backend dictionary archive filenames', () => {
    test.each([
        ['attachment; filename="Dictionary.zip"', 'Dictionary.zip'],
        ["attachment; filename*=UTF-8''Dictionary.mdx", 'Dictionary.mdx'],
        ["attachment; filename=Fallback.zip; filename*=UTF-8'en'%E6%97%A5%E6%9C%AC%E8%AA%9E.mdx", '\u65e5\u672c\u8a9e.mdx'],
        ['attachment; filename = "Dictionary.zip"', 'Dictionary.zip'],
        ['attachment; filename="100%25.zip"', '100%25.zip'],
        ['attachment; filename="Dictionary;2026.zip"', 'Dictionary;2026.zip'],
        ['attachment; filename="Dictionary \\"2026\\".zip"', 'Dictionary "2026".zip'],
        ["attachment; filename*=UTF-8''%broken; filename=Fallback.zip", 'Fallback.zip'],
        ["attachment; filename*=unsupported''ignored.mdx; filename=Fallback.zip", 'Fallback.zip'],
        ['attachment; filename="../Dictionary.zip"', 'Dictionary.zip'],
        ['attachment; xfilename="Wrong.mdx"', 'download'],
        ['attachment; note="; filename=Wrong.mdx"; filename=Right.zip', 'Right.zip'],
        ['', 'download'],
    ])('uses the intended filename for %s', async (disposition, expected) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {headers: {'Content-Disposition': disposition}})));
        expect((await download()).fileName).toBe(expected);
    });

    test.each([
        ['https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E.zip', '日本語.zip'],
        ['https://example.com/archive%2FDictionary.zip', 'Dictionary.zip'],
        ['https://example.com/archive%5CDictionary.zip', 'Dictionary.zip'],
        ['https://example.com/%broken.zip', '%broken.zip'],
        ['https://example.com/100%2525.zip', '100%25.zip'],
    ])('decodes a URL fallback once and preserves a safe basename: %s', async (url, expected) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]))));
        expect((await download(url)).fileName).toBe(expected);
    });

    test('header filenames retain precedence over the decoded URL fallback', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
            headers: {'Content-Disposition': 'attachment; filename="100%25.zip"'},
        })));
        expect((await download('https://example.com/%E6%97%A5.zip')).fileName).toBe('100%25.zip');
    });
});
