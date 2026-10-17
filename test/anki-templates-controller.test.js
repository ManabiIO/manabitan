/*
 * Copyright (C) 2026  Yomitan Authors
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

import {readFile} from 'node:fs/promises';
import {describe, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {AnkiTemplatesController} from '../ext/js/pages/settings/anki-templates-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
const templatesMarkup = await readFile(new URL('../ext/templates-modals.html', import.meta.url), 'utf8');

function deferred() {
    /** @type {(value: any) => void} */
    let resolve = () => {};
    /** @type {(reason: Error) => void} */
    let reject = () => {};
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
function createController(window, overrides = {}) {
    vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}});
    const parsed = new window.DOMParser().parseFromString(templatesMarkup, 'text/html');
    window.document.body.textContent = '';
    for (const template of parsed.querySelectorAll('template')) {
        window.document.body.appendChild(window.document.importNode(template.content, true));
    }
    const opener = window.document.createElement('button');
    opener.dataset.modalAction = 'show,anki-card-templates';
    window.document.body.appendChild(opener);
    const state = /** @type {any} */ ({context: {index: 0, profileId: 'a'}, options: null});
    state.options = {
        anki: {fieldTemplates: 'saved templates'},
        dictionaries: [],
        general: {language: 'en', resultOutputMode: 'split', glossaryLayoutMode: 'default', compactTags: false},
    };
    const settingsController = {
        application: {api: {getDefaultAnkiFieldTemplates: vi.fn().mockResolvedValue('default templates')}},
        getOptions: vi.fn(async () => state.options),
        getOptionsContext: vi.fn(() => ({...state.context})),
        modifySettings: vi.fn().mockResolvedValue([{result: null}]),
        setProfileSetting: vi.fn(async (path, value) => await settingsController.modifySettings([{action: 'set', path, value, scope: 'profile', profileId: state.context.profileId, optionsContext: {...state.context}}])),
        on: vi.fn(),
        ...overrides.settingsController,
    };
    settingsController.setProfileSetting = vi.fn(async (path, value) => await settingsController.modifySettings([{action: 'set', path, value, scope: 'profile', profileId: state.context.profileId, optionsContext: {...state.context}}]));
    const application = {
        api: {
            getLanguageSummaries: vi.fn().mockResolvedValue([{iso: 'en', exampleText: 'text'}]),
            termsFind: vi.fn().mockResolvedValue({dictionaryEntries: []}),
            getDictionaryInfo: vi.fn().mockResolvedValue([]),
        },
        ...overrides.application,
    };
    settingsController.application.api.termsFind = application.api.termsFind;
    const controller = new AnkiTemplatesController(
        /** @type {any} */ (application),
        /** @type {any} */ (settingsController),
        /** @type {any} */ ({getModal: vi.fn(() => null)}),
        /** @type {any} */ ({}),
    );
    vi.spyOn(controller, '_onValidateCompile').mockImplementation(() => {});
    return {controller, settingsController, application, state, window};
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLTextAreaElement}
 */
function textarea(window) {
    return /** @type {HTMLTextAreaElement} */ (window.document.querySelector('#anki-card-templates-textarea'));
}

