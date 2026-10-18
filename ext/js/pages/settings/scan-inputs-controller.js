/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {EventListenerCollection} from '../../core/event-listener-collection.js';
import {log} from '../../core/log.js';
import {convertElementValueToNumber, normalizeModifier} from '../../dom/document-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {ObjectPropertyAccessor} from '../../general/object-property-accessor.js';
import {HotkeyUtil} from '../../input/hotkey-util.js';
import {KeyboardMouseInputField} from './keyboard-mouse-input-field.js';

/** @typedef {import('settings').ScanningInput} ScanningInput */
/** @typedef {{generation: number, context: import('settings').OptionsContext}} Owner */

export class ScanInputsController {
    /** @param {import('./settings-controller.js').SettingsController} settingsController */
    constructor(settingsController) {
        /**
         *
         */
        this._settingsController = settingsController;
        /** @type {?import('environment').OperatingSystem} */
        this._os = null;
        /** @type {HTMLElement} */
        this._container = querySelectorNotNull(document, '#scan-input-list');
        /** @type {HTMLButtonElement} */
        this._addButton = querySelectorNotNull(document, '#scan-input-add');
        /** @type {NodeListOf<HTMLElement>} */
        this._scanningInputCountNodes = document.querySelectorAll('.scanning-input-count');
        /** @type {(ScanInputField|null)[]} */
        this._entries = [];
        /** @type {?import('settings').OptionsContext} */
        this._viewContext = null;
        /** @type {?import('settings').OptionsContext} */
        this._snapshotContext = null;
        /** @type {?{owner: Owner, expected: ScanningInput[], next: ScanningInput[], updateStructure: (() => void)|null, applied: boolean}} */
        this._inflightSave = null;
        /**
         *
         */
        this._viewGeneration = 0;
        /**
         *
         */
        this._readGeneration = 0;
        /** @type {ScanningInput[]} */
        this._savedInputs = [];
        /** @type {Promise<void>} */
        this._mutationTail = Promise.resolve();
    }

