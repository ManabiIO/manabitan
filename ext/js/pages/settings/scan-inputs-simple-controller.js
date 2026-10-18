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

import {log} from '../../core/log.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {HotkeyUtil} from '../../input/hotkey-util.js';
import {ScanInputsController} from './scan-inputs-controller.js';

/** @typedef {import('settings').ScanningInput} ScanningInput */
/** @typedef {{generation: number, context: import('settings').OptionsContext}} Owner */
/** @typedef {{generation: number, revision: number, pending: number, requested: string|boolean}} EditState */

export class ScanInputsSimpleController {
    /** @param {import('./settings-controller.js').SettingsController} settingsController */
    constructor(settingsController) {
        /**
         *
         */
        this._settingsController = settingsController;
        /** @type {HTMLInputElement} */
        this._middleMouseButtonScan = querySelectorNotNull(document, '#middle-mouse-button-scan');
        /** @type {HTMLSelectElement} */
        this._mainScanModifierKeyInput = querySelectorNotNull(document, '#main-scan-modifier-key');
        /**
         *
         */
        this._mainScanModifierKeyInputHasOther = false;
        /**
         *
         */
        this._hotkeyUtil = new HotkeyUtil();
        /** @type {?import('settings').OptionsContext} */
        this._viewContext = null;
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
        /** @type {Map<string, EditState>} */
        this._edits = new Map();
    }

