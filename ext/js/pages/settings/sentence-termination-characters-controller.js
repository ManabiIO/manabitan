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

/** @typedef {import('settings').SentenceParsingTerminationCharacterOption} TerminationCharacter */
/** @typedef {keyof TerminationCharacter} TerminationField */

export class SentenceTerminationCharactersController {
    /** @param {import('./settings-controller.js').SettingsController} settingsController */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {(SentenceTerminationCharacterEntry|null)[]} */
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
        /** @type {TerminationCharacter[]} */
        this._savedRows = [];
        /** @type {HTMLButtonElement} */
        this._addButton = querySelectorNotNull(document, '#sentence-termination-character-list-add');
        /** @type {HTMLButtonElement} */
        this._resetButton = querySelectorNotNull(document, '#sentence-termination-character-list-reset');
        /** @type {HTMLTableElement} */
        this._listTable = querySelectorNotNull(document, '#sentence-termination-character-list-table');
        /** @type {HTMLElement} */
        this._listContainer = querySelectorNotNull(document, '#sentence-termination-character-list');
        /** @type {HTMLElement} */
        this._emptyIndicator = querySelectorNotNull(document, '#sentence-termination-character-list-empty');
    }

    /** @type {import('./settings-controller.js').SettingsController} */
    get settingsController() { return this._settingsController; }

    /**
     * @param {SentenceTerminationCharacterEntry} entry
     * @returns {number}
     */
    getEntryIndex(entry) { return this._entries.indexOf(entry); }

    /**
     * @param {number} index
     * @returns {?SentenceTerminationCharacterEntry}
     */
    getEntry(index) { return this._entries[index] ?? null; }

    /** @returns {Promise<void>} */
    async prepare() {
        this._addButton.addEventListener('click', this._onAddClick.bind(this));
        this._resetButton.addEventListener('click', this._onResetClick.bind(this));
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));
        await this._updateOptions();
    }

    /** @param {TerminationCharacter} value */
    async addEntry(value) {
        const owner = this._captureOwner();
        if (owner === null) { return; }
        ++this._mutationRequestGeneration;
        const item = structuredClone(value);
        await this._enqueue(async () => {
            if (!this._owns(owner)) { return; }
            const next = [...this._savedRows, item];
            if (!await this._saveRows(next, owner)) { return; }
            this._createEntry(item, this._entries.length);
            this._updateEmptyState();
        });
    }

    /**
     * @param {number} index
     * @param {SentenceTerminationCharacterEntry|null|undefined} [entry]
     * @returns {Promise<boolean>}
     */
    async deleteEntry(index, entry = this._entries[index]) {
        const owner = this._captureOwner();
        if (owner === null || entry === null || typeof entry === 'undefined') { return false; }
        ++this._mutationRequestGeneration;
        return await this._enqueue(async () => {
            if (!this._ownsEntry(entry, owner)) { return false; }
            const currentIndex = entry.index;
            const next = [...this._savedRows];
            next.splice(currentIndex, 1);
            if (!await this._saveRows(next, owner)) { return false; }
            this._entries.splice(currentIndex, 1);
            for (let i = currentIndex; i < this._entries.length; ++i) { this._entries[i]?.setIndex(i); }
            entry.cleanup();
            this._updateEmptyState();
            return true;
        });
    }

    /**
     * @param {SentenceTerminationCharacterEntry} entry
     * @param {TerminationField} field
     * @param {string|boolean|null} value
     * @param {boolean} [useCharacter1]
     * @returns {Promise<boolean>}
     */
    async setField(entry, field, value, useCharacter1 = false) {
        const owner = this._captureOwner();
        if (owner === null || !this._ownsEntry(entry, owner)) { return false; }
        ++this._mutationRequestGeneration;
        return await this._enqueue(async () => {
            if (!this._ownsEntry(entry, owner)) { return false; }
            const index = entry.index;
            const next = structuredClone(this._savedRows);
            const savedValue = useCharacter1 ? next[index].character1 : value;
            Object.assign(next[index], {[field]: savedValue});
            if (!await this._saveRows(next, owner, true)) { return false; }
            Object.assign(entry.data, {[field]: savedValue});
            return true;
        });
    }

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameContext(optionsContext, this._settingsController.getOptionsContext())) { return; }
        ++this._readGeneration;
        ++this._viewGeneration;
        this._viewContext = {...optionsContext};
        this._savedRows = structuredClone(options.sentenceParsing.terminationCharacters);
        this._render(this._savedRows);
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
        await this.addEntry({enabled: true, character1: '"', character2: '"', includeCharacterAtStart: false, includeCharacterAtEnd: false});
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
        const owner = this._captureOwner();
        if (owner === null) { return; }
        const requestGeneration = ++this._mutationRequestGeneration;
        const defaults = await this._settingsController.getDefaultOptions();
        const next = structuredClone(defaults.profiles[0].options.sentenceParsing.terminationCharacters);
        await this._enqueue(async () => {
            // A newer edit supersedes a reset still waiting for defaults.
            if (requestGeneration !== this._mutationRequestGeneration || !this._owns(owner) || !await this._saveRows(next, owner)) { return; }
            ++this._viewGeneration;
            this._render(next);
        });
    }

    /**
     * @param {TerminationCharacter[]} next
     * @param {{generation: number, context: import('settings').OptionsContext}} owner
     * @param {boolean} [preserveRows]
     * @returns {Promise<boolean>}
     */
    async _saveRows(next, owner, preserveRows = false) {
        if (!this._owns(owner)) { return false; }
        const expected = structuredClone(this._savedRows);
        let results;
        try {
            results = await this._settingsController.modifySettings([{
                action: 'set',
                path: 'sentenceParsing.terminationCharacters',
                value: next,
                expectedValue: expected,
                scope: 'profile',
                profileId: 'profileId' in owner.context ? owner.context.profileId : null,
                optionsContext: owner.context,
            }]);
        } catch (error) {
            await this._recoverRows(owner, expected, next, preserveRows);
            throw error;
        }
        const response = results?.[0];
        if (response?.error) {
            const data = 'data' in response.error ? response.error.data : null;
            if (data !== null && typeof data === 'object' && 'code' in data && data.code === 'stale') {
                await this._recoverRows(owner, expected, next, preserveRows);
            }
            return false;
        }
        if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(response?.result) || JSON.stringify(response.result) !== JSON.stringify(next)) {
            await this._recoverRows(owner, expected, next, preserveRows);
            throw new Error('Invalid sentence settings response');
        }
        if (!this._owns(owner)) {
            // A revisited profile may have loaded before this earlier save
            // committed. Rebase its confirmed field state without replacing
            // newly typed inputs, before its queued edits are admitted.
            if (this._viewContext !== null && this._sameContext(owner.context, this._settingsController.getOptionsContext()) && JSON.stringify(this._savedRows) === JSON.stringify(expected)) {
                if (preserveRows) {
                    this._adoptFieldRows(next);
                } else {
                    ++this._readGeneration;
                    ++this._viewGeneration;
                    this._savedRows = structuredClone(next);
                    this._render(next);
                }
            }
            return false;
        }
        this._savedRows = structuredClone(next);
        return true;
    }

    /**
     * @param {{generation: number, context: import('settings').OptionsContext}} owner
     * @param {TerminationCharacter[]} expected
     * @param {TerminationCharacter[]} next
     * @param {boolean} preserveRows
     * @returns {Promise<void>}
     */
    async _recoverRows(owner, expected, next, preserveRows) {
        if (!this._owns(owner)) { return; }
        this._viewContext = null;
        const readGeneration = ++this._readGeneration;
        try {
            const options = await this._settingsController.getOptions();
            if (owner.generation !== this._viewGeneration || readGeneration !== this._readGeneration || !this._sameContext(owner.context, this._settingsController.getOptionsContext())) { return; }
            const rows = options.sentenceParsing.terminationCharacters;
            const serializedRows = JSON.stringify(rows);
            if (serializedRows === JSON.stringify(expected) || (preserveRows && serializedRows === JSON.stringify(next))) {
                this._viewContext = {...owner.context};
                this._adoptFieldRows(rows);
            } else {
                // Unknown row structure has no safe positional draft mapping.
                this._onOptionsChanged({options, optionsContext: owner.context});
            }
        } catch (error) {
            // Leave writes blocked until a later authoritative refresh. The
            // original save failure remains the caller's primary error.
            log.error(error);
        }
    }

    /** @param {TerminationCharacter[]} rows */
    _adoptFieldRows(rows) {
        this._savedRows = structuredClone(rows);
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

    /** @returns {?{generation: number, context: import('settings').OptionsContext}} */
    _captureOwner() {
        const context = this._settingsController.getOptionsContext();
        return this._viewContext !== null && this._sameContext(this._viewContext, context) ? {generation: this._viewGeneration, context: {...context}} : null;
    }

    /**
     * @param {{generation: number, context: import('settings').OptionsContext}} owner
     * @returns {boolean}
     */
    _owns(owner) {
        return owner.generation === this._viewGeneration && this._viewContext !== null && this._sameContext(this._viewContext, owner.context) && this._sameContext(owner.context, this._settingsController.getOptionsContext());
    }

    /**
     * @param {SentenceTerminationCharacterEntry} entry
     * @param {{generation: number, context: import('settings').OptionsContext}} owner
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
        const profileId1 = 'profileId' in a ? a.profileId : null;
        const profileId2 = 'profileId' in b ? b.profileId : null;
        return a.index === b.index && profileId1 === profileId2;
    }

    /** @param {TerminationCharacter[]} rows */
    _render(rows) {
        for (const entry of this._entries) { entry?.cleanup(); }
        this._entries = [];
        for (const [index, row] of rows.entries()) { this._createEntry(row, index); }
        this._updateEmptyState();
    }

    /**
     * @param {TerminationCharacter} row
     * @param {number} index
     */
    _createEntry(row, index) {
        const node = /** @type {HTMLElement} */ (this._settingsController.instantiateTemplate('sentence-termination-character-entry'));
        this._listContainer.appendChild(node);
        const entry = new SentenceTerminationCharacterEntry(this, row, node, this._viewGeneration, index);
        try {
            entry.prepare();
            this._entries[index] = entry;
        } catch (error) {
            log.error(error);
            entry.cleanup();
            this._entries[index] = null;
        }
    }

    /** */
    _updateEmptyState() {
        const hasEntries = this._entries.some((entry) => entry !== null);
        this._listTable.hidden = !hasEntries;
        this._emptyIndicator.hidden = hasEntries;
    }
}

