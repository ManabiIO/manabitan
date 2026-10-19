/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import * as ajvSchemas0 from '../../../lib/validate-schemas.js';
import {reportDiagnostics} from '../../core/diagnostics-reporter.js';
import {EventListenerCollection} from '../../core/event-listener-collection.js';
import {ExtensionError} from '../../core/extension-error.js';
import {parseJson, readResponseJson} from '../../core/json.js';
import {log} from '../../core/log.js';
import {deferPromise, promiseTimeout} from '../../core/utilities.js';
import {compareRevisions} from '../../dictionary/dictionary-data-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {bindDictionaryRowOwnership, createDictionaryRowOwnership, getDictionaryRowOwnership} from './dictionary-row-ownership.js';

const ajvSchemas = /** @type {import('dictionary-importer').CompiledSchemaValidators} */ (/** @type {unknown} */ (ajvSchemas0));
const TRANSIENT_UPDATE_TITLE_PATTERN = /\[(?:update-staging|cutover|replaced) [^\]]+\]/;
const DICTIONARY_UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** @type {WeakMap<HTMLElement, number>} */
const dictionaryModalGenerationByNode = new WeakMap();
let nextDictionaryModalGeneration = 0;
const MUTATION_CALLBACK_TIMEOUT_MS = 180_000;

/**
 * @param {unknown} downloadUrl
 * @returns {string|undefined}
 */
function normalizeOptionalDownloadUrl(downloadUrl) {
    return (
        typeof downloadUrl === 'string' &&
        downloadUrl.length > 0 &&
        downloadUrl !== 'undefined'
    ) ?
downloadUrl :
void 0;
}

/**
 * @param {import('settings').ProfileOptions} profileOptions
 * @param {string} dictionaryTitle
 * @returns {boolean}
 */
function profileReferencesDictionary(profileOptions, dictionaryTitle) {
    const {general, dictionaries} = profileOptions;
    return (
        dictionaries.some((dict) => dict.name === dictionaryTitle) ||
        general.mainDictionary === dictionaryTitle ||
        general.sortFrequencyDictionary === dictionaryTitle
    );
}

/**
 * @param {Response | undefined} response
 */
function cancelResponseBody(response) {
    try {
        const cancellation = response?.body?.cancel();
        if (typeof cancellation !== 'undefined') { void cancellation.catch(() => {}); }
    } catch {
        // A response body can already be locked by response.json().
    }
}

class DictionaryEntry {
    /**
     * @param {DictionaryController} dictionaryController
     * @param {DocumentFragment} fragment
     * @param {number} index
     * @param {string} profileId
     * @param {import('settings').DictionaryOptions} dictionarySettings
     * @param {import('dictionary-importer').Summary} dictionaryInfo
     * @param {string | null} updateDownloadUrl
     * @param {import('dictionary-database').DictionaryCountGroup|null} dictionaryDatabaseCounts
     */
    constructor(dictionaryController, fragment, index, profileId, dictionarySettings, dictionaryInfo, updateDownloadUrl, dictionaryDatabaseCounts) {
        /** @type {DictionaryController} */
        this._dictionaryController = dictionaryController;
        /** @type {number} */
        this._index = index;
        /** @type {string} */
        this._profileId = profileId;
        /** @type {import('dictionary-importer').Summary} */
        this._dictionaryInfo = dictionaryInfo;
        /** @type {string | null} */
        this._updateDownloadUrl = updateDownloadUrl;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {?import('dictionary-database').DictionaryCountGroup} */
        this._databaseCounts = dictionaryDatabaseCounts;
        /** @type {ChildNode[]} */
        this._nodes = [...fragment.childNodes];
        /** @type {HTMLInputElement} */
        this._enabledCheckbox = querySelectorNotNull(fragment, '.dictionary-enabled');
        /** @type {HTMLButtonElement} */
        this._upButton = querySelectorNotNull(fragment, '#dictionary-move-up');
        /** @type {HTMLButtonElement} */
        this._downButton = querySelectorNotNull(fragment, '#dictionary-move-down');
        /** @type {HTMLButtonElement} */
        this._menuButton = querySelectorNotNull(fragment, '.dictionary-menu-button');
        /** @type {HTMLButtonElement} */
        this._outdatedButton = querySelectorNotNull(fragment, '.dictionary-outdated-button');
        /** @type {HTMLButtonElement} */
        this._integrityButtonCheck = querySelectorNotNull(fragment, '.dictionary-integrity-button-check');
        /** @type {HTMLButtonElement} */
        this._integrityButtonWarning = querySelectorNotNull(fragment, '.dictionary-integrity-button-warning');
        /** @type {HTMLButtonElement} */
        this._integrityButtonError = querySelectorNotNull(fragment, '.dictionary-integrity-button-error');
        /** @type {HTMLButtonElement} */
        this._updatesAvailable = querySelectorNotNull(fragment, '.dictionary-update-available');
        /** @type {HTMLElement} */
        this._aliasNode = querySelectorNotNull(fragment, '.dictionary-alias');
        /** @type {import('generic-setting-controller').DictionaryRowOwnership} */
        this._rowOwnership = createDictionaryRowOwnership(this._aliasNode, profileId, index, dictionarySettings, 'main');
        /** @type {HTMLElement} */
        this._versionNode = querySelectorNotNull(fragment, '.dictionary-revision');
        /** @type {HTMLElement} */
        this._titleContainer = querySelectorNotNull(fragment, '.dictionary-item-title-container');
        /** @type {number} */
        this._updateCheckGeneration = 0;
        /** @type {AbortController | null} */
        this._updateCheckAbortController = null;
    }

    /** @type {string} */
    get dictionaryTitle() {
        return this._dictionaryInfo.title;
    }

    /**
     * @param {unknown} value
     * @returns {boolean}
     */
    matchesSettingsSnapshot(value) {
        return JSON.stringify(this._rowOwnership.expectedEntry) === JSON.stringify(value);
    }

    /** @returns {number} */
    get settingsIndex() { return this._index; }
    /** @returns {string} */
    get settingsProfileId() { return this._profileId; }

    /** */
    prepare() {
        //
        const {revision, version, importSuccess, storageHealth} = this._dictionaryInfo;

        this._setDictionarySetting(this._aliasNode, 'alias');
        this._versionNode.textContent = `rev.${revision}`;
        this._outdatedButton.hidden = (version >= 3);
        this._setDictionarySetting(this._enabledCheckbox, 'enabled');
        this.showUpdatesAvailableButton();
        this._eventListeners.addEventListener(this._enabledCheckbox, 'settingChanged', this._onEnabledChanged.bind(this), false);
        this._eventListeners.addEventListener(this._menuButton, 'menuOpen', this._onMenuOpen.bind(this), false);
        this._eventListeners.addEventListener(this._menuButton, 'menuClose', this._onMenuClose.bind(this), false);
        this._eventListeners.addEventListener(this._upButton, 'click', (() => { void this._move(-1); }).bind(this), false);
        this._eventListeners.addEventListener(this._downButton, 'click', (() => { void this._move(1); }).bind(this), false);
        this._eventListeners.addEventListener(this._outdatedButton, 'click', this._onOutdatedButtonClick.bind(this), false);
        this._eventListeners.addEventListener(this._integrityButtonCheck, 'click', this._onIntegrityButtonClick.bind(this), false);
        this._eventListeners.addEventListener(this._integrityButtonWarning, 'click', this._onIntegrityButtonClick.bind(this), false);
        this._eventListeners.addEventListener(this._integrityButtonError, 'click', this._onIntegrityButtonClick.bind(this), false);
        this._eventListeners.addEventListener(this._updatesAvailable, 'click', this._onUpdateButtonClick.bind(this), false);

        if (importSuccess === false || storageHealth === 'reimportRequired') {
            this._integrityButtonError.hidden = false;
            this._integrityButtonError.title = storageHealth === 'reimportRequired' ? 'Re-import required' : 'Dictionary may not have been imported properly';
        } else if (storageHealth === 'repairPending' || storageHealth === 'repairing' || storageHealth === 'temporarilyUnavailable') {
            this._integrityButtonWarning.hidden = false;
            this._integrityButtonWarning.title = storageHealth === 'repairPending' ?
                'Lookup index repair pending; dictionary lookup remains available' :
                'Dictionary lookup data is temporarily unavailable';
        }

        this.setCounts(this._databaseCounts);
    }

    /** */
    cleanup() {
        this._cancelUpdateCheck();
        this._eventListeners.removeAllEventListeners();
        for (const node of this._nodes) {
            if (node.parentNode !== null) {
                node.parentNode.removeChild(node);
            }
        }
        this._nodes = [];
    }

    /**
     * @param {import('dictionary-database').DictionaryCountGroup?} databaseCounts
     */
    setCounts(databaseCounts) {
        if (!databaseCounts) {
            return;
        }
        this._databaseCounts = databaseCounts;
        let countsMismatch = false;

        if (!this._dictionaryInfo.counts) {
            log.warn('Check Integrity count not compare dictionary counts of ' + this._dictionaryInfo.title);
            return;
        }

        for (const value of Object.values(this._zipCounts(databaseCounts, this._dictionaryInfo.counts))) {
            if (value[0] !== value[1]) {
                countsMismatch = true;
            }
        }

        if (
            this._dictionaryInfo.storageHealth === 'repairPending' ||
            this._dictionaryInfo.storageHealth === 'repairing' ||
            this._dictionaryInfo.storageHealth === 'temporarilyUnavailable'
        ) {
            this._integrityButtonWarning.hidden = false;
            this._integrityButtonCheck.hidden = true;
        } else if (this._integrityButtonError.hidden) {
            this._integrityButtonWarning.hidden = !countsMismatch;
            this._integrityButtonCheck.hidden = countsMismatch;
        }
    }

    /**
     * @returns {import('dictionary-database').DictionaryCountGroup | null}
     */
    get databaseCounts() {
        return this._databaseCounts;
    }

    /**
     * @param {boolean} value
     */
    setEnabled(value) {
        this._enabledCheckbox.checked = value;
    }

