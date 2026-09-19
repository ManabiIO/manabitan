/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {ExtensionDictionaryWorkerBackend} from '../ext/js/comm/dictionary-worker-backend.js';
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

/**
 * @param {unknown} response
 * @param {{message: string}|undefined} [lastError]
 * @returns {{runtime: {lastError: {message: string}|undefined, sendMessage: ReturnType<typeof vi.fn>}, backend: ExtensionDictionaryWorkerBackend}}
 */
function backendWithResponse(response, lastError) {
    const runtime = {
        lastError,
        sendMessage: vi.fn((_message, callback) => { callback(response); }),
    };
    const backend = new ExtensionDictionaryWorkerBackend(
        /** @type {typeof chrome.runtime} */ (/** @type {unknown} */ (runtime)),
    );
    return {runtime, backend};
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('extension dictionary transport adapter', () => {
    test('sends only the existing delete action and its parameters', async () => {
        const {runtime, backend} = backendWithResponse({result: null});
        await backend.deleteDictionaryByTitle('Jitendex');
        expect(runtime.sendMessage).toHaveBeenCalledWith({action: 'deleteDictionaryByTitle', params: {dictionaryTitle: 'Jitendex'}}, expect.any(Function));
    });

    test('preserves dictionary count results and getTotal', async () => {
        const result = {counts: [], total: {terms: 12}};
        const {runtime, backend} = backendWithResponse({result});
        await expect(backend.getDictionaryCounts(['Jitendex'], true)).resolves.toBe(result);
        expect(runtime.sendMessage).toHaveBeenCalledWith({action: 'getDictionaryCounts', params: {dictionaryNames: ['Jitendex'], getTotal: true}}, expect.any(Function));
    });

    test('reads runtime.lastError in the message callback', async () => {
        const {backend} = backendWithResponse({result: null}, {message: 'Port closed'});
        await expect(backend.deleteDictionaryByTitle('test')).rejects.toThrow('Port closed');
    });

    test.each([null, undefined, [], 'unexpected', 3])('rejects malformed response %s', async (response) => {
        const {backend} = backendWithResponse(response);
        await expect(backend.getDictionaryCounts([], false)).rejects.toThrow('invalid response');
    });

    test('preserves serialized extension errors', async () => {
        const {backend} = backendWithResponse({error: {name: 'StorageError', message: 'locked', stack: 'test'}});
        await expect(backend.deleteDictionaryByTitle('test')).rejects.toMatchObject({name: 'StorageError', message: 'locked'});
    });

    test.each(['failure', []])('rejects malformed error payload %s', async (error) => {
        const {backend} = backendWithResponse({error});
        await expect(backend.deleteDictionaryByTitle('test')).rejects.toThrow('invalid error payload');
    });

    test('absence of runtime is a clear operation error, not a global ReferenceError', async () => {
        // eslint-disable-next-line unicorn/no-useless-undefined
        vi.stubGlobal('chrome', undefined);
        const backend = new ExtensionDictionaryWorkerBackend(undefined);
        await expect(backend.deleteDictionaryByTitle('test')).rejects.toThrow('extension runtime unavailable');
    });
});

describe('shared dictionary worker host boundary', () => {
    test('delegates deletion without any chrome global and reports completion afterward', async () => {
        // eslint-disable-next-line unicorn/no-useless-undefined
        vi.stubGlobal('chrome', undefined);
        /** @type {() => void} */
        let finish = () => { throw new Error('Missing completion callback'); };
        const deleteDictionaryByTitle = vi.fn(() => /** @type {Promise<void>} */ (new Promise((resolve) => { finish = resolve; })));
        const handler = new DictionaryWorkerHandler(
            /** @type {import('dictionary-worker-handler').DictionaryWorkerBackend} */ ({
                deleteDictionaryByTitle,
                getDictionaryCounts: vi.fn(),
            }),
        );
        const progress = vi.fn();
        const operation = Reflect.get(handler, '_deleteDictionary').call(handler, {dictionaryTitle: 'test'}, progress);
        expect(deleteDictionaryByTitle).toHaveBeenCalledWith('test');
        expect(progress).toHaveBeenCalledTimes(1);
        finish();
        await operation;
        expect(progress).toHaveBeenCalledTimes(2);
    });

    test('delegates count queries to the explicit owning environment', async () => {
        // eslint-disable-next-line unicorn/no-useless-undefined
        vi.stubGlobal('chrome', undefined);
        const result = {counts: []};
        const getDictionaryCounts = vi.fn().mockResolvedValue(result);
        const handler = new DictionaryWorkerHandler({deleteDictionaryByTitle: vi.fn(), getDictionaryCounts});
        await expect(Reflect.get(handler, '_getDictionaryCounts').call(handler, {dictionaryNames: ['test'], getTotal: false})).resolves.toBe(result);
        expect(getDictionaryCounts).toHaveBeenCalledWith(['test'], false);
    });

    test('missing backend fails closed instead of implicitly contacting an extension', async () => {
        vi.stubGlobal('chrome', {runtime: {sendMessage: vi.fn()}});
        const handler = new DictionaryWorkerHandler();
        await expect(Reflect.get(handler, '_getDictionaryCounts').call(handler, {dictionaryNames: [], getTotal: false})).rejects.toThrow('not configured');
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    test('failed deletion never emits successful completion progress', async () => {
        const backend = {deleteDictionaryByTitle: vi.fn().mockRejectedValue(new Error('locked')), getDictionaryCounts: vi.fn()};
        const handler = new DictionaryWorkerHandler(backend);
        const progress = vi.fn();
        await expect(Reflect.get(handler, '_deleteDictionary').call(handler, {dictionaryTitle: 'test'}, progress)).rejects.toThrow('locked');
        expect(progress).toHaveBeenCalledTimes(1);
    });
});
