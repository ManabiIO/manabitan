/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {querySelectorNotNull} from '../ext/js/dom/query-selector.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/**
 * @param {{model?: string, deck?: string, cardFormats?: import('settings').AnkiCardFormat[]|null, language?: string}} [options]
 * @returns {import('settings').ProfileOptions}
 */
function profileOptions({model = 'Model A', deck = 'Deck A', cardFormats = null, language = 'ja'} = {}) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language, resultOutputMode: 'group', glossaryLayoutMode: 'default', compactTags: false},
        audio: {sources: [], enableDefaultAudioSources: false},
        anki: {
            cardFormats: cardFormats ?? [{name: model, model, deck, type: 'kanji', fields: {Front: {value: '{character}'}}}],
            downloadTimeout: 0,
            tags: [],
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
        },
        dictionaries: [],
        scanning: [],
        parsing: {enableMecabParser: false, useAllFrequencyDictionaries: false},
    }));
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {import('settings').ProfileOptions} options
 * @returns {{application: any, settings: SettingsController, generator: AnkiDeckGeneratorController, options: import('settings').ProfileOptions}}
 */
function setup(window, options) {
    window.document.body.innerHTML = `
        <select id="generate-anki-flashcard-format"></select>
        <span id="generate-anki-notes-active-model"></span>
        <span id="generate-anki-notes-active-deck"></span>
        <span id="generate-anki-notes-active-deck-confirm"></span>
        <button id="preview"></button><button id="send"></button><button id="export"></button>
        <button id="send-confirm"></button><button id="export-confirm"></button>
        <textarea id="input">initial</textarea><input id="render-text"><div id="render-result"></div>`;
    const application = Object.assign(new EventDispatcher(), {api: {
        optionsGetFull: vi.fn(async () => ({
            profileCurrent: 0,
            profiles: [{id: 'same-profile', name: 'Profile', options, conditionGroups: []}],
        })),
        optionsGet: vi.fn(async () => options),
        getLanguageSummaries: vi.fn(async () => [{iso: 'ja', exampleText: '例文A'}, {iso: 'en', exampleText: 'Example B'}]),
        termsFind: vi.fn(async () => ({dictionaryEntries: []})),
        kanjiFind: vi.fn(async () => [{type: 'kanji'}]),
        parseText: vi.fn(async () => [{content: [[{text: 'parsed'}]]}]),
    }});
    const settings = new SettingsController(/** @type {any} */ (application));
    Reflect.set(settings, '_profileIndex', 0);
    Reflect.set(settings, '_profileId', 'same-profile');
    Reflect.set(settings, '_preparedOptionsFull', awaitableOptionsFull(options));
    const generator = Object.assign(Object.create(AnkiDeckGeneratorController.prototype), {
        _application: application,
        _settingsController: settings,
        _flashcardFormatDetails: [],
        _flashcardFormatDetailsOwnership: null,
        _flashcardFormatViewToken: 0,
        _generationButtons: ['preview', 'send', 'export', 'send-confirm', 'export-confirm'].map((id) => /** @type {HTMLButtonElement} */ (window.document.querySelector(`#${id}`))),
        _activeFlashcardFormatSelect: window.document.querySelector('#generate-anki-flashcard-format'),
        _activeModelText: window.document.querySelector('#generate-anki-notes-active-model'),
        _activeDeckText: window.document.querySelector('#generate-anki-notes-active-deck'),
        _wordInputTextarea: window.document.querySelector('#input'),
        _renderTextInput: window.document.querySelector('#render-text'),
        _renderResult: window.document.querySelector('#render-result'),
        _parseToken: {},
        _modelSelectionToken: {},
        _exampleTextToken: {},
        _renderToken: {},
        _inProgress: false,
        _progressContainers: [],
        _updateProgressBarError: vi.fn(),
        _getDictionaryEntry: vi.fn(async () => ({dictionaryEntry: {type: 'kanji'}, text: '字'})),
        _getAnkiTemplate: vi.fn(async () => 'template'),
        _ankiNoteBuilder: {
            getDictionaryStylesMap: vi.fn(() => new Map()),
            createNote: vi.fn(async ({cardFormat}) => ({note: {fields: {Front: cardFormat.model}, tags: [], modelName: cardFormat.model, deckName: cardFormat.deck}})),
        },
    });
    if (typeof generator._subscribeToSettingsChanges === 'function') { generator._subscribeToSettingsChanges(); }
    return {application, settings, generator, options};
}

