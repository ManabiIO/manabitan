/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @returns {DictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
}

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

describe('DictionaryController task dictionary resolution', () => {
    const getDictionaryInfoForTask = /** @type {(this: DictionaryController, dictionaryTitle: string) => Promise<unknown>} */ (getDictionaryControllerMethod('_getDictionaryInfoForTask'));

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('resolves a shorthand queued update title to the unique installed dictionary title', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockResolvedValue([
            {title: 'Jitendex.org [2026-02-05]', downloadUrl: 'https://example.invalid/jitendex.zip'},
            {title: 'JMdict [2026-02-26]', downloadUrl: 'https://example.invalid/jmdict.zip'},
        ]);
        Reflect.set(controller, '_dictionaries', null);
        Reflect.set(controller, '_settingsController', {getDictionaryInfo});

        const result = await getDictionaryInfoForTask.call(controller, 'Jitendex');

        expect(result).toMatchObject({title: 'Jitendex.org [2026-02-05]'});
        expect(getDictionaryInfo).toHaveBeenCalledTimes(1);
    });
});