    /** @returns {Promise<void>} */
    async prepare() {
        const {platform: {os}} = await this._settingsController.application.api.getEnvironmentInfo();
        this._os = os;
        this._addButton.addEventListener('click', this._onAddButtonClick.bind(this));
        this._settingsController.on('scanInputsChanged', this._onScanInputsChanged.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));
        await this.refresh();
    }

    /** @returns {Promise<void>} */
    async refresh() {
        const generation = ++this._readGeneration;
        const context = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (generation !== this._readGeneration || !this._sameContext(context, this._settingsController.getOptionsContext())) { return; }
        this._onOptionsChanged({options, optionsContext: context});
    }

    /** @param {import('settings-controller').EventArgument<'optionsChanged'>} details */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameContext(optionsContext, this._settingsController.getOptionsContext())) { return; }
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = {...optionsContext};
        this._snapshotContext = {...optionsContext};
        this._savedInputs = structuredClone(options.scanning.inputs);
        for (const entry of this._entries) { entry?.cleanup(); }
        this._entries = [];
        for (const [index, row] of this._savedInputs.entries()) { this._createEntry(row, index); }
        this._updateCounts();
    }

    /** @returns {void} */
    _onOptionsContextChanged() {
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = null;
        this._snapshotContext = null;
    }

    /** @param {import('settings-controller').EventArgument<'scanInputsChanged'>} details */
    _onScanInputsChanged({source, mutation}) {
        if (source === this) { return; }
        if (typeof mutation !== 'undefined' && this._applyKnownMutation(mutation)) { return; }
        void this.refresh().catch((error) => log.error(error));
    }

    /**
     * @param {import('settings-controller').ScanInputsMutation} mutation
     * @returns {boolean}
     */
    _applyKnownMutation(mutation) {
        const {optionsContext, expectedInputs, inputs, previousIndices} = mutation;
        if (this._snapshotContext === null || !this._sameContext(this._snapshotContext, optionsContext) || !this._sameContext(optionsContext, this._settingsController.getOptionsContext()) || previousIndices.length !== inputs.length) { return false; }
        let previous = -1;
        for (const index of previousIndices) {
            if (index === null) { continue; }
            if (!Number.isInteger(index) || index <= previous || index >= expectedInputs.length) { return false; }
            previous = index;
        }
        const expected = JSON.stringify(expectedInputs);
        if (JSON.stringify(this._savedInputs) !== expected) {
            const flight = this._inflightSave;
            if (flight === null || !this._owns(flight.owner) || JSON.stringify(this._savedInputs) !== JSON.stringify(flight.expected) || expected !== JSON.stringify(flight.next)) { return false; }
            this._savedInputs = structuredClone(flight.next);
            if (flight.updateStructure === null) {
                this._adoptInputs(flight.next);
            } else if (!flight.applied) {
                flight.applied = true;
                flight.updateStructure();
            }
        }
        ++this._readGeneration;
        this._viewContext = {...optionsContext};
        const oldEntries = this._entries;
        const used = new Set(previousIndices);
        for (const [index, entry] of oldEntries.entries()) {
            if (!used.has(index)) {
                entry?.cleanup();
            }
        }
        this._savedInputs = structuredClone(inputs);
        this._entries = previousIndices.map((index) => (index === null ? null : oldEntries[index]));
        for (const [index, row] of inputs.entries()) {
            if (previousIndices[index] === null) {
                this._createEntry(row, index);
            } else {
                const entry = this._entries[index];
                entry?.setIndex(index);
                entry?.adoptData(row, true);
            }
        }
        /** @type {Element|null} */
        let anchor = null;
        for (let index = this._entries.length - 1; index >= 0; --index) {
            const node = this._entries[index]?.node;
            if (!node) { continue; }
            if (node.nextElementSibling !== anchor) { this._container.insertBefore(node, anchor); }
            anchor = node;
        }
        this._updateCounts();
        return true;
    }

    /** @param {MouseEvent} event */
    _onAddButtonClick(event) {
        event.preventDefault();
        void this.addInput().catch((error) => log.error(error));
    }

    /** @returns {Promise<void>} */
    async addInput() {
        const owner = this.captureOwner();
        if (owner === null) { return; }
        await this._enqueue(async () => {
            if (!this._owns(owner)) { return; }
            const row = ScanInputsController.createDefaultMouseInput('', '');
            const next = [...structuredClone(this._savedInputs), row];
            if (await this._saveInputs(next, owner, () => {
                this._createEntry(row, next.length - 1);
                this._updateCounts();
            })) {
                const modal = this._addButton.closest('.modal');
                if (modal !== null) {
                    const scroll = querySelectorNotNull(modal, '.modal-body');
                    scroll.scrollTop = scroll.scrollHeight;
                }
            }
        });
    }

    /**
     * @param {number} index
     * @param {ScanInputField|null|undefined} [entry]
     * @returns {Promise<boolean>}
     */
    async removeInput(index, entry = this._entries[index]) {
        const owner = this.captureOwner();
        if (owner === null || entry === null || typeof entry === 'undefined') { return false; }
        return await this._enqueue(async () => {
            if (!this.ownsEntry(entry, owner)) { return false; }
            const currentIndex = entry.index;
            const next = structuredClone(this._savedInputs);
            next.splice(currentIndex, 1);
            return await this._saveInputs(next, owner, () => {
                const [removed] = this._entries.splice(currentIndex, 1);
                removed?.cleanup();
                for (let i = currentIndex; i < this._entries.length; ++i) { this._entries[i]?.setIndex(i); }
                this._updateCounts();
            });
        });
    }

    /**
     * @param {number} index
     * @param {string} property
     * @param {unknown} value
     * @param {boolean} event
     * @param {ScanInputField|null|undefined} [entry]
     * @returns {Promise<boolean>}
     */
    async setProperty(index, property, value, event, entry = this._entries[index]) {
        const owner = this.captureOwner();
        if (owner === null || entry === null || typeof entry === 'undefined' || !this.ownsEntry(entry, owner)) { return false; }
        const externalRevision = entry.getExternalRevision(property);
        return await this._enqueue(async () => {
            for (let attempt = 0; attempt < 2; ++attempt) {
                if (!this.ownsEntry(entry, owner) || entry.getExternalRevision(property) !== externalRevision) { return false; }
                const expected = JSON.stringify(this._savedInputs);
                const next = structuredClone(this._savedInputs);
                new ObjectPropertyAccessor(next[entry.index]).set(ObjectPropertyAccessor.getPathArray(property), value);
                if (await this._saveInputs(next, owner, null, event || property.startsWith('types.'))) {
                    entry.adoptData(next[entry.index]);
                    return true;
                }
                if (JSON.stringify(this._savedInputs) === expected) { return false; }
            }
            return false;
        });
    }

    /**
     * @param {string} name
     * @returns {Element}
     */
    instantiateTemplate(name) { return this._settingsController.instantiateTemplate(name); }

    /**
     * @param {ScanInputField} entry
     * @returns {boolean}
     */
    isEntryCurrent(entry) {
        const owner = this.captureOwner();
        return owner !== null && this.ownsEntry(entry, owner);
    }

    /**
     * @param {ScanningInput[]} next
     * @param {Owner} owner
     * @param {?(() => void)} [updateStructure]
     * @param {boolean} [publish]
     * @returns {Promise<boolean>}
     */
    async _saveInputs(next, owner, updateStructure = null, publish = true) {
        if (!this._owns(owner)) { return false; }
        const expected = structuredClone(this._savedInputs);
        const flight = {owner, expected, next, updateStructure, applied: false};
        this._inflightSave = flight;
        const applyStructure = updateStructure === null ?
null :
() => {
    if (!flight.applied) {
        flight.applied = true;
        updateStructure();
    }
};
        try {
            let results;
            try {
                results = await this._settingsController.modifySettings([{
                    action: 'set',
                    path: 'scanning.inputs',
                    value: next,
                    expectedValue: expected,
                    scope: 'profile',
                    profileId: 'profileId' in owner.context ? owner.context.profileId : null,
                    optionsContext: owner.context,
                }]);
            } catch (error) {
                await this._recoverInputs(owner, expected, next, applyStructure);
                throw error;
            }
            const response = results?.[0];
            if (response?.error) {
                const data = 'data' in response.error ? response.error.data : null;
                if (data !== null && typeof data === 'object' && 'code' in data && data.code === 'stale') { await this._recoverInputs(owner, expected, next, applyStructure); }
                return false;
            }
            if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(response?.result) || JSON.stringify(response.result) !== JSON.stringify(next)) {
                await this._recoverInputs(owner, expected, next, applyStructure);
                throw new Error('Invalid scan input settings response');
            }
            if (!this._owns(owner)) {
                if (this._canReconcileSave(owner, expected)) {
                    ++this._readGeneration;
                    if (applyStructure === null) {
                        this._adoptInputs(next);
                    } else {
                        this._savedInputs = structuredClone(next);
                        applyStructure();
                    }
                    if (publish) { this._triggerScanInputsChanged(); }
                }
                return false;
            }
            const saved = JSON.stringify(this._savedInputs);
            if (saved !== JSON.stringify(expected) && saved !== JSON.stringify(next)) {
                await this._recoverInputs(owner, expected, next, applyStructure);
                return false;
            }
            ++this._readGeneration;
            this._savedInputs = structuredClone(next);
            applyStructure?.();
            if (publish) { this._triggerScanInputsChanged(); }
            return true;
        } finally {
            if (this._inflightSave === flight) { this._inflightSave = null; }
        }
    }

    /**
     * @param {Owner} owner
     * @param {ScanningInput[]} expected
     * @param {ScanningInput[]} next
     * @param {?(() => void)} updateStructure
     * @returns {Promise<void>}
     */
    async _recoverInputs(owner, expected, next, updateStructure) {
        const recoveryOwner = this._owns(owner) ? owner : (this._canReconcileSave(owner, expected) ? this.captureOwner() : null);
        if (recoveryOwner === null) { return; }
        this._viewContext = null;
        const generation = ++this._readGeneration;
        try {
            const options = await this._settingsController.getOptions();
            if (recoveryOwner.generation !== this._viewGeneration || generation !== this._readGeneration || !this._sameContext(recoveryOwner.context, this._settingsController.getOptionsContext())) { return; }
            const actual = options.scanning.inputs;
            const serialized = JSON.stringify(actual);
            if (serialized === JSON.stringify(expected) || serialized === JSON.stringify(next) || serialized === JSON.stringify(this._savedInputs)) {
                this._viewContext = {...recoveryOwner.context};
                if (updateStructure !== null && serialized === JSON.stringify(next) && serialized !== JSON.stringify(expected)) {
                    this._savedInputs = structuredClone(actual);
                    updateStructure();
                } else {
                    this._adoptInputs(actual);
                }
            } else {
                this._onOptionsChanged({options, optionsContext: recoveryOwner.context});
            }
            this._triggerScanInputsChanged();
        } catch (error) {
            // Keep writes blocked until a verified refresh, retaining the save error.
            log.error(error);
        }
    }

    /**
     * @param {Owner} owner
     * @param {ScanningInput[]} expected
     * @returns {boolean}
     */
    _canReconcileSave(owner, expected) {
        return this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext()) && JSON.stringify(this._savedInputs) === JSON.stringify(expected);
    }

    /** @param {ScanningInput[]} rows */
    _adoptInputs(rows) {
        this._savedInputs = structuredClone(rows);
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
     * @param {ScanInputField} entry
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

    /**
     * @param {ScanningInput} row
     * @param {number} index
     */
    _createEntry(row, index) {
        const entry = new ScanInputField(this, row, index, /** @type {import('environment').OperatingSystem} */ (this._os), this._viewGeneration);
        this._entries[index] = entry;
        try {
            entry.prepare(this._container);
        } catch (error) {
            log.error(error);
            entry.cleanup();
            this._entries[index] = null;
        }
    }

    /** @returns {void} */
    _updateCounts() {
        const count = this._entries.filter((entry) => entry !== null).length;
        for (const node of this._scanningInputCountNodes) { node.textContent = String(count); }
    }

    /** @returns {void} */
    _triggerScanInputsChanged() { this._settingsController.trigger('scanInputsChanged', {source: this}); }

    /**
     * @param {string} include
     * @param {string} exclude
     * @returns {import('settings').ScanningInput}
     */
    static createDefaultMouseInput(include, exclude) {
        return {
            include,
            exclude,
            types: {mouse: true, touch: false, pen: false},
            options: {
                showAdvanced: false,
                searchTerms: true,
                searchKanji: true,
                scanOnTouchTap: true,
                scanOnTouchMove: false,
                scanOnTouchPress: false,
                scanOnTouchRelease: false,
                scanOnPenMove: true,
                scanOnPenHover: false,
                scanOnPenReleaseHover: false,
                scanOnPenPress: true,
                scanOnPenRelease: false,
                preventTouchScrolling: true,
                preventPenScrolling: true,
                minimumTouchTime: 0,
            },
        };
    }
}

