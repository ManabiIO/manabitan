/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
import {toError} from '../../core/to-error.js';
import {AnkiNoteBuilder} from '../../data/anki-note-builder.js';
import {getDynamicTemplates} from '../../data/anki-template-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {getLanguageSummaries} from '../../language/languages.js';
import {getRequiredAudioSources} from '../../media/audio-downloader.js';
import {TemplateRendererProxy} from '../../templates/template-renderer-proxy.js';

export class AnkiDeckGeneratorController {
    /**
     * @param {import('../../application.js').Application} application
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('./modal-controller.js').ModalController} modalController
     * @param {import('./anki-controller.js').AnkiController} ankiController
     */
    constructor(application, settingsController, modalController, ankiController) {
        /** @type {import('../../application.js').Application} */
        this._application = application;
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {import('./anki-controller.js').AnkiController} */
        this._ankiController = ankiController;
        /** @type {?string} */
        this._defaultFieldTemplates = null;
        /** @type {HTMLTextAreaElement} */
        this._mainSettingsEntry = querySelectorNotNull(document, '#generate-anki-notes-main-settings-entry');
        /** @type {HTMLTextAreaElement} */
        this._wordInputTextarea = querySelectorNotNull(document, '#generate-anki-notes-textarea');
        /** @type {HTMLInputElement} */
        this._renderTextInput = querySelectorNotNull(document, '#generate-anki-notes-test-text-input');
        /** @type {HTMLElement} */
        this._renderResult = querySelectorNotNull(document, '#generate-anki-notes-render-result');
        /** @type {HTMLElement} */
        this._activeModelText = querySelectorNotNull(document, '#generate-anki-notes-active-model');
        /** @type {HTMLElement} */
        this._activeDeckText = querySelectorNotNull(document, '#generate-anki-notes-active-deck');
        /** @type {HTMLSelectElement} */
        this._activeFlashcardFormatSelect = querySelectorNotNull(document, '#generate-anki-flashcard-format');
        /** @type {import('settings').AnkiCardFormat[]} */
        this._flashcardFormatDetails = [];
        /** @type {?{optionsContext: import('settings').OptionsContext2, profileIndexChangeGeneration: (number|undefined), optionsRevision: (number|undefined)}} */
        this._flashcardFormatDetailsOwnership = null;
        /** @type {?{optionsContext: import('settings').OptionsContext2, cardFormats: import('settings').AnkiCardFormat[], index: number}} */
        this._formatSelectionSnapshot = null;
        /** @type {number} */
        this._flashcardFormatViewToken = 0;
        /** @type {HTMLButtonElement[]} */
        this._generationButtons = [];
        /** @type {HTMLInputElement} */
        this._addMediaCheckbox = querySelectorNotNull(document, '#generate-anki-notes-add-media');
        /** @type {HTMLInputElement} */
        this._disallowDuplicatesCheckbox = querySelectorNotNull(document, '#generate-anki-notes-disallow-duplicates');
        /** @type {string} */
        this._activeNoteType = '';
        /** @type {string} */
        this._activeAnkiDeck = '';
        /** @type {HTMLSpanElement} */
        this._sendWordcount = querySelectorNotNull(document, '#generate-anki-notes-send-wordcount');
        /** @type {HTMLSpanElement} */
        this._exportWordcount = querySelectorNotNull(document, '#generate-anki-notes-export-wordcount');
        /** @type {HTMLButtonElement} */
        this._sendToAnkiButtonConfirmButton = querySelectorNotNull(document, '#generate-anki-notes-send-button-confirm');
        /** @type {HTMLButtonElement} */
        this._exportButtonConfirmButton = querySelectorNotNull(document, '#generate-anki-notes-export-button-confirm');
        /** @type {NodeListOf<HTMLElement>} */
        this._progressContainers = (document.querySelectorAll('.generate-anki-notes-progress'));
        /** @type {?import('./modal.js').Modal} */
        this._sendToAnkiConfirmModal = null;
        /** @type {?import('./modal.js').Modal} */
        this._exportConfirmModal = null;
        /** @type {boolean} */
        this._cancel = false;
        /** @type {boolean} */
        this._inProgress = false;
        /** @type {import('core').TokenObject} */
        this._parseToken = {};
        /** @type {import('core').TokenObject} */
        this._modelSelectionToken = {};
        /** @type {import('core').TokenObject} */
        this._exampleTextToken = {};
        /** @type {import('core').TokenObject} */
        this._renderToken = {};
        /** @type {AnkiNoteBuilder} */
        this._ankiNoteBuilder = new AnkiNoteBuilder(settingsController.application.api, new TemplateRendererProxy());
    }