/**
 * @param {import('settings').ProfileOptions} options
 * @returns {object}
 */
function awaitableOptionsFull(options) {
    return {profileCurrent: 0, profiles: [{id: 'same-profile', name: 'Profile', options, conditionGroups: []}]};
}

/**
 * @param {ReturnType<typeof setup>} context
 * @returns {Promise<void>}
 */
async function refreshSameProfile(context) {
    await context.settings._onOptionsUpdatedInternal(true);
    await flush();
}

test('external same-ID refresh invalidates delayed note generation through real SettingsController revision', async ({window}) => {
    const oldOptions = profileOptions({model: 'Old Model', deck: 'Old Deck'});
    const context = setup(window, oldOptions);
    await context.generator._setupModelSelection();
    expect(context.generator._activeNoteType).toBe('Old Model');
    const lookup = deferred();
    vi.mocked(context.generator._getDictionaryEntry).mockReturnValueOnce(lookup.promise);

    const operation = context.generator._generateNoteData('字', false);
    await flush();
    const replacement = profileOptions({model: 'New Model', deck: 'New Deck'});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(replacement));
    context.application.api.optionsGet.mockResolvedValue(replacement);
    const revision = context.settings.optionsRevision;
    let refreshDoneResolve = () => {};
    /** @type {Promise<void>} */
    const refreshDone = new Promise((resolve) => { refreshDoneResolve = resolve; });
    context.settings.on('optionsChanged', refreshDoneResolve);
    context.settings._onOptionsUpdated({source: 'external-tab'});
    expect(context.settings.getOptionsContext()).toEqual({index: 0, profileId: 'same-profile'});
    expect(context.settings.profileIndexChangeGeneration).toBe(0);
    if (typeof revision === 'number') { expect(context.settings.optionsRevision).toBeGreaterThan(revision); }

    lookup.resolve({dictionaryEntry: {type: 'kanji'}, text: '字'});
    await expect(operation).rejects.toThrow('Profile changed while generating Anki note');
    await refreshDone;
    await flush();
    expect(context.generator._activeNoteType).toBe('');
    expect(context.generator._activeFlashcardFormatSelect.disabled).toBe(false);
    expect(context.generator._generationButtons.every((button) => button.disabled)).toBe(true);
    context.generator._activeFlashcardFormatSelect.value = '0';
    await context.generator._updateActiveModel();
    expect(context.generator._activeNoteType).toBe('New Model');
    expect(context.generator._ankiNoteBuilder.createNote).not.toHaveBeenCalled();
    await expect(context.generator._generateNoteData('字', false)).resolves.toMatchObject({modelName: 'New Model', deckName: 'New Deck'});
});

test('a delayed old setup cannot replace the latest same-ID settings view', async ({window}) => {
    const optionsA = profileOptions({model: 'Model A'});
    const context = setup(window, optionsA);
    const oldRead = deferred();
    context.application.api.optionsGet.mockReturnValueOnce(oldRead.promise);
    const oldSetup = context.generator._setupModelSelection();
    await flush();
    const optionsB = profileOptions({model: 'Model B'});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(optionsB));
    context.application.api.optionsGet.mockResolvedValue(optionsB);
    await refreshSameProfile(context);
    expect(context.generator._activeNoteType).toBe('Model B');
    oldRead.resolve(optionsA);
    await oldSetup;
    expect(context.generator._activeNoteType).toBe('Model B');
});

test('empty formats clear labels and disable preview/send/export with a clear generation error', async ({window}) => {
    const options = profileOptions({cardFormats: []});
    const context = setup(window, options);
    await context.generator._setupModelSelection();
    expect(context.generator._activeNoteType).toBe('');
    expect(context.generator._activeAnkiDeck).toBe('');
    expect(context.generator._generationButtons.every((button) => button.disabled)).toBe(true);
    await expect(context.generator._generateNoteData('字', false)).rejects.toThrow('Select a valid Anki card format');
    expect(context.generator._getDictionaryEntry).not.toHaveBeenCalled();
    const restored = profileOptions({model: 'Restored Model'});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(restored));
    context.application.api.optionsGet.mockResolvedValue(restored);
    await refreshSameProfile(context);
    expect(context.generator._activeNoteType).toBe('Restored Model');
    expect(context.generator._generationButtons.every((button) => !button.disabled)).toBe(true);
});

