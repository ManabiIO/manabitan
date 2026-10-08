/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ClipboardMonitor} from '../ext/js/comm/clipboard-monitor.js';

describe('Clipboard monitor read baseline', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('failed first read does not report already-existing text as a change', async () => {
        const getText = vi.fn()
            .mockRejectedValueOnce(new Error('permission not ready'))
            .mockResolvedValueOnce('existing')
            .mockResolvedValueOnce('new copy');
        const monitor = new ClipboardMonitor({getText});
        const onChange = vi.fn();
        monitor.on('change', onChange);

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(250);
        expect(onChange).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith({text: 'new copy'});
        monitor.stop();
    });

    test('successful clear permits the next copy of identical text', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('copied')
            .mockResolvedValueOnce(' ')
            .mockResolvedValueOnce('copied');
        const monitor = new ClipboardMonitor({getText});
        /** @type {string[]} */
        const changes = [];
        monitor.on('change', ({text}) => { changes.push(text); });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(750);
        expect(changes).toEqual(['copied', 'copied']);
        monitor.stop();
    });

    test('temporary read failure retains the last successful value', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('changed');
        const monitor = new ClipboardMonitor({getText});
        const onChange = vi.fn();
        monitor.on('change', onChange);

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(750);
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith({text: 'changed'});
        monitor.stop();
    });

    test('throwing subscriber is logged without stopping subsequent polls', async () => {
        const getText = vi.fn()
            .mockResolvedValueOnce('initial')
            .mockResolvedValueOnce('first')
            .mockResolvedValueOnce('second');
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const monitor = new ClipboardMonitor({getText});
        monitor.on('change', () => { throw new Error('subscriber failed'); });

        monitor.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(getText).toHaveBeenCalledTimes(3);
        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        monitor.stop();
    });
});
