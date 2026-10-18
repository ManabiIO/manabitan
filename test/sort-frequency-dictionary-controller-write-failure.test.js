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
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({setProfileSetting, getOptionsContext: () => ({index: 0})}));
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
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ ({setProfileSetting, getOptionsContext: () => ({index: 0})}));
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'));

        select.value = 'descending';
        await expect(controller._setSortFrequencyDictionaryOrderValue('descending')).rejects.toThrow('save failed');

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
        const setProfileSetting = vi.fn().mockResolvedValue([{result: null}]);
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
        const setProfileSetting = vi.fn().mockResolvedValue([{result: null}]);
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


describe('Frequency setting mutation ownership', () => {
    /**
     * @param {Pick<Window, 'document'>} window
     * @returns {{controller: SortFrequencyDictionaryController, settings: {setProfileSetting: ReturnType<typeof vi.fn>, getOptionsContext: () => {index: number}}, setIndex: (value: number) => void}}
     */
    function createHarness(window) {
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
        let index = 0;
        const settings = {
            setProfileSetting: vi.fn().mockResolvedValue([{result: null}]),
            getOptionsContext: () => ({index}),
        };
        const controller = new SortFrequencyDictionaryController(/** @type {any} */ (settings));
        Reflect.set(controller, '_getFrequencyOrder', vi.fn().mockResolvedValue(null));
        return {controller, settings, setIndex: (value) => { index = value; }};
    }

    test('a per-setting rejection restores the confirmed order and rejects the save', async ({window}) => {
        const {controller, settings} = createHarness(window);
        settings.setProfileSetting.mockResolvedValue([{error: {name: 'Error', message: 'order denied', stack: ''}}]);
        const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('#sort-frequency-dictionary-order'));
        select.value = 'descending';
        await expect(controller._setSortFrequencyDictionaryOrderValue('descending')).rejects.toThrow('order denied');
        expect(select.value).toBe('ascending');
    });

    test('overlapping order writes persist in order', async ({window}) => {
        const {controller, settings} = createHarness(window);
        const started = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const finish = /** @type {PromiseWithResolvers<import('settings-controller').ModifyResult[]>} */ (Promise.withResolvers());
        settings.setProfileSetting.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        });
        const first = controller._setSortFrequencyDictionaryOrderValue('descending');
        await started.promise;
        const second = controller._setSortFrequencyDictionaryOrderValue('ascending');
        expect(settings.setProfileSetting).toHaveBeenCalledOnce();
        finish.resolve([{result: null}]);
        await Promise.all([first, second]);
        expect(settings.setProfileSetting.mock.calls).toStrictEqual([
            ['general.sortFrequencyDictionaryOrder', 'descending'],
            ['general.sortFrequencyDictionaryOrder', 'ascending'],
        ]);
    });

    test('a late rejected save cannot roll back newer rendered options', async ({window}) => {
        const {controller, settings} = createHarness(window);
        const started = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const finish = /** @type {PromiseWithResolvers<import('settings-controller').ModifyResult[]>} */ (Promise.withResolvers());
        settings.setProfileSetting.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        });
        const pending = controller._setSortFrequencyDictionaryOrderValue('ascending');
        const rejection = expect(pending).rejects.toThrow('old save denied');
        await started.promise;
        controller._onOptionsChanged(/** @type {any} */ ({options: {general: {sortFrequencyDictionary: 'Dict B', sortFrequencyDictionaryOrder: 'descending'}}}));
        finish.resolve([{error: {name: 'Error', message: 'old save denied', stack: ''}}]);
        await rejection;
        expect((/** @type {HTMLSelectElement|null} */ (window.document.querySelector('#sort-frequency-dictionary-order')))?.value).toBe('descending');
    });

    test('a queued write cannot target a newly selected settings profile', async ({window}) => {
        const {controller, settings, setIndex} = createHarness(window);
        const started = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        const finish = /** @type {PromiseWithResolvers<import('settings-controller').ModifyResult[]>} */ (Promise.withResolvers());
        settings.setProfileSetting.mockImplementationOnce(() => {
            started.resolve();
            return finish.promise;
        });
        const first = controller._setSortFrequencyDictionaryOrderValue('descending');
        await started.promise;
        const second = controller._setSortFrequencyDictionaryOrderValue('ascending');
        setIndex(1);
        finish.resolve([{result: null}]);
        await Promise.all([first, second]);
        expect(settings.setProfileSetting).toHaveBeenCalledOnce();
    });
});