test('switching away and back invalidates a pending generation snapshot', async ({window}) => {
    const options = profileOptions();
    const context = setup(window, options);
    await context.generator._setupModelSelection();
    const lookup = deferred();
    vi.mocked(context.generator._getDictionaryEntry).mockReturnValueOnce(lookup.promise);
    const operation = context.generator._generateNoteData('字', false);
    await flush();

    context.settings._setProfileSelection(1, 'other-profile', true);
    context.settings._setProfileSelection(0, 'same-profile', true);
    expect(context.settings.getOptionsContext()).toEqual({index: 0, profileId: 'same-profile'});
    lookup.resolve({dictionaryEntry: {type: 'kanji'}, text: '字'});
    await expect(operation).rejects.toThrow('Profile changed while generating Anki note');
    expect(context.generator._ankiNoteBuilder.createNote).not.toHaveBeenCalled();
});

test('stale parse and example requests do not publish after a real same-ID refresh', async ({window}) => {
    const optionsA = profileOptions({language: 'ja'});
    const context = setup(window, optionsA);
    const parse = deferred();
    context.application.api.parseText.mockReturnValueOnce(parse.promise);
    const parseOperation = context.generator._onParse();
    await flush();
    const languageRead = deferred();
    context.application.api.getLanguageSummaries.mockReturnValueOnce(languageRead.promise);
    const exampleOperation = context.generator._updateExampleText();
    await flush();

    const optionsB = profileOptions({language: 'en'});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(optionsB));
    context.application.api.optionsGet.mockResolvedValue(optionsB);
    const refresh = context.settings._onOptionsUpdatedInternal(true);
    parse.resolve([{content: [[{text: 'obsolete parse'}]]}]);
    languageRead.resolve([{iso: 'ja', exampleText: 'obsolete example'}]);
    await Promise.all([parseOperation, exampleOperation, refresh]);
    await flush();
    expect(context.generator._wordInputTextarea.value).toBe('initial');
    expect(context.generator._renderTextInput.value).not.toBe('obsolete example');
    expect(context.generator._renderTextInput.value).toBe('Example B');
});

test('render result is not published after its profile view is replaced', async ({window}) => {
    const optionsA = profileOptions({model: 'Model A'});
    const context = setup(window, optionsA);
    await context.generator._setupModelSelection();
    const lookup = deferred();
    vi.mocked(context.generator._getDictionaryEntry).mockReturnValueOnce(lookup.promise);
    const info = /** @type {HTMLElement} */ (querySelectorNotNull(window.document, '#render-result'));
    const render = context.generator._testNoteData(info, true);
    await flush();

    const optionsB = profileOptions({model: 'Model B'});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(optionsB));
    context.application.api.optionsGet.mockResolvedValue(optionsB);
    const refresh = context.settings._onOptionsUpdatedInternal(true);
    lookup.resolve({dictionaryEntry: {type: 'kanji'}, text: '字'});
    await Promise.all([render, refresh]);
    expect(info.hidden).toBe(true);
    expect(info.textContent).toBe('');
    expect(context.generator._ankiNoteBuilder.createNote).not.toHaveBeenCalled();
});


test('editing preview input while lookup is pending cannot publish the previous word', async ({window}) => {
    const context = setup(window, profileOptions());
    await context.generator._setupModelSelection();
    context.generator._renderTextInput.value = 'old word';
    const pending = deferred();
    vi.mocked(context.generator._getDictionaryEntry).mockReturnValueOnce(pending.promise);
    const info = /** @type {HTMLElement} */ (querySelectorNotNull(window.document, '#render-result'));
    info.hidden = true;
    const rendering = context.generator._testNoteData(info, true);
    await flush();
    context.generator._renderTextInput.value = 'new word';
    pending.resolve({dictionaryEntry: {type: 'kanji'}, text: 'old word'});
    await rendering;
    expect(info.hidden).toBe(true);
    expect(info.textContent).toBe('');
});


