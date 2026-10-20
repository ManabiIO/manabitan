/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

test('Anki options read cannot publish across a real same-ID external refresh', async () => {
    let full = {profileCurrent: 0, profiles: [{id: 'a', name: 'A', options: {marker: 'old'}, conditionGroups: []}]};
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const pending = new Promise((resolve2) => { resolve = resolve2; });
    const optionsGet = vi.fn(async () => full.profiles[0].options).mockImplementationOnce(() => pending);
    const settings = new SettingsController(/** @type {any} */ ({api: {optionsGetFull: async () => full, optionsGet}}));
    Reflect.set(settings, '_profileId', 'a');
    Reflect.set(settings, '_preparedOptionsFull', full);
    const applied = vi.fn();
    const controller = Object.assign(Object.create(AnkiController.prototype), {_settingsController: settings, _onOptionsChanged: applied});
    const operation = controller._updateOptions();
    await flush();
    const oldOptions = full.profiles[0].options;
    full = {...full, profiles: [{...full.profiles[0], options: {marker: 'new'}}]};
    await settings.refresh();
    resolve(oldOptions);
    await operation;
    expect(settings.optionsRevision).toBeGreaterThan(0);
    expect(applied).not.toHaveBeenCalled();
});
