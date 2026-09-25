/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ClipboardMonitor} from '../ext/js/comm/clipboard-monitor.js';
import {deferPromise} from '../ext/js/core/utilities.js';

/**
 * @param {string[]} values
 * @returns {{monitor: ClipboardMonitor, getText: ReturnType<typeof vi.fn>}}
 */
function createMonitor(values) {
    let index = 0;
    const getText = vi.fn(async () => {
        const value = values[Math.min(index, values.length - 1)] ?? '';
        ++index;
        return value;
    });
    const monitor = new ClipboardMonitor({getText});
    return {monitor, getText};
}

describe('ClipboardMonitor handler lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('stop from a change handler does not schedule another poll', async () => {
        const {monitor, getText} = createMonitor(['initial', 'changed', 'unexpected']);
        /** @type {string[]} */
        const changes = [];
        monitor.on('change', ({text}) => {
            changes.push(text);
            monitor.stop();
        });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);

        expect(changes).toStrictEqual(['changed']);
        expect(getText).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(1000);
        expect(getText).toHaveBeenCalledTimes(2);
    });

    test('restart from a change handler leaves only the replacement poller', async () => {
        const {monitor, getText} = createMonitor(['initial', 'changed', 'replacement-initial', 'replacement-next']);
        let restarted = false;
        monitor.on('change', () => {
            if (!restarted) {
                restarted = true;
                monitor.start();
            }
        });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();

        expect(restarted).toBe(true);
        expect(getText).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(getText).toHaveBeenCalledTimes(4);
        expect(vi.getTimerCount()).toBe(1);

        monitor.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('ordinary polling continues when the handler does not change lifecycle', async () => {
        const {monitor, getText} = createMonitor(['initial', 'changed', 'same']);
        /** @type {string[]} */
        const changes = [];
        monitor.on('change', ({text}) => { changes.push(text); });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);

        expect(changes).toStrictEqual(['changed']);
        expect(getText).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        monitor.stop();
    });

    test('stop while a clipboard read is pending still prevents rescheduling', async () => {
        /** @type {(value: string) => void} */
        let resolveRead = (_value) => { throw new Error('Read did not start'); };
        const getText = vi.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
        const monitor = new ClipboardMonitor({getText});

        monitor.start();
        expect(getText).toHaveBeenCalledOnce();
        monitor.stop();
        resolveRead('late');
        await Promise.resolve();
        await Promise.resolve();

        expect(vi.getTimerCount()).toBe(0);
    });

    test.each(['resolve', 'reject'])('late old read %s cannot replace the restarted monitor state', async (outcome) => {
        const oldRead = /** @type {import('core').DeferredPromiseDetails<string>} */ (deferPromise());
        const getText = vi.fn()
            .mockImplementationOnce(() => oldRead.promise)
            .mockResolvedValue('replacement');
        const monitor = new ClipboardMonitor({getText});
        const onChange = vi.fn();
        monitor.on('change', onChange);

        monitor.start();
        monitor.start();
        await Promise.resolve();
        expect(getText).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);

        if (outcome === 'resolve') {
            oldRead.resolve('stale');
        } else {
            oldRead.reject(new Error('obsolete read failed'));
        }
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);

        expect(getText).toHaveBeenCalledTimes(3);
        expect(onChange).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        monitor.stop();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(getText).toHaveBeenCalledTimes(3);
    });
});
