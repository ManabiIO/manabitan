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
import {convertElementValueToNumber, normalizeModifierKey} from '../../dom/document-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {ObjectPropertyAccessor} from '../../general/object-property-accessor.js';
import {HotkeyUtil} from '../../input/hotkey-util.js';
import {log} from '../../core/log.js';
import {KeyboardMouseInputField} from './keyboard-mouse-input-field.js';

/** @typedef {import('settings').InputsHotkeyOptions} Hotkey */
/** @typedef {import('settings').InputsHotkeyScope} Scope */
/** @typedef {{generation: number, context: import('settings').OptionsContext}} Owner */
/** @typedef {(row: Hotkey) => (boolean|void)} RowMutation */

export class KeyboardShortcutController {
    /** @param {import('./settings-controller.js').SettingsController} settingsController */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {(KeyboardShortcutHotkeyEntry|null)[]} */
        this._entries = [];
        /** @type {?import('settings').OptionsContext} */
        this._viewContext = null;
        /** @type {number} */
        this._viewGeneration = 0;
        /** @type {number} */
        this._readGeneration = 0;
        /** @type {Promise<void>} */
        this._mutationTail = Promise.resolve();
        /** @type {number} */
        this._mutationRequestGeneration = 0;
        /** @type {Hotkey[]} */
        this._savedHotkeys = [];
        /** @type {?import('environment').OperatingSystem} */
        this._os = null;
        /** @type {HTMLButtonElement} */
        this._addButton = querySelectorNotNull(document, '#hotkey-list-add');
        /** @type {HTMLButtonElement} */
        this._resetButton = querySelectorNotNull(document, '#hotkey-list-reset');
        /** @type {HTMLElement} */
        this._listContainer = querySelectorNotNull(document, '#hotkey-list');
        /** @type {HTMLElement} */
        this._emptyIndicator = querySelectorNotNull(document, '#hotkey-list-empty');
        /** @type {Intl.Collator} */
        this._stringComparer = new Intl.Collator('en-US');
        /** @type {HTMLElement} */
        this._scrollContainer = querySelectorNotNull(document, '#keyboard-shortcuts-modal .modal-body');
        /* eslint-disable @stylistic/no-multi-spaces */
        /** @type {Map<string, import('keyboard-shortcut-controller').ActionDetails>} */
        this._actionDetails = new Map([
            ['',                                 {scopes: new Set()}],
            ['close',                            {scopes: new Set(['popup', 'search'])}],
            ['focusSearchBox',                   {scopes: new Set(['search'])}],
            ['nextEntry',                        {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-move-offset', default: '1'}}],
            ['previousEntry',                    {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-move-offset', default: '1'}}],
            ['lastEntry',                        {scopes: new Set(['popup', 'search'])}],
            ['firstEntry',                       {scopes: new Set(['popup', 'search'])}],
            ['nextEntryDifferentDictionary',     {scopes: new Set(['popup', 'search'])}],
            ['previousEntryDifferentDictionary', {scopes: new Set(['popup', 'search'])}],
            ['historyBackward',                  {scopes: new Set(['popup', 'search'])}],
            ['historyForward',                   {scopes: new Set(['popup', 'search'])}],
            ['profilePrevious',                  {scopes: new Set(['popup', 'search', 'web'])}],
            ['profileNext',                      {scopes: new Set(['popup', 'search', 'web'])}],
            ['addNote',                          {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-anki-card-format', default: '0'}}],
            ['viewNotes',                        {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-anki-card-format', default: '0'}}],
            ['playAudio',                        {scopes: new Set(['popup', 'search'])}],
            ['playAudioFromSource',              {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-audio-source', default: 'jpod101'}}],
            ['copyHostSelection',                {scopes: new Set(['popup'])}],
            ['scanSelectedText',                 {scopes: new Set(['web'])}],
            ['scanTextAtSelection',              {scopes: new Set(['web'])}],
            ['scanTextAtCaret',                  {scopes: new Set(['web'])}],
            ['toggleOption',                     {scopes: new Set(['popup', 'search']), argument: {template: 'hotkey-argument-setting-path', default: ''}}],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
    }

    /** @returns {import('./settings-controller.js').SettingsController} */
    get settingsController() { return this._settingsController; }

    /** @returns {Promise<void>} */
    async prepare() {
        const {platform: {os}} = await this._settingsController.application.api.getEnvironmentInfo();
        this._os = os;
        this._addButton.addEventListener('click', this._onAddClick.bind(this));
        this._resetButton.addEventListener('click', this._onResetClick.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));
        await this._updateOptions();
    }

    /**
     * @param {Hotkey} data
     * @returns {Promise<void>}
     */
    async addEntry(data) {
        const owner = this.captureOwner();
        if (owner === null) { return; }
        this.noteMutationRequest();
        await this._enqueue(async () => {
            if (!this._owns(owner)) { return; }
            const item = structuredClone(data);
            const next = [...structuredClone(this._savedHotkeys), item];
            if (await this._saveHotkeys(next, owner, () => {
                this._createEntry(item, next.length - 1);
                this._updateEmptyState();
            })) {
                this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
            }
        });
    }

    /**
     * @param {number} index
     * @param {KeyboardShortcutHotkeyEntry|null|undefined} [entry]
     * @returns {Promise<boolean>}
     */
    async deleteEntry(index, entry = this._entries[index]) {
        const owner = this.captureOwner();
        if (owner === null || entry === null || typeof entry === 'undefined') { return false; }
        this.noteMutationRequest();
        return await this._enqueue(async () => {
            if (!this.ownsEntry(entry, owner)) { return false; }
            const currentIndex = entry.index;
            const next = structuredClone(this._savedHotkeys);
            next.splice(currentIndex, 1);
            return await this._saveHotkeys(next, owner, () => {
                const [removed] = this._entries.splice(currentIndex, 1);
                removed?.cleanup();
                for (let i = currentIndex; i < this._entries.length; ++i) { this._entries[i]?.setIndex(i); }
                this._updateEmptyState();
            });
        });
    }

    /**
     * @param {KeyboardShortcutHotkeyEntry} entry
     * @param {RowMutation} transform
     * @returns {Promise<boolean>}
     */
    async setEntry(entry, transform) {
        const owner = this.captureOwner();
        if (owner === null || !this.ownsEntry(entry, owner)) { return false; }
        this.noteMutationRequest();
        return await this._enqueue(async () => {
            if (!this.ownsEntry(entry, owner)) { return false; }
            const next = structuredClone(this._savedHotkeys);
            if (transform(next[entry.index]) === false) { return false; }
            if (!await this._saveHotkeys(next, owner)) { return false; }
            entry.adoptData(next[entry.index]);
            return true;
        });
    }

    /** @returns {void} */
    noteMutationRequest() { ++this._mutationRequestGeneration; }

    /** @returns {Promise<Hotkey[]>} */
    async getDefaultHotkeys() {
        const options = await this._settingsController.getDefaultOptions();
        return options.profiles[0].options.inputs.hotkeys;
    }

    /**
     * @param {string} action
     * @returns {import('keyboard-shortcut-controller').ActionDetails|undefined}
     */
    getActionDetails(action) { return this._actionDetails.get(action); }

    /** @returns {Promise<string[]>} */
    async getAnkiCardFormats() {
        const owner = this.captureOwner();
        if (owner === null) { return []; }
        const options = await this._settingsController.getOptions();
        return this._owns(owner) ? options.anki.cardFormats.map(({name}) => name) : [];
    }

    /**
     * @param {KeyboardShortcutHotkeyEntry} entry
     * @returns {boolean}
     */
    isEntryCurrent(entry) {
        const owner = this.captureOwner();
        return owner !== null && this.ownsEntry(entry, owner);
    }

    /** @param {import('settings-controller').EventArgument<'optionsChanged'>} details */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameContext(optionsContext, this._settingsController.getOptionsContext())) { return; }
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = {...optionsContext};
        this._savedHotkeys = structuredClone(options.inputs.hotkeys);
        this._render(this._savedHotkeys);
    }

    /** @returns {void} */
    _onOptionsContextChanged() {
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = null;
    }

    /** @param {MouseEvent} event */
    _onAddClick(event) {
        event.preventDefault();
        void this._addNewEntry().catch((error) => log.error(error));
    }

    /** @param {MouseEvent} event */
    _onResetClick(event) {
        event.preventDefault();
        void this._reset().catch((error) => log.error(error));
    }

    /** @returns {Promise<void>} */
    async _addNewEntry() {
        await this.addEntry({action: '', argument: '', key: null, modifiers: [], scopes: ['popup', 'search'], enabled: true});
    }

    /** @returns {Promise<void>} */
    async _updateOptions() {
        const generation = ++this._readGeneration;
        const context = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (generation !== this._readGeneration || !this._sameContext(context, this._settingsController.getOptionsContext())) { return; }
        this._onOptionsChanged({options, optionsContext: context});
    }

    /** @returns {Promise<void>} */
    async _reset() {
        const owner = this.captureOwner();
        if (owner === null) { return; }
        const request = ++this._mutationRequestGeneration;
        const defaults = await this.getDefaultHotkeys();
        if (!this._owns(owner) || request !== this._mutationRequestGeneration) { return; }
        await this._enqueue(async () => {
            if (!this._owns(owner) || request !== this._mutationRequestGeneration) { return; }
            const next = structuredClone(defaults);
            await this._saveHotkeys(next, owner, () => {
                ++this._viewGeneration;
                this._render(next);
            });
        });
    }

    /**
     * @param {Hotkey[]} next
     * @param {Owner} owner
     * @param {?(() => void)} [updateStructure]
     * @returns {Promise<boolean>}
     */
    async _saveHotkeys(next, owner, updateStructure = null) {
        if (!this._owns(owner)) { return false; }
        const expected = structuredClone(this._savedHotkeys);
        let results;
        try {
            results = await this._settingsController.modifySettings([{
                action: 'set',
                path: 'inputs.hotkeys',
                value: next,
                expectedValue: expected,
                scope: 'profile',
                profileId: 'profileId' in owner.context ? owner.context.profileId : null,
                optionsContext: owner.context,
            }]);
        } catch (error) {
            await this._recoverHotkeys(owner, expected, next, updateStructure);
            throw error;
        }
        const response = results?.[0];
        if (response?.error) {
            const data = 'data' in response.error ? response.error.data : null;
            if (data !== null && typeof data === 'object' && 'code' in data && data.code === 'stale') {
                await this._recoverHotkeys(owner, expected, next, updateStructure);
            }
            return false;
        }
        if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(response?.result) || JSON.stringify(response.result) !== JSON.stringify(next)) {
            await this._recoverHotkeys(owner, expected, next, updateStructure);
            throw new Error('Invalid keyboard shortcut settings response');
        }
        if (!this._owns(owner)) {
            if (this._canReconcileSave(owner, expected)) {
                if (updateStructure === null) {
                    this._adoptHotkeys(next);
                } else {
                    this._savedHotkeys = structuredClone(next);
                    updateStructure();
                }
            }
            return false;
        }
        this._savedHotkeys = structuredClone(next);
        updateStructure?.();
        return true;
    }

    /**
     * @param {Owner} owner
     * @param {Hotkey[]} expected
     * @param {Hotkey[]} next
     * @param {?(() => void)} updateStructure
     * @returns {Promise<void>}
     */
    async _recoverHotkeys(owner, expected, next, updateStructure) {
        const recoveryOwner = this._owns(owner) ? owner : (this._canReconcileSave(owner, expected) ? this.captureOwner() : null);
        if (recoveryOwner === null) { return; }
        this._viewContext = null;
        const generation = ++this._readGeneration;
        try {
            const options = await this._settingsController.getOptions();
            if (recoveryOwner.generation !== this._viewGeneration || generation !== this._readGeneration || !this._sameContext(recoveryOwner.context, this._settingsController.getOptionsContext())) { return; }
            const actual = options.inputs.hotkeys;
            const serialized = JSON.stringify(actual);
            if (serialized === JSON.stringify(expected) || serialized === JSON.stringify(next)) {
                this._viewContext = {...recoveryOwner.context};
                if (updateStructure !== null && serialized !== JSON.stringify(expected)) {
                    this._savedHotkeys = structuredClone(actual);
                    updateStructure();
                } else {
                    this._adoptHotkeys(actual);
                }
            } else {
                this._onOptionsChanged({options, optionsContext: recoveryOwner.context});
            }
        } catch (error) {
            // Keep writes blocked until a verified refresh, retaining the save error.
            log.error(error);
        }
    }

    /**
     * @param {Owner} owner
     * @param {Hotkey[]} expected
     * @returns {boolean}
     */
    _canReconcileSave(owner, expected) {
        return this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext()) && JSON.stringify(this._savedHotkeys) === JSON.stringify(expected);
    }

    /** @param {Hotkey[]} rows */
    _adoptHotkeys(rows) {
        this._savedHotkeys = structuredClone(rows);
        for (const entry of this._entries) {
            if (entry !== null) { entry.adoptData(rows[entry.index]); }
        }
    }

    /**
     * @template T
     * @param {() => Promise<T>} callback
     * @returns {Promise<T>}
     */
    _enqueue(callback) {
        const result = this._mutationTail.then(callback);
        this._mutationTail = result.then(() => {}, () => {});
        return result;
    }

    /** @returns {?Owner} */
    captureOwner() {
        const context = this._settingsController.getOptionsContext();
        return this._viewContext !== null && this._sameContext(context, this._viewContext) ? {generation: this._viewGeneration, context: {...context}} : null;
    }

    /**
     * @param {Owner} owner
     * @returns {boolean}
     */
    _owns(owner) {
        return owner.generation === this._viewGeneration && this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext());
    }

    /**
     * @param {KeyboardShortcutHotkeyEntry} entry
     * @param {Owner} owner
     * @returns {boolean}
     */
    ownsEntry(entry, owner) {
        return this._owns(owner) && !entry.isDisposed && entry.generation === owner.generation && this._entries[entry.index] === entry;
    }

    /**
     * @param {import('settings').OptionsContext} a
     * @param {import('settings').OptionsContext} b
     * @returns {boolean}
     */
    _sameContext(a, b) {
        return a.index === b.index && ('profileId' in a ? a.profileId : null) === ('profileId' in b ? b.profileId : null);
    }

    /** @param {Hotkey[]} rows */
    _render(rows) {
        for (const entry of this._entries) { entry?.cleanup(); }
        this._entries = [];
        for (const [index, row] of rows.entries()) { this._createEntry(row, index); }
        this._updateEmptyState();
    }

    /**
     * @param {Hotkey} data
     * @param {number} index
     */
    _createEntry(data, index) {
        let entry = null;
        try {
            const node = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('hotkey-list-item'));
            entry = new KeyboardShortcutHotkeyEntry(this, data, index, node, /** @type {import('environment').OperatingSystem} */ (this._os), this._stringComparer, this._viewGeneration);
            this._entries[index] = entry;
            this._listContainer.appendChild(node);
            entry.prepare();
        } catch (error) {
            log.error(error);
            entry?.cleanup();
            this._entries[index] = null;
        }
    }

    /** @returns {void} */
    _updateEmptyState() {
        this._listContainer.hidden = this._savedHotkeys.length === 0;
        this._emptyIndicator.hidden = this._savedHotkeys.length > 0;
    }
}

class KeyboardShortcutHotkeyEntry {
    /**
     * @param {KeyboardShortcutController} parent
     * @param {Hotkey} data
     * @param {number} index
     * @param {HTMLElement} node
     * @param {import('environment').OperatingSystem} os
     * @param {Intl.Collator} stringComparer
     * @param {number} generation
     */
    constructor(parent, data, index, node, os, stringComparer, generation) {
        /** @type {KeyboardShortcutController} */
        this._parent = parent;
        /** @type {Hotkey} */
        this._data = structuredClone(data);
        /** @type {number} */
        this._index = index;
        /** @type {number} */
        this._generation = generation;
        /** @type {HTMLElement} */
        this._node = node;
        /** @type {import('environment').OperatingSystem} */
        this._os = os;
        /** @type {Intl.Collator} */
        this._stringComparer = stringComparer;
        /** @type {HotkeyUtil} */
        this._hotkeyUtil = new HotkeyUtil(os);
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {EventListenerCollection} */
        this._scopeMenuEventListeners = new EventListenerCollection();
        /** @type {EventListenerCollection} */
        this._argumentEventListeners = new EventListenerCollection();
        /** @type {?KeyboardMouseInputField} */
        this._inputField = null;
        /** @type {?HTMLInputElement} */
        this._keyInput = null;
        /** @type {?HTMLSelectElement} */
        this._actionSelect = null;
        /** @type {?HTMLInputElement} */
        this._enabledToggle = null;
        /** @type {?HTMLButtonElement} */
        this._enabledButton = null;
        /** @type {?import('../../dom/popup-menu.js').PopupMenu} */
        this._scopeMenu = null;
        /** @type {?HTMLElement} */
        this._argumentContainer = null;
        /** @type {?HTMLInputElement} */
        this._argumentInput = null;
        /** @type {?string} */
        this._argumentWidgetAction = null;
        /** @type {boolean} */
        this._isDisposed = false;
        /** @type {number} */
        this._validationRevision = 0;
        /** @type {number} */
        this._argumentRenderRevision = 0;
        /** @type {Map<string, number>} */
        this._fieldRevisions = new Map();
        /** @type {Map<string, number>} */
        this._pendingEdits = new Map();
        /** @type {Map<string, string|boolean>} */
        this._draftValues = new Map();
    }

    /** @returns {number} */
    get index() { return this._index; }

    /** @returns {number} */
    get generation() { return this._generation; }

    /** @returns {boolean} */
    get isDisposed() { return this._isDisposed; }

    /** @param {number} value */
    setIndex(value) { this._index = value; }

    /** @returns {void} */
    prepare() {
        const node = this._node;
        const menu = querySelectorNotNull(node, '.hotkey-list-item-button');
        const input = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.hotkey-list-item-input'));
        const action = /** @type {HTMLSelectElement} */ (querySelectorNotNull(node, '.hotkey-list-item-action'));
        const enabled = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.hotkey-list-item-enabled'));
        const scopes = querySelectorNotNull(node, '.hotkey-list-item-scopes-button');
        this._enabledButton = /** @type {HTMLButtonElement} */ (querySelectorNotNull(node, '.hotkey-list-item-enabled-button'));
        this._keyInput = input;
        this._actionSelect = action;
        this._enabledToggle = enabled;
        this._argumentContainer = node.querySelector('.hotkey-list-item-action-argument-container');
        this._inputField = new KeyboardMouseInputField(input, null, this._os);
        this._inputField.prepare(this._data.key, this._data.modifiers, false, true);
        action.value = this._data.action;
        enabled.checked = this._data.enabled;
        this._updateScopesButton();
        void this._updateActionArgument().catch((error) => log.error(error));
        this._eventListeners.addEventListener(enabled, 'change', () => {
            void this._setEnabled(enabled.checked).catch((error) => log.error(error));
        });
        this._eventListeners.addEventListener(action, 'change', this._onActionSelectChange.bind(this));
        this._eventListeners.addEventListener(scopes, 'menuOpen', this._onScopesMenuOpen.bind(this));
        this._eventListeners.addEventListener(scopes, 'menuClose', this._onScopesMenuClose.bind(this));
        this._eventListeners.addEventListener(menu, 'menuOpen', this._onMenuOpen.bind(this));
        this._eventListeners.addEventListener(menu, 'menuClose', this._onMenuClose.bind(this));
        this._eventListeners.on(this._inputField, 'change', this._onInputFieldChange.bind(this));
    }

    /** @param {Hotkey} data */
    adoptData(data) {
        const previous = this._data;
        if (this._pending('key') === 0 && this._keyInput?.value === this._hotkeyUtil.getInputDisplayValue(previous.key, previous.modifiers)) {
            this._inputField?.setInput(data.key, data.modifiers);
        }
        if (this._pending('enabled') === 0 && this._enabledToggle !== null && this._enabledToggle.checked === previous.enabled) {
            this._enabledToggle.checked = data.enabled;
        }
        const updateAction = this._pending('action') === 0 && this._actionSelect !== null && this._actionSelect.value === previous.action;
        if (updateAction && this._actionSelect !== null) { this._actionSelect.value = data.action; }
        const updateArgument = this._pending('argument') === 0 && this._argumentWidgetAction === previous.action && this._argumentInput !== null && this._argumentInput.value === previous.argument;
        this._data = structuredClone(data);
        if (updateAction && this._argumentWidgetAction !== data.action) {
            void this._updateActionArgument().catch((error) => log.error(error));
        } else if (updateArgument && this._argumentWidgetAction === data.action && this._argumentInput !== null) {
            this._argumentInput.value = data.argument;
        }
        this._updateScopesButton();
        this._updateScopesMenu();
        this._requestValidation();
    }

    /** @returns {void} */
    cleanup() {
        this._isDisposed = true;
        ++this._validationRevision;
        this._eventListeners.removeAllEventListeners();
        this._inputField?.cleanup();
        this._inputField = null;
        this._clearScopeMenu();
        this._clearArgumentEventListeners();
        this._node.remove();
    }

    /** @param {import('popup-menu').MenuOpenEvent} event */
    _onMenuOpen(event) {
        const details = this._parent.getActionDetails(this._data.action);
        const resetArgument = /** @type {HTMLElement} */ (querySelectorNotNull(event.detail.menu.bodyNode, '.popup-menu-item[data-menu-action="resetArgument"]'));
        resetArgument.hidden = typeof details?.argument === 'undefined';
    }

    /** @param {import('popup-menu').MenuCloseEvent} event */
    _onMenuClose(event) {
        switch (event.detail.action) {
            case 'delete':
                void this._delete().catch((error) => log.error(error));
                break;
            case 'clearInputs':
                this._inputField?.clearInputs();
                break;
            case 'resetInput':
                void this._resetInput().catch((error) => log.error(error));
                break;
            case 'resetArgument':
                void this._resetArgument().catch((error) => log.error(error));
                break;
        }
    }

    /** @param {import('popup-menu').MenuOpenEvent} event */
    _onScopesMenuOpen(event) {
        const validScopes = this._getValidScopesForAction(this._actionSelect?.value ?? this._data.action);
        if (validScopes === null || validScopes.size === 0) {
            event.detail.menu.close();
            return;
        }
        this._scopeMenu = event.detail.menu;
        this._updateScopeMenuItems(event.detail.menu);
        this._updateDisplay(event.detail.menu.containerNode);
    }

    /** @param {import('popup-menu').MenuCloseEvent} event */
    _onScopesMenuClose(event) {
        if (event.detail.action === 'toggleScope') {
            event.preventDefault();
            return;
        }
        if (this._scopeMenu === event.detail.menu) { this._clearScopeMenu(); }
    }

    /** @param {import('keyboard-mouse-input-field').EventArgument<'change'>} details */
    _onInputFieldChange({key, modifiers}) {
        /** @type {import('input').ModifierKey[]} */
        const normalized = [];
        for (const modifier of modifiers) {
            const value = normalizeModifierKey(modifier);
            if (value !== null) { normalized.push(value); }
        }
        void this._setKeyAndModifiers(key, normalized).catch((error) => log.error(error));
    }

    /** @param {Event} event */
    _onScopeCheckboxChange(event) {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        const scope = this._normalizeScope(input.dataset.scope);
        if (scope !== null) { void this._setScopeEnabled(scope, input.checked).catch((error) => log.error(error)); }
    }

    /** @param {Event} event */
    _onActionSelectChange(event) {
        const input = /** @type {HTMLSelectElement} */ (event.currentTarget);
        void this._setAction(input.value).catch((error) => log.error(error));
    }

    /**
     * @param {string} template
     * @param {string} action
     * @param {Event} event
     */
    _onArgumentValueChange(template, action, event) {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        if (input !== this._argumentInput) { return; }
        let value = this._getArgumentInputValue(input);
        if (template === 'hotkey-argument-move-offset') {
            value = String(convertElementValueToNumber(value, input));
            input.value = value;
        }
        void this._setArgument(value, action).catch((error) => log.error(error));
    }

    /** @returns {Promise<void>} */
    async _delete() { await this._parent.deleteEntry(this._index, this); }

    /**
     * @param {string} field
     * @param {string|boolean} requested
     * @param {() => Promise<boolean>} callback
     * @returns {Promise<void>}
     */
    async _runEdit(field, requested, callback) {
        const revision = this._nextRevision(field);
        this._pendingEdits.set(field, this._pending(field) + 1);
        this._draftValues.set(field, requested);
        const argumentInput = this._argumentInput;
        if (field === 'action') { ++this._validationRevision; }
        try {
            await callback();
        } finally {
            const remaining = this._pending(field) - 1;
            if (remaining === 0) {
                this._pendingEdits.delete(field);
                this._draftValues.delete(field);
            } else {
                this._pendingEdits.set(field, remaining);
            }
            if (this._parent.isEntryCurrent(this)) {
                if (this._revision(field) === revision) { this._restoreField(field, requested, argumentInput); }
                this._ensureArgumentWidget();
                this._updateScopesButton();
                this._updateScopesMenu();
                this._requestValidation();
            }
        }
    }

    /**
     * @param {string} field
     * @param {string|boolean} requested
     * @param {?HTMLInputElement} argumentInput
     */
    _restoreField(field, requested, argumentInput) {
        switch (field) {
            case 'key':
                if (this._keyInput?.value === requested) { this._inputField?.setInput(this._data.key, this._data.modifiers); }
                break;
            case 'enabled':
                if (this._enabledToggle !== null && this._enabledToggle.checked === requested) { this._enabledToggle.checked = this._data.enabled; }
                break;
            case 'action':
                if (this._actionSelect?.value === requested) { this._actionSelect.value = this._data.action; }
                break;
            case 'argument':
                if (argumentInput !== null && this._argumentInput === argumentInput && this._argumentWidgetAction === this._data.action && argumentInput.value === requested) {
                    argumentInput.value = this._data.argument;
                }
                break;
        }
    }

    /**
     * @param {string} field
     * @returns {number}
     */
    _pending(field) { return this._pendingEdits.get(field) ?? 0; }

    /**
     * @param {string} field
     * @returns {number}
     */
    _revision(field) { return this._fieldRevisions.get(field) ?? 0; }

    /**
     * @param {string} field
     * @returns {number}
     */
    _nextRevision(field) {
        const revision = this._revision(field) + 1;
        this._fieldRevisions.set(field, revision);
        return revision;
    }

    /** @returns {void} */
    _ensureArgumentWidget() {
        if (this._pending('action') === 0 && this._actionSelect?.value === this._data.action && this._argumentWidgetAction !== this._data.action) {
            void this._updateActionArgument().catch((error) => log.error(error));
        }
    }

    /**
     * @param {?string} key
     * @param {import('input').ModifierKey[]} modifiers
     * @param {?string} [action]
     * @returns {Promise<void>}
     */
    async _setKeyAndModifiers(key, modifiers, action = null) {
        const requested = this._keyInput?.value ?? this._hotkeyUtil.getInputDisplayValue(key, modifiers);
        await this._runEdit('key', requested, async () => await this._parent.setEntry(this, (row) => {
            if (action !== null && row.action !== action) { return false; }
            row.key = key;
            row.modifiers = [...modifiers];
        }));
    }

    /**
     * @param {Scope} scope
     * @param {boolean} enabled
     * @returns {Promise<void>}
     */
    async _setScopeEnabled(scope, enabled) {
        const field = 'scope:'.concat(scope);
        await this._runEdit(field, enabled, async () => await this._parent.setEntry(this, (row) => {
            const validScopes = this._getValidScopesForAction(row.action);
            if (enabled && validScopes !== null && !validScopes.has(scope)) { return false; }
            const index = row.scopes.indexOf(scope);
            if ((index >= 0) === enabled) { return; }
            if (enabled) {
                row.scopes.push(scope);
                row.scopes.sort((a, b) => this._stringComparer.compare(a, b));
            } else {
                row.scopes.splice(index, 1);
            }
        }));
    }

    /**
     * @param {boolean} value
     * @returns {Promise<void>}
     */
    async _setEnabled(value) {
        await this._runEdit('enabled', value, async () => await this._parent.setEntry(this, (row) => { row.enabled = value; }));
    }

    /**
     * @param {string} value
     * @returns {Promise<void>}
     */
    async _setAction(value) {
        await this._runEdit('action', value, async () => await this._parent.setEntry(this, (row) => {
            const previousScopes = this._getValidScopesForAction(row.action);
            const details = this._parent.getActionDetails(value) ?? {scopes: new Set()};
            const validScopes = details.scopes;
            let scopesChanged = false;
            if ((previousScopes !== null ? previousScopes.size : 0) === row.scopes.length) {
                row.scopes.length = 0;
                scopesChanged = true;
            } else {
                for (let i = 0; i < row.scopes.length; ++i) {
                    if (!validScopes.has(row.scopes[i])) {
                        row.scopes.splice(i--, 1);
                        scopesChanged = true;
                    }
                }
            }
            if (scopesChanged && row.scopes.length === 0) { row.scopes.push(...validScopes); }
            row.action = value;
            row.argument = typeof details.argument?.default === 'string' ? details.argument.default : '';
        }));
    }

    /**
     * @param {string} value
     * @param {?string} [action]
     * @returns {Promise<void>}
     */
    async _setArgument(value, action = this._argumentWidgetAction) {
        if (action === null || action !== this._argumentWidgetAction || action !== this._actionSelect?.value) { return; }
        const requested = this._argumentInput?.value ?? value;
        await this._runEdit('argument', requested, async () => await this._parent.setEntry(this, (row) => {
            if (row.action !== action) { return false; }
            row.argument = value;
        }));
    }

    /** @returns {Promise<void>} */
    async _resetInput() {
        const owner = this._parent.captureOwner();
        if (owner === null || !this._parent.ownsEntry(this, owner)) { return; }
        this._parent.noteMutationRequest();
        const keyRevision = this._nextRevision('key');
        const actionRevision = this._revision('action');
        const action = this._actionSelect?.value ?? this._data.action;
        const defaults = await this._parent.getDefaultHotkeys();
        if (!this._parent.ownsEntry(this, owner) || keyRevision !== this._revision('key') || actionRevision !== this._revision('action') || action !== this._actionSelect?.value) { return; }
        const value = this._getDefaultKeyAndModifiers(defaults, action);
        if (value !== null) { await this._setKeyAndModifiers(value.key, value.modifiers, action); }
    }

    /** @returns {Promise<void>} */
    async _resetArgument() {
        const action = this._argumentWidgetAction;
        if (action === null || action !== this._actionSelect?.value) { return; }
        const value = this._parent.getActionDetails(action)?.argument?.default;
        await this._setArgument(typeof value === 'string' ? value : '', action);
    }

    /**
     * @param {Hotkey[]} defaults
     * @param {string} action
     * @returns {?{key: ?string, modifiers: import('settings').InputsHotkeyModifier[]}}
     */
    _getDefaultKeyAndModifiers(defaults, action) {
        for (const row of defaults) {
            if (row.action === action) { return {key: row.key, modifiers: row.modifiers}; }
        }
        return null;
    }

    /** @returns {void} */
    _updateScopesMenu() {
        if (this._scopeMenu !== null) { this._updateScopeMenuItems(this._scopeMenu); }
    }

    /**
     * @param {string} action
     * @returns {?Set<Scope>}
     */
    _getValidScopesForAction(action) { return this._parent.getActionDetails(action)?.scopes ?? null; }

    /** @param {import('../../dom/popup-menu.js').PopupMenu} menu */
    _updateScopeMenuItems(menu) {
        this._scopeMenuEventListeners.removeAllEventListeners();
        const validScopes = this._getValidScopesForAction(this._actionSelect?.value ?? this._data.action);
        for (const item of /** @type {NodeListOf<HTMLElement>} */ (menu.bodyNode.querySelectorAll('.popup-menu-item'))) {
            if (item.dataset.menuAction !== 'toggleScope') { continue; }
            const scope = this._normalizeScope(item.dataset.scope);
            if (scope === null) { continue; }
            item.hidden = !(validScopes === null || validScopes.has(scope));
            const input = /** @type {HTMLInputElement} */ (querySelectorNotNull(item, '.hotkey-scope-checkbox'));
            const field = 'scope:'.concat(scope);
            input.checked = this._pending(field) > 0 ? this._draftValues.get(field) === true : this._data.scopes.includes(scope);
            this._scopeMenuEventListeners.addEventListener(input, 'change', this._onScopeCheckboxChange.bind(this));
        }
    }

    /** @returns {void} */
    _clearScopeMenu() {
        this._scopeMenuEventListeners.removeAllEventListeners();
        this._scopeMenu = null;
    }

    /** @returns {void} */
    _updateScopesButton() {
        if (this._enabledButton !== null) { this._enabledButton.dataset.scopeCount = String(this._data.scopes.length); }
    }

    /** @param {HTMLElement} node */
    _updateDisplay(node) {
        const {display} = node.style;
        node.style.display = 'none';
        getComputedStyle(node).getPropertyValue('display');
        node.style.display = display;
    }

    /** @returns {Promise<void>} */
    async _updateActionArgument() {
        const owner = this._parent.captureOwner();
        if (owner === null || !this._parent.ownsEntry(this, owner)) { return; }
        this._clearArgumentEventListeners();
        const revision = this._argumentRenderRevision;
        const {action, argument} = this._data;
        this._argumentWidgetAction = action;
        if (this._argumentContainer !== null) { this._argumentContainer.textContent = ''; }
        const details = this._parent.getActionDetails(action)?.argument;
        if (typeof details === 'undefined') { return; }
        const {template} = details;
        const node = this._parent.settingsController.instantiateTemplate(template);
        const selector = '.hotkey-argument-input';
        const input = /** @type {?HTMLInputElement} */ (node.matches(selector) ? node : node.querySelector(selector));
        this._argumentInput = input;
        if (input !== null) { input.value = argument; }
        if (template === 'hotkey-argument-anki-card-format') {
            let formats;
            try {
                formats = await this._parent.getAnkiCardFormats();
            } catch (error) {
                if (revision === this._argumentRenderRevision) { this._clearArgumentEventListeners(); }
                throw error;
            }
            if (!this._parent.ownsEntry(this, owner) || revision !== this._argumentRenderRevision || input !== this._argumentInput || action !== this._argumentWidgetAction || action !== this._data.action || action !== this._actionSelect?.value) {
                if (revision === this._argumentRenderRevision) { this._clearArgumentEventListeners(); }
                return;
            }
            const value = this._pending('argument') > 0 && input !== null ? input.value : this._data.argument;
            const select = /** @type {HTMLSelectElement} */ (querySelectorNotNull(node, '.anki-card-format-select'));
            for (const [index, name] of formats.entries()) {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = name;
                select.appendChild(option);
            }
            if (input !== null) { input.value = value; }
        }
        if (input !== null) {
            this._argumentEventListeners.addEventListener(input, 'input', () => {
                if (!this._parent.isEntryCurrent(this)) { return; }
                this._parent.noteMutationRequest();
                this._nextRevision('argument');
                this._requestValidation();
            });
            this._argumentEventListeners.addEventListener(input, 'change', this._onArgumentValueChange.bind(this, template, action));
        }
        this._argumentContainer?.appendChild(node);
        this._requestValidation();
    }

    /** @returns {void} */
    _clearArgumentEventListeners() {
        ++this._argumentRenderRevision;
        ++this._validationRevision;
        this._argumentEventListeners.removeAllEventListeners();
        this._argumentInput = null;
        this._argumentWidgetAction = null;
    }

    /**
     * @param {HTMLInputElement} node
     * @returns {string}
     */
    _getArgumentInputValue(node) { return node.value; }

    /** @returns {void} */
    _requestValidation() { void this._updateArgumentInputValidity().catch((error) => log.error(error)); }

    /** @returns {Promise<void>} */
    async _updateArgumentInputValidity() {
        const input = this._argumentInput;
        const action = this._argumentWidgetAction;
        const owner = this._parent.captureOwner();
        if (input === null || action === null || action !== this._actionSelect?.value || owner === null || !this._parent.ownsEntry(this, owner)) { return; }
        const value = input.value;
        const revision = ++this._validationRevision;
        const template = this._parent.getActionDetails(action)?.argument?.template;
        const valid = template !== 'hotkey-argument-setting-path' || await this._isHotkeyArgumentSettingPathValid(value);
        if (this._parent.ownsEntry(this, owner) && revision === this._validationRevision && input === this._argumentInput && input.value === value && action === this._argumentWidgetAction && action === this._actionSelect?.value) {
            input.dataset.invalid = String(!valid);
        }
    }

    /**
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async _isHotkeyArgumentSettingPathValid(path) {
        if (path.length === 0) { return true; }
        try {
            const parts = ObjectPropertyAccessor.getPathArray(path);
            const owner = this._parent.captureOwner();
            if (owner === null || !this._parent.ownsEntry(this, owner)) { return false; }
            const options = await this._parent.settingsController.getOptions();
            if (!this._parent.ownsEntry(this, owner)) { return false; }
            const accessor = new ObjectPropertyAccessor(options);
            return typeof accessor.get(parts, parts.length) === 'boolean';
        } catch (error) {
            return false;
        }
    }

    /**
     * @param {string|undefined} value
     * @returns {?Scope}
     */
    _normalizeScope(value) {
        switch (value) {
            case 'popup':
            case 'search':
            case 'web':
                return value;
            default:
                return null;
        }
    }
}
