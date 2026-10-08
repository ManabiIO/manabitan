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
import {CollapsibleDictionaryController} from '../ext/js/pages/settings/collapsible-dictionary-controller.js';

/**
 * @returns {CollapsibleDictionaryController}
 */
function createControllerForInternalTests() {
    return /** @type {CollapsibleDictionaryController} */ (Object.create(CollapsibleDictionaryController.prototype));
}

describe('CollapsibleDictionaryController database updates', () => {
    test('clears the dictionary-info token when a refresh fails', async () => {
        const controller = createControllerForInternalTests();
        const getDictionaryInfo = vi.fn().mockRejectedValue(new Error('lookup failed'));
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo,
        });
        Reflect.set(controller, '_dictionaryInfoMap', new Map());
        Reflect.set(controller, '_onDictionarySettingsReordered', vi.fn());
        Reflect.set(controller, '_getDictionaryInfoToken', null);

        const onDatabaseUpdated = /** @type {(this: CollapsibleDictionaryController) => Promise<void>} */ (
            Reflect.get(CollapsibleDictionaryController.prototype, '_onDatabaseUpdated')
        );

        await expect(onDatabaseUpdated.call(controller)).rejects.toThrow('lookup failed');
        expect(getDictionaryInfo).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_getDictionaryInfoToken')).toBeNull();
    });

    test('rebuilds the collapsible dictionary list for reorder event payloads', async () => {
        const controller = createControllerForInternalTests();
        const options = {dictionaries: []};
        const onOptionsChanged = vi.fn();
        /** @type {(details: {source: object}) => Promise<void>} */
        let onReordered = async () => {};
        const settingsController = {
            application: {on: vi.fn()},
            on: vi.fn((name, callback) => {
                if (name === 'dictionarySettingsReordered') {
                    onReordered = callback;
                }
            }),
            getOptions: vi.fn(async () => options),
            getOptionsContext: vi.fn(() => ({index: 0})),
        };
        Reflect.set(controller, '_settingsController', settingsController);
        Reflect.set(controller, '_getDictionaryInfoToken', null);
        Reflect.set(controller, '_onDatabaseUpdated', vi.fn(async () => {}));
        Reflect.set(controller, '_onOptionsChanged', onOptionsChanged);

        await controller.prepare();
        await onReordered({source: {}});

        expect(settingsController.getOptions).toHaveBeenCalledOnce();
        expect(onOptionsChanged).toHaveBeenCalledWith({options, optionsContext: {index: 0}});
    });

    test('restores the All dropdown after saving collapsible definitions fails', async () => {
        const controller = createControllerForInternalTests();
        const options = {
            dictionaries: [
                {definitionsCollapsible: 'expanded'},
                {definitionsCollapsible: 'collapsed'},
            ],
        };
        const modifyProfileSettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const allSelect = {value: 'collapsed'};
        const selects = [{value: 'expanded'}, {value: 'collapsed'}];
        Reflect.set(controller, '_settingsController', {
            getOptions: vi.fn(async () => options),
            getOptionsContext: vi.fn(() => ({index: 0})),
            modifyProfileSettings,
        });
        Reflect.set(controller, '_allSelect', allSelect);
        Reflect.set(controller, '_selects', selects);

        await expect(controller._setDefinitionsCollapsibleAll('collapsed')).rejects.toThrow('save failed');

        expect(modifyProfileSettings).toHaveBeenCalledOnce();
        expect(allSelect.value).toBe('varies');
        expect(selects.map((select) => select.value)).toStrictEqual(['expanded', 'collapsed']);
    });

});
