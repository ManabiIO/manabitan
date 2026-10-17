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

/** @typedef {import('settings').TranslationTextReplacementGroup} Replacement */
/** @typedef {keyof Replacement} ReplacementField */
/** @typedef {{generation: number, context: import('settings').OptionsContext}} Owner */

export class TranslationTextReplacementsController {
    /** @param {import('./settings-controller.js').SettingsController} settingsController */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {HTMLElement} */
        this._entryContainer = querySelectorNotNull(document, '#translation-text-replacement-list');
        /** @type {(TranslationTextReplacementsEntry|null)[]} */
        this._entries = [];
        /** @type {?import('settings').OptionsContext} */
        this._viewContext = null;
        /** @type {number} */
        this._viewGeneration = 0;
        /** @type {number} */
        this._readGeneration = 0;
        /** @type {Promise<void>} */
        this._mutationTail = Promise.resolve();
        /** @type {Replacement[][]} */
        this._savedGroups = [];
    }

    /** @returns {Promise<void>} */
    async prepare() {
        const addButton = querySelectorNotNull(document, '#translation-text-replacement-add');
        addButton.addEventListener('click', this._onAdd.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));
        await this._updateOptions();
    }

    /** @returns {Promise<void>} */
    async addGroup() {
        const owner = this._captureOwner();
        if (owner === null) { return; }
        await this._enqueue(async () => {
            if (!this._owns(owner)) { return; }
            const next = structuredClone(this._savedGroups);
            if (next.length === 0) { next.push([]); }
            const item = this._createNewEntry();
            next[0].push(item);
            await this._saveGroups(next, owner, () => { this._createEntry(item, next[0].length - 1); });
        });
    }

    /**
     * @param {number} index
     * @param {TranslationTextReplacementsEntry|null|undefined} [entry]
     * @returns {Promise<boolean>}
     */
    async deleteGroup(index, entry = this._entries[index]) {
        const owner = this._captureOwner();
        if (owner === null || entry === null || typeof entry === 'undefined') { return false; }
        return await this._enqueue(async () => {
            if (!this._ownsEntry(entry, owner)) { return false; }
            const currentIndex = entry.index;
            const next = structuredClone(this._savedGroups);
            next[0].splice(currentIndex, 1);
            const removedFirstGroup = next[0].length === 0;
            if (removedFirstGroup) { next.shift(); }
            return await this._saveGroups(next, owner, () => {
                if (removedFirstGroup) {
                    ++this._viewGeneration;
                    this._render(next);
                } else {
                    const [removedEntry] = this._entries.splice(currentIndex, 1);
                    for (let i = currentIndex; i < this._entries.length; ++i) { this._entries[i]?.setIndex(i); }
                    removedEntry?.cleanup();
                }
            });
        });
    }

    /**
     * @param {TranslationTextReplacementsEntry} entry
     * @param {ReplacementField} field
     * @param {string|boolean} value
     * @returns {Promise<boolean>}
     */
    async setField(entry, field, value) {
        const owner = this._captureOwner();
        if (owner === null || !this._ownsEntry(entry, owner)) { return false; }
        return await this._enqueue(async () => {
            if (!this._ownsEntry(entry, owner)) { return false; }
            const next = structuredClone(this._savedGroups);
            Object.assign(next[0][entry.index], {[field]: value});
            if (!await this._saveGroups(next, owner)) { return false; }
            Object.assign(entry.data, {[field]: value});
            return true;
        });
    }

    /** @param {import('settings-controller').EventArgument<'optionsChanged'>} details */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameContext(optionsContext, this._settingsController.getOptionsContext())) { return; }
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = {...optionsContext};
        this._savedGroups = structuredClone(options.translation.textReplacements.groups);
        this._render(this._savedGroups);
    }

    /** */
    _onOptionsContextChanged() {
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = null;
    }

    /** */
    _onAdd() {
        void this.addGroup().catch((error) => log.error(error));
    }

    /** @returns {Promise<void>} */
    async _updateOptions() {
        const generation = ++this._readGeneration;
        const context = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (generation !== this._readGeneration || !this._sameContext(context, this._settingsController.getOptionsContext())) { return; }
        this._onOptionsChanged({options, optionsContext: context});
    }

    /**
     * @param {Replacement[][]} next
     * @param {Owner} owner
     * @param {?(() => void)} [updateStructure]
     * @returns {Promise<boolean>}
     */
    async _saveGroups(next, owner, updateStructure = null) {
        if (!this._owns(owner)) { return false; }
        const expected = structuredClone(this._savedGroups);
        let results;
        try {
            results = await this._settingsController.modifySettings([{
                action: 'set',
                path: 'translation.textReplacements.groups',
                value: next,
                expectedValue: expected,
                scope: 'profile',
                profileId: 'profileId' in owner.context ? owner.context.profileId : null,
                optionsContext: owner.context,
            }]);
        } catch (error) {
            await this._recoverGroups(owner, expected, next, updateStructure);
            throw error;
        }
        const response = results?.[0];
        if (response?.error) {
            const data = 'data' in response.error ? response.error.data : null;
            if (data !== null && typeof data === 'object' && 'code' in data && data.code === 'stale') {
                await this._recoverGroups(owner, expected, next, updateStructure);
            }
            return false;
        }
        if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(response?.result) || JSON.stringify(response.result) !== JSON.stringify(next)) {
            await this._recoverGroups(owner, expected, next, updateStructure);
            throw new Error('Invalid translation replacement settings response');
        }
        if (!this._owns(owner)) {
            // A revisited profile may have loaded before this earlier save
            // committed. Only reconcile a known full snapshot of that view.
            if (this._canReconcileSave(owner, expected)) {
                if (updateStructure === null) {
                    this._adoptGroups(next);
                } else {
                    // The exact expected snapshot and known operation preserve
                    // surviving row identity, including drafts and queued edits.
                    this._savedGroups = structuredClone(next);
                    updateStructure();
                }
            }
            return false;
        }
        this._savedGroups = structuredClone(next);
        updateStructure?.();
        return true;
    }

    /**
     * @param {Owner} owner
     * @param {Replacement[][]} expected
     * @param {Replacement[][]} next
     * @param {?(() => void)} updateStructure
     * @returns {Promise<void>}
     */
    async _recoverGroups(owner, expected, next, updateStructure) {
        const recoveryOwner = this._owns(owner) ? owner : (this._canReconcileSave(owner, expected) ? this._captureOwner() : null);
        if (recoveryOwner === null) { return; }
        this._viewContext = null;
        const readGeneration = ++this._readGeneration;
        try {
            const options = await this._settingsController.getOptions();
            if (recoveryOwner.generation !== this._viewGeneration || readGeneration !== this._readGeneration || !this._sameContext(recoveryOwner.context, this._settingsController.getOptionsContext())) { return; }
            const groups = options.translation.textReplacements.groups;
            const serialized = JSON.stringify(groups);
            if (serialized === JSON.stringify(expected) || serialized === JSON.stringify(next)) {
                this._viewContext = {...recoveryOwner.context};
                if (updateStructure !== null && serialized !== JSON.stringify(expected)) {
                    this._savedGroups = structuredClone(groups);
                    updateStructure();
                } else {
                    this._adoptGroups(groups);
                }
            } else {
                // Unknown structure has no safe positional draft mapping.
                this._onOptionsChanged({options, optionsContext: recoveryOwner.context});
            }
        } catch (error) {
            // Keep writes blocked until refresh, retaining the primary save error.
            log.error(error);
        }
    }

    /**
     * @param {Owner} owner
     * @param {Replacement[][]} expected
     * @returns {boolean}
     */
    _canReconcileSave(owner, expected) {
        return this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext()) && JSON.stringify(this._savedGroups) === JSON.stringify(expected);
    }

    /** @param {Replacement[][]} groups */
    _adoptGroups(groups) {
        this._savedGroups = structuredClone(groups);
        const rows = groups[0] ?? [];
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
    _captureOwner() {
        const context = this._settingsController.getOptionsContext();
        return this._viewContext !== null && this._sameContext(this._viewContext, context) ? {generation: this._viewGeneration, context: {...context}} : null;
    }

    /**
     * @param {Owner} owner
     * @returns {boolean}
     */
    _owns(owner) {
        return owner.generation === this._viewGeneration && this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext());
    }

    /**
     * @param {TranslationTextReplacementsEntry} entry
     * @param {Owner} owner
     * @returns {boolean}
     */
    _ownsEntry(entry, owner) {
        return this._owns(owner) && !entry.retired && entry.generation === owner.generation && this._entries.includes(entry);
    }

    /**
     * @param {import('settings').OptionsContext} a
     * @param {import('settings').OptionsContext} b
     * @returns {boolean}
     */
    _sameContext(a, b) {
        const id1 = 'profileId' in a ? a.profileId : null;
        const id2 = 'profileId' in b ? b.profileId : null;
        return a.index === b.index && id1 === id2;
    }

    /** @param {Replacement[][]} groups */
    _render(groups) {
        for (const entry of this._entries) { entry?.cleanup(); }
        this._entries = [];
        for (const [index, row] of (groups[0] ?? []).entries()) { this._createEntry(row, index); }
    }

    /**
     * @param {Replacement} row
     * @param {number} index
     */
    _createEntry(row, index) {
        let entry = null;
        try {
            const node = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('translation-text-replacement-entry'));
            entry = new TranslationTextReplacementsEntry(this, row, node, this._viewGeneration, index);
            this._entryContainer.appendChild(node);
            entry.prepare();
            this._entries[index] = entry;
        } catch (error) {
            log.error(error);
            entry?.cleanup();
            this._entries[index] = null;
        }
    }

    /** @returns {Replacement} */
    _createNewEntry() {
        return {pattern: '', ignoreCase: false, replacement: ''};
    }
}

