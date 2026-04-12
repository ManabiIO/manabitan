/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2017-2022  Yomichan Authors
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

import {ThemeController} from '../app/theme-controller.js';
import {getAllPermissions, hasRequiredPermissionsForOptions} from '../data/permissions-util.js';
import {log} from '../core/log.js';
import {HotkeyHelpController} from '../input/hotkey-help-controller.js';
import {HotkeyUtil} from '../input/hotkey-util.js';
import {updateDictionaryWarningTooltips} from './action-popup-dictionary-warnings.js';

export class DisplayController {
    /**
     * @param {import('../application.js').Application} application
     */
    constructor(application) {
        /** @type {import('../application.js').Application} */
        this._application = application;
        /** @type {import('../comm/api.js').API} */
        this._api = application.api;
        /** @type {?import('settings').Options} */
        this._optionsFull = null;
        /** @type {ThemeController} */
        this._themeController = new ThemeController(document.documentElement);
        /** @type {HotkeyUtil} */
        this._hotkeyUtil = new HotkeyUtil();
        /** @type {boolean} */
        this._toggleListenersSetup = false;
        /** @type {boolean} */
        this._profileSelectListenersSetup = false;
        /** @type {number} */
        this._optionsSetupGeneration = 0;
        /** @type {number} */
        this._optionsRefreshGeneration = 0;
        /** @type {(event: Event) => void} */
        this._onToggleChanged = this._onToggleChanged.bind(this);
    }

    /** */
    async prepare() {
        this._themeController.prepare();

        const manifest = chrome.runtime.getManifest();

        const {platform: {os}} = await this._api.getEnvironmentInfo();
        this._hotkeyUtil.os = os;

        this._showExtensionInfo(manifest);
        void this._setupEnvironment();
        this._setupButtonEvents('.action-open-search', 'openSearchPage', chrome.runtime.getURL('/search.html'), this._onSearchClick.bind(this));
        this._setupButtonEvents('.action-open-info', 'openInfoPage', chrome.runtime.getURL('/info.html'));

        await this._refreshOptionsState();

        void this._setupHotkeys();

        const optionsPageUrl = (
            typeof manifest.options_ui === 'object' &&
            manifest.options_ui !== null &&
            typeof manifest.options_ui.page === 'string' ?
            manifest.options_ui.page :
            ''
        );
        this._setupButtonEvents('.action-open-settings', 'openSettingsPage', chrome.runtime.getURL(optionsPageUrl));

        this._application.on('optionsUpdated', this._onOptionsUpdated.bind(this));
        this._application.on('databaseUpdated', this._onDatabaseUpdated.bind(this));

        setTimeout(() => {
            document.body.dataset.loaded = 'true';
        }, 10);
    }

    // Private

    /**
     * @returns {Promise<void>}
     */
    async _refreshOptionsState() {
        const refreshGeneration = ++this._optionsRefreshGeneration;
        const optionsFull = await this._api.optionsGetFull();
        if (refreshGeneration !== this._optionsRefreshGeneration) { return; }
        this._optionsFull = optionsFull;

        const {profiles, profileCurrent} = optionsFull;
        const defaultProfile = (profileCurrent >= 0 && profileCurrent < profiles.length) ? profiles[profileCurrent] : null;
        if (defaultProfile !== null) {
            this._setupOptions(defaultProfile);
        }

        /** @type {NodeListOf<HTMLElement>} */
        const profileSelect = document.querySelectorAll('.action-select-profile');
        for (let i = 0; i < profileSelect.length; i++) {
            profileSelect[i].hidden = (profiles.length <= 1);
        }

        this._updateProfileSelect(profiles, profileCurrent);
    }

