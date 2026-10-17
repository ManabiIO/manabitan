/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

function createHarness() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const options = {profiles: [{options: {dictionaries: [
        {name: 'A', alias: 'first', enabled: true},
        {name: 'B', alias: 'bee', enabled: true},
        {name: 'A', alias: 'second', enabled: false},
    ]}}]};
    Reflect.set(backend, '_options', options);
    Reflect.set(backend, '_optionsUtil', {save: vi.fn().mockResolvedValue(void 0)});
    Reflect.set(backend, '_applyOptions', vi.fn());
    Reflect.set(backend, '_clearProfileConditionsSchemaCache', vi.fn());
    /** @type {(target: import('settings-modifications').ScopedModification) => Promise<import('core').Response<import('settings-modifications').ModificationResult>[]>} */
    const modifyProfileSettings = (target) => backend._modifySettings([{
        ...target,
        scope: 'profile',
        optionsContext: {index: 0},
    }], 'settings');
    Reflect.set(backend, '_getModifySettingObject', () => (
        /** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options
    ));
    Reflect.set(backend, '_saveOptions', async (source, stagedOptions) => {
        Reflect.set(backend, '_options', stagedOptions);
        return source;
    });
    const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    /** @type {() => void} */
    let readResolve = () => {};
    const readGate = new Promise(/** @type {(resolve: (value: void) => void) => void} */ ((resolve) => { readResolve = () => resolve(void 0); }));
    const settingsController = {
        getOptionsContext: () => ({index: 0}),
        async getOptions() {
            const snapshot = structuredClone(/** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options);
            await readGate;
            return snapshot;
        },
        modifyProfileSettings: (/** @type {import('settings-modifications').Modification[]} */ targets) => Promise.all(targets.map((target) => modifyProfileSettings({
            ...target,
            scope: 'profile',
            optionsContext: {index: 0},
        }))),
        trigger: vi.fn(),
    };
    Reflect.set(controller, '_settingsController', settingsController);
    Reflect.set(controller, '_updateCurrentEntries', vi.fn());
    return {backend, controller, settingsController, releaseRead: () => readResolve()};
}

test('reorder preserves concurrent dictionary field edits and duplicate aliases', async () => {
    const {backend, controller, releaseRead} = createHarness();
    const operation = controller.moveDictionaryOptions(0, 1);
    // The UI read has already captured its snapshot; commit a concurrent alias/enablement edit.
    await backend._modifySettings([{
        action: 'set',
        scope: 'profile',
        optionsContext: {index: 0},
        path: 'dictionaries[0].enabled',
        value: false,
    }], 'concurrent edit');
    releaseRead();
    await operation;
    expect(/** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries).toEqual([
        {name: 'B', alias: 'bee', enabled: true},
        {name: 'A', alias: 'first', enabled: false},
        {name: 'A', alias: 'second', enabled: false},
    ]);
});

test('reorder rejects stale indices after an import adds a settings entry', async () => {
    const {backend, controller, releaseRead} = createHarness();
    const operation = controller.moveDictionaryOptions(0, 1);
    await backend._modifySettings([{
        action: 'push',
        scope: 'profile',
        optionsContext: {index: 0},
        path: 'dictionaries',
        items: [{name: 'C', alias: 'new', enabled: true}],
    }], 'import');
    releaseRead();
    await operation;
    const dictionaries = /** @type {{name: string}[]} */ (
        /** @type {{profiles: {options: import('settings').ProfileOptions}[]}} */ (Reflect.get(backend, '_options')).profiles[0].options.dictionaries
    );
    expect(dictionaries.map(({name}) => name)).toEqual(['A', 'B', 'A', 'C']);
});
