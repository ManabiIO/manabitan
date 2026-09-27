/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {TaskAccumulator} from '../ext/js/general/task-accumulator.js';

describe('TaskAccumulator reentrant enqueue', () => {
    test('serializes a task enqueued before the active callback first yields', async () => {
        /** @type {string[]} */
        const events = [];
        let active = 0;
        let maxActive = 0;
        let followUp = Promise.resolve();
        /** @type {TaskAccumulator<string, string>} */
        const accumulator = new TaskAccumulator(async (tasks) => {
            ++active;
            maxActive = Math.max(maxActive, active);
            const data = tasks[0][1].data;
            events.push(`${data}:start`);
            if (data === 'first') {
                followUp = accumulator.enqueue('second', 'second');
                await Promise.resolve();
            }
            events.push(`${data}:end`);
            --active;
        });

        await accumulator.enqueue('first', 'first');
        await followUp;
        expect(maxActive).toBe(1);
        expect(events).toStrictEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    test('marks same-key active work stale and runs only the latest queued value', async () => {
        /** @type {string[]} */
        const events = [];
        /** @type {boolean[]} */
        const staleStates = [];
        let followUp = Promise.resolve();
        /** @type {TaskAccumulator<string, string>} */
        const accumulator = new TaskAccumulator(async (tasks) => {
            const task = tasks[0][1];
            events.push(`${task.data}:start`);
            if (task.data === 'first') {
                void accumulator.enqueue('key', 'superseded');
                followUp = accumulator.enqueue('key', 'latest');
                staleStates.push(task.stale);
                await Promise.resolve();
            } else {
                staleStates.push(task.stale);
            }
            events.push(`${task.data}:end`);
        });

        await accumulator.enqueue('key', 'first');
        await followUp;
        expect(events).toStrictEqual(['first:start', 'first:end', 'latest:start', 'latest:end']);
        expect(staleStates).toStrictEqual([true, false]);
    });

    test('does not replay completed anonymous tasks after a reentrant batch', async () => {
        /** @type {string[][]} */
        const batches = [];
        let followUp = Promise.resolve();
        let queued = false;
        /** @type {TaskAccumulator<string, string>} */
        const accumulator = new TaskAccumulator(async (tasks) => {
            batches.push(tasks.map(([, task]) => task.data));
            if (!queued) {
                queued = true;
                followUp = accumulator.enqueue(null, 'second');
                await Promise.resolve();
            }
        });

        await accumulator.enqueue(null, 'first');
        await followUp;
        await accumulator.enqueue(null, 'third');
        expect(batches).toStrictEqual([['first'], ['second'], ['third']]);
    });

    test('preserves same-turn keyed coalescing and all anonymous tasks', async () => {
        /** @type {string[][]} */
        const batches = [];
        /** @type {TaskAccumulator<string, string>} */
        const accumulator = new TaskAccumulator(async (tasks) => {
            batches.push(tasks.map(([, task]) => task.data));
        });

        await Promise.all([
            accumulator.enqueue('key', 'superseded'),
            accumulator.enqueue(null, 'anonymous-1'),
            accumulator.enqueue('key', 'latest'),
            accumulator.enqueue(null, 'anonymous-2'),
        ]);
        expect(batches).toStrictEqual([['anonymous-1', 'anonymous-2', 'latest']]);
    });

    test('continues to serialize work enqueued after the callback yields', async () => {
        /** @type {string[]} */
        const events = [];
        let followUp = Promise.resolve();
        /** @type {TaskAccumulator<string, string>} */
        const accumulator = new TaskAccumulator(async (tasks) => {
            const data = tasks[0][1].data;
            events.push(`${data}:start`);
            if (data === 'first') {
                await Promise.resolve();
                followUp = accumulator.enqueue('second', 'second');
                await Promise.resolve();
            }
            events.push(`${data}:end`);
        });

        await accumulator.enqueue('first', 'first');
        await followUp;
        expect(events).toStrictEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });
});
