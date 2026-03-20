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
import {SearchDisplayController} from '../ext/js/display/search-display-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');

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

describe('SearchDisplayController touch activation', () => {
    test('search button touch activation dispatches search once', ({window}) => {
        const display = {
            application: {
                api: {
                    clipboardGet: vi.fn(async () => ''),
                },
            },
            history: {
                back: vi.fn(() => {}),
            },
            blurElement: vi.fn(() => {}),
        };
        const searchDisplayController = new SearchDisplayController(
            /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)),
            /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (/** @type {unknown} */ ({})),
            /** @type {import('../ext/js/display/search-persistent-state-controller.js').SearchPersistentStateController} */ (/** @type {unknown} */ ({mode: 'full'})),
        );
        const setupButtonActivationListeners = Reflect.get(SearchDisplayController.prototype, '_setupButtonActivationListeners');
        if (typeof setupButtonActivationListeners !== 'function') {
            throw new Error('Expected SearchDisplayController._setupButtonActivationListeners method');
        }
        setupButtonActivationListeners.call(searchDisplayController);
        const searchSpy = vi.spyOn(searchDisplayController, '_search').mockImplementation(() => {});

        const button = /** @type {HTMLElement} */ (window.document.querySelector('#search-button'));
        dispatchPrimaryTouchActivation(window, button);

        expect(searchSpy).toHaveBeenCalledTimes(1);
        expect(searchSpy).toHaveBeenCalledWith(true, 'new', true, null);
    });
});
