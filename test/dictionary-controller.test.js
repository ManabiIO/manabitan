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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryController.${name} to be a function`);
    }
    return method;
}

/**
 * @returns {DictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
}

describe('DictionaryController task queue', () => {
    const isDictionaryInTaskQueue = /** @type {(this: DictionaryController, dictionaryTitle: string) => boolean} */ (getDictionaryControllerMethod('isDictionaryInTaskQueue'));
    const enqueueTask = /** @type {(this: DictionaryController, task: {type: 'delete'|'update', dictionaryTitle: string, downloadUrl?: string}) => Promise<void>} */ (getDictionaryControllerMethod('_enqueueTask'));
    const hideUpdatesAvailableButton = /** @type {(this: DictionaryController, dictionaryTitle: string) => void} */ (getDictionaryControllerMethod('_hideUpdatesAvailableButton'));

    test('detects queued dictionaries by title', () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_dictionaryTaskQueue', [
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0},
        ]);

        expect(isDictionaryInTaskQueue.call(controller, 'Jitendex')).toBe(true);
        expect(isDictionaryInTaskQueue.call(controller, 'JMdict')).toBe(false);
    });

    test('enqueueTask deduplicates queued dictionary titles and starts the queue once', async () => {
        const controller = createControllerForInternalTests();
        const runTaskQueue = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, '_dictionaryTaskQueue', []);
        Reflect.set(controller, '_runTaskQueue', runTaskQueue);

        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0});
        await enqueueTask.call(controller, {type: 'delete', dictionaryTitle: 'Jitendex'});
        await enqueueTask.call(controller, {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0});

        expect(Reflect.get(controller, '_dictionaryTaskQueue')).toStrictEqual([
            {type: 'update', dictionaryTitle: 'Jitendex', downloadUrl: void 0},
            {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: void 0},
        ]);
        expect(runTaskQueue).toHaveBeenCalledTimes(2);
    });

    test('hideUpdatesAvailableButton only touches the matching entry', () => {
        const controller = createControllerForInternalTests();
        const hideA = vi.fn();
        const hideB = vi.fn();
        Reflect.set(controller, '_dictionaryEntries', [
            {dictionaryTitle: 'Jitendex', hideUpdatesAvailableButton: hideA},
            {dictionaryTitle: 'JMdict', hideUpdatesAvailableButton: hideB},
        ]);

        hideUpdatesAvailableButton.call(controller, 'JMdict');

        expect(hideA).not.toHaveBeenCalled();
        expect(hideB).toHaveBeenCalledTimes(1);
    });
});
