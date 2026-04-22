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

import {describe, expect, vi} from 'vitest';
import {ElementOverflowController} from '../ext/js/display/element-overflow-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('ElementOverflowController', () => {
    test('addElements defers overflow measurement until scheduled update', async ({window}) => {
        const controller = new ElementOverflowController(/** @type {any} */ ({scrollUpToElementTop() {}}));
        controller._dictionaries.set('JMdict', {collapsed: false, force: false});
        const scheduledCallbacks = [];
        const requestIdleCallbackSpy = vi.spyOn(controller, '_requestIdleCallback').mockImplementation((callback) => {
            scheduledCallbacks.push(callback);
            return 1;
        });
        const updateElementSpy = vi.spyOn(controller, '_updateElement');

        const entry = window.document.createElement('div');
        const parent = window.document.createElement('div');
        parent.dataset.dictionary = 'JMdict';
        const inner = window.document.createElement('div');
        inner.className = 'definition-item-inner';
        parent.appendChild(inner);
        entry.appendChild(parent);

        controller.addElements(entry);

        expect(updateElementSpy).not.toHaveBeenCalled();
        expect(requestIdleCallbackSpy).toHaveBeenCalledOnce();
        expect(controller._elements).toContain(inner);

        scheduledCallbacks[0]();

        expect(updateElementSpy).toHaveBeenCalledOnce();
    });
});
