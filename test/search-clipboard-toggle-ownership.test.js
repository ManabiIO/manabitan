/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {log} from '../ext/js/core/log.js';
import {SearchDisplayController} from '../ext/js/display/search-display-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{controller: SearchDisplayController, state: {profileId: string, options: import('settings').ProfileOptions, context: import('settings').OptionsContext}, save: import('vitest').Mock, start: import('vitest').MockInstance, stop: import('vitest').MockInstance}>}
 */
async function setup(window) {
    /** @type {HTMLInputElement} */ (window.document.querySelector('#clipboard-monitor-enable')).checked = false;
    const state = {
        profileId: 'profile-a',
        options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
            general: {language: 'ja', enableWanakana: false, stickySearchHeader: false},
            clipboard: {enableSearchPageMonitor: false, autoSearchContent: true, maximumSearchLength: 100},
        })),
        context: /** @type {import('settings').OptionsContext} */ ({depth: 0, url: 'https://example.test'}),
    };
    const save = vi.fn().mockImplementation(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ changes) => [{result: changes[0].value}]);
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {clipboardGet: vi.fn(), modifySettings: save, optionsGetProfile: vi.fn(async () => ({profileId: state.profileId, options: state.options}))}, webExtension: {unloaded: false}},
        getOptions: () => state.options,
        getOptionsContext: () => state.context,
        getOptionsProfileId: () => state.profileId,
    }));
    const controller = new SearchDisplayController(
        display,
        /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (/** @type {unknown} */ ({})),
        /** @type {import('../ext/js/display/search-persistent-state-controller.js').SearchPersistentStateController} */ (/** @type {unknown} */ ({mode: null})),
    );
    const start = vi.spyOn(controller._clipboardMonitor, 'start').mockImplementation(() => {});
    const stop = vi.spyOn(controller._clipboardMonitor, 'stop').mockImplementation(() => {});
    vi.spyOn(controller, '_updateProfileSelect').mockResolvedValue();
    await controller._onDisplayOptionsUpdated({options: state.options});
    return {controller, state, save, start, stop};
}

test('a delayed clipboard grant cannot undo a newer disabled choice', async ({window}) => {
    const {controller, save, start} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    await controller._setClipboardMonitorEnabled(false);
    permission.resolve(true);
    await older;
    expect(save.mock.calls.map(([changes]) => changes[0].value)).toStrictEqual([false]);
    expect(controller._clipboardMonitorEnabled).toBe(false);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
    expect(start).not.toHaveBeenCalled();
});

test('a profile options refresh retires an older permission response even when the context object survives', async ({window}) => {
    const {controller, state, save, start} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    state.profileId = 'profile-b';
    state.options = structuredClone(state.options);
    await controller._onDisplayOptionsUpdated({options: state.options});
    permission.resolve(true);
    await older;
    expect(save).not.toHaveBeenCalled();
    expect(controller._clipboardMonitorEnabled).toBe(false);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
    expect(start).not.toHaveBeenCalled();
});