class ScanInputField {
    /**
     * @param {ScanInputsController} parent
     * @param {ScanningInput} data
     * @param {number} index
     * @param {import('environment').OperatingSystem} os
     * @param {number} generation
     */
    constructor(parent, data, index, os, generation) {
        /**
         *
         */
        this._parent = parent;
        /**
         *
         */
        this._data = structuredClone(data);
        /**
         *
         */
        this._index = index;
        /**
         *
         */
        this._os = os;
        /**
         *
         */
        this._generation = generation;
        /**
         *
         */
        this._isDisposed = false;
        /**
         *
         */
        this._hotkeyUtil = new HotkeyUtil(os);
        /** @type {?HTMLElement} */
        this._node = null;
        /** @type {?KeyboardMouseInputField} */
        this._includeInputField = null;
        /** @type {?KeyboardMouseInputField} */
        this._excludeInputField = null;
        /**
         *
         */
        this._eventListeners = new EventListenerCollection();
        /** @type {Map<string, HTMLInputElement>} */
        this._controls = new Map();
        /** @type {Map<string, number>} */
        this._revisions = new Map();
        /** @type {Map<string, number>} */
        this._externalRevisions = new Map();
        /** @type {Map<string, number>} */
        this._pending = new Map();
    }

    /** @returns {number} */
    get index() { return this._index; }
    /** @returns {?HTMLElement} */
    get node() { return this._node; }
    /**
     * @param {string} property
     * @returns {number}
     */
    getExternalRevision(property) { return this._externalRevisions.get(property) ?? 0; }
    /** @returns {number} */
    get generation() { return this._generation; }
    /** @returns {boolean} */
    get isDisposed() { return this._isDisposed; }
    /** @param {number} value */
    setIndex(value) { this._index = value; }

