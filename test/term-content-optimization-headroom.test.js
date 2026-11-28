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

import {expect, test} from 'vitest';
import {assertTermContentOptimizationHeadroom} from '../ext/js/dictionary/term-content-optimization-headroom.js';

const MiB = 1024 * 1024;

test('defers unknown or insufficient headroom and leaves room for publication', async () => {
    await expect(assertTermContentOptimizationHeadroom(2 * MiB, undefined, async () => ({quota: 32 * MiB, usage: 15 * MiB})))
        .rejects.toMatchObject({name: 'QuotaExceededError'});
    await expect(assertTermContentOptimizationHeadroom(2 * MiB, undefined, async () => ({})))
        .rejects.toMatchObject({name: 'QuotaExceededError'});
    await expect(assertTermContentOptimizationHeadroom(2 * MiB, undefined, async () => ({quota: 32 * MiB, usage: 14 * MiB})))
        .resolves.toBeUndefined();
});

test('a lookup preemption during quota estimation cannot admit a writer', async () => {
    const controller = new AbortController();
    await expect(assertTermContentOptimizationHeadroom(1, controller.signal, async () => {
        controller.abort();
        return {quota: 32 * MiB, usage: 0};
    })).rejects.toMatchObject({name: 'AbortError'});
});
