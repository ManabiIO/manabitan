/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';

/**
 * @param {() => Promise<import('settings').ProfileOptions>} getOptions
 * @param {() => number} [getIndex]
 * @returns {{controller: CollapsibleDictionaryController, render: ReturnType<typeof vi.fn>, updateAll: ReturnType<typeof vi.fn>}}
 */
function createHarness(getOptions, getIndex = () => 0) {
    const controller = /** @type {CollapsibleDictionaryController} */ (Object.create(CollapsibleDictionaryController.prototype));
    const render = vi.fn();
    const updateAll = vi.fn();
    Reflect.set(controller, '_settingsController', {
        getOptions,
        getOptionsContext: () => ({index: getIndex()}),
    });
    Reflect.set(controller, '_getDictionaryInfoToken', null);
    Reflect.set(controller, '_optionsRenderRequest', 0);
    Reflect.set(controller, '_allSelectRefreshRequest', 0);
    Reflect.set(controller, '_allSelect', {});
    Reflect.set(controller, '_onOptionsChanged', render);
    Reflect.set(controller, '_updateAllSelect', updateAll);
    return {controller, render, updateAll};
}

afterEach(() => { vi.restoreAllMocks(); });

describe('collapsible dictionary asynchronous settings refresh', () => {
    test('an older reordered-settings response cannot overwrite a newer response', async () => {
        const oldRequest = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const newRequest = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
        const {controller, render} = createHarness(getOptions);
        const previous = controller._onDictionarySettingsReordered();
        const current = controller._onDictionarySettingsReordered();
        const previousOptions = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Old'}]}));
        const currentOptions = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'New'}]}));
        newRequest.resolve(currentOptions);
        await current;
        oldRequest.resolve(previousOptions);
        await previous;
        expect(render).toHaveBeenCalledExactlyOnceWith({options: currentOptions, optionsContext: {index: 0}});
    });

    test('a pending all-selector refresh cannot publish after a profile switch', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        let profileIndex = 0;
        const {controller, updateAll} = createHarness(() => deferred.promise, () => profileIndex);
        const pending = controller._updateAllSelectFresh();
        profileIndex = 1;
        deferred.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: []})));
        await pending;
        expect(updateAll).not.toHaveBeenCalled();
    });

    test('a delayed all-selector result cannot overwrite a newer same-profile result', async () => {
        const previous = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const current = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const getOptions = vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
        const {controller, updateAll} = createHarness(getOptions);
        const oldRefresh = controller._updateAllSelectFresh();
        const newRefresh = controller._updateAllSelectFresh();
        const oldOptions = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'Old'}]}));
        const newOptions = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'New'}]}));
        current.resolve(newOptions);
        await newRefresh;
        previous.resolve(oldOptions);
        await oldRefresh;
        expect(updateAll).toHaveBeenCalledExactlyOnceWith(newOptions);
    });

    test('rebuilding the all-selector invalidates a pending refresh', async () => {
        const deferred = /** @type {import('core').DeferredPromiseDetails<import('settings').ProfileOptions>} */ (deferPromise());
        const {controller, updateAll} = createHarness(() => deferred.promise);
        const pending = controller._updateAllSelectFresh();
        Reflect.set(controller, '_allSelect', {});
        deferred.resolve(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: []})));
        await pending;
        expect(updateAll).not.toHaveBeenCalled();
    });
});
