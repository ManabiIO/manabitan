/*
 * Copyright (C) 2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {AccessibilityController} from '../ext/js/accessibility/accessibility-controller.js';
import {log} from '../ext/js/core/log.js';

/**
 * @param {boolean} enabled
 * @returns {import('settings').Options}
 */
function optionsFor(enabled) {
    return /** @type {import('settings').Options} */ ({
        profiles: [{options: {accessibility: {forceGoogleDocsHtmlRendering: enabled}}}],
    });
}

function createRegistrationHarness(registered = false) {
    const script = {id: 'googleDocsAccessibility'};
    const scripting = {
        getRegisteredContentScripts: vi.fn((_filter, callback) => { callback(registered ? [script] : []); }),
        registerContentScripts: vi.fn((_scripts, callback) => {
            registered = true;
            callback();
        }),
        unregisterContentScripts: vi.fn((_filter, callback) => {
            registered = false;
            callback();
        }),
    };
    vi.stubGlobal('chrome', {runtime: {}, scripting});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    return {controller: new AccessibilityController(), scripting, isRegistered: () => registered};
}

describe('Google Docs persistent content-script registration', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('startup removes a persisted script when the setting is disabled', async () => {
        const {controller, scripting, isRegistered} = createRegistrationHarness(true);
        await controller.update(optionsFor(false));
        expect(scripting.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({ids: ['googleDocsAccessibility']}, expect.any(Function));
        expect(isRegistered()).toBe(false);
    });

    test('startup with no registered script does not report an unregister error', async () => {
        const {controller, scripting, isRegistered} = createRegistrationHarness();
        await controller.update(optionsFor(false));
        await controller.update(optionsFor(false));
        expect(scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(1);
        expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
        expect(isRegistered()).toBe(false);
        expect(log.error).not.toHaveBeenCalled();
    });

    test('a failed registration is retried when the same enabled settings are reapplied', async () => {
        const {controller, scripting, isRegistered} = createRegistrationHarness();
        scripting.registerContentScripts
            .mockImplementationOnce(() => { throw new Error('permission unavailable'); })
            .mockImplementationOnce(() => { throw new Error('fallback also unavailable'); });
        await controller.update(optionsFor(true));
        expect(isRegistered()).toBe(false);
        await controller.update(optionsFor(true));
        expect(isRegistered()).toBe(true);
        expect(scripting.registerContentScripts).toHaveBeenCalledTimes(3);
    });

    test('a failed removal is retried without toggling the setting again', async () => {
        const {controller, scripting, isRegistered} = createRegistrationHarness();
        await controller.update(optionsFor(true));
        scripting.unregisterContentScripts.mockImplementationOnce(() => { throw new Error('temporary browser failure'); });
        await controller.update(optionsFor(false));
        expect(isRegistered()).toBe(true);
        await controller.update(optionsFor(false));
        expect(isRegistered()).toBe(false);
        expect(scripting.unregisterContentScripts).toHaveBeenCalledTimes(2);
    });

    test('startup preserves an existing enabled registration without duplicating it', async () => {
        const {controller, scripting, isRegistered} = createRegistrationHarness(true);
        await controller.update(optionsFor(true));
        await controller.update(optionsFor(true));
        expect(isRegistered()).toBe(true);
        expect(scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(1);
        expect(scripting.registerContentScripts).not.toHaveBeenCalled();
        expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
    });
});
