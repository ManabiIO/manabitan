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

import {describe, expect, vi} from 'vitest';
import {RecommendedSettingsController} from '../ext/js/pages/settings/recommended-settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('RecommendedSettingsController', () => {
    test('language change hides stale recommendations when selected language has none', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="recommended-settings-modal" hidden></div>
            <select id="language-select">
                <option value="ja">Japanese</option>
                <option value="fr">French</option>
            </select>
            <button id="recommended-settings-apply-button"></button>
            <div id="recommended-settings-list"></div>
            <template id="recommended-settings-list-item-template">
                <div class="settings-item">
                    <div class="settings-item-label"></div>
                    <div class="settings-item-description"></div>
                    <input type="checkbox">
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#recommended-settings-list-item-template'));
        const settingsController = {
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'recommended-settings-list-item') { throw new Error(`Unexpected template: ${name}`); }
                return /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
            }),
            modifyProfileSettings: vi.fn().mockResolvedValue([]),
            refresh: vi.fn(),
        };
        const controller = new RecommendedSettingsController(/** @type {any} */ (settingsController));
        Reflect.set(controller, '_recommendedSettingsByLanguage', {
            ja: [{description: 'Japanese defaults', modification: {action: 'set', path: 'general.language', value: 'ja'}}],
        });

        const languageSelect = /** @type {HTMLSelectElement} */ (window.document.querySelector('#language-select'));
        languageSelect.value = 'ja';
        await controller._onLanguageSelectChanged(new Event('change'));
        expect(window.document.querySelector('#recommended-settings-modal')?.hidden).toBe(false);
        expect(window.document.querySelectorAll('#recommended-settings-list .settings-item')).toHaveLength(1);

        languageSelect.value = 'fr';
        await controller._onLanguageSelectChanged(new Event('change'));

        expect(window.document.querySelector('#recommended-settings-modal')?.hidden).toBe(true);
        expect(window.document.querySelectorAll('#recommended-settings-list .settings-item')).toHaveLength(0);
    });

    test('missing descriptions render as empty text instead of literal undefined', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="recommended-settings-modal" hidden></div>
            <select id="language-select">
                <option value="ja">Japanese</option>
            </select>
            <button id="recommended-settings-apply-button"></button>
            <div id="recommended-settings-list"></div>
            <template id="recommended-settings-list-item-template">
                <div class="settings-item">
                    <div class="settings-item-label"></div>
                    <div class="settings-item-description"></div>
                    <input type="checkbox">
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#recommended-settings-list-item-template'));
        const settingsController = {
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'recommended-settings-list-item') { throw new Error(`Unexpected template: ${name}`); }
                return /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
            }),
            modifyProfileSettings: vi.fn().mockResolvedValue([]),
            refresh: vi.fn(),
        };
        const controller = new RecommendedSettingsController(/** @type {any} */ (settingsController));
        Reflect.set(controller, '_recommendedSettingsByLanguage', {
            ja: [{modification: {action: 'set', path: 'general.language', value: 'ja'}}],
        });

        const languageSelect = /** @type {HTMLSelectElement} */ (window.document.querySelector('#language-select'));
        languageSelect.value = 'ja';
        await controller._onLanguageSelectChanged(new Event('change'));

        expect(window.document.querySelector('.settings-item-description')?.textContent).toBe('');
    });

    test('apply keeps the modal open and skips refresh when saving fails', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="recommended-settings-modal"></div>
            <select id="language-select">
                <option value="ja">Japanese</option>
            </select>
            <button id="recommended-settings-apply-button"></button>
            <div id="recommended-settings-list"></div>
            <template id="recommended-settings-list-item-template">
                <div class="settings-item">
                    <div class="settings-item-label"></div>
                    <div class="settings-item-description"></div>
                    <input type="checkbox">
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#recommended-settings-list-item-template'));
        const settingsController = {
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'recommended-settings-list-item') { throw new Error(`Unexpected template: ${name}`); }
                return /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
            }),
            modifyProfileSettings: vi.fn().mockRejectedValue(new Error('save failed')),
            refresh: vi.fn(),
        };
        const controller = new RecommendedSettingsController(/** @type {any} */ (settingsController));
        Reflect.set(controller, '_recommendedSettingsByLanguage', {
            ja: [{description: 'Japanese defaults', modification: {action: 'set', path: 'general.language', value: 'ja'}}],
        });

        const languageSelect = /** @type {HTMLSelectElement} */ (window.document.querySelector('#language-select'));
        languageSelect.value = 'ja';
        await controller._onLanguageSelectChanged(new Event('change'));

        const checkbox = /** @type {HTMLInputElement} */ (window.document.querySelector('#recommended-settings-list input[type="checkbox"]'));
        checkbox.checked = true;

        await controller._onApplyButtonClicked(/** @type {MouseEvent} */ (new window.MouseEvent('click')));

        expect(window.document.querySelector('#recommended-settings-modal')?.hidden).toBe(false);
        expect(settingsController.refresh).not.toHaveBeenCalled();
    });
});