    /** */
    async prepare() {
        this._defaultFieldTemplates = await this._settingsController.application.api.getDefaultAnkiFieldTemplates();

        /** @type {HTMLButtonElement} */
        const parseWordsButton = querySelectorNotNull(document, '#generate-anki-notes-parse-button');
        /** @type {HTMLButtonElement} */
        const dedupeWordsButton = querySelectorNotNull(document, '#generate-anki-notes-dedupe-button');
        /** @type {HTMLButtonElement} */
        const testRenderButton = querySelectorNotNull(document, '#generate-anki-notes-test-render-button');
        /** @type {HTMLButtonElement} */
        const sendToAnkiButton = querySelectorNotNull(document, '#generate-anki-notes-send-to-anki-button');
        /** @type {HTMLButtonElement} */
        const sendToAnkiCancelButton = querySelectorNotNull(document, '#generate-anki-notes-send-to-anki-cancel-button');
        /** @type {HTMLButtonElement} */
        const exportButton = querySelectorNotNull(document, '#generate-anki-notes-export-button');
        /** @type {HTMLButtonElement} */
        const exportCancelButton = querySelectorNotNull(document, '#generate-anki-notes-export-cancel-button');
        /** @type {HTMLButtonElement} */
        const generateButton = querySelectorNotNull(document, '#generate-anki-notes-export-button');

        this._sendToAnkiConfirmModal = this._modalController.getModal('generate-anki-notes-send-to-anki');
        this._exportConfirmModal = this._modalController.getModal('generate-anki-notes-export');

        this._generationButtons = [testRenderButton, sendToAnkiButton, exportButton, generateButton, this._sendToAnkiButtonConfirmButton, this._exportButtonConfirmButton];

        parseWordsButton.addEventListener('click', this._onParse.bind(this), false);
        dedupeWordsButton.addEventListener('click', this._onDedupe.bind(this), false);
        testRenderButton.addEventListener('click', this._onRender.bind(this), false);
        sendToAnkiButton.addEventListener('click', this._onSendToAnki.bind(this), false);
        this._sendToAnkiButtonConfirmButton.addEventListener('click', this._onSendToAnkiConfirm.bind(this), false);
        sendToAnkiCancelButton.addEventListener('click', (() => { this._cancel = true; }).bind(this), false);
        exportButton.addEventListener('click', this._onExport.bind(this), false);
        this._exportButtonConfirmButton.addEventListener('click', this._onExportConfirm.bind(this), false);
        exportCancelButton.addEventListener('click', (() => { this._cancel = true; }).bind(this), false);
        generateButton.addEventListener('click', this._onExport.bind(this), false);

        this._subscribeToSettingsChanges();
        void this._updateExampleText();
        this._mainSettingsEntry.addEventListener('click', this._updateExampleText.bind(this), false);

        void this._setupModelSelection();
        this._mainSettingsEntry.addEventListener('click', this._setupModelSelection.bind(this), false);

        this._activeFlashcardFormatSelect.addEventListener('change', this._onFlashcardFormatChange.bind(this), false);
        this._updateGenerationControls();
    }

    /** */
    _subscribeToSettingsChanges() {
        this._settingsController.on('optionsContextChanged', () => {
            this._formatSelectionSnapshot = null;
            this._invalidateFormatView();
            this._parseToken = {};
            this._exampleTextToken = {};
            this._renderToken = {};
        });
        this._settingsController.on('optionsChanged', () => {
            void this._setupModelSelection().catch((error) => log.error(error));
            void this._updateExampleText().catch((error) => log.error(error));
        });
    }

    // Private

    /** */
    async _onParse() {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._parseToken = token;
        let ownership;
        try {
            ownership = this._captureProfileOwnership();
        } catch (error) {
            log.error(error);
            this._updateProgressBarError(`Failed to parse text: ${toError(error).message}`);
            return;
        }
        const {optionsContext} = ownership;
        const inputText = this._wordInputTextarea.value;
        try {
            const options = await this._settingsController.getOptions();
            this._assertProfileOwnershipCurrent(ownership);
            if (this._parseToken !== token || this._wordInputTextarea.value !== inputText) { return; }
            const parserResult = await this._application.api.parseText(inputText, optionsContext, options.scanning.length, !options.parsing.enableMecabParser, options.parsing.enableMecabParser, options.parsing.useAllFrequencyDictionaries);
            this._assertProfileOwnershipCurrent(ownership);
            if (this._parseToken !== token || this._wordInputTextarea.value !== inputText) { return; }
            const parsedText = parserResult[0].content;

            const parsedParts = [];
            for (const parsedTextLine of parsedText) {
                let combinedSegments = '';
                for (const parsedTextSegment of parsedTextLine) {
                    combinedSegments += parsedTextSegment.text;
                }
                combinedSegments = combinedSegments.trim();
                if (combinedSegments.length > 0) { parsedParts.push(combinedSegments); }
            }
            this._wordInputTextarea.value = parsedParts.join('\n');
        } catch (error) {
            if (this._parseToken === token && this._wordInputTextarea.value === inputText) {
                log.error(error);
                this._updateProgressBarError(`Failed to parse text: ${toError(error).message}`);
            }
        }
    }

    /** */
    _onDedupe() {
        this._wordInputTextarea.value = [...new Set(this._wordInputTextarea.value.split('\n'))].join('\n');
    }

