/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {deferPromise} from '../ext/js/core/utilities.js';

/** @returns {{controller: DictionaryImportController, recover: ReturnType<typeof vi.fn>}} */
function fixture() {
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    const recover = vi.fn();
    Reflect.set(controller, '_forceRecoverHungImportSession', recover);
    return {controller, recover};
}

describe('progress-aware import watchdog ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('success releases the pending watchdog timer', async () => {
        const {controller, recover} = fixture();
        await controller._runImportWithWatchdog(Promise.resolve(), 'Import');
        expect(vi.getTimerCount()).toBe(0);
        expect(recover).not.toHaveBeenCalled();
    });

    test.each(['Storage failed', 'Provider did not complete within its own budget'])('ordinary error %s cannot force recovery', async (message) => {
        const {controller, recover} = fixture();
        const error = new Error(message);
        await expect(controller._runImportWithWatchdog(Promise.reject(error), 'Import')).rejects.toBe(error);
        expect(recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('idle deadline recovers once and releases its timer', async () => {
        const {controller, recover} = fixture();
        const pending = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const result = controller._runImportWithWatchdog(pending.promise, 'Import').catch((error) => error);
        await vi.advanceTimersByTimeAsync(180_000);
        const error = await result;
        expect(error.message).toContain('without progress');
        expect(recover).toHaveBeenCalledOnce();
        expect(recover).toHaveBeenCalledWith(error, 'Import');
        expect(vi.getTimerCount()).toBe(0);
        pending.resolve();
    });

    test('forward progress renews the idle budget', async () => {
        const {controller, recover} = fixture();
        const pending = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const tracker = {lastActivityTime: 0, lastForwardProgressTime: 0};
        const result = controller._runImportWithWatchdog(pending.promise, 'Import', tracker);
        await vi.advanceTimersByTimeAsync(179_000);
        tracker.lastForwardProgressTime = Date.now();
        await vi.advanceTimersByTimeAsync(179_000);
        expect(recover).not.toHaveBeenCalled();
        pending.resolve();
        await result;
        expect(vi.getTimerCount()).toBe(0);
    });

    test('continued progress respects the absolute two-hour deadline', async () => {
        const {controller, recover} = fixture();
        const pending = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const tracker = {lastActivityTime: 0, lastForwardProgressTime: 0};
        const activity = setInterval(() => { tracker.lastForwardProgressTime = Date.now(); }, 60_000);
        const result = controller._runImportWithWatchdog(pending.promise, 'Import', tracker).catch((error) => error);
        await vi.advanceTimersByTimeAsync(7_200_000);
        clearInterval(activity);
        const error = await result;
        expect(error.message).toContain('7200000ms');
        expect(recover).toHaveBeenCalledOnce();
        expect(recover).toHaveBeenCalledWith(error, 'Import');
        expect(vi.getTimerCount()).toBe(0);
        pending.resolve();
    });
});