class SentenceTerminationCharacterEntry {
    /**
     * @param {SentenceTerminationCharactersController} parent
     * @param {TerminationCharacter} data
     * @param {HTMLElement} node
     * @param {number} generation
     * @param {number} index
     */
    constructor(parent, data, node, generation, index) {
        /** @type {SentenceTerminationCharactersController} */
        this._parent = parent;
        /** @type {TerminationCharacter} */
        this._data = structuredClone(data);
        /** @type {HTMLElement} */
        this._node = node;
        /** @type {number} */
        this._generation = generation;
        /** @type {number} */
        this._index = index;
        /** @type {boolean} */
        this._retired = false;
        /** @type {Map<TerminationField, number>} */
        this._fieldRevisions = new Map();
        /** @type {Map<TerminationField, number>} */
        this._pendingFieldEdits = new Map();
        /** @type {Map<TerminationField, HTMLInputElement>} */
        this._fieldInputs = new Map();
        /** @type {number} */
        this._typeGeneration = 0;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {?HTMLInputElement} */
        this._character1Input = null;
        /** @type {?HTMLInputElement} */
        this._character2Input = null;
        /** @type {?HTMLSelectElement} */
        this._typeSelect = null;
    }

    /** @returns {TerminationCharacter} */
    get data() { return this._data; }