class TranslationTextReplacementsEntry {
    /**
     * @param {TranslationTextReplacementsController} parent
     * @param {Replacement} data
     * @param {HTMLElement} node
     * @param {number} generation
     * @param {number} index
     */
    constructor(parent, data, node, generation, index) {
        /** @type {TranslationTextReplacementsController} */
        this._parent = parent;
        /** @type {Replacement} */
        this._data = structuredClone(data);
        /** @type {HTMLElement} */
        this._node = node;
        /** @type {number} */
        this._generation = generation;
        /** @type {number} */
        this._index = index;
        /** @type {boolean} */
        this._retired = false;
        /** @type {Map<ReplacementField, number>} */
        this._fieldRevisions = new Map();
        /** @type {Map<ReplacementField, number>} */
        this._pendingFieldEdits = new Map();
        /** @type {Map<ReplacementField, HTMLInputElement>} */
        this._fieldInputs = new Map();
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {?HTMLInputElement} */
        this._patternInput = null;
        /** @type {?HTMLInputElement} */
        this._replacementInput = null;
        /** @type {?HTMLInputElement} */
        this._ignoreCaseToggle = null;
        /** @type {?HTMLInputElement} */
        this._testInput = null;
        /** @type {?HTMLInputElement} */
        this._testOutput = null;
    }

