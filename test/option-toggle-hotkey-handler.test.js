/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {OptionToggleHotkeyHandler} from '../ext/js/display/option-toggle-hotkey-handler.js';

/**
 * @param {ReturnType<typeof vi.fn>} getSettings
 * @param {ReturnType<typeof vi.fn>} modifySettings
 * @returns {{
 *   handler: OptionToggleHotkeyHandler,
 *   notifications: ReturnType<typeof vi.fn>,
 *   setContext: (context: import('settings').OptionsContext) => void,
 * }}
 */
function createHarness(getSettings, modifySettings) {
    /** @type {import('settings').OptionsContext} */
    let context = {index: 0};
    const display = {
        getOptionsContext: () => context,
        application: {api: {getSettings, modifySettings}},
    };
    const handler = new OptionToggleHotkeyHandler(
        /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)),
    );
    const notifications = vi.fn();
    // Test the option ownership and API calls without coupling these regressions
    // to notification DOM templates or the notification's hide timer.
    Reflect.set(handler, '_showNotification', notifications);
    Reflect.set(handler, '_createSuccessMessage', () => ({}));
    Reflect.set(handler, '_createErrorMessage', () => ({}));
    return {handler, notifications, setContext: (value) => { context = value; }};
}

describe('Option toggle hotkey serialization', () => {
    test('two rapid toggles apply twice instead of both writing the initial opposite value', async () => {
        const firstWriteStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const allowFirstWrite = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        let enabled = false;
        const getSettings = vi.fn(async () => [{result: enabled}]);
        const modifySettings = vi.fn(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ modifications) => {
            const value = modifications[0].value;
            if (typeof value !== 'boolean') { throw new Error('Expected boolean'); }
            if (modifySettings.mock.calls.length === 1) {
                firstWriteStarted.resolve();
                await allowFirstWrite.promise;
            }
            enabled = value;
            return [{result: null}];
        });
        const {handler, notifications} = createHarness(getSettings, modifySettings);
        const first = handler._toggleOption('general.enable');
        await firstWriteStarted.promise;
        const second = handler._toggleOption('general.enable');
        expect(getSettings).toHaveBeenCalledOnce();

        allowFirstWrite.resolve();
        await Promise.all([first, second]);
        expect(getSettings).toHaveBeenCalledTimes(2);
        expect(modifySettings.mock.calls.map(([modifications]) => modifications[0].value)).toEqual([true, false]);
        expect(enabled).toBe(false);
        expect(notifications).toHaveBeenCalledTimes(2);
    });

    test('a rejected setting write cannot poison later hotkeys', async () => {
        let enabled = false;
        const getSettings = vi.fn(async () => [{result: enabled}]);
        const modifySettings = vi.fn()
            .mockResolvedValueOnce([{error: {name: 'Error', message: 'save denied', stack: ''}}])
            .mockImplementationOnce(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ modifications) => {
                const value = modifications[0].value;
                if (typeof value !== 'boolean') { throw new Error('Expected boolean'); }
                enabled = value;
                return [{result: null}];
            });
        const {handler, notifications} = createHarness(getSettings, modifySettings);
        await Promise.all([
            handler._toggleOption('general.enable'),
            handler._toggleOption('general.enable'),
        ]);
        expect(enabled).toBe(true);
        expect(modifySettings).toHaveBeenCalledTimes(2);
        expect(notifications.mock.calls.map(([, autoClose]) => autoClose)).toEqual([false, true]);
    });

    test('queued toggles do not apply to a newly selected options context', async () => {
        const firstWriteStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const allowFirstWrite = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const getSettings = vi.fn().mockResolvedValue([{result: false}]);
        const modifySettings = vi.fn(async () => {
            firstWriteStarted.resolve();
            await allowFirstWrite.promise;
            return [{result: null}];
        });
        const {handler, setContext, notifications} = createHarness(getSettings, modifySettings);
        const first = handler._toggleOption('general.enable');
        await firstWriteStarted.promise;
        const second = handler._toggleOption('general.enable');
        setContext({index: 1});
        allowFirstWrite.resolve();
        await Promise.all([first, second]);

        expect(modifySettings).toHaveBeenCalledOnce();
        expect(getSettings).toHaveBeenCalledOnce();
        expect(notifications).not.toHaveBeenCalled();
    });

    test('an in-flight read cannot write after the options context changes', async () => {
        const readStarted = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
        const completeRead = /** @type {import('core').DeferredPromiseDetails<Array<{result: boolean}>>} */ (deferPromise());
        const getSettings = vi.fn(() => {
            readStarted.resolve();
            return completeRead.promise;
        });
        const modifySettings = vi.fn();
        const {handler, setContext, notifications} = createHarness(getSettings, modifySettings);
        const pending = handler._toggleOption('general.enable');
        await readStarted.promise;
        setContext({index: 1});
        completeRead.resolve([{result: false}]);
        await pending;
        expect(modifySettings).not.toHaveBeenCalled();
        expect(notifications).not.toHaveBeenCalled();
    });
});
