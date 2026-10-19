/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';

afterEach(() => { vi.unstubAllGlobals(); });

/** @returns {{promise: Promise<any>, resolve: (value: any) => void}} */
function deferred() {
    /** @type {(value: any) => void} */
    let resolve = () => {};
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/** @returns {any} */
function fixture() {
    vi.stubGlobal('window', {location: {href: 'https://example.com/settings'}});
    vi.stubGlobal('document', {title: 'Settings'});
    const state = {context: {index: 0, profileId: 'a'}, generation: 0};
    const options = {
        general: {language: 'ja', resultOutputMode: 'group', glossaryLayoutMode: 'default', compactTags: false},
        audio: {sources: [], enableDefaultAudioSources: false},
        anki: {downloadTimeout: 0, tags: [], duplicateScope: 'collection', duplicateScopeCheckAllModels: false},
        dictionaries: [],
    };
    const entry = {dictionaryEntry: {type: 'kanji'}, text: '字'};
    const createNote = vi.fn(async ({cardFormat}) => ({note: {
        fields: {Front: cardFormat.model}, tags: [], modelName: cardFormat.model, deckName: cardFormat.deck,
    }}));
    const settings = {
        getOptionsContext: () => ({...state.context}),
        get profileIndexChangeGeneration() { return state.generation; },
        getOptions: vi.fn(async () => options),
    };
    const controller = Object.assign(Object.create(AnkiDeckGeneratorController.prototype), {
        _settingsController: settings,
        _flashcardFormatDetails: [{type: 'kanji', fields: {Front: {value: '{character}'}}}],
        _activeFlashcardFormatSelect: {value: '0'},
        _activeNoteType: 'Original Model',
        _activeAnkiDeck: 'Original Deck',
        _getDictionaryEntry: vi.fn(async () => entry),
        _getAnkiTemplate: vi.fn(async () => 'template'),
        _ankiNoteBuilder: {getDictionaryStylesMap: vi.fn(() => new Map()), createNote},
    });
    return {controller, settings, state, options, entry, createNote};
}

for (const boundary of /** @type {const} */ (['lookup', 'options', 'template', 'builder'])) {
    for (const replacement of ['different ID', 'same-ID settings import']) {
        test('note generation rejects ' + replacement + ' at the same index during ' + boundary, async () => {
            const {controller, settings, state, options, entry, createNote} = fixture();
            const pending = deferred();
            const {owner, method, result} = /** @type {{owner: any, method: string, result: any}} */ ({
                lookup: {owner: controller, method: '_getDictionaryEntry', result: entry},
                options: {owner: settings, method: 'getOptions', result: options},
                template: {owner: controller, method: '_getAnkiTemplate', result: 'template'},
                builder: {owner: controller._ankiNoteBuilder, method: 'createNote', result: {note: {fields: {}, tags: []}}},
            }[boundary]);
            owner[method].mockImplementationOnce(() => pending.promise);
            const operation = controller._generateNoteData('字', false);
            const assertion = expect(operation).rejects.toThrow('Profile changed while generating Anki note');
            await flush();
            if (replacement === 'different ID') {
                state.context = {index: 0, profileId: 'b'};
            } else {
                ++state.generation;
            }
            pending.resolve(result);
            await assertion;
            if (boundary !== 'builder') { expect(createNote).not.toHaveBeenCalled(); }
        });
    }
}

test('unchanged profile returns the captured note type and deck after a selection change', async () => {
    const {controller, entry} = fixture();
    const pending = deferred();
    controller._getDictionaryEntry.mockImplementationOnce(() => pending.promise);
    const operation = controller._generateNoteData('字', false);
    controller._activeNoteType = 'New Model';
    controller._activeAnkiDeck = 'New Deck';
    pending.resolve(entry);
    await expect(operation).resolves.toMatchObject({modelName: 'Original Model', deckName: 'Original Deck', fields: {Front: 'Original Model'}});
});