    /** */
    _onFlashcardFormatChange() {
        this._rememberFormatSelection();
        this._renderToken = {};
        void this._updateActiveModel();
    }

    /** */
    async _setupModelSelection() {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._modelSelectionToken = token;
        const activeFlashcardFormat = /** @type {HTMLSelectElement} */ (this._activeFlashcardFormatSelect);
        this._rememberFormatSelection();
        const selection = this._formatSelectionSnapshot;
        this._invalidateFormatView();
        try {
            const ownership = this._captureProfileOwnership();
            const options = await this._settingsController.getOptions();
            this._assertProfileOwnershipCurrent(ownership);
            if (this._modelSelectionToken !== token) { return; }

            const cardFormats = Array.isArray(options.anki.cardFormats) ? options.anki.cardFormats : [];
            activeFlashcardFormat.innerHTML = '';
            this._flashcardFormatDetails = cardFormats;
            this._flashcardFormatDetailsOwnership = ownership;
            this._flashcardFormatViewToken++;
            for (let i = 0; i < cardFormats.length; i++) {
                const option = document.createElement('option');
                option.value = i.toString();
                option.text = cardFormats[i].name;
                activeFlashcardFormat.add(option);
            }
            if (selection && selection.cardFormats.length > 0 && selection.optionsContext.profileId === ownership.optionsContext.profileId && selection.optionsContext.index === ownership.optionsContext.index) {
                let selectedIndex = -1;
                if (JSON.stringify(selection.cardFormats) === JSON.stringify(cardFormats)) {
                    selectedIndex = selection.index;
                } else if (selection.index >= 0) {
                    const selectedFormat = JSON.stringify(selection.cardFormats[selection.index]);
                    const matches = cardFormats.flatMap((format, index) => (JSON.stringify(format) === selectedFormat ? [index] : []));
                    if (matches.length === 1) { selectedIndex = matches[0]; }
                }
                if (selectedIndex >= 0 && selectedIndex < cardFormats.length) {
                    activeFlashcardFormat.value = selectedIndex.toString();
                } else if (cardFormats.length > 0) {
                    const placeholder = document.createElement('option');
                    placeholder.value = '';
                    placeholder.text = 'Select a card format';
                    placeholder.disabled = true;
                    activeFlashcardFormat.prepend(placeholder);
                    activeFlashcardFormat.value = '';
                }
            }
            this._rememberFormatSelection();
            await this._updateActiveModel();
        } catch (error) {
            if (this._modelSelectionToken === token) {
                this._invalidateFormatView();
                log.error(error);
            }
        }
    }

    /** */
    _rememberFormatSelection() {
        const ownership = this._flashcardFormatDetailsOwnership;
        if (ownership === null) { return; }
        this._formatSelectionSnapshot = {
            optionsContext: {...ownership.optionsContext},
            cardFormats: structuredClone(this._flashcardFormatDetails),
            index: Number.parseInt(this._activeFlashcardFormatSelect.value, 10),
        };
    }

    /** */
    async _updateActiveModel() {
        const activeModelText = /** @type {HTMLElement} */ (this._activeModelText);
        const activeDeckText = /** @type {HTMLElement} */ (this._activeDeckText);
        const activeDeckTextConfirm = querySelectorNotNull(document, '#generate-anki-notes-active-deck-confirm');

        let selectedFormat;
        try {
            this._assertFormatViewCurrent();
            selectedFormat = this._flashcardFormatDetails[Number.parseInt(this._activeFlashcardFormatSelect.value, 10)];
        } catch {
            selectedFormat = null;
        }
        if (typeof selectedFormat === 'undefined' || selectedFormat === null) {
            this._activeNoteType = '';
            this._activeAnkiDeck = '';
            activeModelText.textContent = '';
            activeDeckText.textContent = '';
            activeDeckTextConfirm.textContent = '';
            this._updateGenerationControls();
            return;
        }
        this._activeNoteType = selectedFormat.model;
        this._activeAnkiDeck = selectedFormat.deck;
        activeModelText.textContent = this._activeNoteType;
        activeDeckText.textContent = this._activeAnkiDeck;
        activeDeckTextConfirm.textContent = this._activeAnkiDeck;
        this._updateGenerationControls();
    }

    /** */
    _invalidateFormatView() {
        this._renderToken = {};
        this._renderResult.hidden = true;
        this._renderResult.textContent = '';
        this._flashcardFormatViewToken++;
        this._flashcardFormatDetails = [];
        this._flashcardFormatDetailsOwnership = null;
        this._activeFlashcardFormatSelect.innerHTML = '';
        this._activeNoteType = '';
        this._activeAnkiDeck = '';
        this._activeModelText.textContent = '';
        this._activeDeckText.textContent = '';
        const activeDeckTextConfirm = document.querySelector('#generate-anki-notes-active-deck-confirm');
        if (activeDeckTextConfirm) { activeDeckTextConfirm.textContent = ''; }
        this._updateGenerationControls();
    }

