/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @returns {{controller: DictionaryImportController, recover: import('vitest').Mock}}
 */
function createController() {
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    const recover = vi.fn();
    Reflect.set(controller, '_forceRecoverHungImportSession', recover);
    return {controller, recover};
}

describe('Dictionary import watchdog cleanup', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('clears the watchdog after an import completes successfully', async () => {
        vi.useFakeTimers();
        const {controller, recover} = createController();

        await controller._runImportWithWatchdog(Promise.resolve(), 'Fast import');

        expect(recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('clears the watchdog after a real import error without forcing recovery', async () => {
        vi.useFakeTimers();
        const {controller, recover} = createController();
        const error = new Error('Archive is invalid');

        await expect(controller._runImportWithWatchdog(Promise.reject(error), 'Failed import')).rejects.toBe(error);

        expect(recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('does not mistake an ordinary error message for the watchdog deadline', async () => {
        vi.useFakeTimers();
        const {controller, recover} = createController();
        const error = new Error('Worker did not complete within its own deadline');

        await expect(controller._runImportWithWatchdog(Promise.reject(error), 'Other error')).rejects.toBe(error);

        expect(recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('forces recovery only when the active import actually exceeds the deadline', async () => {
        vi.useFakeTimers();
        const {controller, recover} = createController();
        /** @type {Promise<void>} */
        const neverCompletes = new Promise(() => {});
        const pending = controller._runImportWithWatchdog(neverCompletes, 'Hanging import');
        const assertion = expect(pending).rejects.toThrow('Hanging import did not complete within 180000ms');

        await vi.advanceTimersByTimeAsync(180_000);

        await assertion;
        expect(recover).toHaveBeenCalledOnce();
        expect(recover).toHaveBeenCalledWith(expect.any(Error), 'Hanging import');
        expect(vi.getTimerCount()).toBe(0);
    });
});
