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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ClipboardMonitor} from '../ext/js/comm/clipboard-monitor.js';

describe('ClipboardMonitor observed state', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a failed first clipboard read does not turn unchanged text into a new copy', async () => {
        const getText = vi.fn()
            .mockRejectedValueOnce(new Error('permission not ready'))
            .mockResolvedValueOnce('existing')
            .mockResolvedValueOnce('new');
        const monitor = new ClipboardMonitor({getText});
        const onChange = vi.fn();
        monitor.on('change', onChange);

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        expect(onChange).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(onChange).toHaveBeenCalledExactlyOnceWith({text: 'new'});
        monitor.stop();
    });

    test('clearing the clipboard allows copying the same text again', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('copied')
            .mockResolvedValueOnce(' ')
            .mockResolvedValueOnce('copied');
        const monitor = new ClipboardMonitor({getText});
        const texts = [];
        monitor.on('change', ({text}) => { texts.push(text); });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(750);
        expect(texts).toEqual(['copied', 'copied']);
        expect(getText).toHaveBeenCalledTimes(4);
        monitor.stop();
    });

    test('later read errors keep the last successful value for deduplication', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('changed');
        const monitor = new ClipboardMonitor({getText});
        const texts = [];
        monitor.on('change', ({text}) => { texts.push(text); });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(750);
        expect(texts).toEqual(['changed']);
        monitor.stop();
    });

    test('stop inside a change handler prevents the old poller from rescheduling', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('changed')
            .mockResolvedValue('unexpected');
        const monitor = new ClipboardMonitor({getText});
        const onChange = vi.fn(() => { monitor.stop(); });
        monitor.on('change', onChange);

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        expect(onChange).toHaveBeenCalledOnce();
        expect(getText).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(750);
        expect(getText).toHaveBeenCalledTimes(2);
    });

    test('restart inside a change handler leaves just the replacement timer', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('changed')
            .mockResolvedValueOnce('replacement baseline')
            .mockResolvedValueOnce('replacement change');
        const monitor = new ClipboardMonitor({getText});
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
        expect(getText).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(getText).toHaveBeenCalledTimes(4);
        expect(vi.getTimerCount()).toBe(1);
        monitor.stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