    /** */
    _updateGenerationControls() {
        const selectedIndex = Number.parseInt(this._activeFlashcardFormatSelect.value, 10);
        const hasReadyFormat = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < this._flashcardFormatDetails.length;
        let ownershipCurrent = false;
        if (this._flashcardFormatDetailsOwnership !== null && this._flashcardFormatDetails.length > 0) {
            try {
                this._assertFormatViewCurrent();
                ownershipCurrent = true;
            } catch { /* The view has expired. */ }
        }
        this._activeFlashcardFormatSelect.disabled = !ownershipCurrent || this._inProgress;
        for (const button of this._generationButtons) { button.disabled = !ownershipCurrent || !hasReadyFormat || this._inProgress; }
    }

    /** */
    async _resetState() {
        this._updateProgressBar(true, '', 0, 1, false);
        this._cancel = false;

        this._updateGenerationControls();
        this._exportWordcount.textContent = /** @type {HTMLTextAreaElement} */ (this._wordInputTextarea).value.split('\n').filter(Boolean).length.toString();

        this._addMediaCheckbox.disabled = false;
        this._disallowDuplicatesCheckbox.disabled = false;
        this._sendWordcount.textContent = /** @type {HTMLTextAreaElement} */ (this._wordInputTextarea).value.split('\n').filter(Boolean).length.toString();
    }

    /** */
    async _startGenerationState() {
        if (this._inProgress) { return; }
        this._inProgress = true;
        this._cancel = false;
        this._updateGenerationControls();
        this._addMediaCheckbox.disabled = true;
        this._disallowDuplicatesCheckbox.disabled = true;
    }

    /** */
    async _endGenerationState() {
        this._inProgress = false;
        this._updateGenerationControls();
        this._addMediaCheckbox.disabled = false;
        this._disallowDuplicatesCheckbox.disabled = false;

        if (this._exportConfirmModal !== null) {
            this._exportConfirmModal.setVisible(false);
        }

        if (this._sendToAnkiConfirmModal !== null) {
            this._sendToAnkiConfirmModal.setVisible(false);
        }

        this._updateProgressBar(false, '', 1, 1, false);
    }

    /** */
    async _endGenerationStateError() {
        this._inProgress = false;
        this._updateGenerationControls();
        this._addMediaCheckbox.disabled = false;
        this._disallowDuplicatesCheckbox.disabled = false;
    }

    /**
     * @param {MouseEvent} e
     */
    _onExport(e) {
        e.preventDefault();
        if (this._exportConfirmModal !== null) {
            this._exportConfirmModal.setVisible(true);
            if (this._inProgress) { return; }
            void this._resetState();
        }
    }

    /**
     * @param {MouseEvent} e
     */
    async _onExportConfirm(e) {
        e.preventDefault();
        if (this._inProgress) { return; }
        void this._startGenerationState();
        let profileOwnership;
        try {
            profileOwnership = this._captureViewSnapshot();
        } catch (error) {
            log.error(error);
            this._updateProgressBarError(`Failed to export Anki deck: ${toError(error).message}`);
            void this._endGenerationStateError();
            return;
        }
        const terms = /** @type {HTMLTextAreaElement} */ (this._wordInputTextarea).value.split('\n');
        let ankiTSV = '#separator:tab\n#html:true\n#notetype column:1\n#deck column:2\n#tags column:3\n';
        let index = 0;
        requestAnimationFrame(() => {
            this._updateProgressBar(true, 'Exporting to File...', 0, terms.length, true);
            setTimeout(async () => {
                try {
                    for (const value of terms) {
                        this._assertProfileOwnershipCurrent(profileOwnership);
                        if (!value) { continue; }
                        if (this._cancel) {
                            void this._endGenerationState();
                            return;
                        }
                        const noteData = await this._generateNoteData(value, false, profileOwnership);
                        this._assertProfileOwnershipCurrent(profileOwnership);
                        if (this._cancel) {
                            void this._endGenerationState();
                            return;
                        }
                        if (noteData !== null) {
                            const fieldsTSV = this._fieldsToTSV(noteData.fields);
                            if (fieldsTSV) {
                                ankiTSV += noteData.modelName + '\t';
                                ankiTSV += noteData.deckName + '\t';
                                ankiTSV += noteData.tags.join(' ') + '\t';
                                ankiTSV += fieldsTSV;
                                ankiTSV += '\n';
                            }
                        }
                        index++;
                        this._updateProgressBar(false, '', index, terms.length, true);
                    }
                    const today = new Date();
                    const fileName = 'anki-deck-' + today.toISOString().split('.')[0].replaceAll(/(T|:)/g, '-') + '.txt';
                    const blob = new Blob([ankiTSV], {type: 'application/octet-stream'});
                    this._saveBlob(blob, fileName);

                    void this._endGenerationState();
                } catch (error) {
                    const message = toError(error).message;
                    log.error(error);
                    this._updateProgressBarError(`Failed to export Anki deck: ${message}`);
                    void this._endGenerationStateError();
                }
            }, 1);
        });
    }