    /** @returns {Promise<void>} */
    async prepare() {
        const {platform: {os}} = await this._settingsController.application.api.getEnvironmentInfo();
        this._hotkeyUtil.os = os;
        this._populateSelect(this._mainScanModifierKeyInput, false);
        this._middleMouseButtonScan.addEventListener('change', this.onMiddleMouseButtonScanChange.bind(this));
        this._mainScanModifierKeyInput.addEventListener('change', this._onMainScanModifierKeyInputChange.bind(this));
        this._settingsController.on('scanInputsChanged', this._onScanInputsChanged.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));
        await this.refresh();
    }

    /** @returns {Promise<void>} */
    async refresh() {
        const read = ++this._readGeneration;
        const context = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (read !== this._readGeneration || !this._sameContext(context, this._settingsController.getOptionsContext())) { return; }
        this._onOptionsChanged({options, optionsContext: context});
    }

    /** @param {import('settings-controller').EventArgument<'optionsChanged'>} details */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameContext(optionsContext, this._settingsController.getOptionsContext())) { return; }
        const force = this._viewContext === null || !this._sameContext(this._viewContext, optionsContext);
        ++this._readGeneration;
        this._viewContext = {...optionsContext};
        this._adoptInputs(options.scanning.inputs, force);
    }

    /** @returns {void} */
    _onOptionsContextChanged() {
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = null;
    }

    /** @param {import('settings-controller').EventArgument<'scanInputsChanged'>} details */
    _onScanInputsChanged({source}) {
        if (source !== this) { void this.refresh().catch((error) => log.error(error)); }
    }

    /** @param {Event} event */
    onMiddleMouseButtonScanChange(event) {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        void this._handleMiddleMouseButtonScanChange(input, input.checked).catch((error) => log.error(error));
    }

    /** @param {Event} event */
    _onMainScanModifierKeyInputChange(event) {
        const input = /** @type {HTMLSelectElement} */ (event.currentTarget);
        const value = input.value;
        if (value !== 'other') { void this._handleMainScanModifierKeyInputChange(input, value === 'none' ? [] : [value]).catch((error) => log.error(error)); }
    }

    /**
     * @param {HTMLInputElement} element
     * @param {boolean} value
     * @returns {Promise<void>}
     */
    async _handleMiddleMouseButtonScanChange(element, value) {
        if (element !== this._middleMouseButtonScan) { return; }
        try {
            await this._runEdit('middle', value, (rows, previousIndices) => {
                const index = this._getIndexOfMiddleMouseButtonScanInput(rows);
                if (value) {
                    if (index >= 0) { return; }
                    const main = this._getIndexOfMainScanInput(rows);
                    const insertion = main >= 0 ? main + 1 : rows.length;
                    rows.splice(insertion, 0, ScanInputsController.createDefaultMouseInput('mouse2', ''));
                    previousIndices.splice(insertion, 0, null);
                } else {
                    let removal = index;
                    while (removal >= 0) {
                        rows.splice(removal, 1);
                        previousIndices.splice(removal, 1);
                        removal = this._getIndexOfMiddleMouseButtonScanInput(rows);
                    }
                }
            });
        } catch (error) {
            log.error(error);
        }
    }

    /**
     * @param {HTMLSelectElement} element
     * @param {string[]} values
     * @returns {Promise<void>}
     */
    async _handleMainScanModifierKeyInputChange(element, values) {
        if (element !== this._mainScanModifierKeyInput) { return; }
        const value = values.join(', ');
        try {
            await this._runEdit('main', element.value, (rows, previousIndices) => {
                const index = this._getIndexOfMainScanInput(rows);
                if (index < 0) {
                    rows.push(ScanInputsController.createDefaultMouseInput(value, 'mouse0'));
                    previousIndices.push(null);
                } else {
                    rows[index].include = value;
                }
            });
        } catch (error) {
            log.error(error);
        }
    }

    /**
     * @param {string} field
     * @param {string|boolean} requested
     * @param {(rows: ScanningInput[], previousIndices: (number|null)[]) => void} transform
     * @returns {Promise<void>}
     */
    async _runEdit(field, requested, transform) {
        const owner = this._captureOwner();
        if (owner === null) { return; }
        let state = this._edits.get(field);
        if (typeof state === 'undefined' || state.generation !== owner.generation) {
            state = {generation: owner.generation, revision: 0, pending: 0, requested};
            this._edits.set(field, state);
        }
        const revision = ++state.revision;
        ++state.pending;
        state.requested = requested;
        try {
            const operation = this._mutationTail.then(async () => { await this._commit(owner, transform); });
            this._mutationTail = operation.then(() => {}, () => {});
            await operation;
        } finally {
            --state.pending;
            if (this._owns(owner) && this._edits.get(field) === state && state.revision === revision && state.pending === 0 && this._controlValue(field) === requested) {
                this._applyField(field);
            }
        }
    }

    /**
     * @param {Owner} owner
     * @param {(rows: ScanningInput[], previousIndices: (number|null)[]) => void} transform
     * @returns {Promise<void>}
     */
    async _commit(owner, transform) {
        for (let attempt = 0; attempt < 2; ++attempt) {
            if (!this._owns(owner)) { return; }
            const expected = structuredClone(this._savedInputs);
            const next = structuredClone(expected);
            /** @type {(number|null)[]} */
            const previousIndices = expected.map((_, index) => index);
            transform(next, previousIndices);
            if (JSON.stringify(next) === JSON.stringify(expected)) { return; }
            /** @type {import('settings-controller').ScanInputsMutation} */
            const mutation = {optionsContext: {...owner.context}, expectedInputs: expected, inputs: next, previousIndices};
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
                await this._recover(owner, expected, mutation);
                throw error;
            }
            const response = results?.[0];
            if (response?.error) {
                const data = 'data' in response.error ? response.error.data : null;
                if (data !== null && typeof data === 'object' && 'code' in data && data.code === 'stale' && await this._recover(owner, expected, mutation)) { continue; }
                return;
            }
            if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(response?.result) || JSON.stringify(response.result) !== JSON.stringify(next)) {
                await this._recover(owner, expected, mutation);
                throw new Error('Invalid scan input settings response');
            }
            if (this._owns(owner) || this._canReconcile(owner, expected)) {
                const saved = JSON.stringify(this._savedInputs);
                if (saved !== JSON.stringify(expected) && saved !== JSON.stringify(next)) {
                    await this._recover(owner, expected, mutation);
                    return;
                }
                ++this._readGeneration;
                this._adoptInputs(next);
                this._triggerScanInputsChanged(mutation);
            }
            return;
        }
    }

    /**
     * @param {Owner} owner
     * @param {ScanningInput[]} expected
     * @param {import('settings-controller').ScanInputsMutation} mutation
     * @returns {Promise<boolean>}
     */
    async _recover(owner, expected, mutation) {
        const currentOwner = this._owns(owner) ? owner : (this._canReconcile(owner, expected) ? this._captureOwner() : null);
        if (currentOwner === null) { return false; }
        this._viewContext = null;
        const read = ++this._readGeneration;
        try {
            const options = await this._settingsController.getOptions();
            if (read !== this._readGeneration || currentOwner.generation !== this._viewGeneration || !this._sameContext(currentOwner.context, this._settingsController.getOptionsContext())) { return false; }
            this._viewContext = {...currentOwner.context};
            this._adoptInputs(options.scanning.inputs);
            if (JSON.stringify(options.scanning.inputs) === JSON.stringify(mutation.inputs)) { this._triggerScanInputsChanged(mutation); }
            return this._owns(owner);
        } catch (error) {
            log.error(error);
            return false;
        }
    }

    /** @returns {?Owner} */
    _captureOwner() {
        const context = this._settingsController.getOptionsContext();
        return this._viewContext !== null && this._sameContext(context, this._viewContext) ? {generation: this._viewGeneration, context: {...context}} : null;
    }

    /**
     * @param {Owner} owner
     * @returns {boolean}
     */
    _owns(owner) {
        return owner.generation === this._viewGeneration && this._viewContext !== null && this._sameContext(owner.context, this._viewContext) && this._sameContext(owner.context, this._settingsController.getOptionsContext());
    }

    /**
     * @param {Owner} owner
     * @param {ScanningInput[]} expected
     * @returns {boolean}
     */
    _canReconcile(owner, expected) {
        return this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext()) && JSON.stringify(this._savedInputs) === JSON.stringify(expected);
    }

    /**
     * @param {import('settings').OptionsContext} a
     * @param {import('settings').OptionsContext} b
     * @returns {boolean}
     */
    _sameContext(a, b) { return a.index === b.index && ('profileId' in a ? a.profileId : null) === ('profileId' in b ? b.profileId : null); }

    /**
     * @param {ScanningInput[]} rows
     * @param {boolean} [force]
     */
    _adoptInputs(rows, force = false) {
        const previous = this._savedInputs;
        const updates = ['main', 'middle'].filter((field) => {
            const state = this._edits.get(field);
            return (force || this._controlValue(field) === this._summaryValue(field, previous)) && !(state?.generation === this._viewGeneration && state.pending > 0);
        });
        this._savedInputs = structuredClone(rows);
        for (const field of updates) { this._applyField(field); }
    }

    /**
     * @param {string} field
     * @returns {string|boolean}
     */
    _controlValue(field) { return field === 'middle' ? this._middleMouseButtonScan.checked : this._mainScanModifierKeyInput.value; }

    /**
     * @param {string} field
     * @param {ScanningInput[]} rows
     * @returns {string|boolean}
     */
    _summaryValue(field, rows) {
        if (field === 'middle') { return this._getIndexOfMiddleMouseButtonScanInput(rows) >= 0; }
        const index = this._getIndexOfMainScanInput(rows);
        return index >= 0 ? this._splitValue(rows[index].include)[0] ?? 'none' : 'other';
    }

    /** @param {string} field */
    _applyField(field) {
        const value = this._summaryValue(field, this._savedInputs);
        if (field === 'middle') {
            this._middleMouseButtonScan.checked = value === true;
        } else {
            const hasOther = value === 'other';
            if (hasOther !== this._mainScanModifierKeyInputHasOther) {
                this._mainScanModifierKeyInputHasOther = hasOther;
                this._populateSelect(this._mainScanModifierKeyInput, hasOther);
            }
            this._mainScanModifierKeyInput.value = String(value);
        }
    }

    /** @param {import('settings-controller').ScanInputsMutation} mutation */
    _triggerScanInputsChanged(mutation) { this._settingsController.trigger('scanInputsChanged', {source: this, mutation}); }

    /**
     * @param {HTMLSelectElement} select
     * @param {boolean} hasOther
     */
    _populateSelect(select, hasOther) {
        const modifierKeys = [
            {value: 'none', name: 'No key'},
        ];
        for (const value of /** @type {import('input').ModifierKey[]} */ (['alt', 'ctrl', 'shift', 'meta'])) {
            const name = this._hotkeyUtil.getModifierDisplayValue(value);
            modifierKeys.push({value, name});
        }

        if (hasOther) {
            modifierKeys.push({value: 'other', name: 'Other'});
        }

        const fragment = document.createDocumentFragment();
        for (const {value, name} of modifierKeys) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = name;
            fragment.appendChild(option);
        }
        select.textContent = '';
        select.appendChild(fragment);
    }

    /**
     * @param {string} value
     * @returns {string[]}
     */
    _splitValue(value) {
        return value.split(/[,;\s]+/).map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
    }

    /**
     * @param {import('settings').ScanningInput[]} inputs
     * @returns {number}
     */
    _getIndexOfMainScanInput(inputs) {
        for (let i = 0, ii = inputs.length; i < ii; ++i) {
            const {include, exclude, types: {mouse}} = inputs[i];
            if (!mouse) { continue; }
            const includeValues = this._splitValue(include);
            const excludeValues = this._splitValue(exclude);
            if (
                (
                    includeValues.length === 0 ||
                    (includeValues.length === 1 && !this._isMouseInput(includeValues[0]))
                ) &&
                excludeValues.length === 1 &&
                excludeValues[0] === 'mouse0'
            ) {
                return i;
            }
        }
        return -1;
    }

    /**
     * @param {import('settings').ScanningInput[]} inputs
     * @returns {number}
     */
    _getIndexOfMiddleMouseButtonScanInput(inputs) {
        for (let i = 0, ii = inputs.length; i < ii; ++i) {
            const {include, exclude, types: {mouse}} = inputs[i];
            if (!mouse) { continue; }
            const includeValues = this._splitValue(include);
            const excludeValues = this._splitValue(exclude);
            if (
                (includeValues.length === 1 && includeValues[0] === 'mouse2') &&
                excludeValues.length === 0
            ) {
                return i;
            }
        }
        return -1;
    }

    /**
     * @param {string} input
     * @returns {boolean}
     */
    _isMouseInput(input) {
        return /^mouse\d+$/.test(input);
    }
}
