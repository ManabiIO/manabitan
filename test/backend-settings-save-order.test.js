/*
 * Copyright (C) 2026  Manabitan Authors
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

import {describe, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

/**
 * @param {(options: import('settings').Options) => Promise<void>} save
 * @returns {{backend: Backend, options: {value: string}, applyOptions: ReturnType<typeof vi.fn>, clearCache: ReturnType<typeof vi.fn>}}
 */
function createBackend(save) {
    const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
    const options = {value: 'initial'};
    const applyOptions = vi.fn();
    const clearCache = vi.fn();
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {save});
    Reflect.set(backend, '_applyOptions', applyOptions);
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', clearCache);
    return {backend, options, applyOptions, clearCache};
}

describe('Backend settings persistence ordering', () => {
    test('a newer settings snapshot cannot be overwritten by a delayed earlier save', async () => {
        const firstEntered = Promise.withResolvers();
        const releaseFirst = Promise.withResolvers();
        /** @type {string[]} */
        const persisted = [];
        let attempts = 0;
        const save = vi.fn(async (/** @type {import('settings').Options} */ options) => {
            const snapshot = /** @type {unknown} */ (Reflect.get(options, 'value'));
            if (++attempts === 1) {
                firstEntered.resolve(void 0);
                await releaseFirst.promise;
            }
            persisted.push(String(snapshot));
        });
        const {backend, options, applyOptions, clearCache} = createBackend(save);

        options.value = 'first';
        const earlier = backend._saveOptions('first');
        await firstEntered.promise;
        options.value = 'second';
        const later = backend._saveOptions('second');
        await Promise.resolve();

        expect(save).toHaveBeenCalledOnce();
        releaseFirst.resolve(void 0);
        await Promise.all([earlier, later]);

        expect(persisted).toStrictEqual(['first', 'second']);
        expect(applyOptions.mock.calls).toStrictEqual([['first'], ['second']]);
        expect(clearCache).toHaveBeenCalledTimes(2);
    });

    test('a failed storage write rejects its caller but does not block the next save', async () => {
        const save = vi.fn()
            .mockRejectedValueOnce(new Error('storage unavailable'))
            .mockResolvedValueOnce(void 0);
        const {backend, applyOptions} = createBackend(save);

        const earlier = backend._saveOptions('failed');
        const later = backend._saveOptions('retry');

        await expect(earlier).rejects.toThrow('storage unavailable');
        await expect(later).resolves.toBeUndefined();
        expect(save).toHaveBeenCalledTimes(2);
        expect(applyOptions).toHaveBeenCalledOnce();
        expect(applyOptions).toHaveBeenCalledWith('retry');
    });
});