    /** */
    hideUpdatesAvailableButton() {
        this._updatesAvailable.hidden = true;
        delete this._updatesAvailable.dataset.downloadUrl;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async checkForUpdate() {
        this._cancelUpdateCheck();
        const generation = this._updateCheckGeneration;
        const abortController = new AbortController();
        this._updateCheckAbortController = abortController;
        this.hideUpdatesAvailableButton();
        this._updateDownloadUrl = null;
        const {isUpdatable, indexUrl, revision: currentRevision, downloadUrl: currentDownloadUrl} = this._dictionaryInfo;
        if (!isUpdatable || !indexUrl || !currentDownloadUrl) {
            this._updateCheckAbortController = null;
            return false;
        }

        /** @type {Response | undefined} */
        let response;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timeout;
        /** @type {() => void} */
        let rejectDeadline = () => {};
        const deadline = new Promise((_, reject) => {
            rejectDeadline = () => reject(new Error(`Dictionary update check timed out after ${DICTIONARY_UPDATE_CHECK_TIMEOUT_MS}ms`));
            timeout = setTimeout(() => {
                if (this._updateCheckGeneration === generation) {
                    this._updateCheckGeneration++;
                    this._updateCheckAbortController = null;
                }
                abortController.abort();
                cancelResponseBody(response);
                rejectDeadline();
            }, DICTIONARY_UPDATE_CHECK_TIMEOUT_MS);
        });

        const check = async () => {
            response = await fetch(indexUrl, {signal: abortController.signal});
            if (this._updateCheckGeneration !== generation || abortController.signal.aborted) {
                cancelResponseBody(response);
                throw new Error('Dictionary update check was cancelled');
            }
            if (!response.ok) {
                cancelResponseBody(response);
                throw new Error(`Failed to fetch dictionary index: ${response.status}`);
            }

            /** @type {unknown} */
            const index = await readResponseJson(response);
            if (this._updateCheckGeneration !== generation || abortController.signal.aborted) {
                throw new Error('Dictionary update check was cancelled');
            }

            if (!ajvSchemas.dictionaryIndex(index)) {
                throw new Error('Invalid dictionary index');
            }

            const validIndex = /** @type {import('dictionary-data').Index} */ (index);
            const {revision: latestRevision, downloadUrl: latestDownloadUrl} = validIndex;

            if (!compareRevisions(currentRevision, latestRevision)) {
                return false;
            }

            const downloadUrl = latestDownloadUrl ?? currentDownloadUrl;

            this._updateDownloadUrl = downloadUrl;
            this.showUpdatesAvailableButton();
            return true;
        };

        try {
            return await Promise.race([check(), deadline]);
        } finally {
            clearTimeout(timeout);
            if (this._updateCheckGeneration === generation) { this._updateCheckAbortController = null; }
        }
    }

    /** */
    _cancelUpdateCheck() {
        this._updateCheckGeneration++;
        const abortController = this._updateCheckAbortController;
        this._updateCheckAbortController = null;
        if (abortController !== null && !abortController.signal.aborted) { abortController.abort(); }
    }

    /**
     * @returns {string | null}
     */
    get updateDownloadUrl() {
        return this._updateDownloadUrl;
    }

    /**
     * @param {string} alias
     */
    updateAliasSettings(alias) {
        this._aliasNode.textContent = alias;
        this._aliasNode.dispatchEvent(new CustomEvent('change', {bubbles: true}));
    }

    // Private

    /** */
    showUpdatesAvailableButton() {
        if (this._updateDownloadUrl === null || this._dictionaryController.isDictionaryInTaskQueue(this.dictionaryTitle)) {
            return;
        }
        this._updatesAvailable.dataset.downloadUrl = this._updateDownloadUrl;
        this._updatesAvailable.hidden = false;
    }

    /**
     * @param {import('popup-menu').MenuOpenEvent} e
     */
    _onMenuOpen(e) {
        const bodyNode = e.detail.menu.bodyNode;
        const count = this._dictionaryController.dictionaryOptionCount;
        this._setMenuActionEnabled(bodyNode, 'moveTo', count > 1);
        const deleteDisabled = this._dictionaryController.isDictionaryInTaskQueue(this.dictionaryTitle);
        this._setMenuActionEnabled(bodyNode, 'delete', !deleteDisabled);
    }

    /**
     * @param {import('popup-menu').MenuCloseEvent} e
     */
    _onMenuClose(e) {
        switch (e.detail.action) {
            case 'delete':
                this._delete();
                break;
            case 'showDetails':
                this._showDetails();
                break;
            case 'moveTo':
                void this._showMoveToModal();
                break;
            case 'rename':
                void this._showRenameModal();
                break;
        }
    }

    /**
     * @param {import('dictionary-database').DictionaryCountGroup} databaseCounts
     * @param {import('dictionary-importer').SummaryCounts} summaryCounts
     * @returns {Record<string, [number, number]>}
     */
    _zipCounts(databaseCounts, summaryCounts) {
        return {
            terms: [databaseCounts.terms, summaryCounts?.terms?.total],
            termMeta: [databaseCounts.termMeta, summaryCounts?.termMeta?.total],
            kanji: [databaseCounts.kanji, summaryCounts?.kanji?.total],
            kanjiMeta: [databaseCounts.kanjiMeta, summaryCounts?.kanjiMeta?.total],
            tagMeta: [databaseCounts.tagMeta, summaryCounts?.tagMeta?.total],
            media: [databaseCounts.media, summaryCounts?.media?.total],
        };
    }

    /**
     * @param {import('dom-data-binder').SettingChangedEvent} e
     */
    _onEnabledChanged(e) {
        const {detail: {value}} = e;
        this._titleContainer.dataset.enabled = `${value}`;
        void this._dictionaryController.updateDictionariesEnabled();
    }

    /** */
    _onOutdatedButtonClick() {
        this._showDetails();
    }

    /** */
    _onUpdateButtonClick() {
        this._dictionaryController.updateDictionary(
            this.dictionaryTitle,
            normalizeOptionalDownloadUrl(this._updatesAvailable.dataset.downloadUrl),
        );
    }

    /** */
    _onIntegrityButtonClick() {
        this._showDetails();
    }

    /** */
    _showDetails() {
        const {title, revision, version, counts, prefixWildcardsSupported, storageHealth} = this._dictionaryInfo;

        const modal = this._dictionaryController.modalController.getModal('dictionary-details');
        if (modal === null) { return; }

        /** @type {HTMLElement} */
        const titleElement = querySelectorNotNull(modal.node, '.dictionary-title');
        /** @type {HTMLElement} */
        const versionElement = querySelectorNotNull(modal.node, '.dictionary-revision');
        /** @type {HTMLElement} */
        const outdateElement = querySelectorNotNull(modal.node, '.dictionary-outdated-notification');
        /** @type {HTMLElement} */
        const storageErrorElement = querySelectorNotNull(modal.node, '.dictionary-storage-error-notification');
        /** @type {HTMLButtonElement} */
        const reimportButton = querySelectorNotNull(modal.node, '.dictionary-reimport-button');
        /** @type {HTMLInputElement} */
        const wildcardSupportedElement = querySelectorNotNull(modal.node, '.dictionary-prefix-wildcard-searches-supported');
        /** @type {HTMLElement} */
        const detailsTableElement = querySelectorNotNull(modal.node, '.dictionary-details-table');
        /** @type {HTMLElement} */
        const partsOfSpeechFilterSetting = querySelectorNotNull(modal.node, '.dictionary-parts-of-speech-filter-setting');
        /** @type {HTMLElement} */
        const partsOfSpeechFilterToggle = querySelectorNotNull(partsOfSpeechFilterSetting, '.dictionary-parts-of-speech-filter-toggle');
        /** @type {HTMLElement} */
        const useDeinflectionsSetting = querySelectorNotNull(modal.node, '.dictionary-use-deinflections-setting');
        /** @type {HTMLElement} */
        const useDeinflectionsToggle = querySelectorNotNull(useDeinflectionsSetting, '.dictionary-use-deinflections-toggle');

        titleElement.textContent = title;
        versionElement.textContent = `rev.${revision}`;
        outdateElement.hidden = (version >= 3);
        storageErrorElement.hidden = storageHealth !== 'reimportRequired';
        reimportButton.hidden = storageHealth !== 'reimportRequired';
        reimportButton.onclick = null;
        if (storageHealth === 'reimportRequired') {
            const downloadUrl = normalizeOptionalDownloadUrl(this._updateDownloadUrl) ?? normalizeOptionalDownloadUrl(this._dictionaryInfo.downloadUrl);
            const hasDownloadUrl = typeof downloadUrl === 'string';
            reimportButton.textContent = hasDownloadUrl ? 'Download again' : 'Choose file...';
            reimportButton.onclick = () => {
                modal.setVisible(false);
                if (hasDownloadUrl) {
                    this._dictionaryController.updateDictionary(title, downloadUrl);
                } else {
                    this._dictionaryController.reimportDictionaryFromFile(title);
                }
            };
        }
        wildcardSupportedElement.checked = prefixWildcardsSupported;
        partsOfSpeechFilterSetting.hidden = !counts?.terms.total;
        useDeinflectionsSetting.hidden = !counts?.terms.total;
        this._setDictionarySetting(partsOfSpeechFilterToggle, 'partsOfSpeechFilter');
        this._setDictionarySetting(useDeinflectionsToggle, 'useDeinflections');

        this._setupDetails(detailsTableElement);

        modal.setVisible(true);
    }

    /**
     * @param {Element} detailsTable
     * @returns {boolean}
     */
    _setupDetails(detailsTable) {
        /** @type {Partial<Record<keyof (typeof this._dictionaryInfo & typeof this._dictionaryInfo.counts), string>>} */
        const targets = {
            author: 'Author',
            url: 'URL',
            description: 'Description',
            attribution: 'Attribution',
            sourceLanguage: 'Source Language',
            targetLanguage: 'Target Language',
            terms: 'Term Count',
            termMeta: 'Term Meta Count',
            kanji: 'Kanji Count',
            kanjiMeta: 'Kanji Meta Count',
            tagMeta: 'Tag Count',
            media: 'Media Count',
            frequencyMode: 'Frequency Mode',
            prefixWildcardsSupported: 'Prefix Wildcards Enabled',
            importSuccess: 'Import Success',
            storageHealth: 'Storage',
        };

        const dictionaryInfo = {...this._dictionaryInfo, ...this._dictionaryInfo.counts};
        const fragment = document.createDocumentFragment();
        let any = false;
        for (const [key, label] of /** @type {([keyof (typeof this._dictionaryInfo & typeof this._dictionaryInfo.counts), string])[]} */ (Object.entries(targets))) {
            const info = dictionaryInfo[key];
            let displayText = ((value) => {
                if (typeof value === 'string') {
                    if (key === 'storageHealth') {
                        return {
                            available: 'Available',
                            repairing: 'Repairing',
                            temporarilyUnavailable: 'Temporarily unavailable',
                            reimportRequired: 'Re-import required',
                        }[value] ?? value;
                    }
                    return value;
                }
                if (value && typeof value === 'object' && 'total' in value) {
                    return value.total ? `${value.total}` : false;
                }
                if (typeof value === 'boolean') { return value.toString(); }
                return false;
            })(info);
            if (!displayText) { continue; }

            const details = /** @type {HTMLElement} */ (this._dictionaryController.instantiateTemplate('dictionary-details-entry'));
            details.dataset.type = key;

            /** @type {HTMLElement} */
            const labelElement = querySelectorNotNull(details, '.dictionary-details-entry-label');
            /** @type {HTMLElement} */
            const infoElement = querySelectorNotNull(details, '.dictionary-details-entry-info');

            labelElement.textContent = `${label}:`;
            if (this._databaseCounts && this._databaseCounts[key]) {
                displayText = 'Expected: ' + displayText + ' (Database: ' + this._databaseCounts[key] + ')';
            }
            infoElement.textContent = displayText;
            fragment.appendChild(details);

            any = true;
        }

        detailsTable.textContent = '';
        detailsTable.appendChild(fragment);
        return any;
    }

    /** */
    _delete() {
        void this._dictionaryController.deleteDictionary(this.dictionaryTitle);
    }

    /**
     * @param {number} offset
     */
    async _move(offset) {
        // eslint-disable-next-line no-underscore-dangle
        const settingsController = this._dictionaryController._settingsController;
        const optionsContext = settingsController.getOptionsContext();
        const options = await settingsController.getOptions();
        if (
            settingsController.getOptionsContext().profileId !== optionsContext.profileId ||
            optionsContext.profileId !== this._profileId ||
            !this.matchesSettingsSnapshot(options.dictionaries[this._index])
        ) { return; }
        void this._dictionaryController.moveDictionaryOptions(this._index, this._index + offset, this._profileId, options.dictionaries);
    }

    /**
     * @param {HTMLElement} element
     * @param {import('settings-modifications').ModificationSetDictionaryField['field']} field
     */
    _setDictionarySetting(element, field) {
        element.dataset.setting = `dictionaries[${this._index}].${field}`;
        bindDictionaryRowOwnership(element, this._rowOwnership);
    }

    /**
     * @param {Element} menu
     * @param {string} action
     * @param {boolean} enabled
     */
    _setMenuActionEnabled(menu, action, enabled) {
        const element = /** @type {?HTMLButtonElement} */ (menu.querySelector(`[data-menu-action="${action}"]`));
        if (element === null) { return; }
        element.disabled = !enabled;
    }

    /** */
    async _showMoveToModal() {
        const {title} = this._dictionaryInfo;
        const count = this._dictionaryController.dictionaryOptionCount;
        const modal = this._dictionaryController.modalController.getModal('dictionary-move-location');
        if (modal === null) { return; }
        // eslint-disable-next-line no-underscore-dangle
        const settingsController = this._dictionaryController._settingsController;
        const optionsContext = settingsController.getOptionsContext();
        const options = await settingsController.getOptions();
        if (
            settingsController.getOptionsContext().profileId !== optionsContext.profileId ||
            optionsContext.profileId !== this._profileId ||
            !this.matchesSettingsSnapshot(options.dictionaries[this._index])
        ) { return; }
        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(modal.node, '#dictionary-move-location');
        /** @type {HTMLElement} */
        const titleNode = querySelectorNotNull(modal.node, '.dictionary-title');

        this._setModalDictionaryRow(modal.node);
        modal.node.dataset.index = `${this._index}`;
        modal.node.dataset.dictionaryOrderSnapshot = JSON.stringify(options.dictionaries);
        titleNode.textContent = title;
        input.value = `${this._index + 1}`;
        input.max = `${count}`;

        modal.setVisible(true);
    }

    /** */
    _showRenameModal() {
        const {title} = this._dictionaryInfo;
        const modal = this._dictionaryController.modalController.getModal('dictionary-set-alias');
        if (modal === null) { return; }
        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(modal.node, '#dictionary-alias-input');
        /** @type {HTMLElement} */
        const titleNode = querySelectorNotNull(modal.node, '.dictionary-title');

        this._setModalDictionaryRow(modal.node);
        modal.node.dataset.index = `${this._index}`;
        titleNode.textContent = title;
        input.value = this._aliasNode.textContent || title;

        modal.setVisible(true);
    }

    /**
     * @param {HTMLElement} modalNode
     */
    _setModalDictionaryRow(modalNode) {
        bindDictionaryRowOwnership(modalNode, this._rowOwnership);
        dictionaryModalGenerationByNode.set(modalNode, ++nextDictionaryModalGeneration);
        modalNode.dataset.dictionaryRowProfileId = this._profileId;
        modalNode.dataset.dictionaryTitle = this.dictionaryTitle;
    }
}

class DictionaryExtraInfo {
    /**
     * @param {DictionaryController} dictionaryController
     * @param {import('dictionary-database').DictionaryCountGroup} totalCounts
     * @param {import('dictionary-database').DictionaryCountGroup} remainders
     * @param {number} totalRemainder
     */
    constructor(dictionaryController, totalCounts, remainders, totalRemainder) {
        /** @type {DictionaryController} */
        this._dictionaryController = dictionaryController;
        /** @type {import('dictionary-database').DictionaryCountGroup} */
        this._totalCounts = totalCounts;
        /** @type {import('dictionary-database').DictionaryCountGroup} */
        this._remainders = remainders;
        /** @type {number} */
        this._totalRemainder = totalRemainder;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {ChildNode[]} */
        this._nodes = [];
    }

