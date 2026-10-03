/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DOMParser} from '../ext/lib/linkedom.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

class DownloadRequest {
    /** @type {DownloadRequest[]} */
    static instances = [];
    /** @type {'event'|'silent'|'throw'} */
    static abortBehavior = 'event';

    constructor() {
        DownloadRequest.instances.push(this);
        /** @type {Function|null} */
        this.onload = null;
        /** @type {Function|null} */
        this.onerror = null;
        /** @type {Function|null} */
        this.onabort = null;
        /** @type {Function|null} */
        this.ontimeout = null;
        /** @type {Function|null} */
        this.onprogress = null;
        this.status = 200;
        this.response = new Uint8Array([0, 128, 255]).buffer;
        this.open = vi.fn();
        this.send = vi.fn();
        this.getResponseHeader = vi.fn(() => 'application/zip');
        this.abort = vi.fn(() => {
            if (DownloadRequest.abortBehavior === 'throw') { throw new Error('Abort failed'); }
            if (DownloadRequest.abortBehavior === 'event') { this.onabort?.(); }
        });
    }
}

function createController() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    DownloadRequest.instances = [];
    DownloadRequest.abortBehavior = 'event';
});

describe('settings dictionary download cancellation', () => {
    test.each(['event', 'silent', 'throw'])('cancellation settles without depending on XHR abort behavior: %s', async (behavior) => {
        DownloadRequest.abortBehavior = /** @type {'event'|'silent'|'throw'} */ (behavior);
        vi.stubGlobal('XMLHttpRequest', DownloadRequest);
        const controller = createController();
        const abortController = new AbortController();
        const removeListener = vi.spyOn(abortController.signal, 'removeEventListener');
        const error = new Error('Download owner cancelled');
        const pending = Reflect.get(controller, '_downloadDictionaryFileViaXhr').call(controller, 'https://example.com/dictionary.zip', 120_000, vi.fn(), abortController.signal)
            .then((value) => ({value, error: null}), (reason) => ({value: null, error: reason}));
        const request = DownloadRequest.instances[0];
        const staleLoad = request.onload;
        abortController.abort(error);
        await Promise.resolve();
        const detached = request.onload === null;
        // Drain the old implementation as well, so the red test fails instead of hanging.
        if (!detached) { request.onload?.(); }
        const result = await pending;
        expect(detached).toBe(true);
        expect(result.error).toBe(error);
        expect(request.abort).toHaveBeenCalledOnce();
        expect(removeListener).toHaveBeenCalledOnce();
        expect([request.onload, request.onerror, request.onabort, request.ontimeout, request.onprogress]).toEqual([null, null, null, null, null]);
        staleLoad?.();
        expect(await pending).toBe(result);
    });

    test.each(['success', 'http', 'empty', 'network', 'timeout'])('a %s exit removes handlers and does not abort a later operation', async (outcome) => {
        vi.stubGlobal('XMLHttpRequest', DownloadRequest);
        const controller = createController();
        const abortController = new AbortController();
        const removeListener = vi.spyOn(abortController.signal, 'removeEventListener');
        const pending = Reflect.get(controller, '_downloadDictionaryFileViaXhr').call(controller, 'https://example.com/dictionary.zip', 120_000, vi.fn(), abortController.signal)
            .then((value) => ({value, error: null}), (error) => ({value: null, error}));
        const request = DownloadRequest.instances[0];
        if (outcome === 'http') { request.status = 503; }
        if (outcome === 'empty') { request.response = new ArrayBuffer(0); }
        if (outcome === 'network') {
            request.onerror?.();
        } else if (outcome === 'timeout') {
            request.ontimeout?.();
        } else {
            request.onload?.();
        }
        const result = await pending;
        if (outcome === 'success') {
            expect(result.error).toBeNull();
            if (result.value === null) { throw new Error('Expected downloaded file'); }
            expect(result.value.name).toBe('dictionary.zip');
            expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
        } else {
            expect(result.error).toBeInstanceOf(Error);
        }
        expect(removeListener).toHaveBeenCalledOnce();
        expect([request.onload, request.onerror, request.onabort, request.ontimeout, request.onprogress]).toEqual([null, null, null, null, null]);
        abortController.abort();
        expect(request.abort).not.toHaveBeenCalled();
    });
});