describe('AnkiTemplatesController', () => {
    test('restores the previous textarea value when saving templates fails', async ({window}) => {
        const saveFailed = vi.fn().mockRejectedValue(new Error('save failed'));
        const {controller} = createController(window, {settingsController: {modifySettings: saveFailed, setProfileSetting: saveFailed}});
        await controller.prepare();
        textarea(window).value = 'unsaved templates';

        await expect(controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})))).rejects.toThrow('save failed');
        expect(textarea(window).value).toBe('saved templates');
        expect(textarea(window).dataset.value).toBe('saved templates');
    });

    test('treats a serialized per-target profile write error as a failed save', async ({window}) => {
        const {controller, settingsController} = createController(window, {
            settingsController: {modifySettings: vi.fn().mockResolvedValue([{error: {name: 'Error', message: 'profile is unavailable'}}])},
        });
        await controller.prepare();
        textarea(window).value = 'unsaved templates';

        await expect(controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})))).rejects.toThrow('profile is unavailable');
        expect(textarea(window).value).toBe('saved templates');
        expect(settingsController.modifySettings).toHaveBeenCalledWith([
            {action: 'set', path: 'anki.fieldTemplates', value: 'unsaved templates', scope: 'profile', profileId: 'a', optionsContext: {index: 0, profileId: 'a'}},
        ]);
    });

    for (const [label, response] of [
        ['empty object', [{}]],
        ['array-like response', {0: {result: null}, length: 1}],
        ['missing result', [{other: null}]],
    ]) {
        test(`rejects a malformed success response (${label})`, async ({window}) => {
            const {controller} = createController(window, {settingsController: {modifySettings: vi.fn().mockResolvedValue(response)}});
            await controller.prepare();
            textarea(window).value = 'unsaved templates';

            await expect(controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})))).rejects.toThrow('Invalid profile settings response');
            expect(textarea(window).value).toBe('saved templates');
        });
    }

    test('accepts a valid response with an undefined result payload', async ({window}) => {
        const {controller} = createController(window, {settingsController: {modifySettings: vi.fn().mockResolvedValue([{result: undefined}])}});
        await controller.prepare();
        textarea(window).value = 'saved templates';

        await expect(controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})))).resolves.toBeUndefined();
    });

    test('a missing language summary leaves the example input unchanged', async ({window}) => {
        const {controller, application, settingsController} = createController(window);
        await controller.prepare();
        const input = /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input'));
        input.value = 'user example';
        const optionsReadCount = settingsController.getOptions.mock.calls.length;
        application.api.getLanguageSummaries.mockResolvedValue([]);

        await expect(controller._updateExampleText()).resolves.toBeUndefined();
        expect(settingsController.getOptions).toHaveBeenCalledTimes(optionsReadCount + 1);
        expect(input.value).toBe('user example');
    });

    test('logs a rejected example refresh opened from the settings entry', async ({window}) => {
        const {controller, application} = createController(window);
        await controller.prepare();
        const error = new Error('language summaries unavailable');
        application.api.getLanguageSummaries.mockRejectedValue(error);
        const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
        /** @type {HTMLElement} */ (window.document.querySelector('[data-modal-action="show,anki-card-templates"]')).click();
        await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(error));
    });

    test('captures the profile for a save and does not roll a stale failure into the new view', async ({window}) => {
        const save = deferred();
        const {controller, settingsController, state} = createController(window, {
            settingsController: {modifySettings: vi.fn(() => save.promise)},
        });
        await controller.prepare();
        textarea(window).value = 'profile a draft';
        const pending = controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})));
        state.context = {index: 0, profileId: 'b'};
        const rejection = expect(pending).rejects.toThrow('profile a failed');
        save.reject(new Error('profile a failed'));

        await rejection;
        expect(settingsController.modifySettings.mock.calls[0][0][0]).toMatchObject({profileId: 'a', optionsContext: {index: 0, profileId: 'a'}, scope: 'profile'});
        expect(textarea(window).value).toBe('profile a draft');
    });

    test('does not dispatch a draft after a same-index profile switch before options refresh', async ({window}) => {
        const {controller, settingsController, state} = createController(window);
        await controller.prepare();
        state.context = {index: 0, profileId: 'b'};
        textarea(window).value = 'profile a draft';

        await controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})));

        expect(settingsController.modifySettings).not.toHaveBeenCalled();
    });

    test('preserves text typed after a save was dispatched when that save fails', async ({window}) => {
        const save = deferred();
        const {controller} = createController(window, {settingsController: {modifySettings: vi.fn(() => save.promise)}});
        await controller.prepare();
        textarea(window).value = 'submitted draft';
        const pending = controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea(window)})));
        textarea(window).value = 'new typing';
        const rejection = expect(pending).rejects.toThrow('save failed');
        save.reject(new Error('save failed'));

        await rejection;
        expect(textarea(window).value).toBe('new typing');
    });

    test('does not let an older preview overwrite the latest preview', async ({window}) => {
        const firstRender = deferred();
        const secondRender = deferred();
        const createNote = vi.fn().mockReturnValueOnce(firstRender.promise).mockReturnValueOnce(secondRender.promise);
        const {controller, application, state} = createController(window, {
            application: {api: {termsFind: vi.fn(async (_text, _options, context) => ({dictionaryEntries: [{id: context.profileId}]}))}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (createNote);
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn().mockResolvedValue('template');
        state.options.dictionaries = [];
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input')).value = 'same';
        const oldValidation = controller._validate(result, '{expression}', true, false);
        await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
        /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input')).value = 'different';
        const newValidation = controller._validate(result, '{expression}', true, false);
        await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(2));
        secondRender.resolve({note: {fields: {field: 'new preview'}}, errors: [], requirements: {}});
        await newValidation;
        firstRender.resolve({note: {fields: {field: 'old preview'}}, errors: [], requirements: {}});
        await oldValidation;

        expect(application.api.termsFind).toHaveBeenCalledTimes(2);
        expect(result.textContent).toBe('new preview');
    });

    test('a stale validation error cannot replace a newer successful preview', async ({window}) => {
        const oldRender = deferred();
        const createNote = vi.fn().mockReturnValueOnce(oldRender.promise).mockResolvedValueOnce({note: {fields: {field: 'fresh'}}, errors: [], requirements: {}});
        const {controller, application} = createController(window, {
            application: {api: {termsFind: vi.fn().mockResolvedValue({dictionaryEntries: [{}]})}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (createNote);
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn().mockResolvedValue('template');
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        const oldValidation = controller._validate(result, '{expression}', true, false);
        await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
        const newValidation = controller._validate(result, '{expression}', true, false);
        await newValidation;
        oldRender.reject(new Error('stale render error'));
        await oldValidation;
        expect(result.textContent).toBe('fresh');
        expect(createNote).toHaveBeenCalledTimes(2);
    });

    test('template edits while rendering prevent stale output and the next render uses the edited template', async ({window}) => {
        const pendingRender = deferred();
        const createNote = vi.fn().mockReturnValueOnce(pendingRender.promise).mockResolvedValue({note: {fields: {field: 'edited'}}, errors: [], requirements: {}});
        const {controller} = createController(window, {
            application: {api: {termsFind: vi.fn().mockResolvedValue({dictionaryEntries: [{}]})}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (createNote);
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn(async (_options, templates) => templates);
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        result.textContent = 'previous result';
        const stale = controller._validate(result, '{expression}', true, false);
        await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
        textarea(window).value = 'edited templates';
        pendingRender.resolve({note: {fields: {field: 'stale'}}, errors: [], requirements: {}});
        await stale;
        expect(result.textContent).toBe('previous result');
        await controller._validate(result, '{expression}', true, false);
        expect(createNote.mock.calls[1][0].template).toBe('edited templates');
        /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-field-input')).value = '{Back}';
        await controller._validate(result, '{Back}', true, false);
        expect(createNote.mock.calls[2][0].cardFormat.fields.field.value).toBe('{Back}');
        expect(result.textContent).toBe('edited');
    });

    test('field edits while rendering prevent stale preview publication', async ({window}) => {
        const pendingRender = deferred();
        const createNote = vi.fn(() => pendingRender.promise);
        const {controller} = createController(window, {
            application: {api: {termsFind: vi.fn().mockResolvedValue({dictionaryEntries: [{}]})}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (createNote);
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn(async (_options, templates) => templates);
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        result.textContent = 'prior preview';
        const validating = controller._validate(result, '{expression}', true, false);
        await vi.waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
        /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-field-input')).value = '{Back}';
        pendingRender.resolve({note: {fields: {field: 'stale'}}, errors: [], requirements: {}});
        await validating;
        expect(result.textContent).toBe('prior preview');
    });

    test('refreshing options for the same profile invalidates the cached preview entry', async ({window}) => {
        const {controller, application, state} = createController(window, {
            application: {api: {termsFind: vi.fn().mockResolvedValue({dictionaryEntries: [{}]})}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (vi.fn(async () => ({note: {fields: {field: 'preview'}}, errors: [], requirements: {}})));
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn().mockResolvedValue('template');
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        await controller._validate(result, '{expression}', true, false);
        controller._onOptionsChanged({options: state.options, optionsContext: {...state.context}});
        await controller._validate(result, '{expression}', true, false);
        expect(application.api.termsFind).toHaveBeenCalledTimes(2);
    });

    test('an opened reset confirmation cannot reset the newly selected profile', async ({window}) => {
        const {controller, settingsController, state} = createController(window);
        await controller.prepare();
        controller._fieldTemplateResetModal = {setVisible: vi.fn()};
        controller._onReset(/** @type {MouseEvent} */ (/** @type {unknown} */ ({preventDefault: vi.fn()})));
        state.context = {index: 1, profileId: 'b'};
        controller._onOptionsContextChanged();
        controller._onOptionsChanged({
            options: {...state.options, anki: {fieldTemplates: 'profile B saved'}},
            optionsContext: state.context,
        });
        controller._onResetConfirm(/** @type {MouseEvent} */ (/** @type {unknown} */ ({preventDefault: vi.fn()})));

        expect(settingsController.modifySettings).not.toHaveBeenCalled();
        expect(textarea(window).value).toBe('profile B saved');
    });

    test('does not reuse an example entry across profile contexts', async ({window}) => {
        const {controller, application, state} = createController(window, {
            application: {api: {termsFind: vi.fn(async (_text, _options, context) => ({dictionaryEntries: [{id: context.profileId}]}))}},
        });
        await controller.prepare();
        controller._ankiNoteBuilder.createNote = /** @type {any} */ (vi.fn(async ({dictionaryEntry}) => ({note: {fields: {field: dictionaryEntry.id}}, errors: [], requirements: {}})));
        controller._ankiNoteBuilder.getDictionaryStylesMap = () => new Map();
        controller._getAnkiTemplate = vi.fn().mockResolvedValue('template');
        const result = /** @type {HTMLElement} */ (window.document.querySelector('#anki-card-templates-render-result'));
        /** @type {HTMLInputElement} */ (window.document.querySelector('#anki-card-templates-test-text-input')).value = 'same';

        await controller._validate(result, '{expression}', true, false);
        state.context = {index: 1, profileId: 'b'};
        controller._onOptionsContextChanged();
        controller._onOptionsChanged({options: state.options, optionsContext: state.context});
        await controller._validate(result, '{expression}', true, false);

        expect(application.api.termsFind).toHaveBeenCalledTimes(2);
        expect(result.textContent).toBe('b');
    });
});
