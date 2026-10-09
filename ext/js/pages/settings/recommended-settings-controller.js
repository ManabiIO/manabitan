/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {fetchJson} from '../../core/fetch-utilities.js';
import {log} from '../../core/log.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class RecommendedSettingsController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {HTMLElement} */
        this._recommendedSettingsModal = querySelectorNotNull(document, '#recommended-settings-modal');
        /** @type {HTMLInputElement} */
        this._languageSelect = querySelectorNotNull(document, '#language-select');
        /** @type {HTMLInputElement} */
        this._applyButton = querySelectorNotNull(document, '#recommended-settings-apply-button');
        /** @type {Map<string, import('settings-controller').RecommendedSetting>} */
        this._recommendedSettings = new Map();
        /** @type {number} */
        this._languageRequestGeneration = 0;
        /** @type {Promise<import('settings-controller').RecommendedSettingsByLanguage>|null} */
        this._recommendedSettingsLoadPromise = null;
    }

    /** */
    async prepare() {
        this._languageSelect.addEventListener('change', this._onLanguageSelectChangedEvent.bind(this), false);
        this._applyButton.addEventListener('click', this._onApplyButtonClickedEvent.bind(this), false);
    }

    /**
     * @param {Event} _e
     */
    async _onLanguageSelectChanged(_e) {
        const request = ++this._languageRequestGeneration;
        const setLanguage = this._languageSelect.value;
        if (typeof setLanguage !== 'string') { return; }

        // Hide the previous language's recommendations while the new request is
        // pending. Applying those stale checkboxes would change the wrong settings.
        this._recommendedSettingsModal.hidden = true;
        this._recommendedSettings = new Map();

        let recommendedSettings;
        try {
            recommendedSettings = await this._getRecommendedSettings(setLanguage);
        } catch (error) {
            if (request !== this._languageRequestGeneration || this._languageSelect.value !== setLanguage) { return; }
            throw error;
        }
        if (request !== this._languageRequestGeneration || this._languageSelect.value !== setLanguage) { return; }
        const settingsList = querySelectorNotNull(document, '#recommended-settings-list');
        settingsList.innerHTML = '';
        this._recommendedSettings = new Map();

        if (!Array.isArray(recommendedSettings) || recommendedSettings.length === 0) {
            this._recommendedSettingsModal.hidden = true;
            return;
        }

        for (const [index, setting] of recommendedSettings.entries()) {
            this._recommendedSettings.set(index.toString(), setting);

            const {description} = setting;
            const template = this._settingsController.instantiateTemplate('recommended-settings-list-item');

            // Render label
            this._renderLabel(template, setting);

            // Render description
            const descriptionElement = querySelectorNotNull(template, '.settings-item-description');
            descriptionElement.textContent = typeof description === 'string' ? description : '';

            // Render checkbox
            const checkbox = /** @type {HTMLInputElement} */ (querySelectorNotNull(template, 'input[type="checkbox"]'));
            checkbox.value = index.toString();

            settingsList.append(template);
        }
        this._recommendedSettingsModal.hidden = false;
    }

    /**
     * @param {Event} event
     */
    _onLanguageSelectChangedEvent(event) {
        void this._onLanguageSelectChanged(event).catch((error) => {
            log.error(error);
        });
    }

    /**
     *
     * @param {string} language
     * @returns {Promise<import('settings-controller').RecommendedSetting[]>}
     */
    async _getRecommendedSettings(language) {
        if (typeof this._recommendedSettingsByLanguage === 'undefined') {
            let promise = this._recommendedSettingsLoadPromise;
            if (promise === null) {
                promise = /** @type {Promise<import('settings-controller').RecommendedSettingsByLanguage>} */ (
                    fetchJson('/data/recommended-settings.json')
                );
                this._recommendedSettingsLoadPromise = promise;
            }
            try {
                this._recommendedSettingsByLanguage = await promise;
            } finally {
                if (this._recommendedSettingsLoadPromise === promise) {
                    this._recommendedSettingsLoadPromise = null;
                }
            }
        }
        return this._recommendedSettingsByLanguage[language];
    }

    /**
     * @param {MouseEvent} e
     */
    async _onApplyButtonClicked(e) {
        e.preventDefault();
        /** @type {NodeListOf<HTMLInputElement>} */
        const enabledCheckboxes = querySelectorNotNull(document, '#recommended-settings-list').querySelectorAll('input[type="checkbox"]:checked');
        if (enabledCheckboxes.length === 0) {
            this._recommendedSettingsModal.hidden = true;
            return;
        }

        const modifications = [];
        for (const checkbox of enabledCheckboxes) {
            const index = checkbox.value;
            const setting = this._recommendedSettings.get(index);
            if (typeof setting === 'undefined') { continue; }
            modifications.push(setting.modification);
        }

        try {
            const results = await this._settingsController.modifyProfileSettings(modifications);
            for (const result of results) {
                if (Object.hasOwn(result, 'error')) {
                    log.error(new Error(`Failed to apply recommended setting: ${JSON.stringify(result)}`));
                }
            }
            await this._settingsController.refresh();
            this._recommendedSettingsModal.hidden = true;
        } catch (error) {
            log.error(error);
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onApplyButtonClickedEvent(e) {
        void this._onApplyButtonClicked(e).catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {Element} template
     * @param {import('settings-controller').RecommendedSetting} setting
     */
    _renderLabel(template, setting) {
        const label = querySelectorNotNull(template, '.settings-item-label');

        const {modification} = setting;
        switch (modification.action) {
            case 'set': {
                const {path, value} = modification;
                const pathCodeElement = document.createElement('code');
                pathCodeElement.textContent = path;
                const valueCodeElement = document.createElement('code');
                valueCodeElement.textContent = JSON.stringify(value, null, 2);

                label.appendChild(document.createTextNode('Setting '));
                label.appendChild(pathCodeElement);
                label.appendChild(document.createTextNode(' = '));
                label.appendChild(valueCodeElement);
                break;
            }
            case 'delete': {
                const {path} = modification;
                const pathCodeElement = document.createElement('code');
                pathCodeElement.textContent = path;

                label.appendChild(document.createTextNode('Deleting '));
                label.appendChild(pathCodeElement);
                break;
            }
            case 'swap': {
                const {path1, path2} = modification;
                const path1CodeElement = document.createElement('code');
                path1CodeElement.textContent = path1;
                const path2CodeElement = document.createElement('code');
                path2CodeElement.textContent = path2;

                label.appendChild(document.createTextNode('Swapping '));
                label.appendChild(path1CodeElement);
                label.appendChild(document.createTextNode(' and '));
                label.appendChild(path2CodeElement);
                break;
            }
            case 'splice': {
                const {path, start, deleteCount, items} = modification;
                const pathCodeElement = document.createElement('code');
                pathCodeElement.textContent = path;

                label.appendChild(document.createTextNode('Splicing '));
                label.appendChild(pathCodeElement);
                label.appendChild(document.createTextNode(` at ${start} deleting ${deleteCount} items and inserting ${items.length} items`));
                break;
            }
            case 'removeDictionary': {
                const {path, name} = modification;
                const pathCodeElement = document.createElement('code');
                pathCodeElement.textContent = path;
                label.appendChild(document.createTextNode(`Removing dictionary ${name} from `));
                label.appendChild(pathCodeElement);
                break;
            }
            case 'push': {
                const {path, items} = modification;
                const pathCodeElement = document.createElement('code');
                pathCodeElement.textContent = path;

                label.appendChild(document.createTextNode(`Pushing ${items.length} items to `));
                label.appendChild(pathCodeElement);
                break;
            }
            default: {
                log.error(new Error(`Unknown modification: ${modification}`));
            }
        }
    }
}
