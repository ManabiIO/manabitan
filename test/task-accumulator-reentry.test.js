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

import {setImmediate as nextTurn} from 'node:timers/promises';
import {describe, expect, test, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {deferPromise} from '../ext/js/core/utilities.js';
import {TaskAccumulator} from '../ext/js/general/task-accumulator.js';

describe('TaskAccumulator callback reentry', () => {
    for (const key of [null, 'setting']) {
        for (const rejectFirst of [false, true]) {
            test(`serializes reentrant enqueue (key=${key}, reject=${rejectFirst})`, async () => {
                const release = deferPromise();
                const failure = new Error('injected assignment failure');
                const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
                /** @type {string[]} */
                const started = [];
                /** @type {string[]} */
                const completed = [];
                /** @type {Promise<void>} */
                let followup = Promise.resolve();
                let active = 0;
                let maximumActive = 0;
                let stale = false;
                /** @type {TaskAccumulator<string, string>} */
                const queue = new TaskAccumulator(async (tasks) => {
                    ++active;
                    maximumActive = Math.max(maximumActive, active);
                    const task = tasks[0][1];
                    started.push(task.data);
                    try {
                        if (task.data === 'first') {
                            followup = queue.enqueue(key, 'second');
                            stale = task.stale;
                            await release.promise;
                            if (rejectFirst) { throw failure; }
                        }
                        completed.push(task.data);
                    } finally {
                        --active;
                    }
                });
                try {
                    const first = queue.enqueue(key, 'first');
                    await nextTurn();
                    const beforeRelease = [...started];
                    release.resolve(null);
                    await first;
                    await followup;
                    expect(beforeRelease).toEqual(['first']);
                    expect(maximumActive).toBe(1);
                    expect(started).toEqual(['first', 'second']);
                    expect(completed).toEqual(rejectFirst ? ['second'] : ['first', 'second']);
                    expect(stale).toBe(key !== null);
                    expect(errors).toHaveBeenCalledTimes(rejectFirst ? 1 : 0);
                    if (rejectFirst) { expect(errors).toHaveBeenCalledWith(failure); }
                    await queue.enqueue(key, 'third');
                    expect(started).toEqual(['first', 'second', 'third']);
                    expect(active).toBe(0);
                } finally {
                    release.resolve(null);
                    errors.mockRestore();
                }
            });
        }
    }

    test('still batches ordinary work and keeps the newest pending value per key', async () => {
        /** @type {Array<Array<[string|null, string]>>} */
        const batches = [];
        /** @type {TaskAccumulator<string, string>} */
        const queue = new TaskAccumulator(async (tasks) => {
            batches.push(tasks.map(([key, task]) => [key, task.data]));
        });
        const first = queue.enqueue('setting', 'old');
        const second = queue.enqueue(null, 'unkeyed-a');
        const third = queue.enqueue('setting', 'new');
        const fourth = queue.enqueue(null, 'unkeyed-b');
        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(fourth).toBe(first);
        await first;
        expect(batches).toEqual([[[null, 'unkeyed-a'], [null, 'unkeyed-b'], ['setting', 'new']]]);
    });
});