    /**
     * @param {{source?: string}} details
     * @returns {void}
     */
    _onOptionsUpdated(_details) {
        void this._refreshOptionsState().catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {{type?: string}} details
     * @returns {void}
     */
    _onDatabaseUpdated({type}) {
        if (type !== 'dictionary') { return; }
        const optionsFull = this._optionsFull;
        if (optionsFull === null) { return; }
        const {profiles, profileCurrent} = optionsFull;
        const defaultProfile = (profileCurrent >= 0 && profileCurrent < profiles.length) ? profiles[profileCurrent] : null;
        if (defaultProfile !== null) {
            const generation = this._optionsSetupGeneration;
            void this._updateDictionariesEnabledWarnings(defaultProfile.options, generation).catch((error) => {
                log.error(error);
            });
        }
    }

    /** */
    _updateDisplayModifierKey() {
        const {profiles, profileCurrent} = /** @type {import('settings').Options} */ (this._optionsFull);
        /** @type {NodeListOf<HTMLElement>} */
        const modifierKeyHint = document.querySelectorAll('.tooltip');

        const currentModifierKey = profiles[profileCurrent].options.scanning.inputs[0].include;

        /** @type {{ [key: string]: string }} */
        const modifierKeys = {};
        for (const value of /** @type {import('input').ModifierKey[]} */ (['alt', 'ctrl', 'shift', 'meta'])) {
            const name = this._hotkeyUtil.getModifierDisplayValue(value);
            modifierKeys[value] = name;
        }

        for (let i = 0; i < modifierKeyHint.length; i++) {
            modifierKeyHint[i].textContent = currentModifierKey ? 'Hold ' : 'Hover over text to scan';
            if (currentModifierKey) {
                const em = document.createElement('em');
                em.textContent = modifierKeys[currentModifierKey];
                modifierKeyHint[i].appendChild(em);
                modifierKeyHint[i].appendChild(document.createTextNode(' to scan'));
            }
        }
    }

    /** */
    _onToggleChanged() {
        void this._api.commandExec('toggleTextScanning');
    }

    /**
     * @param {MouseEvent} e
     */
    _onSearchClick(e) {
        if (!e.shiftKey) { return; }
        e.preventDefault();
        location.href = '/search.html?action-popup=true';
    }

    /**
     * @param {chrome.runtime.Manifest} manifest
     */
    _showExtensionInfo(manifest) {
        const node = document.getElementById('extension-info');
        if (node === null) { return; }

        node.textContent = `${manifest.name} v${manifest.version}`;
    }

    /**
     * @param {string} selector
     * @param {?string} command
     * @param {string} url
     * @param {(event: MouseEvent) => void} [customHandler]
     */
    _setupButtonEvents(selector, command, url, customHandler) {
        /** @type {NodeListOf<HTMLAnchorElement>} */
        const nodes = document.querySelectorAll(selector);
        for (const node of nodes) {
            if (typeof command === 'string') {
                /**
                 * @param {MouseEvent} e
                 */
                const onClick = (e) => {
                    if (e.button !== 0) { return; }
                    if (typeof customHandler === 'function') {
                        const result = customHandler(e);
                        if (typeof result !== 'undefined') { return; }
                    }

                    let mode = 'existingOrNewTab';
                    if (e.ctrlKey) {
                        mode = 'newTab';
                    } else if (e.shiftKey) {
                        mode = 'popup';
                    }

                    void this._api.commandExec(command, {mode: mode});
                    e.preventDefault();
                };
                /**
                 * @param {MouseEvent} e
                 */
                const onAuxClick = (e) => {
                    if (e.button !== 1) { return; }
                    void this._api.commandExec(command, {mode: 'newTab'});
                    e.preventDefault();
                };
                node.addEventListener('click', onClick, false);
                node.addEventListener('auxclick', onAuxClick, false);
            }

            if (typeof url === 'string') {
                node.href = url;
                node.target = '_blank';
                node.rel = 'noopener';
            }
        }
    }

    /** */
    async _setupEnvironment() {
        const urlSearchParams = new URLSearchParams(location.search);
        let mode = urlSearchParams.get('mode');
        switch (mode) {
            case 'full':
            case 'mini':
                break;
            default:
                {
                    let tab;
                    try {
                        tab = await this._getCurrentTab();
                        if (tab && await this._isSafari()) {
                            tab = void 0;
                        }
                    } catch (e) {
                        // NOP
                    }
                    mode = (tab ? 'full' : 'mini');
                }
                break;
        }

        document.documentElement.dataset.mode = mode;
    }

    /**
     * @returns {Promise<chrome.tabs.Tab|undefined>}
     */
    _getCurrentTab() {
        return new Promise((resolve, reject) => {
            chrome.tabs.getCurrent((result) => {
                const e = chrome.runtime.lastError;
                if (e) {
                    reject(new Error(e.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    /**
     * @param {import('settings').Profile} profile
     */
    _setupOptions({options}) {
        const generation = ++this._optionsSetupGeneration;
        const extensionEnabled = options.general.enable;
        for (const toggle of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.enable-search,.enable-search2'))) {
            if (toggle.checked !== extensionEnabled) {
                toggle.checked = extensionEnabled;
            }
            if (!this._toggleListenersSetup) {
                toggle.addEventListener('change', this._onToggleChanged, false);
            }
        }
        this._toggleListenersSetup = true;
        void this._updateDisplayModifierKey();
        void this._updateDictionariesEnabledWarnings(options, generation).catch((error) => {
            log.error(error);
        });
        void this._updatePermissionsWarnings(options, generation).catch((error) => {
            log.error(error);
        });

        this._themeController.theme = options.general.popupTheme;
        this._themeController.themePreset = options.general.popupThemePreset;
        this._themeController.siteOverride = true;
        this._themeController.updateTheme();
    }

    /** */
    async _setupHotkeys() {
        const hotkeyHelpController = new HotkeyHelpController();
        await hotkeyHelpController.prepare(this._api);

        const {profiles, profileCurrent} = /** @type {import('settings').Options} */ (this._optionsFull);
        const defaultProfile = (profileCurrent >= 0 && profileCurrent < profiles.length) ? profiles[profileCurrent] : null;
        if (defaultProfile !== null) {
            hotkeyHelpController.setOptions(defaultProfile.options);
        }

        hotkeyHelpController.setupNode(document.documentElement);
    }

    /**
     * @param {import('settings').Profile[]} profiles
     * @param {number} profileCurrent
     */
    _updateProfileSelect(profiles, profileCurrent) {
        /** @type {NodeListOf<HTMLSelectElement>} */
        const selects = document.querySelectorAll('.profile-select');
        for (let i = 0; i < Math.min(selects.length); i++) {
            const fragment = document.createDocumentFragment();
            for (let j = 0, jj = profiles.length; j < jj; ++j) {
                const {name} = profiles[j];
                const option = document.createElement('option');
                option.textContent = name;
                option.value = `${j}`;
                fragment.appendChild(option);
            }
            selects[i].textContent = '';
            selects[i].appendChild(fragment);
            selects[i].value = `${profileCurrent}`;

            if (!this._profileSelectListenersSetup) {
                selects[i].addEventListener('change', this._onProfileSelectChange.bind(this), false);
            }
        }
        this._profileSelectListenersSetup = true;
    }

    /**
     * @param {Event} event
     */
    _onProfileSelectChange(event) {
        const node = /** @type {HTMLInputElement} */ (event.currentTarget);
        const value = Number.parseInt(node.value, 10);
        const optionsFull = this._optionsFull;
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            optionsFull === null ||
            value < 0 ||
            value >= optionsFull.profiles.length
        ) {
            return;
        }
        void this._applyProfileSelection(value).catch((error) => {
            log.error(error);
        });
    }

    /**
     * @param {number} value
     */
    async _setDefaultProfileIndex(value) {
        /** @type {import('settings-modifications').ScopedModificationSet} */
        const modification = {
            action: 'set',
            path: 'profileCurrent',
            value,
            scope: 'global',
            optionsContext: null,
        };
        await this._api.modifySettings([modification], 'action-popup');
    }

    /**
     * @param {number} value
     * @returns {Promise<void>}
     */
    async _applyProfileSelection(value) {
        const optionsFull = this._optionsFull;
        if (optionsFull === null || value < 0 || value >= optionsFull.profiles.length) { return; }

        optionsFull.profileCurrent = value;
        const defaultProfile = optionsFull.profiles[value];
        if (defaultProfile !== null) {
            this._setupOptions(defaultProfile);
        }

        try {
            await this._setDefaultProfileIndex(value);
        } catch (error) {
            await this._refreshOptionsState();
            throw error;
        }
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    async _updateDictionariesEnabledWarnings(options, generation = this._optionsSetupGeneration) {
        const tooltip = document.querySelectorAll('.tooltip');
        const dictionaries = await this._api.getDictionaryInfo();
        if (generation !== this._optionsSetupGeneration) { return; }

        const enabledDictionaries = new Set();
        for (const {name, enabled} of options.dictionaries) {
            if (enabled) {
                enabledDictionaries.add(name);
            }
        }

        let enabledCount = 0;
        for (const {title} of dictionaries) {
            if (enabledDictionaries.has(title)) {
                ++enabledCount;
            }
        }

        updateDictionaryWarningTooltips(tooltip, enabledCount > 0, () => {
            void this._updateDisplayModifierKey();
        });
    }

    /**
     * @param {import('settings').ProfileOptions} options
     */
    async _updatePermissionsWarnings(options, generation = this._optionsSetupGeneration) {
        const permissions = await getAllPermissions();
        if (generation !== this._optionsSetupGeneration) { return; }
        if (hasRequiredPermissionsForOptions(permissions, options)) { return; }

        const tooltip = document.querySelectorAll('.tooltip');
        for (let i = 0; i < tooltip.length; i++) {
            tooltip[i].innerHTML = '<a class="action-open-permissions">Please enable permissions</a>';
        }
        this._setupButtonEvents('.action-open-permissions', null, chrome.runtime.getURL('/permissions.html'));
    }

    /** @returns {Promise<boolean>} */
    async _isSafari() {
        const {browser} = await this._api.getEnvironmentInfo();
        return browser === 'safari';
    }
}
