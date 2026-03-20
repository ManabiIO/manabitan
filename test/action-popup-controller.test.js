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

import {describe, expect, vi} from 'vitest';
import {ActionPopupController} from '../ext/js/pages/action-popup-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/action-popup.html');

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {HTMLElement} target
 * @returns {void}
 */
function dispatchPrimaryTouchActivation(window, target) {
    const pointerUp = new window.MouseEvent('pointerup', {button: 0, bubbles: true, cancelable: true});
    Object.defineProperty(pointerUp, 'pointerType', {value: 'touch'});
    Object.defineProperty(pointerUp, 'isPrimary', {value: true});
    target.dispatchEvent(pointerUp);
    target.dispatchEvent(new window.MouseEvent('click', {button: 0, bubbles: true, cancelable: true, detail: 1}));
}

/**
 * @returns {Promise<void>}
 */
async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('ActionPopupController', () => {
    test('search button touch activation executes once per tap', async ({window}) => {
        const api = {
            commandExec: vi.fn(async () => {}),
        };
        const controller = new ActionPopupController(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)));
        controller._setupButtonEvents('.action-open-search', 'openSearchPage', '/search.html');

        const button = /** @type {HTMLElement} */ (window.document.querySelector('.action-open-search'));
        dispatchPrimaryTouchActivation(window, button);
        await flushPromises();

        expect(api.commandExec).toHaveBeenCalledTimes(1);
        expect(api.commandExec).toHaveBeenCalledWith('openSearchPage', {mode: 'existingOrNewTab'});
    });

    test('failed search page command falls back to in-popup search page navigation', async ({window}) => {
        const api = {
            commandExec: vi.fn(async () => {
                throw new Error('unsupported');
            }),
        };
        const controller = new ActionPopupController(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)));
        const navigateFallback = vi.spyOn(controller, '_navigateFallback').mockImplementation(() => {});
        controller._setupButtonEvents('.action-open-search', 'openSearchPage', '/search.html');

        const button = /** @type {HTMLElement} */ (window.document.querySelector('.action-open-search'));
        button.dispatchEvent(new window.MouseEvent('click', {button: 0, bubbles: true, cancelable: true, detail: 1}));
        await flushPromises();

        expect(api.commandExec).toHaveBeenCalledTimes(1);
        expect(navigateFallback).toHaveBeenCalledTimes(1);
        expect(navigateFallback).toHaveBeenCalledWith('/search.html?action-popup=true');
    });

    test('enable-search toggle dispatches change once for a primary touch activation', ({window}) => {
        const api = {
            commandExec: vi.fn(async () => {}),
        };
        const controller = new ActionPopupController(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)));
        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('.enable-search'));
        const toggle = /** @type {HTMLElement} */ (checkbox.closest('.toggle'));
        const changeSpy = vi.fn();
        checkbox.addEventListener('change', changeSpy);

        controller._setupToggleActivation(checkbox);
        dispatchPrimaryTouchActivation(window, toggle);

        expect(checkbox.checked).toBe(true);
        expect(changeSpy).toHaveBeenCalledTimes(1);
    });
});
