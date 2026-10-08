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

import {EventListenerCollection} from '../../core/event-listener-collection.js';
import {log} from '../../core/log.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class CollapsibleDictionaryController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {?import('core').TokenObject} */
        this._getDictionaryInfoToken = null;
        /** @type {Map<string, import('dictionary-importer').Summary>} */
        this._dictionaryInfoMap = new Map();
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {HTMLElement} */
        this._container = querySelectorNotNull(document, '#collapsible-dictionary-list');
        /** @type {HTMLSelectElement[]} */
        this._selects = [];
        /** @type {?HTMLSelectElement} */
        this._allSelect = null;
        /** @type {number} */
        this._optionsRenderRequest = 0;
        /** @type {number} */
        this._allSelectRefreshRequest = 0;
    }

    /** */
    async prepare() {
        await this._onDatabaseUpdated();

        this._settingsController.application.on('databaseUpdated', this._onDatabaseUpdated.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        // Event payload is not the internal database refresh token.
        this._settingsController.on('dictionarySettingsReordered', this._onDictionarySettingsReordered.bind(this, null));
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

            this._dictionaryInfoMap.clear();
            for (const entry of dictionaries) {
                this._dictionaryInfoMap.set(entry.title, entry);
            }

            await this._onDictionarySettingsReordered(token);
            if (this._getDictionaryInfoToken !== token) { return; }
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
        // An options event supersedes any older asynchronous settings snapshot.
        ++this._optionsRenderRequest;
        ++this._allSelectRefreshRequest;
        this._eventListeners.removeAllEventListeners();
        this._selects = [];

        const fragment = document.createDocumentFragment();

        this._setupAllSelect(fragment, options);

        const {dictionaries} = options;
        for (let i = 0, ii = dictionaries.length; i < ii; ++i) {
            const {name} = dictionaries[i];
            const dictionaryInfo = this._dictionaryInfoMap.get(name);
            if (!dictionaryInfo?.counts?.terms?.total && !dictionaryInfo?.counts?.kanji?.total) {
                continue;
            }
            if (typeof dictionaryInfo === 'undefined') { continue; }

            const select = this._addSelect(fragment, name, `rev.${dictionaryInfo.revision}`);
            select.dataset.setting = `dictionaries[${i}].definitionsCollapsible`;
            this._eventListeners.addEventListener(select, 'settingChanged', this._onDefinitionsCollapsibleChange.bind(this), false);

            this._selects.push(select);
        }

        const container = /** @type {HTMLElement} */ (this._container);
        container.textContent = '';
        container.appendChild(fragment);
    }

    /** */
    _onDefinitionsCollapsibleChange() {
        void this._updateAllSelectFresh().catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {Event} e
     */
    _onAllSelectChange(e) {
        const {value} = /** @type {HTMLSelectElement} */ (e.currentTarget);
        const value2 = this._normalizeDictionaryDefinitionsCollapsible(value);
        if (value2 === null) { return; }
        void this._setDefinitionsCollapsibleAll(value2).catch((error) => {
            log.error(error);
            // Reconcile the all-selector with persisted settings after failure.
            void this._updateAllSelectFresh().catch((refreshError) => {
                log.error(refreshError);
            });
        });
    }

    /** */
    /**
     * @param {import('core').TokenObject|null|import('settings-controller').EventArgument<'dictionarySettingsReordered'>} [token]
     */
    async _onDictionarySettingsReordered(token = null) {
        const request = ++this._optionsRenderRequest;
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (
            request !== this._optionsRenderRequest ||
            (token !== null && this._getDictionaryInfoToken !== token) ||
            this._settingsController.getOptionsContext().index !== optionsContext.index
        ) {
            return;
        }
        this._onOptionsChanged({options, optionsContext});
    }

    /**
     * @param {DocumentFragment} fragment
     * @param {import('settings').ProfileOptions} options
     */
    _setupAllSelect(fragment, options) {
        const select = this._addSelect(fragment, 'All', '');

        const option = document.createElement('option');
        option.value = 'varies';
        option.textContent = 'Varies';
        option.disabled = true;
        select.appendChild(option);

        this._eventListeners.addEventListener(select, 'change', this._onAllSelectChange.bind(this), false);

        this._allSelect = select;
        this._updateAllSelect(options);
    }

    /**
     * @param {DocumentFragment} fragment
     * @param {string} dictionary
     * @param {string} version
     * @returns {HTMLSelectElement}
     */
    _addSelect(fragment, dictionary, version) {
        const node = this._settingsController.instantiateTemplate('collapsible-dictionary-item');
        fragment.appendChild(node);

        /** @type {HTMLElement} */
        const nameNode = querySelectorNotNull(node, '.dictionary-title');
        nameNode.textContent = dictionary;

        /** @type {HTMLElement} */
        const versionNode = querySelectorNotNull(node, '.dictionary-revision');
        versionNode.textContent = version;

        return querySelectorNotNull(node, '.definitions-collapsible');
    }

    /** */
    async _updateAllSelectFresh() {
        const request = ++this._allSelectRefreshRequest;
        const select = this._allSelect;
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (
            request !== this._allSelectRefreshRequest ||
            this._allSelect !== select ||
            this._settingsController.getOptionsContext().index !== optionsContext.index
        ) {
            return;
        }
        this._updateAllSelect(options);
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    _updateAllSelect(options) {
        let value = null;
        let varies = false;
        for (const {definitionsCollapsible} of options.dictionaries) {
            if (value === null) {
                value = definitionsCollapsible;
            } else if (value !== definitionsCollapsible) {
                varies = true;
                break;
            }
        }

        if (this._allSelect !== null) {
            this._allSelect.value = (varies || value === null ? 'varies' : value);
        }
    }

    /**
     * @param {import('settings').DictionaryDefinitionsCollapsible} value
     */
    async _setDefinitionsCollapsibleAll(value) {
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (this._settingsController.getOptionsContext().index !== optionsContext.index) { return; }
        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        const {dictionaries} = options;
        for (let i = 0, ii = dictionaries.length; i < ii; ++i) {
            const path = `dictionaries[${i}].definitionsCollapsible`;
            targets.push({action: 'set', path, value});
        }
        const selects = this._selects;
        try {
            await this._settingsController.modifyProfileSettings(targets);
        } catch (error) {
            if (this._selects === selects && this._settingsController.getOptionsContext().index === optionsContext.index) {
                this._updateAllSelect(options);
            }
            throw error;
        }
        // A profile change or options rerender can replace these controls while
        // the mutation is in flight. Never update the new controls with old state.
        if (
            this._settingsController.getOptionsContext().index !== optionsContext.index ||
            this._selects !== selects
        ) {
            return;
        }
        for (const select of selects) {
            select.value = value;
        }
    }

    /**
     * @param {string} value
     * @returns {?import('settings').DictionaryDefinitionsCollapsible}
     */
    _normalizeDictionaryDefinitionsCollapsible(value) {
        switch (value) {
            case 'not-collapsible':
            case 'expanded':
            case 'collapsed':
            case 'force-collapsed':
            case 'force-expanded':
                return value;
            default:
                return null;
        }
    }
}
