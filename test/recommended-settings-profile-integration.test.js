/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {deferPromise} from '../ext/js/core/utilities.js';
import {RecommendedSettingsController} from '../ext/js/pages/settings/recommended-settings-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/** @type {import('settings-controller').RecommendedSettingsByLanguage} */
const recommendations = {
    en: [{description: 'English scanning', modification: {action: 'set', path: 'scanning.scanResolution', value: 'word'}}],
    ja: [{description: 'Japanese scanning', modification: {action: 'set', path: 'scanning.scanResolution', value: 'character'}}],
};

/** @returns {Promise<{controller: RecommendedSettingsController, settings: SettingsController, api: {modifySettings: ReturnType<typeof vi.fn>}, language: HTMLSelectElement, modal: HTMLElement}>} */
async function createHarness() {
    document.body.innerHTML = `
        <div id="recommended-settings-modal" hidden></div>
        <select id="language-select"><option value="en">English</option><option value="ja">Japanese</option></select>
        <button id="recommended-settings-apply-button"></button>
        <div id="recommended-settings-list"></div>
        <template id="recommended-settings-list-item-template">
            <div class="settings-item">
                <div class="settings-item-label"></div>
                <div class="settings-item-description"></div>
                <input type="checkbox" checked>
            </div>
        </template>
    `;
    const profiles = ['profile-a', 'profile-b'].map((id) => ({id, name: id, options: {general: {language: 'en'}}}));
    const options = {profileCurrent: 0, profiles};
    const api = {
        optionsGetFull: vi.fn(async () => options),
        optionsGet: vi.fn(async ({index}) => profiles[index].options),
        modifySettings: vi.fn(async () => [{result: true}]),
    };
    const settings = new SettingsController(/** @type {any} */ ({api}));
    Reflect.set(settings, '_preparedOptionsFull', options);
    settings._setProfileSelection(0, 'profile-a', true);
    const template = /** @type {HTMLTemplateElement} */ (document.querySelector('#recommended-settings-list-item-template'));
    vi.spyOn(settings, 'instantiateTemplate').mockImplementation(() => /** @type {HTMLElement} */ (template.content.firstElementChild?.cloneNode(true)));
    const controller = new RecommendedSettingsController(settings);
    Reflect.set(controller, '_recommendedSettingsByLanguage', recommendations);
    await controller.prepare();
    return {
        controller,
        settings,
        api,
        language: /** @type {HTMLSelectElement} */ (document.querySelector('#language-select')),
        modal: /** @type {HTMLElement} */ (document.querySelector('#recommended-settings-modal')),
    };
}

test('a recommendation download cannot open in a different profile', async ({window}) => {
    const {controller, settings, modal} = await createHarness();
    const pending = /** @type {import('core').DeferredPromiseDetails<import('settings-controller').RecommendedSetting[]>} */ (deferPromise());
    vi.spyOn(controller, '_getRecommendedSettings').mockReturnValueOnce(pending.promise);
    const load = controller._onLanguageSelectChanged(new window.Event('change'));

    settings.profileIndex = 1;
    pending.resolve(recommendations.en);
    await load;

    expect(settings.getOptionsContext()).toEqual({index: 1, profileId: 'profile-b'});
    expect(modal.hidden).toBe(true);
    expect(document.querySelectorAll('#recommended-settings-list input')).toHaveLength(0);
});

test('recommendations from the previous profile cannot write the newly selected profile', async ({window}) => {
    const {controller, settings, api, modal} = await createHarness();
    await controller._onLanguageSelectChanged(new window.Event('change'));
    expect(modal.hidden).toBe(false);

    settings.profileIndex = 1;
    await controller._onApplyButtonClicked(/** @type {MouseEvent} */ (new window.MouseEvent('click')));

    expect(api.modifySettings).not.toHaveBeenCalled();
    expect(modal.hidden).toBe(true);
});

test('an earlier apply completion cannot refresh or hide newer language recommendations', async ({window}) => {
    const {controller, settings, api, language, modal} = await createHarness();
    const pending = /** @type {import('core').DeferredPromiseDetails<import('settings-controller').ModifyResult[]>} */ (deferPromise());
    api.modifySettings.mockReturnValueOnce(pending.promise);
    const refresh = vi.spyOn(settings, 'refresh');
    await controller._onLanguageSelectChanged(new window.Event('change'));
    const apply = controller._onApplyButtonClicked(/** @type {MouseEvent} */ (new window.MouseEvent('click')));
    expect(api.modifySettings).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({scope: 'profile', optionsContext: {index: 0, profileId: 'profile-a'}, path: 'scanning.scanResolution', value: 'word'}),
    ], settings.source);

    language.value = 'ja';
    await controller._onLanguageSelectChanged(new window.Event('change'));
    pending.resolve([{result: true}]);
    await apply;

    expect(modal.hidden).toBe(false);
    expect(document.querySelector('.settings-item-label')?.textContent).toContain('character');
    expect(refresh).not.toHaveBeenCalled();
});

test('a pending apply refresh cannot hide a subsequent recommendation view', async ({window}) => {
    const {controller, settings, language, modal} = await createHarness();
    const pending = /** @type {import('core').DeferredPromiseDetails<void>} */ (deferPromise());
    const refresh = vi.spyOn(settings, 'refresh').mockReturnValueOnce(pending.promise);
    await controller._onLanguageSelectChanged(new window.Event('change'));
    const apply = controller._onApplyButtonClicked(/** @type {MouseEvent} */ (new window.MouseEvent('click')));
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce(); });

    language.value = 'ja';
    await controller._onLanguageSelectChanged(new window.Event('change'));
    pending.resolve();
    await apply;

    expect(modal.hidden).toBe(false);
    expect(document.querySelector('.settings-item-label')?.textContent).toContain('character');
});

test('applying current recommendations still saves and refreshes their profile', async ({window}) => {
    const {controller, settings, api, modal} = await createHarness();
    const refresh = vi.spyOn(settings, 'refresh');
    await controller._onLanguageSelectChanged(new window.Event('change'));
    await controller._onApplyButtonClicked(/** @type {MouseEvent} */ (new window.MouseEvent('click')));

    expect(api.modifySettings).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(modal.hidden).toBe(true);
});