    /**
     * @param {HTMLElement} container
     */
    prepare(container) {
        const fragment = this._dictionaryController.instantiateTemplateFragment('dictionary-extra');
        for (const node of fragment.childNodes) {
            this._nodes.push(node);
        }

        /** @type {HTMLButtonElement} */
        const dictionaryIntegrityButton = querySelectorNotNull(fragment, '.dictionary-integrity-button-warning');

        const titleNode = fragment.querySelector('.dictionary-total-count');
        this._setTitle(titleNode);
        this._eventListeners.addEventListener(dictionaryIntegrityButton, 'click', this._onIntegrityButtonClick.bind(this), false);

        container.appendChild(fragment);
    }

    /** */
    cleanup() {
        this._eventListeners.removeAllEventListeners();
        for (const node of this._nodes) {
            if (node.parentNode !== null) {
                node.parentNode.removeChild(node);
            }
        }
        this._nodes.length = 0;
    }

    // Private

    /** */
    _onIntegrityButtonClick() {
        this._showDetails();
    }

    /** */
    _showDetails() {
        const modal = this._dictionaryController.modalController.getModal('dictionary-extra-data');
        if (modal === null) { return; }

        const titleNode = modal.node.querySelector('.dictionary-total-count');
        this._setTitle(titleNode);

        /** @type {HTMLElement} */
        const detailsTableElement = querySelectorNotNull(modal.node, '.dictionary-details-table');
        this._setupDetails(detailsTableElement);

        modal.setVisible(true);
    }

    /**
     * @param {Element} detailsTable
     * @returns {boolean}
     */
    _setupDetails(detailsTable) {
        /** @type {Partial<Record<keyof (typeof this._totalCounts), string>>} */
        const targets = {
            terms: 'Term Count',
            termMeta: 'Term Meta Count',
            kanji: 'Kanji Count',
            kanjiMeta: 'Kanji Meta Count',
            tagMeta: 'Tag Count',
            media: 'Media Count',
        };

        const fragment = document.createDocumentFragment();
        let any = false;
        for (const [key, label] of (Object.entries(targets))) {
            if (!this._remainders[key]) {
                continue;
            }
            const details = /** @type {HTMLElement} */ (this._dictionaryController.instantiateTemplate('dictionary-details-entry'));
            details.dataset.type = key;

            /** @type {HTMLElement} */
            const labelElement = querySelectorNotNull(details, '.dictionary-details-entry-label');
            /** @type {HTMLElement} */
            const infoElement = querySelectorNotNull(details, '.dictionary-details-entry-info');

            labelElement.textContent = `${label}:`;
            infoElement.textContent = this._remainders[key].toString();
            fragment.appendChild(details);

            any = true;
        }

        detailsTable.textContent = '';
        detailsTable.appendChild(fragment);
        return any;
    }

