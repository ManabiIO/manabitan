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
 * @returns {Promise<{controller: SearchDisplayController, state: {profileId: ?string, context: import('settings').OptionsContext, options: import('settings').ProfileOptions}, save: import('vitest').Mock, control: (setting: 'enableWanakana'|'stickySearchHeader') => HTMLInputElement, change: (setting: 'enableWanakana'|'stickySearchHeader', value: boolean) => void}>}
 */
async function setup(window) {
    const state = {
        profileId: /** @type {?string} */ ('profile-a'),
        context: /** @type {import('settings').OptionsContext} */ ({depth: 0, url: 'https://example.test'}),
        options: /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
            general: {language: 'ja', enableWanakana: false, stickySearchHeader: false},
            clipboard: {enableSearchPageMonitor: false},
        })),
    };
    const save = vi.fn().mockImplementation(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ changes) => [{result: changes[0].value}]);
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {clipboardGet: vi.fn(), modifySettings: save, optionsGetProfile: vi.fn(async () => ({profileId: state.profileId, options: state.options}))}, webExtension: {unloaded: false}},
        getOptions: () => state.options,
        getOptionsProfileId: () => state.profileId,
        getOptionsContext: () => state.context,
    }));
    const controller = new SearchDisplayController(
        display,
        /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (/** @type {unknown} */ ({})),
        /** @type {import('../ext/js/display/search-persistent-state-controller.js').SearchPersistentStateController} */ (/** @type {unknown} */ ({mode: null})),
    );
    vi.spyOn(controller._clipboardMonitor, 'start').mockImplementation(() => {});
    vi.spyOn(controller._clipboardMonitor, 'stop').mockImplementation(() => {});
    vi.spyOn(controller, '_updateProfileSelect').mockResolvedValue();
    await controller._onDisplayOptionsUpdated({options: state.options});
    /**
     * @param {'enableWanakana'|'stickySearchHeader'} setting
     * @returns {HTMLInputElement}
     */
    const control = (setting) => /** @type {HTMLInputElement} */ (window.document.querySelector(setting === 'enableWanakana' ? '#wanakana-enable' : '#sticky-header-enable'));
    /**
     * @param {'enableWanakana'|'stickySearchHeader'} setting
     * @param {boolean} value
     */
    const change = (setting, value) => {
        const checkbox = control(setting);
        checkbox.checked = value;
        const event = /** @type {Event} */ (/** @type {unknown} */ ({target: checkbox}));
        if (setting === 'enableWanakana') {
            controller._onWanakanaEnableChange(event);
        } else {
            controller._onStickyHeaderEnableChange(event);
        }
    };
    return {controller, state, save, control, change};
}

