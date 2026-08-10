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

import {describe, expect, test, vi} from 'vitest';
import {RetryablePromiseCache} from '../ext/js/core/retryable-promise-cache.js';

describe('RetryablePromiseCache', () => {
    test('shares a successful in-flight initialization and caches its result', async () => {
        const cache = new RetryablePromiseCache();
        const value = {};
        const factory = vi.fn(async () => value);

        const [first, second] = await Promise.all([cache.get(factory), cache.get(factory)]);

        expect(first).toBe(value);
        expect(second).toBe(value);
        expect(await cache.get(factory)).toBe(value);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    test('evicts a shared rejection so a later initialization can recover', async () => {
        const cache = new RetryablePromiseCache();
        const failure = new Error('temporary failure');
        let rejectInitialization = (_reason) => {};
        const firstFactory = vi.fn(() => new Promise((_resolve, reject) => {
            rejectInitialization = reject;
        }));

        const first = cache.get(firstFactory);
        const second = cache.get(firstFactory);
        await Promise.resolve();
        rejectInitialization(failure);
        await expect(first).rejects.toBe(failure);
        await expect(second).rejects.toBe(failure);
        expect(firstFactory).toHaveBeenCalledTimes(1);

        const recoveredValue = {};
        const recoveryFactory = vi.fn(async () => recoveredValue);
        await expect(cache.get(recoveryFactory)).resolves.toBe(recoveredValue);
        expect(recoveryFactory).toHaveBeenCalledTimes(1);
    });
});
