/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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

import {ExtensionError} from '../../core/extension-error.js';
import {log} from '../../core/log.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class SortFrequencyDictionaryController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {HTMLSelectElement} */
        this._sortFrequencyDictionarySelect = querySelectorNotNull(document, '#sort-frequency-dictionary');
        /** @type {HTMLSelectElement} */
        this._sortFrequencyDictionaryOrderSelect = querySelectorNotNull(document, '#sort-frequency-dictionary-order');
        /** @type {HTMLButtonElement} */
        this._sortFrequencyDictionaryOrderAutoButton = querySelectorNotNull(document, '#sort-frequency-dictionary-order-auto');
        /** @type {HTMLElement} */
        this._sortFrequencyDictionaryOrderContainerNode = querySelectorNotNull(document, '#sort-frequency-dictionary-order-container');
        /** @type {string} */
        this._confirmedDictionary = this._sortFrequencyDictionarySelect.value;
        /** @type {string} */
        this._confirmedOrder = this._sortFrequencyDictionaryOrderSelect.value;
        /** @type {number} */
        this._autoOrderRequestId = 0;
        /** @type {number} */
        this._dictionaryWriteRequest = 0;
        /** @type {number} */
        this._orderWriteRequest = 0;
        /** @type {number} */
        this._optionsRevision = 0;
        /** @type {Promise<void>} */
        this._settingWriteTail = Promise.resolve();
        /** @type {?import('core').TokenObject} */
        this._getDictionaryInfoToken = null;
        /** @type {number} */
        this._optionsRenderRequest = 0;
    }

    /** */
    async prepare() {
        await this._onDatabaseUpdated();

        this._settingsController.application.on('databaseUpdated', this._onDatabaseUpdated.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._sortFrequencyDictionarySelect.addEventListener('change', this._onSortFrequencyDictionarySelectChange.bind(this));
        this._sortFrequencyDictionaryOrderSelect.addEventListener('change', this._onSortFrequencyDictionaryOrderSelectChange.bind(this));
        this._sortFrequencyDictionaryOrderAutoButton.addEventListener('click', this._onSortFrequencyDictionaryOrderAutoButtonClick.bind(this));
    }

    // Private

    /** */
    async _onDatabaseUpdated() {
        /** @type {?import('core').TokenObject} */
        const token = {};
        this._getDictionaryInfoToken = token;
        try {
            const dictionaries = await this._settingsController.getDictionaryInfo();
            if (this._getDictionaryInfoToken !== token) { return; }

            this._updateDictionaryOptions(dictionaries);

            const request = ++this._optionsRenderRequest;
            const optionsContext = this._settingsController.getOptionsContext();
            const options = await this._settingsController.getOptions();
            if (
                request !== this._optionsRenderRequest ||
                this._getDictionaryInfoToken !== token ||
                this._settingsController.getOptionsContext().index !== optionsContext.index
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
        ++this._optionsRevision;
        ++this._autoOrderRequestId;
        const {sortFrequencyDictionary, sortFrequencyDictionaryOrder} = options.general;
        this._confirmedDictionary = sortFrequencyDictionary !== null ? sortFrequencyDictionary : '';
        this._confirmedOrder = sortFrequencyDictionaryOrder;
        /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionarySelect).value = this._confirmedDictionary;
        /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionaryOrderSelect).value = this._confirmedOrder;
        /** @type {HTMLElement} */ (this._sortFrequencyDictionaryOrderContainerNode).hidden = (sortFrequencyDictionary === null);
    }

    /** */
    _onSortFrequencyDictionarySelectChange() {
        const {value} = /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionarySelect);
        ++this._autoOrderRequestId;
        void this._setSortFrequencyDictionaryValue(value !== '' ? value : null).catch((error) => { log.error(error); });
    }

    /** */
    _onSortFrequencyDictionaryOrderSelectChange() {
        const {value} = /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionaryOrderSelect);
        const value2 = this._normalizeSortFrequencyDictionaryOrder(value);
        if (value2 === null) { return; }
        ++this._autoOrderRequestId;
        void this._setSortFrequencyDictionaryOrderValue(value2).catch((error) => { log.error(error); });
    }

    /** */
    _onSortFrequencyDictionaryOrderAutoButtonClick() {
        const {value} = /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionarySelect);
        if (value === '') { return; }
        void this._autoUpdateOrder(value).catch((error) => { log.error(error); });
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
        const select = /** @type {HTMLSelectElement} */ (this._sortFrequencyDictionarySelect);
        select.textContent = '';
        select.appendChild(fragment);
    }

    /**
     * @param {?string} value
     */
    async _setSortFrequencyDictionaryValue(value) {
        const request = ++this._dictionaryWriteRequest;
        const revision = this._optionsRevision;
        const {index} = this._settingsController.getOptionsContext();
        this._sortFrequencyDictionaryOrderContainerNode.hidden = (value === null);
        try {
            const saved = await this._saveProfileSetting('general.sortFrequencyDictionary', value, index, () => request === this._dictionaryWriteRequest);
            if (!saved || this._settingsController.getOptionsContext().index !== index || revision !== this._optionsRevision) { return; }
            this._confirmedDictionary = value !== null ? value : '';
            if (request === this._dictionaryWriteRequest && value !== null) {
                await this._autoUpdateOrder(value);
            }
        } catch (error) {
            if (request === this._dictionaryWriteRequest && revision === this._optionsRevision && this._settingsController.getOptionsContext().index === index) {
                this._sortFrequencyDictionarySelect.value = this._confirmedDictionary;
                this._sortFrequencyDictionaryOrderContainerNode.hidden = this._confirmedDictionary === '';
            }
            throw error;
        }
    }

    /**
     * @param {import('settings').SortFrequencyDictionaryOrder} value
     */
    async _setSortFrequencyDictionaryOrderValue(value) {
        const request = ++this._orderWriteRequest;
        const revision = this._optionsRevision;
        const {index} = this._settingsController.getOptionsContext();
        try {
            const saved = await this._saveProfileSetting('general.sortFrequencyDictionaryOrder', value, index, () => request === this._orderWriteRequest);
            if (saved && revision === this._optionsRevision && this._settingsController.getOptionsContext().index === index) {
                this._confirmedOrder = value;
            }
        } catch (error) {
            if (request === this._orderWriteRequest && revision === this._optionsRevision && this._settingsController.getOptionsContext().index === index) {
                this._sortFrequencyDictionaryOrderSelect.value = this._confirmedOrder;
            }
            throw error;
        }
    }

    /**
     * @param {string} path
     * @param {unknown} value
     * @param {number} index
     * @param {() => boolean} isCurrent
     * @returns {Promise<boolean>}
     */
    async _saveProfileSetting(path, value, index, isCurrent) {
        const operation = this._settingWriteTail.then(async () => {
            if (!isCurrent() || this._settingsController.getOptionsContext().index !== index) { return false; }
            const results = await this._settingsController.setProfileSetting(path, value);
            if (!Array.isArray(results) || results.length !== 1 || typeof results[0] !== 'object' || results[0] === null) {
                throw new Error('Frequency setting update returned an invalid result');
            }
            if (results[0].error) { throw ExtensionError.deserialize(results[0].error); }
            return true;
        });
        this._settingWriteTail = operation.then(() => {}, () => {});
        return await operation;
    }

    /**
     * @param {string} dictionary
     */
    async _autoUpdateOrder(dictionary) {
        const requestId = ++this._autoOrderRequestId;
        const optionsContext = this._settingsController.getOptionsContext();
        const order = await this._getFrequencyOrder(dictionary);
        if (
            order === null ||
            requestId !== this._autoOrderRequestId ||
            this._settingsController.getOptionsContext().index !== optionsContext.index ||
            this._confirmedDictionary !== dictionary ||
            this._sortFrequencyDictionarySelect.value !== dictionary
        ) {
            return;
        }
        this._sortFrequencyDictionaryOrderSelect.value = order;
        await this._setSortFrequencyDictionaryOrderValue(order);
    }

    /**
     * @param {string} dictionary
     * @returns {Promise<import('settings').SortFrequencyDictionaryOrder?>}
     */
    async _getFrequencyOrder(dictionary) {
        const dictionaryInfo = await this._settingsController.application.api.getDictionaryInfo();
        const dictionaryFrequencyMode = dictionaryInfo.find(({title}) => title === dictionary)?.frequencyMode ?? '';
        switch (dictionaryFrequencyMode) {
            case 'occurrence-based': {
                return 'descending';
            }
            case 'rank-based': {
                return 'ascending';
            }
        }

        const dictionaryLang = dictionaryInfo.find(({title}) => title === dictionary)?.sourceLanguage ?? '';

        /** @type {Record<string, string[]>} */
        const moreCommonTerms = {
            ja: ['来る', '言う', '出る', '入る', '方', '男', '女', '今', '何', '時'],
        };
        /** @type {Record<string, string[]>} */
        const lessCommonTerms = {
            ja: ['行なう', '論じる', '過す', '行方', '人口', '猫', '犬', '滝', '理', '暁'],
        };
        let langMoreCommonTerms = moreCommonTerms[dictionaryLang];
        let langLessCommonTerms = lessCommonTerms[dictionaryLang];
        if (dictionaryLang === '') {
            langMoreCommonTerms = [];
            for (const key in moreCommonTerms) {
                if (Object.hasOwn(moreCommonTerms, key)) {
                    langMoreCommonTerms.push(...moreCommonTerms[key]);
                }
            }
            langLessCommonTerms = [];
            for (const key in lessCommonTerms) {
                if (Object.hasOwn(lessCommonTerms, key)) {
                    langLessCommonTerms.push(...lessCommonTerms[key]);
                }
            }
        }

        const terms = [...langMoreCommonTerms, ...langLessCommonTerms];

        const frequencies = await this._settingsController.application.api.getTermFrequencies(
            terms.map((term) => ({term, reading: null})),
            [dictionary],
        );

        /** @type {Map<string, {hasValue: boolean, minValue: number, maxValue: number}>} */
        const termDetails = new Map();
        const moreCommonTermDetails = [];
        const lessCommonTermDetails = [];
        for (const term of langMoreCommonTerms) {
            const details = {hasValue: false, minValue: Number.MAX_SAFE_INTEGER, maxValue: Number.MIN_SAFE_INTEGER};
            termDetails.set(term, details);
            moreCommonTermDetails.push(details);
        }
        for (const term of langLessCommonTerms) {
            const details = {hasValue: false, minValue: Number.MAX_SAFE_INTEGER, maxValue: Number.MIN_SAFE_INTEGER};
            termDetails.set(term, details);
            lessCommonTermDetails.push(details);
        }

        for (const {term, frequency} of frequencies) {
            const details = termDetails.get(term);
            if (typeof details === 'undefined') { continue; }
            details.minValue = Math.min(details.minValue, frequency);
            details.maxValue = Math.max(details.maxValue, frequency);
            details.hasValue = true;
        }

        let result = 0;
        for (const details1 of moreCommonTermDetails) {
            if (!details1.hasValue) { continue; }
            for (const details2 of lessCommonTermDetails) {
                if (!details2.hasValue) { continue; }
                result += Math.sign(details1.maxValue - details2.minValue) + Math.sign(details1.minValue - details2.maxValue);
            }
        }

        const resultSign = Math.sign(result);
        if (resultSign > 0) { return 'descending'; }
        if (resultSign < 0) { return 'ascending'; }
        return null;
    }

    /**
     * @param {string} value
     * @returns {?import('settings').SortFrequencyDictionaryOrder}
     */
    _normalizeSortFrequencyDictionaryOrder(value) {
        switch (value) {
            case 'ascending':
            case 'descending':
                return value;
            default:
                return null;
        }
    }
}
