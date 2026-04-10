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
import {SecondarySearchDictionaryController} from '../ext/js/pages/settings/secondary-search-dictionary-controller.js';

/**
 * @returns {SecondarySearchDictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {SecondarySearchDictionaryController} */ (Object.create(SecondarySearchDictionaryController.prototype));
}

describe('SecondarySearchDictionaryController database updates', () => {
    test('clears the dictionary-info token when a refresh fails', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockRejectedValue(new Error('lookup failed'));
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo,
        });
        Reflect.set(controller, '_dictionaryInfoMap', new Map());
        Reflect.set(controller, '_onDictionarySettingsReordered', vi.fn());
        Reflect.set(controller, '_getDictionaryInfoToken', null);

        const onDatabaseUpdated = /** @type {(this: SecondarySearchDictionaryController) => Promise<void>} */ (
            Reflect.get(SecondarySearchDictionaryController.prototype, '_onDatabaseUpdated')
        );

        await expect(onDatabaseUpdated.call(controller)).rejects.toThrow('lookup failed');
        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_getDictionaryInfoToken')).toBeNull();
    });
});
