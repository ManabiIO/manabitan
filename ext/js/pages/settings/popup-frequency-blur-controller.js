/*
 * Copyright (C) 2025  Yomitan Authors
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

import {isDictionaryImportBusyError} from '../../core/dictionary-import-busy-error.js';
import {log} from '../../core/log.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class PopupFrequencyBlurController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {HTMLSelectElement} */
        this._popupFrequencyBlurDictionarySelect = querySelectorNotNull(document, '#popup-frequency-blur-dictionary');
        /** @type {?import('core').TokenObject} */
        this._getDictionaryInfoToken = null;
        /** @type {number} */
        this._optionsRenderRequest = 0;
    }

    /** */
    async prepare() {
        this._settingsController.application.on('databaseUpdated', () => this._onDatabaseUpdated().catch((error) => { log.error(error); }));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));

        await this._onDatabaseUpdated();
    }

    /** */
    async _onDatabaseUpdated() {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._getDictionaryInfoToken = token;
        try {
            let dictionaries;
            try {
                dictionaries = await this._settingsController.getDictionaryInfo();
            } catch (error) {
                // Mutation owns metadata until its databaseUpdated publication.
                // Keep the last usable controls and wait for that event.
                if (isDictionaryImportBusyError(error)) { return; }
                throw error;
            }
            if (this._getDictionaryInfoToken !== token) { return; }

            // Metadata is global. Publish it before reading profile options so
            // a newer options event can render against the same dictionary list.
            this._updateDictionaryOptions(dictionaries);
            const request = ++this._optionsRenderRequest;
            const optionsContext = this._settingsController.getOptionsContext();
            const options = await this._settingsController.getOptions();
            if (
                request !== this._optionsRenderRequest ||
                this._getDictionaryInfoToken !== token ||
                this._settingsController.getOptionsContext().index !== optionsContext.index ||
                this._settingsController.getOptionsContext().profileId !== optionsContext.profileId
            ) {
                return;
            }
            this._onOptionsChanged({options, optionsContext});
        } finally {
            if (this._getDictionaryInfoToken === token) {
                this._getDictionaryInfoToken = null;
            }
        }
    }

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options}) {
        ++this._optionsRenderRequest;
        const {popupBlurByFrequencyDictionary} = options.general;
        this._popupFrequencyBlurDictionarySelect.value = (popupBlurByFrequencyDictionary !== null ? popupBlurByFrequencyDictionary : '');
    }

    /**
     * @param {import('dictionary-importer').Summary[]} dictionaries
     */
    _updateDictionaryOptions(dictionaries) {
        const fragment = document.createDocumentFragment();
        let option = document.createElement('option');
        option.value = '';
        option.textContent = 'None';
        fragment.appendChild(option);

        for (const {title, counts} of dictionaries) {
            if (counts && counts.termMeta && counts.termMeta.freq > 0) {
                option = document.createElement('option');
                option.value = title;
                option.textContent = title;
                fragment.appendChild(option);
            }
        }

        this._popupFrequencyBlurDictionarySelect.textContent = '';
        this._popupFrequencyBlurDictionarySelect.appendChild(fragment);
    }
}
