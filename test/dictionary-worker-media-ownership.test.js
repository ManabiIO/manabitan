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
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryWorkerMediaLoader} from '../ext/js/dictionary/dictionary-worker-media-loader.js';

/** @typedef {{action: string, params: {id: string, content: ArrayBuffer, mediaType: string}}} ImageRequest */

const sourceBytes = [0x3c, 0x73, 0x76, 0x67, 0x2f, 0x3e];

/**
 * Apply the actual structured-clone transfer semantics rather than a spy that
 * leaves transferred ArrayBuffers attached in the sender.
 * @returns {ReturnType<typeof vi.fn<(message: ImageRequest, transfer?: Transferable[]) => ImageRequest>>}
 */
function createHost() {
    const postMessage = vi.fn((/** @type {ImageRequest} */ message, /** @type {Transferable[]} */ transfer = []) => (
        structuredClone(message, {transfer})
    ));
    vi.stubGlobal('self', {postMessage});
    return postMessage;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('image metadata request buffer ownership', () => {
    test('preserves caller bytes when the host rejects decoding', async () => {
        const host = createHost();
        const loader = new DictionaryWorkerMediaLoader();
        const content = Uint8Array.from(sourceBytes).buffer;
        const promise = loader.getImageDetails(content, 'image/svg+xml');
        const {params} = host.mock.results[0].value;
        loader.handleMessage({id: params.id, error: ExtensionError.serialize(new Error('unsupported image'))});

        await expect(promise).rejects.toThrow('unsupported image');
        expect([...new Uint8Array(content)]).toEqual(sourceBytes);
        expect([...new Uint8Array(params.content)]).toEqual(sourceBytes);
        expect(params.content).not.toBe(content);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });

    test('preserves caller bytes when the host transfers a successful result back', async () => {
        const host = createHost();
        const loader = new DictionaryWorkerMediaLoader();
        const content = Uint8Array.from(sourceBytes).buffer;
        const promise = loader.getImageDetails(content, 'image/svg+xml');
        const {params} = host.mock.results[0].value;
        const returned = structuredClone(params.content, {transfer: [params.content]});
        loader.handleMessage({id: params.id, result: {content: returned, width: 12, height: 34}});

        await expect(promise).resolves.toEqual({content: returned, width: 12, height: 34});
        expect([...new Uint8Array(returned)]).toEqual(sourceBytes);
        expect([...new Uint8Array(content)]).toEqual(sourceBytes);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });

    test('preserves caller bytes after a timeout and ignores a late host reply', async () => {
        vi.useFakeTimers();
        const host = createHost();
        const loader = new DictionaryWorkerMediaLoader();
        const content = Uint8Array.from(sourceBytes).buffer;
        const promise = loader.getImageDetails(content, 'image/svg+xml');
        const expectation = expect(promise).rejects.toThrow('Timed out waiting for image details');
        const {params} = host.mock.results[0].value;
        await vi.advanceTimersByTimeAsync(60_000);
        await expectation;
        const returned = structuredClone(params.content, {transfer: [params.content]});
        loader.handleMessage({id: params.id, result: {content: returned, width: 12, height: 34}});

        expect([...new Uint8Array(content)]).toEqual(sourceBytes);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each(['decode error', 'timeout'])('keeps importer fallback media intact after %s', async (failure) => {
        vi.useFakeTimers();
        const host = createHost();
        const loader = new DictionaryWorkerMediaLoader();
        const importer = new DictionaryImporter(loader);
        const content = Uint8Array.from(sourceBytes);
        const read = vi.fn(async () => content);
        Reflect.set(importer, '_getData', read);
        Reflect.set(importer, '_skipImageMetadata', false);
        const media = new Map();
        const context = {fileMap: new Map([['picture.svg', {}]]), media};
        const entry = {dictionary: 'Image ownership fixture', expression: 'a', reading: ''};
        const promise = Reflect.get(importer, '_getImageMedia').call(importer, context, 'picture.svg', entry);
        await vi.advanceTimersByTimeAsync(0);
        const {params} = host.mock.results[0].value;
        if (failure === 'timeout') {
            await vi.advanceTimersByTimeAsync(60_000);
        } else {
            loader.handleMessage({id: params.id, error: ExtensionError.serialize(new Error('unsupported image'))});
        }
        const result = await promise;

        expect(result.width).toBe(0);
        expect(result.height).toBe(0);
        expect([...new Uint8Array(result.content)]).toEqual(sourceBytes);
        expect(media.get('picture.svg')).toBe(result);
        expect(read).toHaveBeenCalledTimes(1);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });
});
