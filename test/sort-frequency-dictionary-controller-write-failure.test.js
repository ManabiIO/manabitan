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
import {SortFrequencyDictionaryController} from '../ext/js/pages/settings/sort-frequency-dictionary-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('SortFrequencyDictionaryController write failure rollback', () => {
    test('restores dictionary selection UI when saving dictionary choice fails', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="">None</option>
                <option value="Dict A" selected>Dict A</option>
                <option value="Dict B">Dict B</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({
            setProfileSetting,
            getOptionsContext: () => ({index: 0}),
        }));

        await expect(controller._setSortFrequencyDictionaryValue('Dict B')).rejects.toThrow('save failed');

        expect((/** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary'))).value).toBe('Dict A');
        expect((/** @type {HTMLElement} */ (window.document.querySelector('#sort-frequency-dictionary-order-container'))).hidden).toBe(false);
    });

    test('restores order selection UI when auto-detected order save fails', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="Dict A" selected>Dict A</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({
            setProfileSetting,
            getOptionsContext: () => ({index: 0}),
        }));
        Reflect.set(controller, '_getFrequencyOrder', vi.fn().mockResolvedValue('descending'));

        await expect(controller._autoUpdateOrder('Dict A')).rejects.toThrow('save failed');

        expect((/** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'))).value).toBe('ascending');
    });

    test('reverts a dictionary dropdown that was already changed by the browser before the save', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="">None</option>
                <option value="Dict A" selected>Dict A</option>
                <option value="Dict B">Dict B</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({setProfileSetting}));
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary'));

        select.value = 'Dict B';
        await expect(controller._setSortFrequencyDictionaryValue(select.value)).rejects.toThrow('save failed');

        expect(select.value).toBe('Dict A');
        expect(/** @type {HTMLElement} */ (window.document.querySelector('#sort-frequency-dictionary-order-container')).hidden).toBe(false);
    });

    test('reverts an order dropdown that was already changed by the browser before the save', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="Dict A" selected>Dict A</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({setProfileSetting}));
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'));

        select.value = 'descending';
        await expect(controller._setSortFrequencyDictionaryOrderValue(select.value)).rejects.toThrow('save failed');

        expect(select.value).toBe('ascending');
    });

    test('ignores auto-detected order when the user selects another dictionary meanwhile', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="Dict A" selected>Dict A</option>
                <option value="Dict B">Dict B</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        /** @type {(value: 'ascending'|'descending') => void} */
        let resolveOrder = () => {};
        /** @type {Promise<'ascending'|'descending'>} */
        const orderPromise = new Promise((resolve) => { resolveOrder = resolve; });
        const setProfileSetting = vi.fn().mockResolvedValue(undefined);
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({
            setProfileSetting,
            getOptionsContext: () => ({index: 0}),
        }));
        Reflect.set(controller, '_getFrequencyOrder', vi.fn(() => orderPromise));

        const pending = controller._autoUpdateOrder('Dict A');
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary'));
        select.value = 'Dict B';
        resolveOrder('descending');
        await pending;

        expect(setProfileSetting).not.toHaveBeenCalled();
    });

    test('manual frequency order overrides an older pending auto-detection result', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="sort-frequency-dictionary">
                <option value="Dict A" selected>Dict A</option>
            </select>
            <select id="sort-frequency-dictionary-order">
                <option value="ascending" selected>Ascending</option>
                <option value="descending">Descending</option>
            </select>
            <button id="sort-frequency-dictionary-order-auto"></button>
            <div id="sort-frequency-dictionary-order-container"></div>
        `;

        /** @type {(value: 'ascending'|'descending') => void} */
        let resolveOrder = () => {};
        /** @type {Promise<'ascending'|'descending'>} */
        const orderPromise = new Promise((resolve) => { resolveOrder = resolve; });
        const setProfileSetting = vi.fn().mockResolvedValue(undefined);
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({
            setProfileSetting,
            getOptionsContext: () => ({index: 0}),
        }));
        Reflect.set(controller, '_getFrequencyOrder', vi.fn(() => orderPromise));

        const pending = controller._autoUpdateOrder('Dict A');
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'));
        select.value = 'descending';
        controller._onSortFrequencyDictionaryOrderSelectChange();
        await vi.waitFor(() => {
            expect(setProfileSetting).toHaveBeenCalledWith('general.sortFrequencyDictionaryOrder', 'descending');
        });

        resolveOrder('ascending');
        await pending;

        expect(select.value).toBe('descending');
        expect(setProfileSetting).toHaveBeenCalledTimes(1);
    });

});