    /** @returns {boolean} */
    get retired() { return this._retired; }

    /** @returns {number} */
    get generation() { return this._generation; }

    /** @returns {number} */
    get index() { return this._index; }

    /** @param {number} value */
    setIndex(value) { this._index = value; }

    /** @returns {void} */
    prepare() {
        const node = this._node;
        const enabled = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.sentence-termination-character-enabled'));
        const type = /** @type {HTMLSelectElement} */ (querySelectorNotNull(node, '.sentence-termination-character-type'));
        const character1 = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.sentence-termination-character-input1'));
        const character2 = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.sentence-termination-character-input2'));
        const includeStart = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.sentence-termination-character-include-at-start'));
        const includeEnd = /** @type {HTMLInputElement} */ (querySelectorNotNull(node, '.sentence-termination-character-include-at-end'));
        const menu = querySelectorNotNull(node, '.sentence-termination-character-entry-button');
        this._character1Input = character1;
        this._character2Input = character2;
        this._typeSelect = type;
        this._fieldInputs.set('character1', character1);
        this._fieldInputs.set('character2', character2);
        character1.value = this._data.character1;
        character2.value = this._data.character2 ?? '';
        type.value = this._data.character2 === null ? 'terminator' : 'quote';
        node.dataset.type = type.value;
        for (const [control, field] of /** @type {[HTMLInputElement, 'enabled'|'includeCharacterAtStart'|'includeCharacterAtEnd'][]} */ ([
            [enabled, 'enabled'], [includeStart, 'includeCharacterAtStart'], [includeEnd, 'includeCharacterAtEnd'],
        ])) {
            this._fieldInputs.set(field, control);
            control.checked = this._data[field];
            this._eventListeners.addEventListener(control, 'change', () => {
                void this._setCheckboxValue(control, field, control.checked).catch((error) => log.error(error));
            });
        }
        this._eventListeners.addEventListener(type, 'change', this._onTypeSelectChange.bind(this));
        this._eventListeners.addEventListener(character1, 'change', this._onCharacterChange.bind(this, 1));
        this._eventListeners.addEventListener(character2, 'change', this._onCharacterChange.bind(this, 2));
        this._eventListeners.addEventListener(menu, 'menuClose', this._onMenuClose.bind(this));
    }