test('changed search context retires a delayed grant before settings publication', async ({window}) => {
    const {controller, state, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    state.context = {index: 1, profileId: 'another-profile'};
    permission.resolve(true);
    await older;
    expect(save).not.toHaveBeenCalled();
    expect(controller._clipboardMonitorEnabled).toBe(false);
});

test('successful clipboard grant saves the setting and starts monitoring', async ({window}) => {
    const {controller, state, save, start} = await setup(window);
    vi.spyOn(controller, '_requestPermissions').mockResolvedValue(true);
    await controller._setClipboardMonitorEnabled(true);
    expect(save).toHaveBeenCalledWith([{action: 'set', path: 'clipboard.enableSearchPageMonitor', value: true, scope: 'profile', profileId: state.profileId, optionsContext: state.context}], 'search');
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(true);
    expect(start).toHaveBeenCalledOnce();
});

test('denied clipboard permission restores the checkbox without a settings write', async ({window}) => {
    const {controller, save, start} = await setup(window);
    vi.spyOn(controller, '_requestPermissions').mockResolvedValue(false);
    controller._clipboardMonitorEnableCheckbox.checked = true;
    await controller._setClipboardMonitorEnabled(true);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
});

for (const failure of ['transport', 'setting-result', 'invalid-result', 'missing-result', 'wrong-result']) {
    test('a failed clipboard save restores the prior monitor state: ' + failure, async ({window}) => {
        const {controller, save} = await setup(window);
        vi.spyOn(controller, '_requestPermissions').mockResolvedValue(true);
        switch (failure) {
            case 'transport':
                save.mockRejectedValueOnce(new Error('Save unavailable'));
                break;
            case 'setting-result':
                save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Save unavailable'))}]);
                break;
            case 'missing-result':
                save.mockResolvedValueOnce([{}]);
                break;
            case 'wrong-result':
                save.mockResolvedValueOnce([{result: false}]);
                break;
            default:
                save.mockResolvedValueOnce([]);
                break;
        }
        await expect(controller._setClipboardMonitorEnabled(true)).rejects.toThrow();
        expect(controller._clipboardMonitorEnabled).toBe(false);
        expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
    });
}

test('the checkbox event reports a failed save without an unhandled rejection', async ({window}) => {
    const {controller, save} = await setup(window);
    save.mockRejectedValueOnce(new Error('Save unavailable'));
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    controller._clipboardMonitorEnableCheckbox.checked = false;
    controller._onClipboardMonitorEnableChange(/** @type {Event} */ (/** @type {unknown} */ ({target: controller._clipboardMonitorEnableCheckbox})));
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({message: 'Save unavailable'})));
});


test('an older denied grant cannot reset a newer successful enable', async ({window}) => {
    const {controller, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValueOnce(permission.promise).mockResolvedValueOnce(true);
    const older = controller._setClipboardMonitorEnabled(true);
    await controller._setClipboardMonitorEnabled(true);
    permission.resolve(false);
    await older;
    expect(save).toHaveBeenCalledOnce();
    expect(controller._clipboardMonitorEnabled).toBe(true);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(true);
});

test('an old failed save cannot restore state over a newer successful disable', async ({window}) => {
    const {controller, save} = await setup(window);
    const pending = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockResolvedValue(true);
    save.mockReturnValueOnce(pending.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    const observed = expect(older).rejects.toThrow('Old save failed');
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await controller._setClipboardMonitorEnabled(false);
    pending.reject(new Error('Old save failed'));
    await observed;
    expect(controller._clipboardMonitorEnabled).toBe(false);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
});

test('an unrelated options broadcast preserves a pending permission choice', async ({window}) => {
    const {controller, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    vi.spyOn(controller, '_refreshAfterOptionsUpdate').mockResolvedValue();
    const older = controller._setClipboardMonitorEnabled(true);
    controller._onOptionsUpdated();
    permission.resolve(true);
    await older;
    expect(save).toHaveBeenCalledOnce();
    expect(controller._clipboardMonitorEnabled).toBe(true);
});

test('a user profile selection retires a permission response before its queued write starts', async ({window}) => {
    const {controller, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    const profileRead = /** @type {PromiseWithResolvers<import('settings').Options>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    controller._profileSelectProfiles = /** @type {import('settings').Profile[]} */ (/** @type {unknown} */ ([{id: 'first'}, {id: 'second'}]));
    Reflect.set(controller._display.application.api, 'optionsGetFull', vi.fn(() => profileRead.promise));
    vi.spyOn(controller, '_setDefaultProfileIndex').mockResolvedValue();
    const older = controller._setClipboardMonitorEnabled(true);
    const changing = controller._onProfileSelectChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {value: '1'}})));
    permission.resolve(true);
    await older;
    expect(save).not.toHaveBeenCalled();
    profileRead.resolve(/** @type {import('settings').Options} */ (/** @type {unknown} */ ({profiles: controller._profileSelectProfiles})));
    await changing;
});

test('a failed disable restores the prior enabled monitor and reports failure', async ({window}) => {
    const {controller, state, save} = await setup(window);
    state.options.clipboard.enableSearchPageMonitor = true;
    controller._clipboardMonitorEnabled = true;
    controller._updateClipboardMonitorEnabled();
    save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Cannot disable'))}]);
    await expect(controller._setClipboardMonitorEnabled(false)).rejects.toThrow('Cannot disable');
    expect(controller._clipboardMonitorEnabled).toBe(true);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(true);
});