    /**
     * @param {?Element} node
     */
    _setTitle(node) {
        if (node === null) { return; }
        node.textContent = `${this._totalRemainder} item${this._totalRemainder !== 1 ? 's' : ''}`;
    }
}

/** @type {WeakMap<import('./settings-controller.js').SettingsController, Promise<void>>} */
const dictionarySettingsReconciliations = new WeakMap();

export class DictionaryController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./modal-controller.js').ModalController} modalController
     * @param {import('./status-footer.js').StatusFooter} statusFooter
     */
    constructor(settingsController, modalController, statusFooter) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {HTMLElement} */
        this._dictionaryModalBody = querySelectorNotNull(document, '#dictionaries-modal-body');
        /** @type {import('./status-footer.js').StatusFooter} */
        this._statusFooter = statusFooter;
        /** @type {?import('dictionary-importer').Summary[]} */
        this._dictionaries = null;
        /** @type {DictionaryEntry[]} */
        this._dictionaryEntries = [];
        /** @type {?import('core').TokenObject} */
        this._databaseStateToken = null;
        /** @type {?import('core').TokenObject} */
        this._entriesUpdateToken = null;
        /** @type {?import('core').TokenObject} */
        this._dictionaryReorderToken = null;
        /** @type {boolean} */
        this._checkingUpdates = false;
        /** @type {boolean} */
        this._checkingIntegrity = false;
        /** @type {?HTMLButtonElement} */
        this._checkUpdatesButton = document.querySelector('#dictionary-check-updates');
        /** @type {?HTMLButtonElement} */
        this._checkIntegrityButton = document.querySelector('#dictionary-check-integrity');
        /** @type {HTMLElement} */
        this._dictionaryEntryContainer = querySelectorNotNull(document, '#dictionary-list');
        /** @type {?HTMLElement} */
        this._dictionaryInstallCountNode = document.querySelector('#dictionary-install-count');
        /** @type {?HTMLElement} */
        this._dictionaryEnabledCountNode = document.querySelector('#dictionary-enabled-count');
        /** @type {?NodeListOf<HTMLElement>} */
        this._noDictionariesInstalledWarnings = null;
        /** @type {?NodeListOf<HTMLElement>} */
        this._noDictionariesEnabledWarnings = null;
        /** @type {?import('./modal.js').Modal} */
        this._deleteDictionaryModal = null;
        /** @type {?import('./modal.js').Modal} */
        this._updateDictionaryModal = null;
        /** @type {HTMLInputElement} */
        this._allCheckbox = querySelectorNotNull(document, '#all-dictionaries-enabled');
        /** @type {?DictionaryExtraInfo} */
        this._extraInfo = null;
        /** @type {import('dictionary-controller.js').DictionaryTask[]} */
        this._dictionaryTaskQueue = [];
        /** @type {boolean} */
        this._isTaskQueueRunning = false;
        /** @type {(() => void) | null} */
        this._onDictionariesUpdate = null;
    }

    /** @type {import('./modal-controller.js').ModalController} */
    get modalController() {
        return this._modalController;
    }

    /** @type {number} */
    get dictionaryOptionCount() {
        return this._dictionaryEntries.length;
    }

    /** */
    async prepare() {
        this._noDictionariesInstalledWarnings = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.no-dictionaries-installed-warning'));
        this._noDictionariesEnabledWarnings = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.no-dictionaries-enabled-warning'));
        this._deleteDictionaryModal = this._modalController.getModal('dictionary-confirm-delete');
        this._updateDictionaryModal = this._modalController.getModal('dictionary-confirm-update');
        /** @type {HTMLButtonElement} */
        const dictionaryDeleteButton = querySelectorNotNull(document, '#dictionary-confirm-delete-button');
        /** @type {HTMLButtonElement} */
        const dictionaryUpdateButton = querySelectorNotNull(document, '#dictionary-confirm-update-button');

        /** @type {HTMLButtonElement} */
        const dictionaryMoveButton = querySelectorNotNull(document, '#dictionary-move-button');

        /** @type {HTMLButtonElement} */
        const dictionaryResetAliasButton = querySelectorNotNull(document, '#dictionary-reset-alias-button');
        /** @type {HTMLButtonElement} */
        const dictionarySetAliasButton = querySelectorNotNull(document, '#dictionary-set-alias-button');

        this._settingsController.application.on('databaseUpdated', this._onDatabaseUpdatedEvent.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._allCheckbox.addEventListener('change', this._onAllCheckboxChange.bind(this), false);
        dictionaryDeleteButton.addEventListener('click', this._onDictionaryConfirmDelete.bind(this), false);
        dictionaryUpdateButton.addEventListener('click', this._onDictionaryConfirmUpdate.bind(this), false);

        dictionaryMoveButton.addEventListener('click', this._onDictionaryMoveButtonClick.bind(this), false);

        dictionarySetAliasButton.addEventListener('click', this._onDictionarySetAliasButtonClick.bind(this), false);
        dictionaryResetAliasButton.addEventListener('click', this._onDictionaryResetAliasButtonClick.bind(this), false);

        if (this._checkUpdatesButton !== null) {
            this._checkUpdatesButton.addEventListener('click', this._onCheckUpdatesButtonClick.bind(this), false);
        }
        if (this._checkIntegrityButton !== null) {
            this._checkIntegrityButton.addEventListener('click', this._onCheckIntegrityButtonClick.bind(this), false);
        }

        this._updateDictionaryEntryCount();

        await this._onDatabaseUpdated();
    }

    /**
     * @param {string} dictionaryTitle
     */
    async deleteDictionary(dictionaryTitle) {
        const modal = /** @type {import('./modal.js').Modal} */ (this._deleteDictionaryModal);
        /** @type {HTMLElement | null} */
        const usedProfilesText = modal.node.querySelector('#dictionary-confirm-delete-used-profiles-text');
        /** @type {HTMLElement | null} */
        const usedProfilesList = modal.node.querySelector('#dictionary-confirm-delete-used-profiles');
        if (usedProfilesText === null || usedProfilesList === null) { return; }
        const usedProfileNames = await this.getProfileNamesUsingDictionary(dictionaryTitle);
        /** @type {Element} */
        const nameElement = querySelectorNotNull(modal.node, '#dictionary-confirm-delete-name');
        nameElement.textContent = dictionaryTitle;
        if (usedProfileNames.length > 0) {
            usedProfilesText.hidden = false;
            usedProfilesList.hidden = false;
            usedProfilesList.textContent = '';
            for (const profileName of usedProfileNames) {
                const li = document.createElement('li');
                li.textContent = profileName;
                usedProfilesList.appendChild(li);
            }
        } else {
            usedProfilesText.hidden = true;
            usedProfilesList.hidden = true;
        }
        modal.node.dataset.dictionaryTitle = dictionaryTitle;
        modal.setVisible(true);
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<string[]>}
     */
    async getProfileNamesUsingDictionary(dictionaryTitle) {
        const options = await this._settingsController.getOptionsFull();
        const {profiles} = options;
        /** @type {string[]} */
        const profileNames = [];
        for (const profile of profiles) {
            if (profileReferencesDictionary(profile.options, dictionaryTitle)) {
                profileNames.push(profile.name);
            }
        }
        return profileNames;
    }

    /**
     * @param {string} dictionaryTitle
     * @param {string|undefined} downloadUrl
     */
    updateDictionary(dictionaryTitle, downloadUrl) {
        const modal = this._updateDictionaryModal;
        if (modal === null) { return; }
        /** @type {Element} */
        const nameElement = querySelectorNotNull(modal.node, '#dictionary-confirm-update-name');
        nameElement.textContent = dictionaryTitle;
        if (typeof downloadUrl === 'string') {
            modal.node.dataset.downloadUrl = downloadUrl;
        } else {
            delete modal.node.dataset.downloadUrl;
        }
        modal.node.dataset.dictionaryTitle = dictionaryTitle;
        modal.setVisible(true);
    }

    /**
     * @param {string} dictionaryTitle
     */
    reimportDictionaryFromFile(dictionaryTitle) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.zip,.mdx,.mdd,application/zip';
        fileInput.multiple = true;
        fileInput.addEventListener('change', () => {
            const files = fileInput.files === null ? [] : [...fileInput.files];
            if (files.length === 0) { return; }
            this._enqueueTask({type: 'replaceFromFiles', dictionaryTitle, files});
        }, {once: true});
        fileInput.click();
    }

    /**
     * @param {number} currentIndex
     * @param {number} targetIndex
     * @param {string|null} [capturedProfileId]
     * @param {import('settings').DictionaryOptions[]|null} [capturedEntries]
     */
    async moveDictionaryOptions(currentIndex, targetIndex, capturedProfileId = null, capturedEntries = null) {
        /** @type {import('core').TokenObject} */
        const reorderToken = {};
        this._dictionaryReorderToken = reorderToken;
        const optionsContext = this._settingsController.getOptionsContext();
        if (capturedProfileId !== null && optionsContext.profileId !== capturedProfileId) { return; }
        const options = capturedEntries === null ? await this._settingsController.getOptions() : null;
        if (this._dictionaryReorderToken !== reorderToken || this._settingsController.getOptionsContext().index !== optionsContext.index || this._settingsController.getOptionsContext().profileId !== optionsContext.profileId) { return; }
        const dictionaries = capturedEntries ?? /** @type {import('settings').ProfileOptions} */ (options).dictionaries;
        if (
            currentIndex < 0 || currentIndex >= dictionaries.length ||
            targetIndex < 0 || targetIndex >= dictionaries.length ||
            currentIndex === targetIndex
        ) {
            return;
        }

        const dictionaryNames = dictionaries.map(({name}) => name);
        const expectedEntries = dictionaries.map((dictionary) => structuredClone(dictionary));
        const results = await this._settingsController.modifyProfileSettings([{
            action: 'moveDictionary',
            path: 'dictionaries',
            currentIndex,
            targetIndex,
            expectedNames: dictionaryNames,
            expectedEntries,
        }]);
        if (this._dictionaryReorderToken !== reorderToken || this._settingsController.getOptionsContext().index !== optionsContext.index || this._settingsController.getOptionsContext().profileId !== optionsContext.profileId) { return; }
        if (results[0]?.error) {
            await this._settingsController.refresh();
            if (this._dictionaryReorderToken !== reorderToken || this._settingsController.getOptionsContext().index !== optionsContext.index || this._settingsController.getOptionsContext().profileId !== optionsContext.profileId) { return; }
            return;
        }

        // Options events during the write may have rendered an earlier snapshot.
        // Start a fresh committed read now so it includes those field changes.
        if (this._dictionaries === null) {
            /** @type {import('settings-controller').EventArgument<'dictionarySettingsReordered'>} */
            const event = {source: this};
            this._settingsController.trigger('dictionarySettingsReordered', event);
            return;
        }

        /** @type {import('core').TokenObject} */
        const renderToken = {};
        this._entriesUpdateToken = renderToken;
        const committedOptions = await this._settingsController.getOptions();
        if (
            this._dictionaryReorderToken !== reorderToken ||
            this._entriesUpdateToken !== renderToken ||
            this._settingsController.getOptionsContext().index !== optionsContext.index ||
            this._settingsController.getOptionsContext().profileId !== optionsContext.profileId
        ) { return; }

        /** @type {import('settings-controller').EventArgument<'dictionarySettingsReordered'>} */
        const event = {source: this};
        this._settingsController.trigger('dictionarySettingsReordered', event);
        if (this._entriesUpdateToken !== renderToken) { return; }
        this._updateCurrentEntries(committedOptions);
    }

    /**
     * @param {string} name
     * @returns {Element}
     */
    instantiateTemplate(name) {
        return this._settingsController.instantiateTemplate(name);
    }

    /**
     * @param {string} name
     * @returns {DocumentFragment}
     */
    instantiateTemplateFragment(name) {
        return this._settingsController.instantiateTemplateFragment(name);
    }

    /** */
    async updateDictionariesEnabled() {
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (this._settingsController.getOptionsContext().index !== optionsContext.index || this._settingsController.getOptionsContext().profileId !== optionsContext.profileId) { return; }
        this._updateDictionariesEnabledWarnings(options);
    }

    /**
     * @param {string} name
     * @param {boolean} enabled
     * @param {string} styles
     * @returns {import('settings').DictionaryOptions}
     */
    static createDefaultDictionarySettings(name, enabled, styles) {
        return {
            name,
            alias: name,
            enabled,
            allowSecondarySearches: false,
            definitionsCollapsible: 'not-collapsible',
            partsOfSpeechFilter: true,
            useDeinflections: true,
            styles: styles ?? '',
        };
    }

    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('dictionary-importer').Summary[]|undefined} dictionaries
     * @param {import('settings').Options|undefined} optionsFull
     * @param {boolean} modifyGlobalSettings
     * @param {boolean} newDictionariesEnabled
     */
    static async ensureDictionarySettings(settingsController, dictionaries, optionsFull, modifyGlobalSettings, newDictionariesEnabled) {
        const previous = dictionarySettingsReconciliations.get(settingsController) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(() => (
            DictionaryController.#ensureDictionarySettings(settingsController, dictionaries, optionsFull, modifyGlobalSettings, newDictionariesEnabled)
        ));
        dictionarySettingsReconciliations.set(settingsController, operation);
        try {
            await operation;
        } finally {
            if (dictionarySettingsReconciliations.get(settingsController) === operation) {
                dictionarySettingsReconciliations.delete(settingsController);
            }
        }
    }

    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('dictionary-importer').Summary[]|undefined} dictionaries
     * @param {import('settings').Options|undefined} optionsFull
     * @param {boolean} modifyGlobalSettings
     * @param {boolean} newDictionariesEnabled
     */
    static async #ensureDictionarySettings(settingsController, dictionaries, optionsFull, modifyGlobalSettings, newDictionariesEnabled) {
        if (typeof dictionaries === 'undefined') {
            dictionaries = await settingsController.getDictionaryInfo();
        }
        if (typeof optionsFull === 'undefined') {
            optionsFull = await settingsController.getOptionsFull();
        }

        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        const {profiles} = optionsFull;
        const installedDictionaryNames = new Set(dictionaries.map(({title}) => title));
        for (let i = 0, ii = profiles.length; i < ii; ++i) {
            const existingDictionaryNames = new Set();
            const dictionaryOptionsArray = profiles[i].options.dictionaries;
            const profileId = profiles[i].id;
            for (let j = dictionaryOptionsArray.length - 1; j >= 0; --j) {
                const {name} = dictionaryOptionsArray[j];
                if (installedDictionaryNames.has(name)) {
                    // Preserve distinct aliases and enablement flags for the
                    // same installed dictionary, including disabled entries.
                    existingDictionaryNames.add(name);
                } else {
                    dictionaryOptionsArray.splice(j, 1);
                    // Never write a stale whole-array snapshot: a concurrent
                    // import may have just enabled an entry in the backend.
                    targets.push({action: 'removeDictionaryByName', profileId, name});
                }
            }

            for (const {title, styles} of dictionaries) {
                if (existingDictionaryNames.has(title)) { continue; }
                const value = DictionaryController.createDefaultDictionarySettings(title, newDictionariesEnabled, styles);
                dictionaryOptionsArray.push(value);
                targets.push({action: 'ensureDictionary', profileId, item: value});
            }
        }

        if (modifyGlobalSettings && targets.length > 0) {
            const results = await settingsController.modifyGlobalSettings(targets);
            const errors = results.flatMap(({error}) => (typeof error === 'undefined' ? [] : [ExtensionError.deserialize(error)]));
            if (errors.length > 0) {
                throw new Error(errors.map((error) => error.message).join('; '));
            }
        }
    }

    // Private

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options}) {
        this._updateDictionariesEnabledWarnings(options);
        if (this._dictionaries !== null) {
            void this._refreshEntriesAfterOptionsChanged();
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async _refreshEntriesAfterOptionsChanged() {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._entriesUpdateToken = token;
        try {
            // The cached dictionary list can be older than an in-flight import.
            // Reconcile settings only after a databaseUpdated event supplies a
            // fresh list; an options-only refresh must remain render-only.
            await this._updateEntries(token, false);
        } catch (error) {
            log.error(error);
        }
    }

    /**
     * @param {import('application').EventArgument<'databaseUpdated'>} details
     * @returns {void}
     */
    _onDatabaseUpdatedEvent(details) {
        void this._onDatabaseUpdated(details);
    }

    /**
     * @param {import('application').EventArgument<'databaseUpdated'>|undefined} [_details]
     */
    async _onDatabaseUpdated(_details = void 0) {
        /** @type {?import('core').TokenObject} */
        const token = {};
        this._databaseStateToken = token;
        this._entriesUpdateToken = token;
        this._dictionaries = null;
        try {
            const dictionaries = await this._settingsController.getDictionaryInfo();
            if (this._databaseStateToken !== token) { return; }
            this._dictionaries = dictionaries;

            await this._updateEntries(token);
            if (this._databaseStateToken !== token || !this._isEntriesUpdateCurrent(token)) { return; }

            if (this._onDictionariesUpdate) {
                this._onDictionariesUpdate();
            }
        } catch (error) {
            if (this._databaseStateToken === token) {
                this._dictionaries = null;
            }
            log.error(error);
        }
    }

    /** */
    _onAllCheckboxChange() {
        const allCheckbox = /** @type {HTMLInputElement} */ (this._allCheckbox);
        const value = allCheckbox.checked;
        allCheckbox.checked = !value;
        void this._setAllDictionariesEnabled(value);
    }

    /**
     * @param {import('core').TokenObject|null} [token]
     * @param {boolean} [reconcileSettings]
     */
    async _updateEntries(token = null, reconcileSettings = true) {
        const dictionaries = this._dictionaries;
        if (dictionaries === null) { return; }
        this._updateMainDictionarySelectOptions(dictionaries);

        /** @type {Map<string, string | null>} */
        const dictionaryUpdateDownloadUrlMap = new Map();
        for (const entry of this._dictionaryEntries) {
            dictionaryUpdateDownloadUrlMap.set(entry.dictionaryTitle, entry.updateDownloadUrl);
            entry.cleanup();
        }
        this._dictionaryEntries = [];
        this._updateDictionaryEntryCount();

        if (this._dictionaryInstallCountNode !== null) {
            this._dictionaryInstallCountNode.textContent = `${dictionaries.length}`;
        }

        const hasDictionary = (dictionaries.length > 0);
        for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._noDictionariesInstalledWarnings)) {
            node.hidden = hasDictionary;
        }

        if (reconcileSettings) {
            await DictionaryController.ensureDictionarySettings(this._settingsController, dictionaries, void 0, true, false);
            if (token !== null && !this._isEntriesUpdateCurrent(token)) { return; }
        }

        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (
            (token !== null && !this._isEntriesUpdateCurrent(token)) ||
            this._settingsController.getOptionsContext().index !== optionsContext.index ||
            this._settingsController.getOptionsContext().profileId !== optionsContext.profileId
        ) { return; }
        this._updateDictionariesEnabledWarnings(options);

        /** @type {Map<string, import('dictionary-importer').Summary>} */
        const dictionaryInfoMap = new Map();
        for (const dictionary of dictionaries) {
            dictionaryInfoMap.set(dictionary.title, dictionary);
        }

        const dictionaryOptionsArray = options.dictionaries;
        for (let i = 0, ii = dictionaryOptionsArray.length; i < ii; ++i) {
            const {name} = dictionaryOptionsArray[i];
            const dictionaryInfo = dictionaryInfoMap.get(name);
            const updateDownloadUrl = dictionaryUpdateDownloadUrlMap.get(name) ?? null;
            if (typeof dictionaryInfo === 'undefined') { continue; }
            this._createDictionaryEntry(i, optionsContext.profileId ?? '', dictionaryOptionsArray[i], dictionaryInfo, updateDownloadUrl, null);
        }
    }

    /**
     * @param {import('core').TokenObject} token
     * @returns {boolean}
     */
    _isEntriesUpdateCurrent(token) {
        return this._entriesUpdateToken === token;
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    _updateCurrentEntries(options) {
        const dictionariesModalBodyScrollY = this._dictionaryModalBody.scrollTop;
        const dictionaries = this._dictionaries;
        if (dictionaries === null) { return; }
        this._entriesUpdateToken = {};
        /** @type {Map<string, string | null>} */
        const dictionaryUpdateDownloadUrlMap = new Map();
        /** @type {Map<string, import('dictionary-database').DictionaryCountGroup | null>} */
        const dictionaryDatabaseCountsMap = new Map();
        for (const entry of this._dictionaryEntries) {
            dictionaryUpdateDownloadUrlMap.set(entry.dictionaryTitle, entry.updateDownloadUrl);
            dictionaryDatabaseCountsMap.set(entry.dictionaryTitle, entry.databaseCounts);
            entry.cleanup();
        }
        this._dictionaryEntries = [];
        const dictionaryOptionsArray = options.dictionaries;
        for (let i = 0; i < dictionaryOptionsArray.length; i++) {
            const {name} = dictionaryOptionsArray[i];
            /** @type {import('dictionary-importer').Summary | undefined} */
            const dictionaryInfo = dictionaries.find((dictionary) => dictionary.title === name);
            if (typeof dictionaryInfo === 'undefined') { continue; }
            const updateDownloadUrl = dictionaryUpdateDownloadUrlMap.get(name) ?? null;
            const dictionaryDatabaseCounts = dictionaryDatabaseCountsMap.get(name) ?? null;
            this._createDictionaryEntry(i, this._settingsController.getOptionsContext().profileId ?? '', dictionaryOptionsArray[i], dictionaryInfo, updateDownloadUrl, dictionaryDatabaseCounts);
        }
        this._dictionaryModalBody.scroll({top: dictionariesModalBodyScrollY});
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    _updateDictionariesEnabledWarnings(options) {
        const {dictionaries} = options;
        let enabledDictionaryCountValid = 0;
        let enabledDictionaryCount = 0;
        const dictionaryCount = dictionaries.length;
        if (this._dictionaries !== null) {
            const enabledDictionaries = new Set();
            for (const {name, enabled} of dictionaries) {
                if (enabled) {
                    ++enabledDictionaryCount;
                    enabledDictionaries.add(name);
                }
            }

            for (const {title} of this._dictionaries) {
                if (enabledDictionaries.has(title)) {
                    ++enabledDictionaryCountValid;
                }
            }
        }

        const hasEnabledDictionary = (enabledDictionaryCountValid > 0);
        if (hasEnabledDictionary) {
            this._settingsController.trigger('dictionaryEnabled', {});
        }
        for (const node of /** @type {NodeListOf<HTMLElement>} */ (this._noDictionariesEnabledWarnings)) {
            node.hidden = hasEnabledDictionary;
        }

        if (this._dictionaryEnabledCountNode !== null) {
            this._dictionaryEnabledCountNode.textContent = `${enabledDictionaryCountValid}`;
        }

        /** @type {HTMLInputElement} */ (this._allCheckbox).checked = (enabledDictionaryCount >= dictionaryCount);

        const entries = this._dictionaryEntries;
        for (let i = 0, ii = Math.min(entries.length, dictionaryCount); i < ii; ++i) {
            entries[i].setEnabled(dictionaries[i].enabled);
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onDictionaryConfirmDelete(e) {
        e.preventDefault();

        const modal = /** @type {import('./modal.js').Modal} */ (this._deleteDictionaryModal);
        modal.setVisible(false);

        const dictionaryTitle = modal.node.dataset.dictionaryTitle;
        delete modal.node.dataset.dictionaryTitle;
        if (typeof dictionaryTitle !== 'string') { return; }

        void this._enqueueTask({type: 'delete', dictionaryTitle});
        this._hideUpdatesAvailableButton(dictionaryTitle);
    }

    /**
     * @param {MouseEvent} e
     */
    _onDictionaryConfirmUpdate(e) {
        e.preventDefault();

        const modal = /** @type {import('./modal.js').Modal} */ (this._updateDictionaryModal);
        modal.setVisible(false);

        const dictionaryTitle = modal.node.dataset.dictionaryTitle;
        const downloadUrlValue = modal.node.dataset.downloadUrl;
        delete modal.node.dataset.dictionaryTitle;
        delete modal.node.dataset.downloadUrl;
        if (typeof dictionaryTitle !== 'string') { return; }
        const downloadUrl = normalizeOptionalDownloadUrl(downloadUrlValue);

        void this._enqueueTask({type: 'update', dictionaryTitle, downloadUrl});
        this._hideUpdatesAvailableButton(dictionaryTitle);
    }

    /**
     * @param {string} dictionaryTitle
     */
    _hideUpdatesAvailableButton(dictionaryTitle) {
        for (const entry of this._dictionaryEntries) {
            if (entry.dictionaryTitle === dictionaryTitle) {
                entry.hideUpdatesAvailableButton();
            }
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onCheckIntegrityButtonClick(e) {
        e.preventDefault();
        void this._checkIntegrity();
    }

    /**
     * @param {MouseEvent} e
     */
    _onCheckUpdatesButtonClick(e) {
        e.preventDefault();
        void this._checkForUpdates();
    }

    /** */
    _onDictionaryMoveButtonClick() {
        const modal = /** @type {import('./modal.js').Modal} */ (this._modalController.getModal('dictionary-move-location'));
        const index = modal.node.dataset.index ?? '';
        const indexNumber = Number.parseInt(index, 10);
        if (Number.isNaN(indexNumber)) { return; }
        const profileId = modal.node.dataset.dictionaryRowProfileId;
        const ownership = getDictionaryRowOwnership(modal.node);
        const entriesString = modal.node.dataset.dictionaryOrderSnapshot;
        if (typeof profileId !== 'string' || ownership === void 0 || ownership.profileId !== profileId || typeof entriesString !== 'string' || this._settingsController.getOptionsContext().profileId !== profileId) { return; }
        let expectedEntries;
        try {
            expectedEntries = parseJson(entriesString);
        } catch {
            return;
        }
        if (!Array.isArray(expectedEntries) || indexNumber < 0 || indexNumber >= expectedEntries.length) { return; }

        /** @type {HTMLInputElement} */
        const targetStringInput = querySelectorNotNull(document, '#dictionary-move-location');
        const targetString = targetStringInput.value;
        const target = Number.parseInt(targetString, 10) - 1;

        if (!Number.isFinite(target) || !Number.isFinite(indexNumber) || indexNumber === target) { return; }

        void this.moveDictionaryOptions(indexNumber, target, profileId, expectedEntries);
    }

    /** */
    async _onDictionaryResetAliasButtonClick() {
        const modal = /** @type {import('./modal.js').Modal} */ (this._modalController.getModal('dictionary-set-alias'));
        const generation = dictionaryModalGenerationByNode.get(modal.node);
        const index = modal.node.dataset.index ?? '';
        const indexNumber = Number.parseInt(index, 10);
        if (Number.isNaN(indexNumber)) { return; }
        const entry = await this._getModalDictionaryRow(modal.node, indexNumber, generation);
        if (entry === null || dictionaryModalGenerationByNode.get(modal.node) !== generation) { return; }

        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(modal.node, '#dictionary-alias-input');
        input.value = entry.dictionaryTitle;
    }

    /** */
    async _onDictionarySetAliasButtonClick() {
        const modal = /** @type {import('./modal.js').Modal} */ (this._modalController.getModal('dictionary-set-alias'));
        const generation = dictionaryModalGenerationByNode.get(modal.node);
        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(modal.node, '#dictionary-alias-input');
        const inputValue = input.value.trim();
        const index = modal.node.dataset.index ?? '';
        const indexNumber = Number.parseInt(index, 10);
        if (Number.isNaN(indexNumber)) { return; }
        const entry = await this._getModalDictionaryRow(modal.node, indexNumber, generation);
        if (entry !== null && dictionaryModalGenerationByNode.get(modal.node) === generation && inputValue) {
            entry.updateAliasSettings(inputValue);
        }
    }

    /**
     * @param {HTMLElement} modalNode
     * @param {number} index
     * @param {number|undefined} generation
     * @returns {Promise<DictionaryEntry|null>}
     */
    async _getModalDictionaryRow(modalNode, index, generation) {
        const ownership = getDictionaryRowOwnership(modalNode);
        const profileId = ownership?.profileId;
        const expectedEntry = ownership?.expectedEntry;
        if (ownership === void 0 || ownership.index !== index || typeof profileId !== 'string' || dictionaryModalGenerationByNode.get(modalNode) !== generation || this._settingsController.getOptionsContext().profileId !== profileId) { return null; }
        const options = await this._settingsController.getOptions();
        if (dictionaryModalGenerationByNode.get(modalNode) !== generation || getDictionaryRowOwnership(modalNode) !== ownership || this._settingsController.getOptionsContext().profileId !== profileId) { return null; }
        const entry = options.dictionaries[index];
        if (!entry || entry.name !== modalNode.dataset.dictionaryTitle || JSON.stringify(entry) !== JSON.stringify(expectedEntry)) { return null; }
        return this._dictionaryEntries.find((candidate) => (
            candidate.settingsIndex === index &&
            candidate.settingsProfileId === profileId &&
            candidate.dictionaryTitle === entry.name
        )) ?? null;
    }

    /**
     * @param {import('dictionary-importer').Summary[]} dictionaries
     */
    _updateMainDictionarySelectOptions(dictionaries) {
        for (const select of document.querySelectorAll('[data-setting="general.mainDictionary"]')) {
            const fragment = document.createDocumentFragment();

            let option = document.createElement('option');
            option.className = 'text-muted';
            option.value = '';
            option.textContent = 'Not selected';
            fragment.appendChild(option);

            for (const {title, sequenced} of dictionaries) {
                if (!sequenced) { continue; }
                option = document.createElement('option');
                option.value = title;
                option.textContent = title;
                fragment.appendChild(option);
            }

            select.textContent = ''; // Empty
            select.appendChild(fragment);
        }
    }

    /** */
    async _checkForUpdates() {
        if (this._dictionaries === null || this._checkingIntegrity || this._checkingUpdates || this._isTaskQueueRunning) { return; }
        let hasUpdates = false;
        let hadFailures = false;
        let currentCheck = true;
        const entries = this._dictionaryEntries;
        const entriesUpdateToken = this._entriesUpdateToken;
        try {
            this._checkingUpdates = true;
            this._clearMutationErrors();
            this._setButtonsEnabled(false);

            const updateChecks = entries.map((entry) => entry.checkForUpdate());
            const results = await Promise.allSettled(updateChecks);
            if (this._dictionaryEntries !== entries || this._entriesUpdateToken !== entriesUpdateToken) {
                currentCheck = false;
                return;
            }
            const updateCount = results.reduce((sum, result) => (sum + (result.status === 'fulfilled' && result.value ? 1 : 0)), 0);
            const failures = results
                .filter((result) => result.status === 'rejected')
                .map((result) => /** @type {unknown} */ (/** @type {PromiseRejectedResult} */ (result).reason));
            hadFailures = (failures.length > 0);
            if (hadFailures) {
                reportDiagnostics('dictionary-update-check-failed', {
                    failedCount: failures.length,
                    totalCount: results.length,
                });
                const [firstFailure] = failures;
                const error = firstFailure instanceof Error ? firstFailure : new Error(String(firstFailure));
                this._showMutationError(error);
            }
            if (this._checkUpdatesButton !== null) {
                hasUpdates = !!updateCount;
                this._checkUpdatesButton.textContent = hasUpdates ?
                    `${updateCount} update${updateCount > 1 ? 's' : ''}${hadFailures ? ' (partial)' : ''}` :
                    (hadFailures ? 'Check failed' : 'No updates');
            }
        } finally {
            this._setButtonsEnabled(true);
            if (currentCheck && this._checkUpdatesButton !== null && !hasUpdates && !hadFailures) {
                this._checkUpdatesButton.disabled = true;
            }
            this._checkingUpdates = false;
        }
    }

    /** */
    async _checkIntegrity() {
        if (Reflect.get(globalThis, 'manabitanDisableIntegrityCounts') === true) { return; }
        if (this._dictionaries === null || this._checkingIntegrity || this._checkingUpdates || this._isTaskQueueRunning) { return; }

        try {
            this._checkingIntegrity = true;
            this._setButtonsEnabled(false);

            const token = this._databaseStateToken;
            const dictionaryTitles = this._dictionaryEntries.map(({dictionaryTitle}) => dictionaryTitle);
            const {counts, total} = await this._settingsController.application.api.getDictionaryCounts(dictionaryTitles, true);
            if (this._databaseStateToken !== token) { return; }

            for (let i = 0, ii = Math.min(counts.length, this._dictionaryEntries.length); i < ii; ++i) {
                const entry = this._dictionaryEntries[i];
                entry.setCounts(counts[i]);
            }

            this._setCounts(counts, /** @type {import('dictionary-database').DictionaryCountGroup} */ (total));
        } finally {
            this._setButtonsEnabled(true);
            this._checkingIntegrity = false;
        }
    }

    /**
     * @param {import('dictionary-database').DictionaryCountGroup[]} dictionaryCounts
     * @param {import('dictionary-database').DictionaryCountGroup} totalCounts
     */
    _setCounts(dictionaryCounts, totalCounts) {
        const remainders = Object.assign({}, totalCounts);
        const keys = Object.keys(remainders);

        for (const counts of dictionaryCounts) {
            for (const key of keys) {
                remainders[key] -= counts[key];
            }
        }

        let totalRemainder = 0;
        for (const key of keys) {
            totalRemainder += remainders[key];
        }

        if (this._extraInfo !== null) {
            this._extraInfo.cleanup();
            this._extraInfo = null;
        }

        if (totalRemainder > 0 && this._dictionaryEntryContainer !== null) {
            this._extraInfo = new DictionaryExtraInfo(this, totalCounts, remainders, totalRemainder);
            this._extraInfo.prepare(this._dictionaryEntryContainer);
        }
    }

    /**
     * @param {number} index
     * @param {string} profileId
     * @param {import('settings').DictionaryOptions} dictionarySettings
     * @param {import('dictionary-importer').Summary} dictionaryInfo
     * @param {string|null} updateDownloadUrl
     * @param {import('dictionary-database').DictionaryCountGroup|null} dictionaryDatabaseCounts
     */
    _createDictionaryEntry(index, profileId, dictionarySettings, dictionaryInfo, updateDownloadUrl, dictionaryDatabaseCounts) {
        const fragment = this.instantiateTemplateFragment('dictionary');
        try {
            const entry = new DictionaryEntry(this, fragment, index, profileId, dictionarySettings, dictionaryInfo, updateDownloadUrl, dictionaryDatabaseCounts);
            this._dictionaryEntries.push(entry);
            entry.prepare();

            const container = /** @type {HTMLElement} */ (this._dictionaryEntryContainer);
            const relative = container.querySelector('.dictionary-item-bottom');
            container.insertBefore(fragment, relative);

            this._updateDictionaryEntryCount();
        } catch (error) {
            log.error(error);
        }
    }


    /**
     * @param {string} dictionaryTitle
     * @returns {boolean}
     */
    isDictionaryInTaskQueue(dictionaryTitle) {
        return this._dictionaryTaskQueue.some((task) => task.dictionaryTitle === dictionaryTitle);
    }

    /**
     * @param {import('dictionary-controller.js').DictionaryTask} task
     */
    _enqueueTask(task) {
        // The running task still occupies slot zero until its finally block
        // retires it. Replacing that slot would silently discard the new task
        // when the running operation finishes and shifts the queue.
        const existingTaskIndex = this._dictionaryTaskQueue.findIndex((queueTask, index) => (
            (!this._isTaskQueueRunning || index > 0) && queueTask.dictionaryTitle === task.dictionaryTitle
        ));
        if (existingTaskIndex >= 0) {
            const existingTask = this._dictionaryTaskQueue[existingTaskIndex];
            let taskReplaced = false;
            if (task.type === 'delete' || (existingTask.type === 'update' && task.type === 'update')) {
                this._dictionaryTaskQueue.splice(existingTaskIndex, 1, task);
                taskReplaced = true;
            }
            if (taskReplaced && !this._isTaskQueueRunning) {
                void this._runTaskQueue();
            }
            return;
        }
        this._dictionaryTaskQueue.push(task);
        void this._runTaskQueue();
    }


    /** */
    async _runTaskQueue() {
        if (this._isTaskQueueRunning) { return; }
        this._isTaskQueueRunning = true;
        try {
            while (this._dictionaryTaskQueue.length > 0) {
                const task = this._dictionaryTaskQueue[0];
                let taskFailed = false;
                try {
                    switch (task.type) {
                        case 'delete':
                            await this._deleteDictionary(task.dictionaryTitle);
                            break;
                        case 'update':
                            await this._updateDictionary(task.dictionaryTitle, task.downloadUrl);
                            break;
                        case 'replaceFromFiles':
                            await this._reimportDictionaryFromFiles(task.dictionaryTitle, task.files);
                            break;
                        default:
                            break;
                    }
                } catch (error) {
                    taskFailed = true;
                    const normalizedError = error instanceof Error ? error : new Error(String(error));
                    reportDiagnostics('dictionary-task-queue-failed', {
                        taskType: task.type,
                        dictionaryTitle: task.dictionaryTitle,
                        message: normalizedError.message,
                    });
                    log.error(normalizedError);
                    this._showMutationError(normalizedError);
                } finally {
                    void this._dictionaryTaskQueue.shift();
                    if (taskFailed && (task.type === 'update' || task.type === 'delete')) {
                        this._showUpdatesAvailableButton(task.dictionaryTitle);
                    }
                }
            }
        } finally {
            this._isTaskQueueRunning = false;
        }
    }

    /**
     * @param {string} dictionaryTitle
     */
    async _deleteDictionary(dictionaryTitle) {
        if (this._checkingIntegrity) { return; }

        const index = this._dictionaryEntries.findIndex((entry) => entry.dictionaryTitle === dictionaryTitle);
        if (index < 0) { return; }

        const statusFooter = this._statusFooter;
        const progressSelector = '.dictionary-delete-progress';
        const progressContainers = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`#dictionaries-modal ${progressSelector}`));
        const progressBars = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`${progressSelector} .progress-bar`));
        const infoLabels = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`${progressSelector} .progress-info`));
        const statusLabels = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(`${progressSelector} .progress-status`));
        const prevention = this._settingsController.preventPageExit();
        try {
            this._clearMutationErrors();
            this._setButtonsEnabled(false);

            /**
             * @param {import('dictionary-database').DeleteDictionaryProgressData} details
             */
            const onProgress = ({processed, count, storeCount, storesProcesed}) => {
                const percent = (
                    (count > 0 && storesProcesed > 0) ?
                    (processed / count) * (storesProcesed / storeCount) * 100 :
                    0
                );
                const cssString = `${percent}%`;
                const statusString = `${percent.toFixed(0)}%`;
                for (const progressBar of progressBars) { progressBar.style.width = cssString; }
                for (const label of statusLabels) { label.textContent = statusString; }
            };

            onProgress({processed: 0, count: 1, storeCount: 1, storesProcesed: 0});

            for (const progress of progressContainers) { progress.hidden = false; }
            for (const label of infoLabels) { label.textContent = 'Deleting dictionary...'; }
            if (statusFooter !== null) { statusFooter.setTaskActive(progressSelector, true); }

            await this._deleteDictionaryInternal(dictionaryTitle, onProgress);
            await this._deleteDictionarySettings(dictionaryTitle);
        } finally {
            prevention.end();
            for (const progress of progressContainers) { progress.hidden = true; }
            if (statusFooter !== null) { statusFooter.setTaskActive(progressSelector, false); }
            this._setButtonsEnabled(true);
            this._triggerStorageChanged();
        }
    }

    /**
     * @param {string} dictionaryTitle
     * @param {string|undefined} downloadUrl
     */
    async _updateDictionary(dictionaryTitle, downloadUrl) {
        if (this._checkingIntegrity || this._checkingUpdates) { return; }

        const dictionaryInfo = await this._getDictionaryInfoForTask(dictionaryTitle);
        dictionaryTitle = dictionaryInfo.title;
        downloadUrl = downloadUrl ?? dictionaryInfo.downloadUrl;
        if (typeof downloadUrl !== 'string') { throw new Error('Attempted to update dictionary without download URL'); }

        const options = await this._settingsController.getOptionsFull();
        this._clearMutationErrors();
        const profilesDictionarySettings = this._getProfilesDictionarySettingsForTitle(options.profiles, dictionaryTitle);

        const importToken = this._createUpdateImportToken();
        const stagedDictionaryTitle = `${dictionaryTitle} [update-staging ${importToken}]`;
        let importResult;
        try {
            importResult = await this._importReplacementDictionary(
                dictionaryTitle,
                downloadUrl,
                profilesDictionarySettings,
                importToken,
                stagedDictionaryTitle,
            );
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (normalizedError.message.includes('Timed out importing replacement dictionary')) {
                const recovered = await this._recoverTimedOutUpdateState(dictionaryTitle, importToken, stagedDictionaryTitle);
                if (recovered) { return; }
            }
            throw normalizedError;
        }
        if (!importResult.ok) {
            throw new Error(
                `Replacement dictionary import failed for ${dictionaryTitle}: ` +
                importResult.errors.map((error) => error.message).join('; '),
            );
        }
        await this._validateUpdatedDictionaryState(dictionaryTitle, importToken, stagedDictionaryTitle, importResult.importedTitles);
    }

    /**
     * @param {string} dictionaryTitle
     * @param {File[]} files
     */
    async _reimportDictionaryFromFiles(dictionaryTitle, files) {
        if (this._checkingIntegrity || this._checkingUpdates || files.length === 0) { return; }

        const dictionaryInfo = await this._getDictionaryInfoForTask(dictionaryTitle);
        dictionaryTitle = dictionaryInfo.title;
        const options = await this._settingsController.getOptionsFull();
        this._clearMutationErrors();
        const profilesDictionarySettings = this._getProfilesDictionarySettingsForTitle(options.profiles, dictionaryTitle);

        const importToken = this._createUpdateImportToken();
        const stagedDictionaryTitle = `${dictionaryTitle} [update-staging ${importToken}]`;
        let importResult;
        try {
            importResult = await this._importReplacementDictionaryFromFiles(
                dictionaryTitle,
                files,
                profilesDictionarySettings,
                importToken,
                stagedDictionaryTitle,
            );
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (normalizedError.message.includes('Timed out importing replacement dictionary')) {
                const recovered = await this._recoverTimedOutUpdateState(dictionaryTitle, importToken, stagedDictionaryTitle);
                if (recovered) { return; }
            }
            throw normalizedError;
        }
        if (!importResult.ok) {
            throw new Error(
                `Replacement dictionary import failed for ${dictionaryTitle}: ` +
                importResult.errors.map((error) => error.message).join('; '),
            );
        }
        await this._validateUpdatedDictionaryState(dictionaryTitle, importToken, stagedDictionaryTitle, importResult.importedTitles);
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {Promise<import('dictionary-importer').Summary>}
     */
    async _getDictionaryInfoForTask(dictionaryTitle) {
        const dictionaries = this._dictionaries ?? await this._settingsController.getDictionaryInfo();
        const exactMatch = dictionaries.find((entry) => entry.title === dictionaryTitle);
        if (typeof exactMatch !== 'undefined') { return exactMatch; }

        const normalizedTaskTitle = this._getDictionaryTaskMatchTitle(dictionaryTitle);
        const matches = dictionaries.filter((entry) => {
            const normalizedInstalledTitle = this._getDictionaryTaskMatchTitle(entry.title);
            return (
                normalizedInstalledTitle === normalizedTaskTitle ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle} `) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}.`) ||
                normalizedInstalledTitle.startsWith(`${normalizedTaskTitle}[`)
            );
        });
        if (matches.length === 1) { return matches[0]; }
        if (matches.length > 1) {
            throw new Error(`Dictionary update task title is ambiguous: ${dictionaryTitle}`);
        }
        throw new Error(`Dictionary not found: ${dictionaryTitle}`);
    }

    /**
     * @param {unknown} title
     * @returns {string}
     */
    _getDictionaryTaskMatchTitle(title) {
        return (typeof title === 'string' ? title : '')
            .replace(TRANSIENT_UPDATE_TITLE_PATTERN, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    /**
     * @returns {number}
     */
    _getMutationCallbackTimeoutMs() {
        return MUTATION_CALLBACK_TIMEOUT_MS;
    }

    /**
     * @returns {string}
     */
    _createUpdateImportToken() {
        return Math.random().toString(36).slice(2, 10);
    }

    /**
     * @param {import('settings').Options['profiles']} profiles
     * @param {string} dictionaryTitle
     * @returns {import('settings-controller.js').ProfilesDictionarySettings}
     */
    _getProfilesDictionarySettingsForTitle(profiles, dictionaryTitle) {
        /** @type {import('settings-controller.js').ProfilesDictionarySettings} */
        const profilesDictionarySettings = {};
        for (const profile of profiles) {
            const dictionaries = profile.options.dictionaries;
            /** @type {import('settings-controller.js').ProfileDictionarySettings[]} */
            const profileMatches = [];
            for (let i = 0; i < dictionaries.length; ++i) {
                if (dictionaries[i].name !== dictionaryTitle) { continue; }
                profileMatches.push({...dictionaries[i], index: i});
            }
            if (profileMatches.length > 0) {
                profilesDictionarySettings[profile.id] = profileMatches;
            }
        }
        return profilesDictionarySettings;
    }

    /**
     * @param {string} dictionaryTitle
     * @param {string} downloadUrl
     * @param {import('settings-controller.js').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {string} importToken
     * @param {string} stagedDictionaryTitle
     * @returns {Promise<import('settings-controller').ImportDictionaryDoneResult>}
     */
    async _importReplacementDictionary(dictionaryTitle, downloadUrl, profilesDictionarySettings, importToken, stagedDictionaryTitle) {
        return await this._awaitPromiseResult(
            this._settingsController.importDictionaryFromUrl(
                downloadUrl,
                profilesDictionarySettings,
                {
                    dictionaryTitleOverride: stagedDictionaryTitle,
                    replacementDictionaryTitle: dictionaryTitle,
                    updateSessionToken: importToken,
                    useImportSession: false,
                    finalizeImportSession: false,
                },
            ),
            `Timed out importing replacement dictionary for ${dictionaryTitle}`,
        );
    }

    /**
     * @param {string} dictionaryTitle
     * @param {File[]} files
     * @param {import('settings-controller.js').ProfilesDictionarySettings} profilesDictionarySettings
     * @param {string} importToken
     * @param {string} stagedDictionaryTitle
     * @returns {Promise<import('settings-controller').ImportDictionaryDoneResult>}
     */
    async _importReplacementDictionaryFromFiles(dictionaryTitle, files, profilesDictionarySettings, importToken, stagedDictionaryTitle) {
        return await this._awaitPromiseResult(
            this._settingsController.importDictionaryFromFile(
                files,
                profilesDictionarySettings,
                {
                    dictionaryTitleOverride: stagedDictionaryTitle,
                    replacementDictionaryTitle: dictionaryTitle,
                    updateSessionToken: importToken,
                    useImportSession: false,
                    finalizeImportSession: false,
                },
            ),
            `Timed out importing replacement dictionary for ${dictionaryTitle}`,
        );
    }

    /**
     * @template T
     * @param {Promise<T>} promise
     * @param {string} timeoutMessage
     * @returns {Promise<T>}
     */
    async _awaitPromiseResult(promise, timeoutMessage) {
        const mutationCallbackTimeoutMs = this._getMutationCallbackTimeoutMs();
        return await Promise.race([
            promise,
            promiseTimeout(mutationCallbackTimeoutMs).then(() => {
                throw new Error(`${timeoutMessage} after ${String(mutationCallbackTimeoutMs)}ms`);
            }),
        ]);
    }

    /**
     * @param {string} dictionaryTitle
     * @param {string} importToken
     * @param {string} stagedDictionaryTitle
     * @param {string[]} importedTitles
     * @returns {Promise<void>}
     */
    async _validateUpdatedDictionaryState(dictionaryTitle, importToken, stagedDictionaryTitle, importedTitles) {
        const {dictionaryInfo, transientTitles} = await this._getDictionaryInfoAfterTransientCleanup();
        const updatedDictionaries = dictionaryInfo.filter((dictionary) => (
            importedTitles.includes(dictionary.title) &&
            typeof dictionary.updateSessionToken === 'string' &&
            dictionary.updateSessionToken === importToken
        ));
        const updatedDictionary = updatedDictionaries.length === 1 ? updatedDictionaries[0] : null;
        const importedDictionaryPresent = updatedDictionary !== null;
        const updateTokenApplied = importedDictionaryPresent;
        const originalDictionaryRemoved = dictionaryTitle === updatedDictionary?.title || !dictionaryInfo.some((dictionary) => dictionary.title === dictionaryTitle);
        const stagedDictionaryRemoved = !dictionaryInfo.some((dictionary) => dictionary.title === stagedDictionaryTitle);
        reportDiagnostics('dictionary-update-state-validated', {
            dictionaryTitle,
            importToken,
            stagedDictionaryTitle,
            importedTitles,
            importedDictionaryPresent,
            updateTokenApplied,
            updatedDictionaryTitle: updatedDictionary?.title ?? null,
            matchingUpdateCount: updatedDictionaries.length,
            originalDictionaryRemoved,
            stagedDictionaryRemoved,
            transientTitles,
        });
        if (!importedDictionaryPresent || !originalDictionaryRemoved || !stagedDictionaryRemoved || transientTitles.length > 0) {
            throw new Error(
                `Dictionary update requires repair for "${dictionaryTitle}" ` +
                `(imported=${String(importedDictionaryPresent)} tokenApplied=${String(updateTokenApplied)} ` +
                `originalRemoved=${String(originalDictionaryRemoved)} matchingUpdates=${String(updatedDictionaries.length)} ` +
                `stagedRemoved=${String(stagedDictionaryRemoved)} ` +
                `transientTitles=${JSON.stringify(transientTitles)})`,
            );
        }
    }

    /**
     * @param {string} dictionaryTitle
     * @param {string} importToken
     * @param {string} stagedDictionaryTitle
     * @returns {Promise<boolean>}
     */
    async _recoverTimedOutUpdateState(dictionaryTitle, importToken, stagedDictionaryTitle) {
        // Promise.race does not cancel the underlying import. Inspect state without
        // deleting staging rows which may still be owned by that import.
        const dictionaryInfo = await this._settingsController.application.api.getDictionaryInfo();
        const transientTitles = this._getTransientDictionaryTitles(dictionaryInfo);
        const updatedDictionaries = dictionaryInfo.filter((dictionary) => (
            typeof dictionary.updateSessionToken === 'string' &&
            dictionary.updateSessionToken === importToken
        ));
        const updatedDictionary = updatedDictionaries.length === 1 ? updatedDictionaries[0] : null;
        const updateTokenApplied = updatedDictionary !== null;
        const originalDictionaryRemoved = dictionaryTitle === updatedDictionary?.title || !dictionaryInfo.some((dictionary) => dictionary.title === dictionaryTitle);
        const stagedDictionaryRemoved = !dictionaryInfo.some((dictionary) => dictionary.title === stagedDictionaryTitle);
        reportDiagnostics('dictionary-update-timeout-recovery', {
            dictionaryTitle,
            importToken,
            stagedDictionaryTitle,
            updateTokenApplied,
            updatedDictionaryTitle: updatedDictionary?.title ?? null,
            matchingUpdateCount: updatedDictionaries.length,
            originalDictionaryRemoved,
            stagedDictionaryRemoved,
            transientTitles,
            installedTitles: dictionaryInfo.map((dictionary) => dictionary.title),
        });
        return updateTokenApplied && originalDictionaryRemoved && stagedDictionaryRemoved && transientTitles.length === 0;
    }

    /**
     * @returns {Promise<{dictionaryInfo: import('dictionary-importer').Summary[], transientTitles: string[]}>}
     */
    async _getDictionaryInfoAfterTransientCleanup() {
        let dictionaryInfo = await this._settingsController.application.api.getDictionaryInfo();
        let transientTitles = this._getTransientDictionaryTitles(dictionaryInfo);
        for (const transientTitle of transientTitles) {
            try {
                await this._deleteDictionaryInternal(transientTitle, () => {});
                await this._deleteDictionarySettings(transientTitle);
            } catch (error) {
                log.error(error);
            }
        }
        if (transientTitles.length > 0) {
            dictionaryInfo = await this._settingsController.application.api.getDictionaryInfo();
            transientTitles = this._getTransientDictionaryTitles(dictionaryInfo);
        }
        return {dictionaryInfo, transientTitles};
    }

    /**
     * @param {import('dictionary-importer').Summary[]} dictionaryInfo
     * @returns {string[]}
     */
    _getTransientDictionaryTitles(dictionaryInfo) {
        return dictionaryInfo
            .map((dictionary) => dictionary.title)
            .filter((title) => typeof title === 'string' && TRANSIENT_UPDATE_TITLE_PATTERN.test(title));
    }

    /**
     * @param {boolean} value
     */
    _setButtonsEnabled(value) {
        value = !value;
        for (const node of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.dictionary-database-mutating-input'))) {
            node.disabled = value;
        }
    }

    /**
     * @param {string} dictionaryTitle
     * @param {import('dictionary-worker').DeleteProgressCallback} onProgress
     */
    async _deleteDictionaryInternal(dictionaryTitle, onProgress) {
        onProgress({processed: 0, count: 1, storeCount: 1, storesProcesed: 0});
        await this._settingsController.application.api.deleteDictionaryByTitle(dictionaryTitle);
        onProgress({processed: 1, count: 1, storeCount: 1, storesProcesed: 1});
        await this._awaitDictionaryRefresh(dictionaryTitle, 'delete');
    }

    /**
     * @param {string} dictionaryTitle
     * @param {'delete'} cause
     * @returns {Promise<void>}
     */
    async _awaitDictionaryRefresh(dictionaryTitle, cause) {
        /** @type {import('core').DeferredPromiseDetails<void>} */
        const {promise: dictionariesUpdatePromise, resolve} = deferPromise();
        this._onDictionariesUpdate = resolve;
        try {
            const mutationCallbackTimeoutMs = this._getMutationCallbackTimeoutMs();
            await this._settingsController.application.api.triggerDatabaseUpdated('dictionary', cause);
            await Promise.race([
                dictionariesUpdatePromise,
                promiseTimeout(mutationCallbackTimeoutMs).then(() => {
                    throw new Error(`Timed out waiting for dictionary ${cause} refresh for ${dictionaryTitle} after ${String(mutationCallbackTimeoutMs)}ms`);
                }),
            ]);
        } finally {
            this._onDictionariesUpdate = null;
        }
    }

    /**
     * @param {string} dictionaryTitle
     */
    async _deleteDictionarySettings(dictionaryTitle) {
        const optionsFull = await this._settingsController.getOptionsFull();
        const {profiles} = optionsFull;
        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        for (let i = 0, ii = profiles.length; i < ii; ++i) {
            const {options: {dictionaries, general}, id: profileId} = profiles[i];
            if (dictionaries.some(({name}) => name === dictionaryTitle)) {
                targets.push({action: 'removeDictionaryByName', profileId, name: dictionaryTitle});
            }
            if (general.mainDictionary === dictionaryTitle) {
                targets.push({action: 'setDictionarySelector', profileId, selector: 'mainDictionary', expectedValue: dictionaryTitle, value: '', requireDictionaryUninstalled: dictionaryTitle});
            }
            if (general.sortFrequencyDictionary === dictionaryTitle) {
                targets.push({action: 'setDictionarySelector', profileId, selector: 'sortFrequencyDictionary', expectedValue: dictionaryTitle, value: null, requireDictionaryUninstalled: dictionaryTitle});
            }
        }
        const results = await this._settingsController.modifyGlobalSettings(targets);
        const failure = results.find((result) => typeof result.error !== 'undefined');
        if (typeof failure?.error !== 'undefined') {
            throw ExtensionError.deserialize(failure.error);
        }
    }

    /** */
    _triggerStorageChanged() {
        this._settingsController.application.triggerStorageChanged();
    }

    /**
     * @param {string} dictionaryTitle
     * @returns {void}
     */
    _showUpdatesAvailableButton(dictionaryTitle) {
        for (const entry of this._dictionaryEntries) {
            if (entry.dictionaryTitle === dictionaryTitle && typeof entry.showUpdatesAvailableButton === 'function') {
                entry.showUpdatesAvailableButton();
            }
        }
    }

    /**
     * @param {Error} error
     * @returns {void}
     */
    _showMutationError(error) {
        if (typeof HTMLElement === 'undefined') { return; }
        const errorContainer = globalThis.document?.querySelector('#dictionary-error');
        if (!(errorContainer instanceof HTMLElement)) { return; }
        const line = document.createElement('p');
        line.textContent = error.message;
        errorContainer.appendChild(line);
        errorContainer.hidden = false;
    }

    /** */
    _clearMutationErrors() {
        if (typeof HTMLElement === 'undefined') { return; }
        const errorContainer = globalThis.document?.querySelector('#dictionary-error');
        if (!(errorContainer instanceof HTMLElement)) { return; }
        errorContainer.textContent = '';
        errorContainer.hidden = true;
    }

    /** */
    _updateDictionaryEntryCount() {
        /** @type {HTMLElement} */ (this._dictionaryEntryContainer).dataset.count = `${this._dictionaryEntries.length}`;
    }

    /**
     * @param {boolean} value
     */
    async _setAllDictionariesEnabled(value) {
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (this._settingsController.getOptionsContext().index !== optionsContext.index || this._settingsController.getOptionsContext().profileId !== optionsContext.profileId) { return; }
        const {dictionaries} = options;

        /** @type {import('settings-modifications').Modification[]} */
        const targets = [];
        for (let i = 0, ii = dictionaries.length; i < ii; ++i) {
            targets.push({
                action: 'setDictionaryField',
                profileId: optionsContext.profileId ?? '',
                index: i,
                expectedEntry: structuredClone(dictionaries[i]),
                field: 'enabled',
                value,
            });
        }
        const results = await this._settingsController.modifyProfileSettings(targets);
        if (results.some(({error, result}) => typeof error !== 'undefined' || (result !== null && typeof result === 'object' && /** @type {{stale?: unknown}} */ (result).stale === true))) {
            await this._settingsController.refresh();
            return;
        }

        await this.updateDictionariesEnabled();
    }
}