    /** @param {HTMLElement} container */
    prepare(container) {
        const node = /** @type {HTMLElement} */ (this._parent.instantiateTemplate('scan-input'));
        this._node = node;
        const include = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.scan-input-field[data-property=include]'));
        const exclude = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.scan-input-field[data-property=exclude]'));
        const includeMouse = /** @type {HTMLButtonElement} */ (querySelectorNotNull(node, '.mouse-button[data-property=include]'));
        const excludeMouse = /** @type {HTMLButtonElement} */ (querySelectorNotNull(node, '.mouse-button[data-property=exclude]'));
        const menu = querySelectorNotNull(node, '.scanning-input-menu-button');
        this._controls.set('include', include);
        this._controls.set('exclude', exclude);
        this._includeInputField = new KeyboardMouseInputField(include, includeMouse, this._os, this._isPointerTypeSupported.bind(this));
        this._excludeInputField = new KeyboardMouseInputField(exclude, excludeMouse, this._os, this._isPointerTypeSupported.bind(this));
        this._includeInputField.prepare(null, this._splitModifiers(this._data.include), true, false);
        this._excludeInputField.prepare(null, this._splitModifiers(this._data.exclude), true, false);
        this._eventListeners.on(this._includeInputField, 'change', ({modifiers}) => {
            void this._setProperty('include', modifiers.join(', ')).catch((error) => log.error(error));
        });
        this._eventListeners.on(this._excludeInputField, 'change', ({modifiers}) => {
            void this._setProperty('exclude', modifiers.join(', ')).catch((error) => log.error(error));
        });
        for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (node.querySelectorAll('.scan-input-settings-checkbox, .scan-input-settings-input'))) {
            const {property} = input.dataset;
            if (typeof property !== 'string') { continue; }
            delete input.dataset.setting;
            this._controls.set(property, input);
            this._applyValue(property);
            this._eventListeners.addEventListener(input, 'change', () => {
                const value = input.type === 'checkbox' ? input.checked : convertElementValueToNumber(input.value, input);
                if (input.type !== 'checkbox') { input.value = String(value); }
                void this._setProperty(property, value).catch((error) => log.error(error));
            });
        }
        this._applyValue('options.showAdvanced');
        this._eventListeners.addEventListener(menu, 'menuOpen', this._onMenuOpen.bind(this));
        this._eventListeners.addEventListener(menu, 'menuClose', this._onMenuClose.bind(this));
        container.appendChild(node);
    }

    /**
     * @param {ScanningInput} data
     * @param {boolean} [external]
     */
    adoptData(data, external = false) {
        const previous = this._data;
        const properties = [...this._controls.keys(), 'options.showAdvanced'];
        if (external) {
            for (const property of properties) {
                const parts = ObjectPropertyAccessor.getPathArray(property);
                if (JSON.stringify(new ObjectPropertyAccessor(previous).get(parts)) !== JSON.stringify(new ObjectPropertyAccessor(data).get(parts))) {
                    this._externalRevisions.set(property, this.getExternalRevision(property) + 1);
                }
            }
        }
        const updates = properties.filter((property) => (this._pending.get(property) ?? 0) === 0 && this._controlValue(property) === this._displayValue(property, previous));
        this._data = structuredClone(data);
        for (const property of updates) { this._applyValue(property); }
    }

    /** @returns {void} */
    cleanup() {
        this._isDisposed = true;
        this._eventListeners.removeAllEventListeners();
        this._includeInputField?.cleanup();
        this._excludeInputField?.cleanup();
        this._includeInputField = null;
        this._excludeInputField = null;
        this._controls.clear();
        this._node?.remove();
        this._node = null;
    }

    /**
     * @param {string} property
     * @param {unknown} value
     * @returns {Promise<void>}
     */
    async _setProperty(property, value) {
        const revision = (this._revisions.get(property) ?? 0) + 1;
        this._revisions.set(property, revision);
        const requested = this._controlValue(property);
        this._pending.set(property, (this._pending.get(property) ?? 0) + 1);
        try {
            await this._parent.setProperty(this._index, property, value, property === 'include' || property === 'exclude', this);
        } finally {
            const remaining = (this._pending.get(property) ?? 1) - 1;
            if (remaining === 0) {
                this._pending.delete(property);
            } else {
                this._pending.set(property, remaining);
            }
            if (this._parent.isEntryCurrent(this) && this._revisions.get(property) === revision && remaining === 0 && this._controlValue(property) === requested) {
                this._applyValue(property);
            }
        }
    }

    /**
     * @param {string} property
     * @returns {string|boolean|undefined}
     */
    _controlValue(property) {
        if (property === 'options.showAdvanced') { return this._node?.dataset.showAdvanced === 'true'; }
        const input = this._controls.get(property);
        return input?.type === 'checkbox' ? input.checked : input?.value;
    }

    /**
     * @param {string} property
     * @param {ScanningInput} data
     * @returns {string|boolean}
     */
    _displayValue(property, data) {
        const value = new ObjectPropertyAccessor(data).get(ObjectPropertyAccessor.getPathArray(property));
        if (property === 'include' || property === 'exclude') {
            return this._hotkeyUtil.getInputDisplayValue(null, this._hotkeyUtil.sortModifiers(this._splitModifiers(String(value))));
        }
        return typeof value === 'boolean' ? value : String(value);
    }

    /** @param {string} property */
    _applyValue(property) {
        const value = this._displayValue(property, this._data);
        switch (property) {
            case 'options.showAdvanced': {
                if (this._node !== null) { this._node.dataset.showAdvanced = String(value); }

                break;
            }
            case 'include': {
                this._includeInputField?.setInput(null, this._splitModifiers(this._data.include));

                break;
            }
            case 'exclude': {
                this._excludeInputField?.setInput(null, this._splitModifiers(this._data.exclude));

                break;
            }
            default: {
                const input = this._controls.get(property);
                if (typeof input === 'undefined') { return; }
                if (input.type === 'checkbox') {
                    input.checked = value === true;
                } else {
                    input.value = String(value);
                }
            }
        }
    }

    /** @param {import('popup-menu').MenuOpenEvent} event */
    _onMenuOpen(event) {
        const advanced = this._node?.dataset.showAdvanced === 'true';
        const show = /** @type {?HTMLElement} */ (event.detail.menu.bodyNode.querySelector('[data-menu-action="showAdvanced"]'));
        const hide = /** @type {?HTMLElement} */ (event.detail.menu.bodyNode.querySelector('[data-menu-action="hideAdvanced"]'));
        if (show !== null) { show.hidden = advanced; }
        if (hide !== null) { hide.hidden = !advanced; }
    }

    /** @param {import('popup-menu').MenuCloseEvent} event */
    _onMenuClose(event) {
        switch (event.detail.action) {
            case 'remove':
                void this._parent.removeInput(this._index, this).catch((error) => log.error(error));
                break;
            case 'showAdvanced':
            case 'hideAdvanced':
                if (this._node !== null) { this._node.dataset.showAdvanced = String(event.detail.action === 'showAdvanced'); }
                void this._setProperty('options.showAdvanced', event.detail.action === 'showAdvanced').catch((error) => log.error(error));
                break;
            case 'clearInputs':
                this._includeInputField?.clearInputs();
                this._excludeInputField?.clearInputs();
                break;
        }
    }

    /**
     * @param {string} pointerType
     * @returns {boolean}
     */
    _isPointerTypeSupported(pointerType) { return this._controls.get('types.'.concat(pointerType))?.checked === true; }

    /**
     * @param {string} value
     * @returns {import('input').Modifier[]}
     */
    _splitModifiers(value) {
        /** @type {import('input').Modifier[]} */
        const result = [];
        for (const item of value.split(/[,;\s]+/)) {
            const modifier = normalizeModifier(item.trim().toLowerCase());
            if (modifier !== null) { result.push(modifier); }
        }
        return result;
    }
}