    /** @returns {Replacement} */
    get data() { return this._data; }

    /** @returns {boolean} */
    get retired() { return this._retired; }

    /** @returns {number} */
    get generation() { return this._generation; }

    /** @returns {number} */
    get index() { return this._index; }

    /** @param {number} value */
    setIndex(value) { this._index = value; }

    /** */
    prepare() {
        const node = this._node;
        const pattern = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.translation-text-replacement-pattern'));
        const replacement = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.translation-text-replacement-replacement'));
        const ignoreCase = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.translation-text-replacement-pattern-ignore-case'));
        const menu = querySelectorNotNull(node, '.translation-text-replacement-button');
        this._patternInput = pattern;
        this._replacementInput = replacement;
        this._ignoreCaseToggle = ignoreCase;
        const testInput = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.translation-text-replacement-test-input'));
        this._testInput = testInput;
        this._testOutput = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.translation-text-replacement-test-output'));
        for (const [field, input] of /** @type {[ReplacementField, HTMLInputElement][]} */ ([
            ['pattern', pattern], ['replacement', replacement], ['ignoreCase', ignoreCase],
        ])) {
            this._fieldInputs.set(field, input);
            this._eventListeners.addEventListener(input, 'change', () => {
                const value = field === 'ignoreCase' ? input.checked : input.value;
                void this._setFieldValue(field, input, value).catch((error) => log.error(error));
            });
        }
        pattern.value = this._data.pattern;
        replacement.value = this._data.replacement;
        ignoreCase.checked = this._data.ignoreCase;
        this._eventListeners.addEventListener(pattern, 'input', this._onFieldInput.bind(this));
        this._eventListeners.addEventListener(replacement, 'input', this._onFieldInput.bind(this));
        this._eventListeners.addEventListener(menu, 'menuOpen', this._onMenuOpen.bind(this));
        this._eventListeners.addEventListener(menu, 'menuClose', this._onMenuClose.bind(this));
        this._eventListeners.addEventListener(testInput, 'input', this._updateTestInput.bind(this));
        this._validatePattern(pattern.value);
    }