    /**
     * @param {MouseEvent} e
     */
    _onSendToAnki(e) {
        e.preventDefault();
        if (this._sendToAnkiConfirmModal !== null) {
            this._sendToAnkiConfirmModal.setVisible(true);
            if (this._inProgress) { return; }
            void this._resetState();
        }
    }

    /**
     * @param {MouseEvent} e
     */
    async _onSendToAnkiConfirm(e) {
        e.preventDefault();
        if (this._inProgress) { return; }
        void this._startGenerationState();
        let profileOwnership;
        try {
            profileOwnership = this._captureViewSnapshot();
        } catch (error) {
            log.error(error);
            this._updateProgressBarError(`Failed to send Anki notes: ${toError(error).message}`);
            void this._endGenerationStateError();
            return;
        }
        const terms = /** @type {HTMLTextAreaElement} */ (this._wordInputTextarea).value.split('\n');
        const addMedia = this._addMediaCheckbox.checked;
        const disallowDuplicates = this._disallowDuplicatesCheckbox.checked;
        /** @type {import("anki.js").Note[]} */
        let notes = [];
        let index = 0;
        requestAnimationFrame(() => {
            this._updateProgressBar(true, 'Sending to Anki...', 0, terms.length, true);
            setTimeout(async () => {
                try {
                    for (const value of terms) {
                        this._assertProfileOwnershipCurrent(profileOwnership);
                        if (!value) { continue; }
                        if (this._cancel) {
                            void this._endGenerationState();
                            return;
                        }
                        const noteData = await this._generateNoteData(value, addMedia, profileOwnership);
                        this._assertProfileOwnershipCurrent(profileOwnership);
                        if (this._cancel) {
                            void this._endGenerationState();
                            return;
                        }
                        if (noteData) {
                            notes.push(noteData);
                        }
                        if (notes.length >= 100) {
                            const sendNotesResult = await this._sendNotes(notes, disallowDuplicates, profileOwnership);
                            if (sendNotesResult === false) {
                                void this._endGenerationStateError();
                                return;
                            }
                            notes = [];
                            if (this._cancel) {
                                void this._endGenerationState();
                                return;
                            }
                        }
                        index++;
                        this._updateProgressBar(false, '', index, terms.length, true);
                    }
                    if (notes.length > 0) {
                        const sendNotesResult = await this._sendNotes(notes, disallowDuplicates, profileOwnership);
                        if (sendNotesResult === false) {
                            void this._endGenerationStateError();
                            return;
                        }
                    }

                    void this._endGenerationState();
                } catch (error) {
                    const message = toError(error).message;
                    log.error(error);
                    this._updateProgressBarError(`Failed to send Anki notes: ${message}`);
                    void this._endGenerationStateError();
                }
            }, 1);
        });
    }

    /**
     * @param {import("anki.js").Note[]} notes
     * @param {boolean} disallowDuplicates
     * @param {ReturnType<AnkiDeckGeneratorController['_captureViewSnapshot']>|undefined} [profileOwnership]
     * @returns {Promise<boolean>}
     */
    async _sendNotes(notes, disallowDuplicates, profileOwnership) {
        try {
            if (profileOwnership) { this._assertProfileOwnershipCurrent(profileOwnership); }
            if (this._cancel) { return true; }
            if (disallowDuplicates) {
                const duplicateNotes = await this._ankiController.canAddNotes(notes.map((note) => ({...note, options: {...note.options, allowDuplicate: false}})));
                notes = notes.filter((_, i) => duplicateNotes[i]);
            }
            if (profileOwnership) { this._assertProfileOwnershipCurrent(profileOwnership); }
            if (this._cancel) { return true; }
            const addNotesResult = await this._ankiController.addNotes(notes);
            if (addNotesResult === null || addNotesResult.includes(null)) {
                this._updateProgressBarError('Ankiconnect error: Failed to add cards');
                return false;
            }
        } catch (error) {
            this._updateProgressBarError(`Ankiconnect error: ${toError(error).message}`);
            log.error(error);
            return false;
        }
        return true;
    }

    /**
     * @param {boolean} init
     * @param {string} text
     * @param {number} current
     * @param {number} end
     * @param {boolean} visible
     */
    _updateProgressBar(init, text, current, end, visible) {
        if (!visible) {
            for (const progress of this._progressContainers) { progress.hidden = true; }
            return;
        }
        if (init) {
            for (const progress of this._progressContainers) {
                progress.hidden = false;
                for (const infoLabel of progress.querySelectorAll('.progress-info')) {
                    infoLabel.textContent = text;
                    infoLabel.classList.remove('danger-text');
                }
            }
        }
        for (const progress of this._progressContainers) {
            /** @type {NodeListOf<HTMLElement>} */
            const statusLabels = progress.querySelectorAll('.progress-status');
            for (const statusLabel of statusLabels) { statusLabel.textContent = ((current / end) * 100).toFixed(0).toString() + '%'; }
            /** @type {NodeListOf<HTMLElement>} */
            const progressBars = progress.querySelectorAll('.progress-bar');
            for (const progressBar of progressBars) { progressBar.style.width = ((current / end) * 100).toString() + '%'; }
        }
    }

