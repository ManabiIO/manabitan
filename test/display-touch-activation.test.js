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
import {EventListenerCollection} from '../ext/js/core/event-listener-collection.js';
import {Display} from '../ext/js/display/display.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

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
 * @param {Document} document
 * @returns {HTMLElement}
 */
function createEntry(document) {
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.dataset.index = '0';
    entry.innerHTML = `
        <button type="button" class="headword-kanji-link">漢</button>
        <button type="button" class="inflection" data-reason="test">inflection</button>
        <button type="button" class="tag-label">tag</button>
        <button type="button" class="action-button" data-action="menu">menu</button>
    `;
    document.body.appendChild(entry);
    return entry;
}

/**
 * @returns {(this: unknown, entry: HTMLElement) => void}
 */
function getAddEntryEventListenersMethod() {
    const method = Reflect.get(Display.prototype, '_addEntryEventListeners');
    if (typeof method !== 'function') {
        throw new Error('Expected Display._addEntryEventListeners method');
    }
    return method;
}

describe('Display touch activation', () => {
    test('entry touch activation dispatches once', ({window}) => {
        const entry = createEntry(window.document);
        const context = {
            _eventListeners: new EventListenerCollection(),
            _onEntryClickBind: vi.fn(() => {}),
            _onKanjiLookupBind: vi.fn(() => {}),
            _onInflectionClickBind: vi.fn(() => {}),
            _onTagClickBind: vi.fn(() => {}),
            _onMenuButtonClickBind: vi.fn(() => {}),
            _onMenuButtonMenuCloseBind: vi.fn(() => {}),
        };

        getAddEntryEventListenersMethod().call(context, entry);
        dispatchPrimaryTouchActivation(window, entry);

        expect(context._onEntryClickBind).toHaveBeenCalledTimes(1);
        context._eventListeners.removeAllEventListeners();
    });

    test('tag touch activation dispatches once', ({window}) => {
        const entry = createEntry(window.document);
        const context = {
            _eventListeners: new EventListenerCollection(),
            _onEntryClickBind: vi.fn(() => {}),
            _onKanjiLookupBind: vi.fn(() => {}),
            _onInflectionClickBind: vi.fn(() => {}),
            _onTagClickBind: vi.fn(() => {}),
            _onMenuButtonClickBind: vi.fn(() => {}),
            _onMenuButtonMenuCloseBind: vi.fn(() => {}),
        };

        getAddEntryEventListenersMethod().call(context, entry);
        const tag = /** @type {HTMLElement} */ (entry.querySelector('.tag-label'));
        dispatchPrimaryTouchActivation(window, tag);

        expect(context._onTagClickBind).toHaveBeenCalledTimes(1);
        context._eventListeners.removeAllEventListeners();
    });

    test('menu button touch activation dispatches once', ({window}) => {
        const entry = createEntry(window.document);
        const context = {
            _eventListeners: new EventListenerCollection(),
            _onEntryClickBind: vi.fn(() => {}),
            _onKanjiLookupBind: vi.fn(() => {}),
            _onInflectionClickBind: vi.fn(() => {}),
            _onTagClickBind: vi.fn(() => {}),
            _onMenuButtonClickBind: vi.fn(() => {}),
            _onMenuButtonMenuCloseBind: vi.fn(() => {}),
        };

        getAddEntryEventListenersMethod().call(context, entry);
        const menuButton = /** @type {HTMLElement} */ (entry.querySelector('.action-button[data-action=menu]'));
        dispatchPrimaryTouchActivation(window, menuButton);

        expect(context._onMenuButtonClickBind).toHaveBeenCalledTimes(1);
        context._eventListeners.removeAllEventListeners();
    });
});