for (const setting of /** @type {const} */ (['enableWanakana', 'stickySearchHeader'])) {
    test(setting + ': delivery after default profile change still edits the displayed profile', async ({window}) => {
        const {controller, state, save, change} = await setup(window);
        const profiles = [{id: 'profile-a', conditionGroups: [], options: structuredClone(state.options)}, {id: 'profile-b', conditionGroups: [], options: structuredClone(state.options)}];
        const options = {profiles, profileCurrent: 0};
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
        Reflect.set(backend, '_getOptionsFull', () => options);
        Reflect.set(backend, '_profileConditionsSchemaCache', []);
        const delivery = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        save.mockImplementation(async (/** @type {import('settings-modifications').ScopedModificationSet[]} */ changes) => {
            await delivery.promise;
            return [{result: backend._modifySetting(changes[0])}];
        });
        change(setting, true);
        options.profileCurrent = 1;
        delivery.resolve();
        await save.mock.results[0].value;
        expect(profiles[0].options.general[setting]).toBe(true);
        expect(profiles[1].options.general[setting]).toBe(false);
        expect(save.mock.calls[0][0][0]).toMatchObject({profileId: 'profile-a'});
        expect(controller._display.getOptionsProfileId()).toBe('profile-a');
    });

    for (const failure of ['transport', 'setting-error', 'empty', 'missing', 'wrong']) {
        test(setting + ': failed save restores the current option and reports error: ' + failure, async ({window}) => {
            const {controller, save, control, change} = await setup(window);
            const report = vi.spyOn(log, 'error').mockImplementation(() => {});
            switch (failure) {
                case 'transport': save.mockRejectedValueOnce(new Error('Save failed')); break;
                case 'setting-error': save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Save failed'))}]); break;
                case 'empty': save.mockResolvedValueOnce([]); break;
                case 'missing': save.mockResolvedValueOnce([{}]); break;
                default: save.mockResolvedValueOnce([{result: false}]); break;
            }
            change(setting, true);
            await save.mock.results[0].value.catch(() => {});
            await vi.waitFor(() => expect(control(setting).checked).toBe(false));
            if (setting === 'enableWanakana') { expect(controller._wanakanaEnabled).toBe(false); }
            expect(report).toHaveBeenCalledOnce();
        });
    }

    test(setting + ': late failure cannot overwrite a newer toggle', async ({window}) => {
        const {save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const first = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
        save.mockReturnValueOnce(first.promise);
        change(setting, true);
        change(setting, true);
        await save.mock.results[1].value;
        first.resolve([{error: ExtensionError.serialize(new Error('Old failure'))}]);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(control(setting).checked).toBe(true);
    });

    test(setting + ': rollback uses saved options after two overlapping failures', async ({window}) => {
        const {save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const first = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
        const second = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
        save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        change(setting, true);
        change(setting, false);
        second.resolve([{error: ExtensionError.serialize(new Error('Second failure'))}]);
        await second.promise;
        first.resolve([{error: ExtensionError.serialize(new Error('First failure'))}]);
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
        expect(control(setting).checked).toBe(false);
    });

    test(setting + ': a profile refresh owns UI over a retired failure', async ({window}) => {
        const {controller, state, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const pending = /** @type {PromiseWithResolvers<unknown>} */ (Promise.withResolvers());
        save.mockReturnValueOnce(pending.promise);
        change(setting, true);
        state.profileId = 'profile-b';
        state.options = structuredClone(state.options);
        state.options.general[setting] = true;
        await controller._onDisplayOptionsUpdated({options: state.options});
        pending.resolve([{error: ExtensionError.serialize(new Error('Old profile failure'))}]);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(controller._display.application.api.optionsGetProfile).not.toHaveBeenCalled();
        expect(control(setting).checked).toBe(true);
    });

    test(setting + ': missing profile identity rejects before mutation and restores UI', async ({window}) => {
        const {state, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        state.profileId = null;
        change(setting, true);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(save).not.toHaveBeenCalled();
        expect(control(setting).checked).toBe(false);
    });
    test(setting + ': failed newer save restores an acknowledged write before its broadcast', async ({window}) => {
        const {controller, state, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const committed = structuredClone(state.options);
        vi.spyOn(controller._display.application.api, 'optionsGetProfile').mockImplementation(async (context) => {
            expect(context).toStrictEqual({index: 0, profileId: 'profile-a'});
            return {profileId: 'profile-a', options: committed};
        });
        save.mockImplementationOnce(async () => {
            committed.general[setting] = true;
            return [{result: true}];
        }).mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Second save failed'))}]);
        change(setting, true);
        await save.mock.results[0].value;
        change(setting, false);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(state.options.general[setting]).toBe(false);
        expect(control(setting).checked).toBe(true);
    });

    test(setting + ': delayed recovery read cannot reset a newer successful toggle', async ({window}) => {
        const {controller, state, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const read = /** @type {PromiseWithResolvers<import('api').ApiReturn<'optionsGetProfile'>>} */ (Promise.withResolvers());
        vi.spyOn(controller._display.application.api, 'optionsGetProfile').mockReturnValueOnce(read.promise);
        save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Old save failed'))}]);
        change(setting, true);
        await vi.waitFor(() => expect(controller._display.application.api.optionsGetProfile).toHaveBeenCalledOnce());
        change(setting, true);
        await save.mock.results[1].value;
        read.resolve({profileId: 'profile-a', options: state.options});
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(control(setting).checked).toBe(true);
    });

    test(setting + ': unavailable recovery read restores displayed state and preserves the save error', async ({window}) => {
        const {controller, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        vi.spyOn(controller._display.application.api, 'optionsGetProfile').mockRejectedValueOnce(new Error('Read failed'));
        save.mockRejectedValueOnce(new Error('Save failed'));
        change(setting, true);
        await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({message: 'Save failed'})));
        expect(control(setting).checked).toBe(false);
    });

    test(setting + ': a recovery snapshot from another profile cannot replace displayed state', async ({window}) => {
        const {controller, state, save, control, change} = await setup(window);
        const report = vi.spyOn(log, 'error').mockImplementation(() => {});
        const other = structuredClone(state.options);
        other.general[setting] = true;
        vi.spyOn(controller._display.application.api, 'optionsGetProfile').mockResolvedValueOnce({profileId: 'profile-b', options: other});
        save.mockResolvedValueOnce([{error: ExtensionError.serialize(new Error('Save failed'))}]);
        change(setting, true);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        expect(control(setting).checked).toBe(false);
    });
}
