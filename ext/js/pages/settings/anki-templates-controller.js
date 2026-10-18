/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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
import {TemplateRendererProxy} from '../../templates/template-renderer-proxy.js';

export class AnkiTemplatesController {
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
        /** @type {?import('dictionary').TermDictionaryEntry} */
        this._cachedDictionaryEntryValue = null;
        /** @type {?string} */
        this._cachedDictionaryEntryText = null;
        /** @type {?string} */
        this._cachedDictionaryEntryContext = null;
        /** @type {number} */
        this._viewGeneration = 0;
        /** @type {?import('settings').OptionsContext} */
        this._viewOptionsContext = null;
        /** @type {number} */
        this._prepareGeneration = 0;
        /** @type {number} */
        this._compileValidationGeneration = 0;
        /** @type {number} */
        this._previewValidationGeneration = 0;
        /** @type {number} */
        this._saveGeneration = 0;
        /** @type {number} */
        this._lastAcknowledgedSaveGeneration = 0;
        /** @type {string} */
        this._lastAcknowledgedTemplates = '';
        /** @type {?string} */
        this._defaultFieldTemplates = null;
        /** @type {HTMLTextAreaElement} */
        this._fieldTemplatesTextarea = querySelectorNotNull(document, '#anki-card-templates-textarea');
        /** @type {HTMLElement} */
        this._compileResultInfo = querySelectorNotNull(document, '#anki-card-templates-compile-result');
        /** @type {HTMLInputElement} */
        this._renderFieldInput = querySelectorNotNull(document, '#anki-card-templates-test-field-input');
        /** @type {HTMLInputElement} */
        this._renderTextInput = querySelectorNotNull(document, '#anki-card-templates-test-text-input');
        /** @type {HTMLElement} */
        this._renderResult = querySelectorNotNull(document, '#anki-card-templates-render-result');
        /** @type {HTMLElement} */
        this._mainSettingsEntry = querySelectorNotNull(document, '[data-modal-action="show,anki-card-templates"]');
        /** @type {?import('./modal.js').Modal} */
        this._fieldTemplateResetModal = null;
        /** @type {?{viewGeneration: number, optionsContext: import('settings').OptionsContext}} */
        this._resetModalOwner = null;
        /** @type {AnkiNoteBuilder} */
        this._ankiNoteBuilder = new AnkiNoteBuilder(settingsController.application.api, new TemplateRendererProxy());
    }

    /** */
    async prepare() {
        this._defaultFieldTemplates = await this._settingsController.application.api.getDefaultAnkiFieldTemplates();

        /** @type {HTMLButtonElement} */
        const menuButton = querySelectorNotNull(document, '#anki-card-templates-test-field-menu-button');
        /** @type {HTMLButtonElement} */
        const testRenderButton = querySelectorNotNull(document, '#anki-card-templates-test-render-button');
        /** @type {HTMLButtonElement} */
        const resetButton = querySelectorNotNull(document, '#anki-card-templates-reset-button');
        /** @type {HTMLButtonElement} */
        const resetConfirmButton = querySelectorNotNull(document, '#anki-card-templates-reset-button-confirm');
        this._fieldTemplateResetModal = this._modalController.getModal('anki-card-templates-reset');

        this._fieldTemplatesTextarea.addEventListener('change', this._onChangedEvent.bind(this), false);
        testRenderButton.addEventListener('click', this._onRender.bind(this), false);
        resetButton.addEventListener('click', this._onReset.bind(this), false);
        resetConfirmButton.addEventListener('click', this._onResetConfirm.bind(this), false);
        if (menuButton !== null) {
            menuButton.addEventListener(
                /** @type {string} */ ('menuClose'),
                /** @type {EventListener} */ (this._onFieldMenuClose.bind(this)),
                false,
            );
        }

        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('optionsContextChanged', this._onOptionsContextChanged.bind(this));

        const prepareGeneration = ++this._prepareGeneration;
        const optionsContext = this._settingsController.getOptionsContext();
        const options = await this._settingsController.getOptions();
        if (prepareGeneration === this._prepareGeneration && this._sameOptionsContext(this._settingsController.getOptionsContext(), optionsContext)) {
            this._onOptionsChanged({options, optionsContext});
        }

        void this._updateExampleTextEvent();
        this._mainSettingsEntry.addEventListener('click', this._updateExampleTextEvent.bind(this), false);
    }

    // Private

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options, optionsContext}) {
        if (!this._sameOptionsContext(this._settingsController.getOptionsContext(), optionsContext)) { return; }
        ++this._prepareGeneration;
        ++this._viewGeneration;
        this._viewOptionsContext = optionsContext;
        this._invalidateDictionaryEntryCache();
        let templates = options.anki.fieldTemplates;
        if (typeof templates !== 'string') {
            templates = this._defaultFieldTemplates;
            if (typeof templates !== 'string') { templates = ''; }
        }
        /** @type {HTMLTextAreaElement} */ (this._fieldTemplatesTextarea).value = templates;
        /** @type {HTMLTextAreaElement} */ (this._fieldTemplatesTextarea).dataset.value = templates;
        this._lastAcknowledgedTemplates = templates;

        this._onValidateCompile();
    }

    /** */
    _onOptionsContextChanged() {
        ++this._prepareGeneration;
        ++this._viewGeneration;
        this._viewOptionsContext = null;
        this._invalidateDictionaryEntryCache();
        this._clearValidationResults();
    }

    /**
     * @param {MouseEvent} e
     */
    _onReset(e) {
        e.preventDefault();
        if (this._fieldTemplateResetModal !== null) {
            const optionsContext = this._settingsController.getOptionsContext();
            this._resetModalOwner = this._viewOptionsContext !== null && this._sameOptionsContext(this._viewOptionsContext, optionsContext) ?
                {
                    viewGeneration: this._viewGeneration,
                    optionsContext,
                } :
                null;
            this._fieldTemplateResetModal.setVisible(true);
        }
    }

    /**
     * @param {MouseEvent} e
     */
    _onResetConfirm(e) {
        e.preventDefault();

        if (this._fieldTemplateResetModal !== null) {
            this._fieldTemplateResetModal.setVisible(false);
        }

        const owner = this._resetModalOwner;
        this._resetModalOwner = null;
        if (owner === null || owner.viewGeneration !== this._viewGeneration || !this._sameOptionsContext(owner.optionsContext, this._settingsController.getOptionsContext())) { return; }

        const value = this._defaultFieldTemplates;

        const textarea = /** @type {HTMLTextAreaElement} */ (this._fieldTemplatesTextarea);
        textarea.value = typeof value === 'string' ? value : '';
        textarea.dispatchEvent(new Event('change'));
    }

    /**
     * @param {Event} e
     */
    async _onChanged(e) {
        const element = /** @type {HTMLInputElement} */ (e.currentTarget);
        const submittedValue = element.value;
        const viewGeneration = this._viewGeneration;
        const optionsContext = this._settingsController.getOptionsContext();
        if (this._viewOptionsContext === null || !this._sameOptionsContext(this._viewOptionsContext, optionsContext)) { return; }
        const saveGeneration = ++this._saveGeneration;
        const profileId = optionsContext.profileId;
        const payload = submittedValue === this._defaultFieldTemplates ? null : submittedValue;
        const isCurrentView = () => this._viewGeneration === viewGeneration && this._sameOptionsContext(this._settingsController.getOptionsContext(), optionsContext);
        try {
            const modification = /** @type {import('settings-modifications').ScopedModification} */ ({
                action: 'set',
                path: 'anki.fieldTemplates',
                value: payload,
                scope: 'profile',
                profileId,
                optionsContext,
            });
            const results = await this._settingsController.modifySettings([modification]);
            const result = results?.[0];
            if (!Array.isArray(results) || results.length !== 1 || typeof result !== 'object' || result === null || Array.isArray(result) || !Object.hasOwn(result, 'result') || result.error) {
                throw ExtensionError.deserialize(result?.error ?? {name: 'Error', message: 'Invalid profile settings response', stack: ''});
            }
            if (saveGeneration >= this._lastAcknowledgedSaveGeneration) {
                this._lastAcknowledgedSaveGeneration = saveGeneration;
                if (isCurrentView()) {
                    this._lastAcknowledgedTemplates = submittedValue;
                    this._fieldTemplatesTextarea.dataset.value = submittedValue;
                }
            }
        } catch (error) {
            if (isCurrentView() && saveGeneration === this._saveGeneration && element.value === submittedValue) {
                element.value = this._lastAcknowledgedTemplates;
                element.dataset.value = this._lastAcknowledgedTemplates;
            }
            throw error;
        }
        if (isCurrentView()) { this._onValidateCompile(); }
    }

    /**
     * @param {Event} e
     */
    _onChangedEvent(e) {
        void this._onChanged(e).catch((error) => {
            log.error(error);
        });
    }

    /** */
    _onValidateCompile() {
        if (this._compileResultInfo === null) { return; }
        void this._validate(this._compileResultInfo, '{expression}', false, true);
    }

    /** */
    _clearValidationResults() {
        ++this._compileValidationGeneration;
        ++this._previewValidationGeneration;
        if (this._compileResultInfo !== null) {
            this._compileResultInfo.textContent = '';
            this._compileResultInfo.hidden = true;
        }
        if (this._renderResult !== null) {
            this._renderResult.textContent = '';
            this._renderResult.hidden = true;
        }
        delete this._fieldTemplatesTextarea.dataset.invalid;
    }

    /**
     * @param {Event} e
     */
    _onRender(e) {
        e.preventDefault();

        const field = /** @type {HTMLInputElement} */ (this._renderFieldInput).value;
        const infoNode = /** @type {HTMLElement} */ (this._renderResult);
        infoNode.hidden = true;
        this._invalidateDictionaryEntryCache();
        void this._validate(infoNode, field, true, false);
    }

    /** */
    _updateExampleTextEvent() {
        void this._updateExampleText().catch((error) => {
            log.error(error);
        });
    }

    /** */
    async _updateExampleText() {
        const viewGeneration = this._viewGeneration;
        const optionsContext = this._settingsController.getOptionsContext();
        const input = /** @type {HTMLInputElement} */ (this._renderTextInput);
        const inputValue = input.value;
        const ownsExample = () => this._viewGeneration === viewGeneration && this._viewOptionsContext !== null && this._sameOptionsContext(this._viewOptionsContext, optionsContext) && this._sameOptionsContext(this._settingsController.getOptionsContext(), optionsContext) && input.value === inputValue;
        const languageSummaries = await this._application.api.getLanguageSummaries();
        if (!ownsExample()) { return; }
        const options = await this._settingsController.getOptions();
        if (!ownsExample()) { return; }
        const activeLanguage = languageSummaries.find(({iso}) => iso === options.general.language);
        if (typeof activeLanguage === 'undefined') { return; }
        this._renderTextInput.lang = options.general.language;
        this._renderTextInput.value = activeLanguage.exampleText;
        this._renderResult.lang = options.general.language;
    }

    /**
     * @param {import('popup-menu').MenuCloseEvent} event
     */
    _onFieldMenuClose({detail: {action, item}}) {
        switch (action) {
            case 'setFieldMarker':
                {
                    const {marker} = /** @type {HTMLElement} */ (item).dataset;
                    if (typeof marker === 'string') {
                        this._setFieldMarker(marker);
                    }
                }
                break;
        }
    }

    /**
     * @param {string} marker
     */
    _setFieldMarker(marker) {
        const input = /** @type {HTMLInputElement} */ (this._renderFieldInput);
        input.value = `{${marker}}`;
        input.dispatchEvent(new Event('change'));
    }

    /**
     * @param {string} text
     * @param {import('settings').OptionsContext} optionsContext
     * @param {number} viewGeneration
     * @returns {Promise<?{dictionaryEntry: import('dictionary').TermDictionaryEntry, text: string}>}
     */
    async _getDictionaryEntry(text, optionsContext, viewGeneration) {
        const contextKey = JSON.stringify(optionsContext);
        if (this._cachedDictionaryEntryText !== text || this._cachedDictionaryEntryContext !== contextKey) {
            const {dictionaryEntries} = await this._settingsController.application.api.termsFind(text, {}, optionsContext);
            if (dictionaryEntries.length === 0) { return null; }

            const dictionaryEntry = dictionaryEntries[0];
            if (this._viewGeneration === viewGeneration && this._sameOptionsContext(this._settingsController.getOptionsContext(), optionsContext)) {
                this._cachedDictionaryEntryValue = dictionaryEntry;
                this._cachedDictionaryEntryText = text;
                this._cachedDictionaryEntryContext = contextKey;
            }
            return {dictionaryEntry, text};
        }
        return {
            dictionaryEntry: /** @type {import('dictionary').TermDictionaryEntry} */ (this._cachedDictionaryEntryValue),
            text: this._cachedDictionaryEntryText,
        };
    }

    /**
     * @param {HTMLElement} infoNode
     * @param {string} field
     * @param {boolean} showSuccessResult
     * @param {boolean} invalidateInput
     */
    async _validate(infoNode, field, showSuccessResult, invalidateInput) {
        const validationGeneration = invalidateInput ? ++this._compileValidationGeneration : ++this._previewValidationGeneration;
        const validationViewGeneration = this._viewGeneration;
        const validationOptionsContext = this._settingsController.getOptionsContext();
        if (this._viewOptionsContext === null || !this._sameOptionsContext(this._viewOptionsContext, validationOptionsContext)) { return; }
        const textInput = /** @type {HTMLInputElement} */ (this._renderTextInput);
        const fieldTemplatesTextarea = /** @type {HTMLTextAreaElement} */ (this._fieldTemplatesTextarea);
        const inputText = textInput.value;
        const fieldInput = /** @type {HTMLInputElement} */ (this._renderFieldInput);
        const inputField = fieldInput.value;
        const inputTemplates = fieldTemplatesTextarea.value;
        const inputOptionsGeneration = this._viewGeneration;
        const ownsResult = () => {
            const currentGeneration = invalidateInput ? this._compileValidationGeneration : this._previewValidationGeneration;
            const ownsView = this._viewOptionsContext !== null && this._sameOptionsContext(this._viewOptionsContext, validationOptionsContext) && this._sameOptionsContext(this._settingsController.getOptionsContext(), validationOptionsContext);
            const ownsInputs = this._viewGeneration === inputOptionsGeneration && (
                textInput.value === inputText &&
                fieldInput.value === inputField &&
                fieldTemplatesTextarea.value === inputTemplates
            );
            return currentGeneration === validationGeneration && this._viewGeneration === validationViewGeneration && ownsView && ownsInputs;
        };
        /** @type {Error[]} */
        const allErrors = [];
        const text = inputText;
        let result = `No definition found for ${text}`;
        try {
            const data = await this._getDictionaryEntry(text, validationOptionsContext, validationViewGeneration);
            if (data !== null) {
                if (!ownsResult()) { return; }
                const {dictionaryEntry, text: sentenceText} = data;
                const options = await this._settingsController.getOptions();
                if (!ownsResult()) { return; }
                if (!this._sameOptionsContext(validationOptionsContext, this._settingsController.getOptionsContext())) { return; }
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
                const template = await this._getAnkiTemplate(options, inputTemplates);
                if (!ownsResult()) { return; }
                const {general: {resultOutputMode, glossaryLayoutMode, compactTags}} = options;
                const fields = {
                    field: {
                        value: field,
                        overwriteMode: 'skip',
                    },
                };
                const cardFormat = /** @type {import('settings').AnkiCardFormat} */ ({
                    type: 'term',
                    name: '',
                    deck: '',
                    model: '',
                    fields,
                    icon: 'big-circle',
                });
                const {note, errors} = await this._ankiNoteBuilder.createNote(/** @type {import('anki-note-builder').CreateNoteDetails} */ ({
                    dictionaryEntry,
                    context,
                    template,
                    cardFormat,
                    resultOutputMode,
                    glossaryLayoutMode,
                    compactTags,
                    dictionaryStylesMap: this._ankiNoteBuilder.getDictionaryStylesMap(options.dictionaries),
                }));
                if (!ownsResult()) { return; }
                result = note.fields.field;
                allErrors.push(...errors);
            }
        } catch (e) {
            allErrors.push(toError(e));
        }

        if (!ownsResult()) { return; }

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
        infoNode.textContent = hasError ? allErrors.map(errorToMessageString).join('\n') : (showSuccessResult ? result : '');
        infoNode.classList.toggle('text-danger', hasError);
        if (invalidateInput) {
            /** @type {HTMLTextAreaElement} */ (this._fieldTemplatesTextarea).dataset.invalid = `${hasError}`;
        }
    }

    /**
     * @param {import('settings').OptionsContext} a
     * @param {import('settings').OptionsContext} b
     * @returns {boolean}
     */
    _sameOptionsContext(a, b) {
        const profileIdA = 'profileId' in a ? a.profileId : null;
        const profileIdB = 'profileId' in b ? b.profileId : null;
        return a.index === b.index && profileIdA === profileIdB;
    }

    /** */
    _invalidateDictionaryEntryCache() {
        this._cachedDictionaryEntryValue = null;
        this._cachedDictionaryEntryText = null;
        this._cachedDictionaryEntryContext = null;
    }

    /**
     * @param {import('settings').ProfileOptions} options
     * @param {string} [fieldTemplates]
     * @returns {Promise<string>}
     */
    async _getAnkiTemplate(options, fieldTemplates) {
        let staticTemplates = fieldTemplates ?? options.anki.fieldTemplates;
        if (typeof staticTemplates !== 'string') { staticTemplates = this._defaultFieldTemplates; }
        const dictionaryInfo = await this._application.api.getDictionaryInfo();
        const dynamicTemplates = getDynamicTemplates(options, dictionaryInfo);
        return staticTemplates + '\n' + dynamicTemplates;
    }
}