describe('settings dictionary unused response cleanup', () => {
    test.each(['success', 'reject', 'pending'])('HTTP errors cancel the body without waiting for cancellation: %s', async (outcome) => {
        const cancel = vi.fn(() => {
            if (outcome === 'reject') { throw new Error('Body cancellation failed'); }
            if (outcome === 'pending') { return new Promise(() => {}); }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({cancel}), {status: 503})));
        const controller = createController();
        await expect(Reflect.get(controller, '_createImportSourceFromUrl').call(controller, 'https://example.com/download', 120_000, vi.fn(), new AbortController().signal)).rejects.toThrow('status=503');
        expect(cancel).toHaveBeenCalledOnce();
    });

    test.each([
        [503, 'text/html', false],
        [200, 'application/octet-stream', false],
        [200, 'application/octet-stream', true],
    ])('optional MDX listing cancels an unused response (%s, %s, cancel rejects: %s)', async (status, contentType, cancelRejects) => {
        const cancel = vi.fn(() => {
            if (cancelRejects) { throw new Error('Body cancellation failed'); }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({cancel}), {status, headers: {'Content-Type': contentType}})));
        const controller = createController();
        await expect(Reflect.get(controller, '_getMdxListingForUrl').call(controller, 'https://example.com/dictionary.mdx', 'dictionary.mdx', new AbortController().signal)).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
    });

    test('a valid optional listing is consumed and parsed instead of cancelled', async () => {
        const response = new Response('<html>directory</html>', {headers: {'Content-Type': 'text/html'}});
        const cancel = vi.spyOn(/** @type {ReadableStream} */ (response.body), 'cancel');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        const controller = createController();
        const listing = {mdxLink: {url: 'https://example.com/dictionary.mdx', fileName: 'dictionary.mdx'}, mddLinks: []};
        const parse = vi.fn().mockReturnValue(listing);
        Reflect.set(controller, '_parseMdxListingDocument', parse);
        await expect(Reflect.get(controller, '_getMdxListingForUrl').call(controller, listing.mdxLink.url, listing.mdxLink.fileName, new AbortController().signal)).resolves.toBe(listing);
        expect(parse).toHaveBeenCalledExactlyOnceWith('https://example.com/', '<html>directory</html>', 'dictionary.mdx');
        expect(cancel).not.toHaveBeenCalled();
    });
});

describe('settings MDX directory redirects', () => {
    test.each([
        ['https://example.com/dictionaries', 'https://example.com/dictionaries/'],
        ['https://example.com/dictionaries/', 'https://cdn.example.com/releases/current/'],
        ['https://example.com/dictionaries/', ''],
    ])('directory import resolves relative links against the delivered URL (%s -> %s)', async (url, responseUrl) => {
        vi.stubGlobal('DOMParser', DOMParser);
        const response = new Response('<a href="Book.mdx">MDX</a><a href="Book.10.mdd">volume 10</a><a href="Book.mdd">base</a><a href="Book.2.mdd">volume 2</a><a href="../Other.mdd">other directory</a>', {headers: {'Content-Type': 'text/html'}});
        Object.defineProperty(response, 'url', {value: responseUrl});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        const controller = createController();
        const source = {type: 'mdx', mdxFile: new File(['fixture'], 'Book.mdx'), mddFiles: []};
        const download = vi.fn().mockResolvedValue(source);
        Reflect.set(controller, '_downloadMdxImportSourceFromListing', download);
        const signal = new AbortController().signal;
        const onProgress = vi.fn();
        await expect(Reflect.get(controller, '_createImportSourceFromUrl').call(controller, url, 120_000, onProgress, signal)).resolves.toBe(source);
        const base = responseUrl || url;
        expect(download).toHaveBeenCalledExactlyOnceWith({
            mdxLink: {url: new URL('Book.mdx', base).href, fileName: 'Book.mdx'},
            mddLinks: ['Book.mdd', 'Book.2.mdd', 'Book.10.mdd'].map((fileName) => ({url: new URL(fileName, base).href, fileName})),
        }, 120_000, onProgress, signal);
    });

    test('redirected optional listing retains matching media and excludes other directories', async () => {
        vi.stubGlobal('DOMParser', DOMParser);
        const response = new Response('<a href="Book.mdx">MDX</a><a href="Book.mdd">base</a><a href="../Book.1.mdd">other directory</a>', {headers: {'Content-Type': 'text/html'}});
        Object.defineProperty(response, 'url', {value: 'https://example.com/releases/current/'});
        const fetch = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetch);
        const controller = createController();
        const signal = new AbortController().signal;
        await expect(Reflect.get(controller, '_getMdxListingForUrl').call(controller, 'https://example.com/releases/Book.mdx', 'Book.mdx', signal)).resolves.toEqual({
            mdxLink: {url: 'https://example.com/releases/current/Book.mdx', fileName: 'Book.mdx'},
            mddLinks: [{url: 'https://example.com/releases/current/Book.mdd', fileName: 'Book.mdd'}],
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith('https://example.com/releases/', {signal});
    });
});
