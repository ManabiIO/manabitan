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
import {Offscreen} from '../ext/js/background/offscreen.js';

/**
 * @returns {Offscreen}
 */
function createOffscreenForInternalTests() {
    return /** @type {Offscreen} */ (Object.create(Offscreen.prototype));
}

/**
 * @param {string} name
 * @returns {Function}
 */
function getOffscreenMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(Offscreen.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected Offscreen.${name} to be a function`);
    }
    return method;
}

describe('Offscreen import response port handling', () => {
    const importDictionaryOffscreenHandler = /** @type {(this: Offscreen, params: {archiveContent: Blob, details: import('dictionary-importer').ImportDetails}, ports: MessagePort[]) => void} */ (getOffscreenMethod('_importDictionaryOffscreenHandler'));

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('does not throw when error delivery to a dead import response port fails', async () => {
        const offscreen = createOffscreenForInternalTests();
        Reflect.set(offscreen, '_invokeDictionaryWorker', vi.fn(async () => {
            throw new Error('dictionary worker unavailable');
        }));
        const responsePort = {
            postMessage: vi.fn(() => {
                throw new Error('response port is closed');
            }),
            close: vi.fn(() => {
                throw new Error('response port close failed');
            }),
        };
        const typedResponsePort = /** @type {MessagePort} */ (/** @type {unknown} */ (responsePort));

        expect(importDictionaryOffscreenHandler.call(
            offscreen,
            {
                archiveContent: new Blob(['dictionary']),
                details: /** @type {import('dictionary-importer').ImportDetails} */ ({}),
            },
            [typedResponsePort],
        )).toBeUndefined();

        await vi.waitFor(() => expect(responsePort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
        })));
        expect(responsePort.close).toHaveBeenCalledTimes(1);
    });
});