    /**
     * @param {string} text
     */
    _updateProgressBarError(text) {
        for (const progress of this._progressContainers) {
            progress.hidden = false;
            for (const infoLabel of progress.querySelectorAll('.progress-info')) {
                infoLabel.textContent = text;
                infoLabel.classList.add('danger-text');
            }
        }
    }

    /**
     * @param {HTMLElement} infoNode
     * @param {boolean} showSuccessResult
     */
    async _testNoteData(infoNode, showSuccessResult) {
        /** @type {Error[]} */
        const allErrors = [];
        const text = /** @type {HTMLInputElement} */ (this._renderTextInput).value;
        let result;
        /** @type {import('core').TokenObject} */
        const token = {};
        this._renderToken = token;
        let ownership;
        try {
            ownership = this._captureViewSnapshot();
            const noteData = await this._generateNoteData(text, false, ownership);
            this._assertProfileOwnershipCurrent(ownership);
            if (this._renderToken !== token || this._renderTextInput.value !== text) { return; }
            result = noteData ? this._fieldsToTSV(noteData.fields) : `No definition found for ${text}`;
        } catch (e) {
            if (this._renderToken !== token || this._renderTextInput.value !== text) { return; }
            allErrors.push(toError(e));
        }
        if (this._renderToken !== token || this._renderTextInput.value !== text) { return; }

        /**
         * @param {Error} e
         * @returns {string}
         */
        const errorToMessageString = (e) => {
            if (e instanceof ExtensionError) {
                const v = e.data;
                if (typeof v === 'object' && v !== null) {
                    const v2 = /** @type {import('core').UnknownObject} */ (v).error;
                    if (v2 instanceof Error) {
                        return v2.message;
                    }
                }
            }
            return e.message;
        };

        const hasError = allErrors.length > 0;
        infoNode.hidden = !(showSuccessResult || hasError);
        if (hasError || !result) {
            infoNode.textContent = allErrors.map(errorToMessageString).join('\n');
        } else {
            infoNode.textContent = showSuccessResult ? result : '';
        }
        infoNode.classList.toggle('text-danger', hasError);
    }

    /**
     * @param {string} word
     * @param {boolean} addMedia
     * @param {ReturnType<AnkiDeckGeneratorController['_captureViewSnapshot']>|undefined} [batchProfileOwnership]
     * @returns {Promise<?import('anki.js').Note>}
     */
    async _generateNoteData(word, addMedia, batchProfileOwnership) {
        const profileOwnership = batchProfileOwnership ?? this._captureViewSnapshot();
        const {optionsContext} = profileOwnership;
        this._assertProfileOwnershipCurrent(profileOwnership);
        const activeFlashcardFormatDetails = profileOwnership.flashcardFormatDetails;
        const activeNoteType = profileOwnership.activeNoteType;
        const activeAnkiDeck = profileOwnership.activeAnkiDeck;
        const assertProfileCurrent = () => this._assertProfileOwnershipCurrent(profileOwnership);
        const data = await this._getDictionaryEntry(word, optionsContext, activeFlashcardFormatDetails.type);
        assertProfileCurrent();

        if (data === null) {
            return null;
        }
        const {dictionaryEntry, text: sentenceText} = data;
        const options = await this._settingsController.getOptions();
        assertProfileCurrent();
        const context = {
            url: window.location.href,
            sentence: {
                text: sentenceText,
                offset: 0,
            },
            documentTitle: document.title,
            query: sentenceText,
            fullQuery: sentenceText,
        };
        const template = await this._getAnkiTemplate(options);
        assertProfileCurrent();
        const deckOptionsFields = activeFlashcardFormatDetails.fields;
        const {general: {resultOutputMode, glossaryLayoutMode, compactTags}} = options;
        const idleTimeout = (Number.isFinite(options.anki.downloadTimeout) && options.anki.downloadTimeout > 0 ? options.anki.downloadTimeout : null);
        const languageSummary = getLanguageSummaries().find(({iso}) => iso === options.general.language);
        const requiredAudioSources = options.audio.enableDefaultAudioSources ? getRequiredAudioSources(options.general.language, options.audio.sources) : [];
        const mediaOptions = addMedia ? {audio: {sources: [...options.audio.sources, ...requiredAudioSources], preferredAudioIndex: null, idleTimeout: idleTimeout, languageSummary: languageSummary}} : null;
        const requirements = addMedia ? [...getDictionaryEntryMedia(dictionaryEntry), {type: 'audio'}] : [];
        const dictionaryStylesMap = this._ankiNoteBuilder.getDictionaryStylesMap(options.dictionaries);
        const cardFormat = /** @type {import('settings').AnkiCardFormat} */ ({
            deck: activeAnkiDeck,
            model: activeNoteType,
            fields: deckOptionsFields,
            type: activeFlashcardFormatDetails.type,
            name: '',
            icon: 'big-circle',
        });
        const {note} = await this._ankiNoteBuilder.createNote(/** @type {import('anki-note-builder').CreateNoteDetails} */ ({
            dictionaryEntry,
            cardFormat,
            context,
            template,
            resultOutputMode,
            glossaryLayoutMode,
            compactTags,
            tags: options.anki.tags,
            mediaOptions: mediaOptions,
            requirements: requirements,
            duplicateScope: options.anki.duplicateScope,
            duplicateScopeCheckAllModels: options.anki.duplicateScopeCheckAllModels,
            dictionaryStylesMap: dictionaryStylesMap,
        }));
        assertProfileCurrent();
        return note;
    }

