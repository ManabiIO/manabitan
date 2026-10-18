/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {log} from '../ext/js/core/log.js';
import {RecommendedSettingsController} from '../ext/js/pages/settings/recommended-settings-controller.js';

/** @returns {RecommendedSettingsController} */
function createController() {
    const controller = /** @type {RecommendedSettingsController} */ (Object.create(RecommendedSettingsController.prototype));
    Reflect.set(controller, '_languageRequestGeneration', 0);
    Reflect.set(controller, '_recommendedSettingsLoadPromise', null);
    return controller;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('recommended settings language selection ownership', () => {
    test('a slower previous language cannot redraw the modal after a newer selection', async () => {
        const earlier = /** @type {import('core').DeferredPromiseDetails<import('settings-controller').RecommendedSetting[]>} */ (deferPromise());
        const latest = /** @type {import('core').DeferredPromiseDetails<import('settings-controller').RecommendedSetting[]>} */ (deferPromise());
        const recommendations = vi.fn().mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
        const list = {};
        const clear = vi.fn();
        Object.defineProperty(list, 'innerHTML', {get: () => '', set: clear});
        vi.stubGlobal('document', {querySelector: () => list});
        const select = {value: 'ja'};
        const modal = {hidden: false};
        const controller = createController();
        Reflect.set(controller, '_languageSelect', select);
        Reflect.set(controller, '_recommendedSettingsModal', modal);
        Reflect.set(controller, '_getRecommendedSettings', recommendations);
        const previous = controller._onLanguageSelectChanged(/** @type {Event} */ (/** @type {unknown} */ ({})));
        select.value = 'en';
        const current = controller._onLanguageSelectChanged(/** @type {Event} */ (/** @type {unknown} */ ({})));
        latest.resolve([]);
        await current;
        earlier.resolve([]);
        await previous;
        expect(clear).toHaveBeenCalledOnce();
        expect(modal.hidden).toBe(true);
        expect(recommendations).toHaveBeenCalledTimes(2);
    });

    test('changing language immediately hides old recommendations until the new fetch finishes', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings-controller').RecommendedSetting[]>} */ (deferPromise());
        const controller = createController();
        const oldSettings = new Map([['0', /** @type {import('settings-controller').RecommendedSetting} */ ({
            description: 'Old language',
            modification: {action: 'set', path: 'general.language', value: 'ja'},
        })]]);
        const modal = {hidden: false};
        Reflect.set(controller, '_languageSelect', {value: 'en'});
        Reflect.set(controller, '_recommendedSettingsModal', modal);
        Reflect.set(controller, '_recommendedSettings', oldSettings);
        Reflect.set(controller, '_getRecommendedSettings', () => deferred.promise);
        const pending = controller._onLanguageSelectChanged(/** @type {Event} */ (/** @type {unknown} */ ({})));
        expect(modal.hidden).toBe(true);
        expect(Reflect.get(controller, '_recommendedSettings')).toEqual(new Map());
        const list = {};
        Object.defineProperty(list, 'innerHTML', {get: () => '', set: () => {}});
        vi.stubGlobal('document', {querySelector: () => list});
        deferred.resolve([]);
        await pending;
        expect(modal.hidden).toBe(true);
    });

    test('concurrent language requests share one recommended-settings fetch', async () => {
        const response = new Response(JSON.stringify({ja: [], en: []}), {headers: {'Content-Type': 'application/json'}});
        const fetch = vi.fn().mockResolvedValue(response);
        vi.stubGlobal('fetch', fetch);
        const controller = createController();
        const first = controller._getRecommendedSettings('ja');
        const second = controller._getRecommendedSettings('en');
        await expect(first).resolves.toEqual([]);
        await expect(second).resolves.toEqual([]);
        expect(fetch).toHaveBeenCalledOnce();
    });

    test('a failed recommended-settings load can be retried', async () => {
        const response = new Response(JSON.stringify({ja: []}), {headers: {'Content-Type': 'application/json'}});
        const fetch = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(response);
        vi.stubGlobal('fetch', fetch);
        const controller = createController();
        await expect(controller._getRecommendedSettings('ja')).rejects.toThrow('Network unavailable');
        await expect(controller._getRecommendedSettings('ja')).resolves.toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('the language change listener logs a current request failure instead of leaking a rejection', async () => {
        const failure = new Error('Recommended settings download failed');
        const logError = vi.spyOn(log, 'error').mockImplementation(() => {});
        const controller = createController();
        Reflect.set(controller, '_languageSelect', {value: 'ja'});
        Reflect.set(controller, '_recommendedSettingsModal', {hidden: false});
        Reflect.set(controller, '_getRecommendedSettings', vi.fn().mockRejectedValueOnce(failure));
        controller._onLanguageSelectChangedEvent(/** @type {Event} */ (/** @type {unknown} */ ({})));
        await vi.waitFor(() => { expect(logError).toHaveBeenCalledExactlyOnceWith(failure); });
    });
});
