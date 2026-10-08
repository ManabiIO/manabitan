/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/** @returns {DictionaryImportController} */
function createController() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('dictionary URL download timeout ownership', () => {
    test('a completed download cannot time out while its yielded archive is being imported', async () => {
        vi.useFakeTimers();
        const controller = createController();
        const observed = {signal: /** @type {AbortSignal|null} */ (null)};
        /**
         * @param {...unknown} args
         * @returns {Promise<{type: string, file: File}>}
         */
        const download = async (...args) => {
            observed.signal = /** @type {AbortSignal} */ (args[3]);
            return {type: 'zip', file: new File(['archive'], 'dictionary.zip')};
        };
        Reflect.set(controller, '_createImportSourceFromUrl', download);
        Reflect.set(controller, '_getImportSourceSize', () => 7);
        const generator = controller._generateFilesFromUrls(['https://example.com/dictionary.zip'], vi.fn());
        const first = await generator.next();
        expect(first.done).toBe(false);
        const signal = observed.signal;
        if (signal === null) { throw new Error('Missing download signal'); }
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(120_001);
        expect(signal.aborted).toBe(false);
        await generator.return();
    });

    test('a stalled download still times out and rejects its source', async () => {
        vi.useFakeTimers();
        const controller = createController();
        /**
         * @param {...unknown} args
         * @returns {Promise<never>}
         */
        const download = async (...args) => {
            const signal = /** @type {AbortSignal} */ (args[3]);
            return await new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => { reject(signal.reason); }, {once: true});
            });
        };
        Reflect.set(controller, '_createImportSourceFromUrl', download);
        const generator = controller._generateFilesFromUrls(['https://example.com/dictionary.zip'], vi.fn());
        const pending = generator.next();
        const rejection = expect(pending).rejects.toThrow('Timed out fetching URL after 120000ms');
        await vi.advanceTimersByTimeAsync(120_000);
        await rejection;
    });
});