    /**
     * @returns {{optionsContext: import('settings').OptionsContext2, profileIndexChangeGeneration: (number|undefined), optionsRevision: (number|undefined)}}
     */
    _captureProfileOwnership() {
        const settingsController = this._settingsController;
        return {
            optionsContext: settingsController.getOptionsContext(),
            profileIndexChangeGeneration: settingsController.profileIndexChangeGeneration,
            optionsRevision: settingsController.optionsRevision,
        };
    }

    /**
     * @returns {ReturnType<AnkiDeckGeneratorController['_captureProfileOwnership']> & {flashcardFormatDetails: import('settings').AnkiCardFormat, flashcardFormatIndex: number, activeNoteType: string, activeAnkiDeck: string, viewToken: number}}
     * @throws {Error} If the selected format view is unavailable or stale.
     */
    _captureViewSnapshot() {
        this._assertFormatViewCurrent();
        const index = Number.parseInt(this._activeFlashcardFormatSelect.value, 10);
        const flashcardFormatDetails = this._flashcardFormatDetails[index];
        if (!flashcardFormatDetails) { throw new Error('Select a valid Anki card format before generating notes'); }
        return {
            ...this._captureProfileOwnership(),
            flashcardFormatDetails,
            flashcardFormatIndex: index,
            activeNoteType: flashcardFormatDetails.model,
            activeAnkiDeck: flashcardFormatDetails.deck,
            viewToken: this._flashcardFormatViewToken,
        };
    }

    /**
     * @throws {Error} If no current card format view exists.
     */
    _assertFormatViewCurrent() {
        const ownership = this._flashcardFormatDetailsOwnership;
        if (ownership === null || this._flashcardFormatDetails.length === 0) {
            throw new Error('Select a valid Anki card format before generating notes');
        }
        this._assertProfileOwnershipCurrent(ownership);
    }

    /**
     * @param {{optionsContext: import('settings').OptionsContext2, profileIndexChangeGeneration: (number|undefined), optionsRevision?: number, viewToken?: number}} ownership
     * @throws {Error} If the selected profile changed while generation was pending.
     */
    _assertProfileOwnershipCurrent({optionsContext, profileIndexChangeGeneration, optionsRevision, viewToken}) {
        const current = this._settingsController.getOptionsContext();
        if (
            current.index !== optionsContext.index ||
            current.profileId !== optionsContext.profileId ||
            (Number.isInteger(profileIndexChangeGeneration) && this._settingsController.profileIndexChangeGeneration !== profileIndexChangeGeneration) ||
            (Number.isInteger(optionsRevision) && this._settingsController.optionsRevision !== optionsRevision) ||
            (Number.isInteger(viewToken) && (
                this._flashcardFormatViewToken !== viewToken ||
                this._flashcardFormatDetailsOwnership === null ||
                !this._areProfileOwnershipsEqual(this._flashcardFormatDetailsOwnership, {optionsContext, profileIndexChangeGeneration, optionsRevision})
            ))
        ) {
            throw new Error('Profile changed while generating Anki note');
        }
    }

    /**
     * @param {{optionsContext: import('settings').OptionsContext2, profileIndexChangeGeneration: (number|undefined), optionsRevision: (number|undefined)}} first
     * @param {{optionsContext: import('settings').OptionsContext2, profileIndexChangeGeneration: (number|undefined), optionsRevision: (number|undefined)}} second
     * @returns {boolean}
     */
    _areProfileOwnershipsEqual(first, second) {
        return first.optionsContext.index === second.optionsContext.index &&
        first.optionsContext.profileId === second.optionsContext.profileId &&
        first.profileIndexChangeGeneration === second.profileIndexChangeGeneration &&
        first.optionsRevision === second.optionsRevision;
    }

