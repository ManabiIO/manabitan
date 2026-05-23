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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryWorkerMediaLoader} from '../ext/js/dictionary/dictionary-worker-media-loader.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DictionaryWorkerMediaLoader', () => {
    test('rejects and clears pending request when host postMessage fails', async () => {
        const postMessage = vi.fn(() => {
            throw new Error('host channel closed');
        });
        vi.stubGlobal('self', {postMessage});
        const loader = new DictionaryWorkerMediaLoader();

        await expect(
            loader.getImageDetails(new ArrayBuffer(4), 'image/png'),
        ).rejects.toThrow('host channel closed');

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });

    test('times out unanswered host requests', async () => {
        vi.useFakeTimers();
        const postMessage = vi.fn();
        vi.stubGlobal('self', {postMessage});
        const loader = new DictionaryWorkerMediaLoader();

        const promise = loader.getImageDetails(new ArrayBuffer(4), 'image/png');
        const expectation = expect(promise).rejects.toThrow('Timed out waiting for image details response after 60000ms');

        expect(Reflect.get(loader, '_requests').size).toBe(1);
        await vi.advanceTimersByTimeAsync(60_000);
        await expectation;

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });

    test('settles matching host responses and drops stale responses', async () => {
        const postMessage = vi.fn();
        vi.stubGlobal('self', {postMessage});
        const loader = new DictionaryWorkerMediaLoader();

        const promise = loader.getImageDetails(new ArrayBuffer(4), 'image/png');
        expect(postMessage).toHaveBeenCalledTimes(1);
        const [{params}] = postMessage.mock.calls[0];

        loader.handleMessage({
            id: 'missing',
            result: {
                content: new ArrayBuffer(0),
                width: 0,
                height: 0,
            },
        });
        expect(Reflect.get(loader, '_requests').size).toBe(1);

        const content = new ArrayBuffer(2);
        loader.handleMessage({
            id: params.id,
            result: {
                content,
                width: 8,
                height: 9,
            },
        });

        await expect(promise).resolves.toStrictEqual({
            content,
            width: 8,
            height: 9,
        });
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });

    test('rejects matching host error responses', async () => {
        const postMessage = vi.fn();
        vi.stubGlobal('self', {postMessage});
        const loader = new DictionaryWorkerMediaLoader();

        const promise = loader.getImageDetails(new ArrayBuffer(4), 'image/png');
        const [{params}] = postMessage.mock.calls[0];
        loader.handleMessage({
            id: params.id,
            error: ExtensionError.serialize(new Error('invalid image')),
        });

        await expect(promise).rejects.toThrow('invalid image');
        expect(Reflect.get(loader, '_requests').size).toBe(0);
    });
});