test('same-profile refresh preserves the selected format and custom preview word', async ({window}) => {
    const options = profileOptions();
    const baseFormat = options.anki.cardFormats[0];
    options.anki.cardFormats = Array.from({length: 3}, (_, index) => ({...baseFormat, name: 'Format ' + index, model: 'Model ' + index}));
    const context = setup(window, options);
    await context.generator._setupModelSelection();
    context.generator._activeFlashcardFormatSelect.value = '2';
    await context.generator._updateActiveModel();
    context.generator._renderTextInput.lang = 'ja';
    context.generator._renderTextInput.value = 'custom word';
    await refreshSameProfile(context);
    expect(context.generator._activeFlashcardFormatSelect.value).toBe('2');
    expect(context.generator._activeNoteType).toBe('Model 2');
    expect(context.generator._renderTextInput.value).toBe('custom word');
});


for (const overlap of [false, true]) {
    test('same-profile format reorder preserves the chosen format across ' + (overlap ? 'overlapping' : 'one') + ' refresh', async ({window}) => {
        const options = profileOptions();
        const first = {...options.anki.cardFormats[0], name: 'First', model: 'First Model'};
        const chosen = {...first, name: 'Chosen', model: 'Chosen Model', deck: 'Chosen Deck'};
        options.anki.cardFormats = [first, chosen];
        const context = setup(window, options);
        await context.generator._setupModelSelection();
        context.generator._activeFlashcardFormatSelect.value = '1';
        await context.generator._updateActiveModel();
        let pending;
        let oldSetup;
        if (overlap) {
            pending = deferred();
            context.application.api.optionsGet.mockReturnValueOnce(pending.promise);
            oldSetup = context.generator._setupModelSelection();
            await flush();
        }
        const replacement = profileOptions({cardFormats: [{...first, name: 'Inserted'}, first, chosen]});
        context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(replacement));
        context.application.api.optionsGet.mockResolvedValue(replacement);
        await refreshSameProfile(context);
        if (pending) {
            pending.resolve(options);
            await oldSetup;
        }
        expect(context.generator._activeFlashcardFormatSelect.value).toBe('2');
        expect(context.generator._activeNoteType).toBe('Chosen Model');
        expect(context.generator._activeAnkiDeck).toBe('Chosen Deck');
        await expect(context.generator._generateNoteData('字', false)).resolves.toMatchObject({modelName: 'Chosen Model', deckName: 'Chosen Deck'});
    });
}

test('removed selected format requires a new choice and does not silently send to another format', async ({window}) => {
    const options = profileOptions();
    const first = {...options.anki.cardFormats[0], name: 'First', model: 'First Model'};
    const chosen = {...first, name: 'Chosen', model: 'Chosen Model'};
    options.anki.cardFormats = [first, chosen];
    const context = setup(window, options);
    await context.generator._setupModelSelection();
    context.generator._activeFlashcardFormatSelect.value = '1';
    await context.generator._updateActiveModel();
    const replacement = profileOptions({cardFormats: [first]});
    context.application.api.optionsGetFull.mockResolvedValue(awaitableOptionsFull(replacement));
    context.application.api.optionsGet.mockResolvedValue(replacement);
    await refreshSameProfile(context);
    expect(context.generator._activeFlashcardFormatSelect.value).toBe('');
    expect(context.generator._activeFlashcardFormatSelect.disabled).toBe(false);
    expect(context.generator._activeNoteType).toBe('');
    expect(context.generator._generationButtons.every((button) => button.disabled)).toBe(true);
    await expect(context.generator._generateNoteData('字', false)).rejects.toThrow('Select a valid Anki card format');
    expect(context.generator._getDictionaryEntry).not.toHaveBeenCalled();
    await refreshSameProfile(context);
    expect(context.generator._activeFlashcardFormatSelect.value).toBe('');
    context.generator._activeFlashcardFormatSelect.value = '0';
    await context.generator._updateActiveModel();
    expect(context.generator._generationButtons.every((button) => !button.disabled)).toBe(true);
    await expect(context.generator._generateNoteData('字', false)).resolves.toMatchObject({modelName: 'First Model'});
});