    /**
     * @param {TerminationCharacter} row
     */
    adoptData(row) {
        // Only update controls which still display the previous acknowledgement.
        // Submitted edits own their controls until their own completion.
        for (const [field, input] of this._fieldInputs) {
            if ((this._pendingFieldEdits.get(field) ?? 0) !== 0) { continue; }
            const previous = this._data[field];
            const value = row[field];
            if (typeof previous === 'boolean' && typeof value === 'boolean') {
                if (input.checked === previous) { input.checked = value; }
            } else if (input.value === (previous ?? '')) {
                input.value = typeof value === 'string' ? value : '';
            }
        }
        if ((this._pendingFieldEdits.get('character2') ?? 0) === 0 && this._typeSelect !== null) {
            const previousType = this._data.character2 === null ? 'terminator' : 'quote';
            if (this._typeSelect.value === previousType) {
                this._typeSelect.value = row.character2 === null ? 'terminator' : 'quote';
                this._node.dataset.type = this._typeSelect.value;
            }
        }
        Object.assign(this._data, row);
    }

    /** @param {TerminationField} field */
    _finishFieldEdit(field) {
        const remaining = (this._pendingFieldEdits.get(field) ?? 1) - 1;
        if (remaining === 0) {
            this._pendingFieldEdits.delete(field);
        } else {
            this._pendingFieldEdits.set(field, remaining);
        }
    }

    /** @returns {void} */
    cleanup() {
        this._retired = true;
        this._eventListeners.removeAllEventListeners();
        this._node.remove();
    }

    /** @param {Event} event */
    _onTypeSelectChange(event) {
        const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
        this._node.dataset.type = select.value;
        void this._setHasCharacter2(select.value === 'quote').catch((error) => log.error(error));
    }

    /**
     * @param {1|2} number
     * @param {Event} event
     */
    _onCharacterChange(number, event) {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        if (number === 2 && this._typeSelect?.value !== 'quote') { input.value = ''; }
        void this._setCharacterValue(input, number, input.value.substring(0, 1)).catch((error) => log.error(error));
    }

    /** @param {import('popup-menu').MenuCloseEvent} event */
    _onMenuClose(event) {
        if (event.detail.action === 'delete') { void this._delete().catch((error) => log.error(error)); }
    }

    /** @returns {Promise<boolean>} */
    async _delete() {
        return await this._parent.deleteEntry(this._parent.getEntryIndex(this), this);
    }

    /** @param {boolean} has */
    async _setHasCharacter2(has) {
        const input = this._character2Input;
        const select = this._typeSelect;
        if (input === null || select === null) { return; }
        const generation = ++this._typeGeneration;
        const submittedType = has ? 'quote' : 'terminator';
        const promise = this._setCharacterValue(input, 2, has ? this._data.character1 : null, has);
        const revision = this._fieldRevisions.get('character2');
        try {
            await promise;
        } finally {
            if (!this._retired && generation === this._typeGeneration && revision === this._fieldRevisions.get('character2') && select.value === submittedType) {
                const type = this._data.character2 === null ? 'terminator' : 'quote';
                this._node.dataset.type = type;
                select.value = type;
            }
        }
    }

    /**
     * @param {HTMLInputElement} input
     * @param {1|2} number
     * @param {?string} value
     * @param {boolean} [useCharacter1]
     * @returns {Promise<boolean>}
     */
    async _setCharacterValue(input, number, value, useCharacter1 = false) {
        const submitted = input.value;
        const field = number === 1 ? 'character1' : 'character2';
        const revision = (this._fieldRevisions.get(field) ?? 0) + 1;
        this._fieldRevisions.set(field, revision);
        this._pendingFieldEdits.set(field, (this._pendingFieldEdits.get(field) ?? 0) + 1);
        try {
            return await this._parent.setField(this, field, number === 1 && value === null ? '' : value, useCharacter1);
        } finally {
            this._finishFieldEdit(field);
            if (!this._retired && this._fieldRevisions.get(field) === revision && input.value === submitted) { input.value = this._data[field] ?? ''; }
        }
    }

    /**
     * @param {HTMLInputElement} input
     * @param {'enabled'|'includeCharacterAtStart'|'includeCharacterAtEnd'} field
     * @param {boolean} value
     * @returns {Promise<void>}
     */
    async _setCheckboxValue(input, field, value) {
        const revision = (this._fieldRevisions.get(field) ?? 0) + 1;
        this._fieldRevisions.set(field, revision);
        this._pendingFieldEdits.set(field, (this._pendingFieldEdits.get(field) ?? 0) + 1);
        try {
            await this._parent.setField(this, field, value);
        } finally {
            this._finishFieldEdit(field);
            if (!this._retired && this._fieldRevisions.get(field) === revision && input.checked === value) { input.checked = this._data[field]; }
        }
    }
}