    /**
     * @param {string} text
     * @param {import('settings').OptionsContext} optionsContext
     * @param {import('settings').AnkiCardFormatType} type
     * @returns {Promise<?{dictionaryEntry: (import('dictionary').DictionaryEntry), text: string}>}
     */
    async _getDictionaryEntry(text, optionsContext, type) {
        let dictionaryEntriesTermKanji = null;
        if (type === 'term') {
            const {dictionaryEntries} = await this._settingsController.application.api.termsFind(text, {}, optionsContext);
            dictionaryEntriesTermKanji = dictionaryEntries;
        }
        if (type === 'kanji') {
            const [firstCharacter] = text;
            if (typeof firstCharacter === 'undefined') { return null; }
            dictionaryEntriesTermKanji = await this._settingsController.application.api.kanjiFind(firstCharacter, optionsContext);
        }

        if (!dictionaryEntriesTermKanji || dictionaryEntriesTermKanji.length === 0) { return null; }

        return {
            dictionaryEntry: /** @type {import('dictionary').DictionaryEntry} */ (dictionaryEntriesTermKanji[0]),
            text: text,
        };
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @returns {Promise<string>}
     */
    async _getAnkiTemplate(options) {
        let staticTemplates = options.anki.fieldTemplates;
        if (typeof staticTemplates !== 'string') { staticTemplates = this._defaultFieldTemplates; }
        const dictionaryInfo = await this._application.api.getDictionaryInfo();
        const dynamicTemplates = getDynamicTemplates(options, dictionaryInfo);
        return staticTemplates + '\n' + dynamicTemplates;
    }

    /**
     * @param {Event} e
     */
    _onRender(e) {
        e.preventDefault();

        const infoNode = /** @type {HTMLElement} */ (this._renderResult);
        infoNode.hidden = true;
        void this._testNoteData(infoNode, true).catch((error) => {
            log.error(error);
            infoNode.hidden = false;
            infoNode.textContent = toError(error).message;
            infoNode.classList.add('text-danger');
        });
    }

    /** */
    async _updateExampleText() {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._exampleTextToken = token;
        const inputText = this._renderTextInput.value;
        const inputLanguage = this._renderTextInput.lang;
        try {
            const ownership = this._captureProfileOwnership();
            const languageSummaries = await this._application.api.getLanguageSummaries();
            this._assertProfileOwnershipCurrent(ownership);
            const options = await this._settingsController.getOptions();
            this._assertProfileOwnershipCurrent(ownership);
            if (this._exampleTextToken !== token) { return; }
            const activeLanguage = languageSummaries.find(({iso}) => iso === options.general.language);
            if (typeof activeLanguage === 'undefined') { return; }
            this._renderTextInput.lang = options.general.language;
            if (
                this._renderTextInput.value === inputText &&
                (inputLanguage !== options.general.language || inputText.length === 0)
            ) { this._renderTextInput.value = activeLanguage.exampleText; }
            this._renderResult.lang = options.general.language;
        } catch (error) {
            if (this._exampleTextToken === token) { log.error(error); }
        }
    }

    /**
     * @param {import('anki.js').NoteFields} noteFields
     * @returns {string}
     */
    _fieldsToTSV(noteFields) {
        let tsv = '';
        for (const key in noteFields) {
            if (Object.prototype.hasOwnProperty.call(noteFields, key)) {
                tsv += noteFields[key].replaceAll('\t', '&nbsp;&nbsp;&nbsp;').replaceAll('\n', '').replaceAll('\r', '') + '\t';
            }
        }
        return tsv;
    }

    /**
     * @param {Blob} blob
     * @param {string} fileName
     */
    _saveBlob(blob, fileName) {
        if (
            typeof navigator === 'object' && navigator !== null &&
            // @ts-expect-error - call for legacy Edge
            typeof navigator.msSaveBlob === 'function' &&
            // @ts-expect-error - call for legacy Edge
            navigator.msSaveBlob(blob)
        ) {
            return;
        }

        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        a.rel = 'noopener';
        a.target = '_blank';

        const revoke = () => {
            URL.revokeObjectURL(blobUrl);
            a.href = '';
            this._settingsExportRevoke = null;
        };
        this._settingsExportRevoke = revoke;

        a.dispatchEvent(new MouseEvent('click'));
        setTimeout(revoke, 60000);
    }
}

/**
 * @param {import('dictionary').DictionaryEntry} dictionaryEntry
 * @returns {Array<import('anki-note-builder').RequirementDictionaryMedia>}
 */
export function getDictionaryEntryMedia(dictionaryEntry) {
    if (dictionaryEntry.type !== 'term') {
        return [];
    }
    /** @type {Array<import('anki-note-builder').RequirementDictionaryMedia>} */
    const media = [];
    const definitions = dictionaryEntry.definitions;
    for (const definition of definitions) {
        const paths = [...new Set(findAllPaths(definition))];
        for (const path of paths) {
            media.push({dictionary: definition.dictionary, path: path, type: 'dictionaryMedia'});
        }
    }
    return media;
}

/**
 * Extracts all values of json keys named `path` which contain a string value.
 * Example json snippet containing a path:
 * ...","path":"example-dictionary/svg/example-media.svg","...
 * The path can be found in many different positions in the structure of the definition json.
 * It is most reliable to flatten it to a string and use regex.
 * @param {object} obj
 * @returns {Array<string>}
 */
function findAllPaths(obj) {
    return JSON.stringify(obj).match(/(?<="path":").*?(?=")/g) ?? [];
}
