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
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {DictionaryWorkerHandler} from '../ext/js/dictionary/dictionary-worker-handler.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @returns {{messages: unknown[], postMessage: ReturnType<typeof vi.fn>}}
 */
function installStructuredCloneWorker() {
    /** @type {unknown[]} */
    const messages = [];
    const postMessage = vi.fn((message) => {
        messages.push(structuredClone(message));
    });
    vi.stubGlobal('self', {postMessage});
    return {messages, postMessage};
}

describe('DictionaryWorkerHandler completion transport', () => {
    test('reports a structured-clone failure instead of stranding an uncloneable result', async () => {
        const {messages, postMessage} = installStructuredCloneWorker();
        const handler = new DictionaryWorkerHandler();

        await Reflect.get(handler, '_onMessageWithProgress').call(
            handler,
            {},
            async () => ({callback() {}}),
        );

        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(messages).toHaveLength(1);
        const message = /** @type {{action: string, params: {error: import('core').SerializedError}}} */ (messages[0]);
        expect(message.action).toBe('complete');
        expect(() => ExtensionError.deserialize(message.params.error)).not.toThrow();
    });

    test('reports a clone failure when serialized ExtensionError data is not cloneable', async () => {
        const {messages, postMessage} = installStructuredCloneWorker();
        const handler = new DictionaryWorkerHandler();

        await Reflect.get(handler, '_onMessageWithProgress').call(
            handler,
            {},
            async () => {
                const error = new ExtensionError('original failure');
                error.data = () => {};
                throw error;
            },
        );

        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(messages).toHaveLength(1);
        const message = /** @type {{action: string, params: {error: import('core').SerializedError}}} */ (messages[0]);
        expect(message.action).toBe('complete');
        expect(() => ExtensionError.deserialize(message.params.error)).not.toThrow();
    });

    test('keeps a serializable successful result unchanged', async () => {
        const {messages, postMessage} = installStructuredCloneWorker();
        const handler = new DictionaryWorkerHandler();
        const result = {counts: [{terms: 3}]};

        await Reflect.get(handler, '_onMessageWithProgress').call(
            handler,
            {},
            async () => result,
        );

        expect(postMessage).toHaveBeenCalledOnce();
        expect(messages).toEqual([{action: 'complete', params: {result}}]);
    });
});
