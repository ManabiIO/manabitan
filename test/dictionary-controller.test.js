/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @returns {DictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
}

/**
 * @param {string} name
 * @returns {Function}
 * @throws {Error}
 */
function getDictionaryControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryController.${name} to be a function`);
    }
    return method;
}

describe('DictionaryController update-all behavior', () => {
    const {window} = testEnv;
    const getUpdateAllDictionaryTitles = /** @type {() => string[]} */ (getDictionaryControllerMethod('_getUpdateAllDictionaryTitles'));
    const updateUpdateAllButtonState = /** @type {() => void} */ (getDictionaryControllerMethod('_updateUpdateAllButtonState'));
    const onUpdateAllButtonClick = /** @type {(event: MouseEvent) => void} */ (getDictionaryControllerMethod('_onUpdateAllButtonClick'));

    afterEach(() => {
        vi.restoreAllMocks();
        window.document.body.innerHTML = '';
    });

    test('collects updatable displayed dictionaries and skips queued or non-updatable entries', () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_dictionaries', [
            {title: 'Jitendex', isUpdatable: true, indexUrl: 'https://example.invalid/jitendex-index.json', downloadUrl: 'https://example.invalid/jitendex.zip'},
            {title: 'JMdict', isUpdatable: true, indexUrl: 'https://example.invalid/jmdict-index.json', downloadUrl: 'https://example.invalid/jmdict.zip'},
            {title: 'Static', isUpdatable: false},
            {title: 'Broken', isUpdatable: true, indexUrl: 'https://example.invalid/broken-index.json'},
        ]);
        Reflect.set(controller, '_dictionaryEntries', [
            {dictionaryTitle: 'Static'},
            {dictionaryTitle: 'Jitendex'},
            {dictionaryTitle: 'JMdict'},
            {dictionaryTitle: 'Broken'},
        ]);
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0},
        ]);

        const dictionaryTitles = getUpdateAllDictionaryTitles.call(controller);
        expect(dictionaryTitles).toStrictEqual(['Jitendex']);
    });

    test('update-all button disables when there is nothing eligible or when work is in progress', () => {
        const controller = createControllerForInternalTests();
        const button = window.document.createElement('button');
        Reflect.set(controller, '_updateAllButton', button);
        Reflect.set(controller, '_checkingIntegrity', false);
        Reflect.set(controller, '_checkingUpdates', false);
        Reflect.set(controller, '_isTaskQueueRunning', false);
        Reflect.set(controller, '_getUpdateAllDictionaryTitles', vi.fn(() => []));

        updateUpdateAllButtonState.call(controller);
        expect(button.disabled).toBe(true);

        Reflect.set(controller, '_getUpdateAllDictionaryTitles', vi.fn(() => ['Jitendex']));
        updateUpdateAllButtonState.call(controller);
        expect(button.disabled).toBe(false);

        Reflect.set(controller, '_isTaskQueueRunning', true);
        updateUpdateAllButtonState.call(controller);
        expect(button.disabled).toBe(true);
    });

    test('click handler enqueues update tasks for all eligible dictionaries and hides row update buttons', () => {
        const controller = createControllerForInternalTests();
        const preventDefault = vi.fn();
        const enqueueTask = vi.fn();
        const hideUpdatesAvailableButton = vi.fn();
        const updateButtonState = vi.fn();
        Reflect.set(controller, '_getUpdateAllDictionaryTitles', vi.fn(() => ['Jitendex', 'JMdict']));
        Reflect.set(controller, '_enqueueTask', enqueueTask);
        Reflect.set(controller, '_hideUpdatesAvailableButton', hideUpdatesAvailableButton);
        Reflect.set(controller, '_updateUpdateAllButtonState', updateButtonState);

        onUpdateAllButtonClick.call(
            controller,
            /** @type {MouseEvent} */ (/** @type {unknown} */ ({preventDefault})),
        );

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(enqueueTask).toHaveBeenCalledTimes(2);
        expect(enqueueTask).toHaveBeenNthCalledWith(1, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0});
        expect(enqueueTask).toHaveBeenNthCalledWith(2, {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0});
        expect(hideUpdatesAvailableButton).toHaveBeenCalledTimes(2);
        expect(hideUpdatesAvailableButton).toHaveBeenNthCalledWith(1, 'Jitendex');
        expect(hideUpdatesAvailableButton).toHaveBeenNthCalledWith(2, 'JMdict');
        expect(updateButtonState).toHaveBeenCalledTimes(1);
    });
});