    /** @param {Replacement} row */
    adoptData(row) {
        for (const [field, input] of this._fieldInputs) {
            if ((this._pendingFieldEdits.get(field) ?? 0) !== 0) { continue; }
            if (field === 'ignoreCase') {
                if (input.checked === this._data.ignoreCase) { input.checked = row.ignoreCase; }
            } else if (input.value === this._data[field]) {
                input.value = row[field];
            }
        }
        Object.assign(this._data, row);
        this._onFieldInput();
    }

    /** */
    cleanup() {
        this._retired = true;
        this._eventListeners.removeAllEventListeners();
        this._node.remove();
    }

    /**
     * @param {ReplacementField} field
     * @param {HTMLInputElement} input
     * @param {string|boolean} value
     * @returns {Promise<void>}
     */
    async _setFieldValue(field, input, value) {
        const revision = (this._fieldRevisions.get(field) ?? 0) + 1;
        this._fieldRevisions.set(field, revision);
        this._pendingFieldEdits.set(field, (this._pendingFieldEdits.get(field) ?? 0) + 1);
        this._onFieldInput();
        try {
            await this._parent.setField(this, field, value);
        } finally {
            const remaining = (this._pendingFieldEdits.get(field) ?? 1) - 1;
            if (remaining === 0) {
                this._pendingFieldEdits.delete(field);
            } else {
                this._pendingFieldEdits.set(field, remaining);
            }
            if (!this._retired) {
                if (this._fieldRevisions.get(field) === revision && (typeof value === 'boolean' ? input.checked === value : input.value === value)) {
                    if (field === 'ignoreCase') {
                        input.checked = this._data.ignoreCase;
                    } else {
                        input.value = this._data[field];
                    }
                }
                this._onFieldInput();
            }
        }
    }

    /** */
    _onFieldInput() {
        this._validatePattern(this._patternInput?.value ?? '');
        this._updateTestInput();
    }

    /** @param {import('popup-menu').MenuOpenEvent} event */
    _onMenuOpen(event) {
        const body = event.detail.menu.bodyNode;
        const visible = this._isTestVisible();
        /** @type {HTMLElement} */ (querySelectorNotNull(body, '[data-menu-action=showTest]')).hidden = visible;
        /** @type {HTMLElement} */ (querySelectorNotNull(body, '[data-menu-action=hideTest]')).hidden = !visible;
    }

    /** @param {import('popup-menu').MenuCloseEvent} event */
    _onMenuClose(event) {
        switch (event.detail.action) {
            case 'remove':
                void this._parent.deleteGroup(this._index, this).catch((error) => log.error(error));
                break;
            case 'showTest': this._setTestVisible(true); break;
            case 'hideTest': this._setTestVisible(false); break;
        }
    }

    /** @param {string} value */
    _validatePattern(value) {
        let okay = false;
        try {
            // eslint-disable-next-line no-new
            new RegExp(value, 'g');
            okay = true;
        } catch (error) {
            // Invalid patterns are retained for editing, but cannot show output.
        }
        if (this._patternInput !== null) { this._patternInput.dataset.invalid = `${!okay}`; }
    }

    /** @returns {boolean} */
    _isTestVisible() { return this._node.dataset.testVisible === 'true'; }

    /** @param {boolean} visible */
    _setTestVisible(visible) {
        this._node.dataset.testVisible = `${visible}`;
        this._updateTestInput();
    }

    /** */
    _updateTestInput() {
        if (!this._isTestVisible() || this._ignoreCaseToggle === null || this._patternInput === null || this._replacementInput === null || this._testInput === null || this._testOutput === null) { return; }
        let regex;
        try {
            regex = new RegExp(this._patternInput.value, this._ignoreCaseToggle.checked ? 'gi' : 'g');
        } catch (error) {
            this._testOutput.value = '';
            return;
        }
        this._testOutput.value = this._testInput.value.replace(regex, this._replacementInput.value);
    }
}