test('a same-profile options refresh preserves a pending grant when only unrelated settings changed', async ({window}) => {
    const {controller, state, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    state.options = structuredClone(state.options);
    state.options.general.stickySearchHeader = true;
    await controller._onDisplayOptionsUpdated({options: state.options});
    permission.resolve(true);
    await older;
    expect(save).toHaveBeenCalledOnce();
    expect(controller._clipboardMonitorEnabled).toBe(true);
});

test('the displayed profile owns a delayed grant even if the backend default changes before its broadcast', async ({window}) => {
    const {controller, state, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    const profiles = [{id: state.profileId, conditionGroups: [], options: structuredClone(state.options)}, {id: 'profile-b', conditionGroups: [], options: structuredClone(state.options)}];
    const options = {profiles, profileCurrent: 0};
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_getOptionsFull', () => options);
    Reflect.set(backend, '_profileConditionsSchemaCache', []);
    save.mockImplementation(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ changes) => [{result: backend._modifySetting(changes[0])}]);
    const older = controller._setClipboardMonitorEnabled(true);
    options.profileCurrent = 1;
    permission.resolve(true);
    await older;
    expect(profiles[0].options.clipboard.enableSearchPageMonitor).toBe(true);
    expect(profiles[1].options.clipboard.enableSearchPageMonitor).toBe(false);
});


test('a failed profile selection restores the visible monitor state while retiring a pending grant', async ({window}) => {
    const {controller, save} = await setup(window);
    const permission = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockReturnValue(permission.promise);
    controller._clipboardMonitorEnableCheckbox.checked = true;
    controller._profileSelectProfiles = /** @type {import('settings').Profile[]} */ (/** @type {unknown} */ ([{id: 'first'}, {id: 'second'}]));
    Reflect.set(controller._display.application.api, 'optionsGetFull', vi.fn(async () => ({profiles: controller._profileSelectProfiles})));
    vi.spyOn(controller, '_setDefaultProfileIndex').mockRejectedValue(new Error('Profile save failed'));
    const enabling = controller._setClipboardMonitorEnabled(true);
    await expect(controller._onProfileSelectChange(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: {value: '1'}})))).rejects.toThrow('Profile save failed');
    permission.resolve(true);
    await enabling;
    expect(save).not.toHaveBeenCalled();
    expect(controller._clipboardMonitorEnabled).toBe(false);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
});


test('two overlapping failed clipboard saves restore the committed disabled option', async ({window}) => {
    const {controller, save} = await setup(window);
    vi.spyOn(controller, '_requestPermissions').mockResolvedValue(true);
    const first = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    const second = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = controller._setClipboardMonitorEnabled(true);
    const observedOlder = expect(older).rejects.toThrow('First failure');
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const newer = controller._setClipboardMonitorEnabled(false);
    const observedNewer = expect(newer).rejects.toThrow('Second failure');
    second.resolve([{error: ExtensionError.serialize(new Error('Second failure'))}]);
    await observedNewer;
    first.resolve([{error: ExtensionError.serialize(new Error('First failure'))}]);
    await observedOlder;
    expect(controller._clipboardMonitorEnabled).toBe(false);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(false);
});

test('a delayed clipboard recovery read cannot overwrite a newer successful choice', async ({window}) => {
    const {controller, state, save} = await setup(window);
    const read = /** @type {PromiseWithResolvers<import('api').ApiReturn<'optionsGetProfile'>>} */ (Promise.withResolvers());
    vi.spyOn(controller, '_requestPermissions').mockResolvedValue(true);
    vi.spyOn(controller._display.application.api, 'optionsGetProfile').mockReturnValueOnce(read.promise);
    save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Old failure'))}]);
    const older = controller._setClipboardMonitorEnabled(true);
    const observedOlder = expect(older).rejects.toThrow('Old failure');
    await vi.waitFor(() => expect(controller._display.application.api.optionsGetProfile).toHaveBeenCalledOnce());
    await controller._setClipboardMonitorEnabled(true);
    read.resolve({profileId: state.profileId, options: state.options});
    await observedOlder;
    expect(controller._clipboardMonitorEnabled).toBe(true);
    expect(controller._clipboardMonitorEnableCheckbox.checked).toBe(true);
});
