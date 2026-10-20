/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';

/** @returns {{promise: Promise<any>, resolve: (value: any) => void, reject: (reason: unknown) => void}} */
function deferred() {
    /** @type {(value: any) => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {any} */
function fixture() {
    let full = {profileCurrent: 0, profiles: [{id: 'a', name: 'A', options: {marker: 'old'}, conditionGroups: []}]};
    const api = {
        optionsGetFull: vi.fn(async () => full),
        optionsGet: vi.fn(async () => full.profiles[0].options),
        setAllSettings: vi.fn(async (value) => { full = value; }),
    };
    const controller = new SettingsController(/** @type {any} */ ({api}));
    Reflect.set(controller, '_profileId', 'a');
    Reflect.set(controller, '_preparedOptionsFull', full);
    return {controller, api, replace: () => { full = {...full, profiles: [{...full.profiles[0], options: {marker: 'replacement'}}]}; }};
}

test('external same-ID refresh invalidates ownership before fetching replacement settings', async () => {
    const {controller, api, replace} = fixture();
    const pending = deferred();
    const ownerRevision = controller.optionsRevision;
    const selectionGeneration = controller.profileIndexChangeGeneration;
    api.optionsGetFull.mockImplementationOnce(() => pending.promise);
    const refreshing = controller.refresh();
    expect(controller.optionsRevision).toBe(ownerRevision + 1);
    replace();
    pending.resolve(await api.optionsGetFull());
    await refreshing;
    expect(controller.optionsRevision).toBe(ownerRevision + 1);
    expect(controller.getOptionsContext()).toEqual({index: 0, profileId: 'a'});
    expect(controller.profileIndexChangeGeneration).toBe(selectionGeneration);
});

test('failed refresh still retires work which captured the previous options revision', async () => {
    const {controller, api} = fixture();
    const pending = deferred();
    const before = controller.optionsRevision;
    api.optionsGetFull.mockImplementationOnce(() => pending.promise);
    const refreshing = controller._onOptionsUpdatedInternal(false);
    const assertion = expect(refreshing).rejects.toThrow('settings unavailable');
    expect(controller.optionsRevision).toBe(before + 1);
    pending.reject(new Error('settings unavailable'));
    await assertion;
    expect(controller.optionsRevision).toBe(before + 1);
});

test('same-ID local import advances both replacement and options ownership', async () => {
    const {controller, api} = fixture();
    const full = await api.optionsGetFull();
    const selection = controller.profileIndexChangeGeneration;
    const revision = controller.optionsRevision;
    await controller.setAllSettings({...full, profiles: [{...full.profiles[0], options: {marker: 'imported'}}]});
    expect(controller.profileIndexChangeGeneration).toBeGreaterThan(selection);
    expect(controller.optionsRevision).toBeGreaterThan(revision);
    expect(controller.getOptionsContext()).toEqual({index: 0, profileId: 'a'});
});


test('local settings replacement invalidates pending work before its write acknowledges', async () => {
    const {controller, api} = fixture();
    const full = await api.optionsGetFull();
    const pending = deferred();
    api.setAllSettings.mockImplementationOnce(() => pending.promise);
    const before = controller.optionsRevision;
    const importing = controller.setAllSettings(full);
    expect(controller.optionsRevision).toBe(before + 1);
    pending.resolve(null);
    await importing;
    expect(controller.optionsRevision).toBeGreaterThan(before);
});
