/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {TemplateRenderer} from '../ext/js/templates/template-renderer.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Exercise the real Handlebars renderer, batched formatting, and note builder.
 * The minimal data modifier only exposes the requested field marker.
 * @param {string} template
 * @param {Document} document
 * @returns {{controller: AnkiDeckGeneratorController, builder: AnkiNoteBuilder, options: any, api: any, addNotes: ReturnType<typeof vi.fn>, saveBlob: ReturnType<typeof vi.fn>, progressError: ReturnType<typeof vi.fn>}}
 */
function createGenerator(template, document) {
    const renderer = new TemplateRenderer();
    renderer.registerDataType('ankiNote', {
        composeData: (data, commonData) => ({...data, commonData}),
        modifier: (data) => /** @type {any} */ ({marker: data.marker}),
    });
    renderer.setRenderCallbacks(() => ({requirements: []}), null);
    const api = {
        termsFind: vi.fn(async () => ({dictionaryEntries: [{
            type: 'term',
            headwords: [{term: '読む', reading: 'よむ', sources: [{originalText: '読む', isPrimary: true}]}],
            definitions: [],
        }]})),
        getDictionaryInfo: vi.fn(async () => []),
        injectAnkiNoteMedia: vi.fn(async () => ({
            audioFileName: null,
            screenshotFileName: null,
            clipboardImageFileName: null,
            clipboardText: null,
            dictionaryMedia: [],
            errors: [],
        })),
    };
    const options = {
        general: {language: 'ja', resultOutputMode: 'group', glossaryLayoutMode: 'default', compactTags: false},
        audio: {sources: [], enableDefaultAudioSources: false},
        anki: {fieldTemplates: template, downloadTimeout: 0, tags: [], duplicateScope: 'collection', duplicateScopeCheckAllModels: false},
        dictionaries: [],
    };
    const cardFormat = {type: 'term', name: 'Basic', model: 'Basic', deck: 'Japanese', fields: {Front: {value: '{expression}'}, Back: {value: 'definition'}}};
    const addNotes = vi.fn(async () => [123]);
    const saveBlob = vi.fn();
    const progressError = vi.fn();
    const builder = new AnkiNoteBuilder(/** @type {any} */ (api), renderer);
    const input = document.createElement('input');
    input.value = '読む';
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(Object.create(AnkiDeckGeneratorController.prototype), {
        _application: {api},
        _settingsController: {
            application: {api},
            getOptionsContext: () => ({index: 0, profileId: 'profile-a'}),
            profileIndexChangeGeneration: 0,
            optionsRevision: 0,
            getOptions: async () => options,
        },
        _ankiController: {addNotes},
        _ankiNoteBuilder: builder,
        _flashcardFormatDetails: [cardFormat],
        _flashcardFormatDetailsOwnership: {optionsContext: {index: 0, profileId: 'profile-a'}, profileIndexChangeGeneration: 0, optionsRevision: 0},
        _flashcardFormatViewToken: 0,
        _activeFlashcardFormatSelect: {value: '0'},
        _inProgress: false,
        _cancel: false,
        _wordInputTextarea: {value: '読む'},
        _renderTextInput: input,
        _addMediaCheckbox: {checked: false, disabled: false},
        _disallowDuplicatesCheckbox: {checked: false, disabled: false},
        _exportConfirmModal: null,
        _sendToAnkiConfirmModal: null,
        _generationButtons: [],
        _progressContainers: [],
        _saveBlob: saveBlob,
        _updateProgressBar: vi.fn(),
        _updateProgressBarError: progressError,
    }));
    return {controller, builder, options, api, addNotes, saveBlob, progressError};
}

for (const template of ['{{#if}}', '{{missingHelper marker}}']) {
    test(`note generation rejects template errors instead of returning placeholders: ${template}`, async ({window}) => {
        const {controller} = createGenerator(template, window.document);

        await expect(controller._generateNoteData('読む', false)).rejects.toMatchObject({
            message: 'Template render error for {expression}',
            data: {error: expect.any(Error)},
        });
    });
}

test('the card preview displays the actual rendering failure as an error', async ({window}) => {
    const {controller} = createGenerator('{{missingHelper marker}}', window.document);
    const preview = window.document.createElement('div');

    await controller._testNoteData(preview, true);

    expect(preview.hidden).toBe(false);
    expect(preview.classList.contains('text-danger')).toBe(true);
    expect(preview.textContent).toContain('Missing helper');
    expect(preview.textContent).not.toContain('{expression-render-error}');
});

for (const operation of /** @type {const} */ (['send', 'export'])) {
    test(`${operation} stops before publishing broken cards and succeeds after correcting the template`, async ({window}) => {
        const {controller, options, addNotes, saveBlob, progressError} = createGenerator('{{missingHelper marker}}', window.document);
        /** @type {(() => Promise<void>)[]} */
        const pending = [];
        vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
            callback(0);
            return 0;
        });
        vi.stubGlobal('setTimeout', (/** @type {() => Promise<void>} */ callback) => {
            pending.push(callback);
            return 0;
        });
        const confirm = operation === 'send' ? controller._onSendToAnkiConfirm.bind(controller) : controller._onExportConfirm.bind(controller);
        await confirm(new window.MouseEvent('click'));
        await pending.shift()?.();

        expect(addNotes).not.toHaveBeenCalled();
        expect(saveBlob).not.toHaveBeenCalled();
        expect(progressError).toHaveBeenCalledWith(expect.stringContaining('Template render error for {expression}'));
        expect(controller._inProgress).toBe(false);

        options.anki.fieldTemplates = '{{marker}}';
        await confirm(new window.MouseEvent('click'));
        await pending.shift()?.();
        expect(operation === 'send' ? addNotes : saveBlob).toHaveBeenCalledOnce();
        expect(controller._inProgress).toBe(false);
        if (operation === 'send') {
            expect(addNotes).toHaveBeenCalledWith([expect.objectContaining({fields: {Front: 'expression', Back: 'definition'}})]);
        }
    });
}

test('optional media errors do not reject an otherwise correctly rendered generated note', async ({window}) => {
    const {controller, api} = createGenerator('{{marker}}', window.document);
    api.injectAnkiNoteMedia.mockResolvedValueOnce({
        audioFileName: null,
        screenshotFileName: null,
        clipboardImageFileName: null,
        clipboardText: null,
        dictionaryMedia: [],
        errors: [ExtensionError.serialize(new Error('Audio not available'))],
    });

    await expect(controller._generateNoteData('読む', true)).resolves.toMatchObject({fields: {Front: 'expression', Back: 'definition'}});
    expect(api.injectAnkiNoteMedia).toHaveBeenCalledOnce();
});

test('the note builder retains its existing diagnostic result behavior unless rejection is requested', async ({window}) => {
    const {controller, builder} = createGenerator('{{missingHelper marker}}', window.document);
    const createNote = vi.spyOn(builder, 'createNote');
    await controller._generateNoteData('読む', false).catch(() => {});
    const details = {...createNote.mock.calls[0][0]};
    delete details.throwOnRenderError;

    await expect(builder.createNote(details)).resolves.toMatchObject({
        note: {fields: {Front: '{expression-render-error}', Back: 'definition'}},
        errors: [expect.objectContaining({message: 'Template render error for {expression}'})],
    });
});
