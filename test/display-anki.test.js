/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, vi} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js';
import {Backend} from '../ext/js/background/backend.js';
import {DisplayAnki} from '../ext/js/display/display-anki.js';
import {TemplateRenderer} from '../ext/js/templates/template-renderer.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
const defaultAnkiFieldTemplates = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ext/data/templates/default-anki-field-templates.handlebars'), 'utf8');

/**
 * @param {string} text
 * @returns {import('dictionary').TermSource}
 */
function createSource(text) {
    return {
        originalText: text,
        transformedText: text,
        deinflectedText: text,
        matchType: 'exact',
        matchSource: 'term',
        isPrimary: true,
    };
}

/**
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function createTermEntry() {
    return /** @type {import('dictionary').TermDictionaryEntry} */ ({
        type: 'term',
        headwords: [
            {
                term: 'term',
                reading: 'reading',
                sources: [createSource('term')],
            },
        ],
    });
}

/**
 * @returns {import('settings').AnkiCardFormat}
 */
function createCardFormat() {
    return {
        type: 'term',
        name: 'Expression',
        deck: 'Deck',
        model: 'Model',
        fields: {
            Front: {
                value: '{first}',
                overwriteMode: 'overwrite',
            },
        },
        icon: 'big-circle',
    };
}

/**
 * @returns {import('settings').AnkiCardFormat}
 */
function createFastProbeCardFormat() {
    return {
        type: 'term',
        name: 'Expression',
        deck: 'Deck',
        model: 'Model',
        fields: {
            Front: {
                value: '{expression}',
                overwriteMode: 'overwrite',
            },
        },
        icon: 'big-circle',
    };
}

/**
 * @returns {AnkiNoteBuilder}
 */
function createTemplateNoteBuilder() {
    const renderer = new TemplateRenderer();
    renderer.registerDataType('ankiNote', {
        modifier: ({marker, commonData}) => createAnkiNoteData(marker, commonData),
        composeData: ({marker}, commonData) => ({marker, commonData}),
    });
    renderer.setRenderCallbacks(() => ({requirements: []}), null);
    return new AnkiNoteBuilder({
        injectAnkiNoteMedia: async () => ({
            screenshotFileName: null,
            clipboardImageFileName: null,
            clipboardText: null,
            audioFileName: null,
            dictionaryMedia: [],
            errors: [],
        }),
        parseText: async () => [],
    }, renderer);
}

/**
 * @param {import('anki').Note[]} notes
 * @returns {Promise<import('anki').NoteInfoWrapper[]>}
 */
async function createNoDuplicateInfo(notes) {
    return notes.map(() => ({canAdd: true, valid: true, isDuplicate: false, noteIds: [], noteInfos: []}));
}

/**
 * @param {import('settings').AnkiCardFormat} cardFormat
 * @param {string} fieldTemplates
 * @returns {import('settings').ProfileOptions}
 */
function createTemplateOptions(cardFormat, fieldTemplates) {
    return /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {
            resultOutputMode: 'split',
            glossaryLayoutMode: 'default',
            compactTags: false,
        },
        dictionaries: [],
        anki: {
            tags: [],
            targetTags: [],
            duplicateScope: 'collection',
            duplicateScopeCheckAllModels: false,
            duplicateBehavior: 'new',
            suspendNewCards: false,
            checkForDuplicates: false,
            displayTagsAndFlags: 'never',
            cardFormats: [cardFormat],
            noteGuiMode: 'browse',
            screenshot: {format: 'png', quality: 90},
            downloadTimeout: 0,
            forceSync: false,
            noteDupeCheckFirst: false,
            fieldTemplates,
        },
        scanning: {length: 10},
    }));
}

/**
 * @param {Document} document
 * @returns {void}
 */
function setupDocument(document) {
    global.chrome = /** @type {typeof chrome} */ ({
        runtime: {
            getURL: (path) => path,
        },
    });
    document.body.innerHTML = `
        <div id="popup-menus"></div>
        <template id="action-button-container-template">
            <div class="action-button-container">
                <button type="button" class="action-button" data-action="save-note">
                    <span class="action-icon icon color-icon" data-icon=""></span>
                </button>
            </div>
        </template>
        <template id="note-action-button-view-note-template">
            <button type="button" class="action-button" data-action="view-note" hidden disabled title="View added note">
                <span class="action-icon icon color-icon" data-icon="view-note"></span>
                <span class="action-button-badge icon"></span>
            </button>
        </template>
        <template id="note-action-button-view-tags-template">
            <button type="button" class="action-button" data-action="view-tags" hidden disabled>
                <span class="action-icon icon" data-icon="tag"></span>
            </button>
        </template>
        <template id="note-action-button-view-flags-template">
            <button type="button" class="action-button" data-action="view-flags" hidden disabled>
                <span class="action-icon icon" data-icon="flag"></span>
            </button>
        </template>
    `;
}

/**
 * @param {Document} document
 * @param {import('dictionary').DictionaryEntry[]} dictionaryEntries
 * @param {Partial<Record<string, unknown>>} [apiOverrides]
 * @returns {{display: any, api: any}}
 */
function createDisplay(document, dictionaryEntries, apiOverrides = {}) {
    const dictionaryEntryNodes = dictionaryEntries.map(() => {
        const node = document.createElement('div');
        node.className = 'entry';
        node.innerHTML = '<div class="note-actions-container"></div>';
        document.body.appendChild(node);
        return node;
    });

    const api = {
        getAnkiNoteInfo: vi.fn(async () => []),
        isAnkiConnected: vi.fn(async () => true),
        addAnkiNote: vi.fn(async () => 42),
        updateAnkiNote: vi.fn(async () => {}),
        getDictionaryInfo: vi.fn(async () => []),
        getDefaultAnkiFieldTemplates: vi.fn(async () => ''),
        forceSync: vi.fn(async () => {}),
        ...apiOverrides,
    };

    const displayGenerator = {
        /**
         * @param {string} name
         * @returns {Node|null}
         */
        instantiateTemplate(name) {
            const template = document.querySelector(`#${name}-template`);
            if (!(template instanceof HTMLTemplateElement)) { return null; }
            const {firstElementChild} = template.content;
            return firstElementChild === null ? null : firstElementChild.cloneNode(true);
        },
        createAnkiNoteErrorsNotificationContent() {
            return document.createElement('div');
        },
    };

    const hotkeyHelpController = {
        setHotkeyLabel: vi.fn(),
        getHotkeyLabel: vi.fn(() => null),
        setupNode: vi.fn(),
    };

    const display = {
        application: {api},
        hotkeyHandler: {registerActions: vi.fn()},
        on: vi.fn(),
        displayGenerator,
        dictionaryEntries,
        dictionaryEntryNodes,
        getOptions: () => ({anki: {enable: true}}),
        getContentOrigin: () => ({tabId: 1, frameId: 0}),
        getOptionsContext: () => /** @type {import('settings').OptionsContext} */ ({current: true}),
        getLanguageSummary: () => ({}),
        createNotification: () => ({setContent: vi.fn(), open: vi.fn(), close: vi.fn()}),
        progressIndicatorVisible: {
            setOverride: vi.fn(() => 1),
            clearOverride: vi.fn(),
        },
        _hotkeyHelpController: hotkeyHelpController,
    };

    return {
        display: /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)),
        api,
    };
}

/**
 * @param {number} noteId
 * @param {string} value
 * @returns {import('anki').NoteInfo}
 */
function createNoteInfo(noteId, value) {
    return {
        noteId,
        tags: [],
        fields: {
            Front: {value, order: 0},
        },
        modelName: 'Model',
        cards: [noteId],
        cardsInfo: [
            {
                noteId,
                cardId: noteId,
                flags: 0,
                cardState: 0,
            },
        ],
    };
}

/**
 * @returns {import('../ext/js/display/display-audio.js').DisplayAudio}
 */
function createDisplayAudio() {
    return /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (
        /** @type {unknown} */ ({
            getAnkiNoteMediaAudioDetails: vi.fn(() => ({
                sources: [],
                preferredAudioIndex: null,
                enableDefaultAudioSources: true,
            })),
        })
    );
}

/**
 * @param {string} front
 * @returns {import('anki').Note}
 */
function createCollectionNote(front) {
    return {
        fields: {Front: front},
        tags: [],
        deckName: 'Deck',
        modelName: 'Model',
        options: {
            allowDuplicate: true,
            duplicateScope: 'collection',
            duplicateScopeOptions: {
                deckName: null,
                checkChildren: false,
                checkAllModels: false,
            },
        },
    };
}

describe('DisplayAnki preload and save flow', () => {
    test('native duplicate candidates drive overwrite to the true first-field match', async ({window}) => {
        const originalFetch = globalThis.fetch;
        /** @type {import('anki').MessageBody[]} */
        const transportRequests = [];
        /** @type {number[]} */
        const updatedNoteIds = [];
        /**
         * @param {number} noteId
         * @param {string} modelName
         * @param {Record<string, string>} fields
         * @returns {Record<string, unknown>}
         */
        const noteInfo = (noteId, modelName, fields) => ({
            noteId,
            tags: [],
            fields: Object.fromEntries(Object.entries(fields).map(([name, value], order) => [name, {value, order}])),
            modelName,
            cards: [noteId + 1000],
        });
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            const body = /** @type {import('anki').MessageBody} */ (JSON.parse(String(options?.body)));
            transportRequests.push(body);
            let result;
            switch (body.action) {
                case 'version': result = 6; break;
                case 'modelNamesAndIds': result = {Model: 11, 'Term Model': 12}; break;
                case 'canAddNotesWithErrorDetail':
                    result = /** @type {import('anki').Note[]} */ (body.params.notes).map(() => ({canAdd: false, error: 'cannot create note because it is a duplicate'}));
                    break;
                case 'multi': {
                    result = /** @type {{params: {query: string}}[]} */ (body.params.actions).map(({params: {query}}) => {
                        if (query.includes('dupe:11,Alpha')) { return [202]; }
                        if (/front:Alpha/i.test(query)) { return [101, 202]; }
                        throw new Error(`Unexpected duplicate query: ${query}`);
                    });
                    break;
                }
                case 'notesInfo': result = /** @type {number[]} */ (body.params.notes).map((id) => noteInfo(id, 'Model', {Front: 'Alpha', Back: 'Original'})); break;
                case 'cardsInfo': result = /** @type {number[]} */ (body.params.cards).map((cardId) => ({cardId, noteId: cardId - 1000, flags: 0, cardState: 0})); break;
                case 'updateNoteFields':
                    updatedNoteIds.push((/** @type {import('anki').Note & {id: number}} */ (body.params.note)).id);
                    result = null;
                    break;
                default: throw new Error(`Unexpected AnkiConnect action: ${body.action}`);
            }
            return new Response(JSON.stringify(result));
        }));

        try {
            const anki = new AnkiConnect();
            anki.enabled = true;
            anki.server = 'http://localhost:8765';
            anki.apiKey = 'test-key';
            const backend = Object.create(Backend.prototype);
            backend._anki = anki;
            const updateAnkiNote = vi.fn((noteWithId) => backend._onApiUpdateAnkiNote({noteWithId}));
            /**
             * @param {{notes: import('anki').Note[], fetchAdditionalInfo: boolean}} request
             * @returns {Promise<import('anki').NoteInfoWrapper[]>}
             */
            const getAnkiNoteInfo = (request) => backend._onApiGetAnkiNoteInfo(request);

            setupDocument(window.document);
            const {display} = createDisplay(window.document, [createTermEntry()], {
                getAnkiNoteInfo,
                updateAnkiNote,
            });
            const displayAnki = new DisplayAnki(display, createDisplayAudio());
            displayAnki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
            displayAnki._cardFormats = [createCardFormat()];
            displayAnki._duplicateBehavior = 'overwrite';
            displayAnki._ankiFieldTemplates = 'test template';
            const [duplicateInfo] = await backend._onApiGetAnkiNoteInfo({
                notes: [createCollectionNote('Alpha')],
                fetchAdditionalInfo: true,
            });
            displayAnki._dictionaryEntryDetails = [{noteMap: new Map([[0, {
                cardFormat: displayAnki._cardFormats[0],
                ...duplicateInfo,
                ankiError: null,
            }]])}];
            displayAnki._updateSaveButtons(displayAnki._dictionaryEntryDetails);
            const updatedNote = createCollectionNote('Alpha');
            vi.spyOn(displayAnki._ankiNoteBuilder, 'createNote')
                .mockResolvedValueOnce({note: updatedNote, errors: [], requirements: []})
                .mockResolvedValueOnce({note: updatedNote, errors: [], requirements: []});
            await displayAnki._saveAnkiNote(0, 0);

            expect(updatedNoteIds).toEqual([202]);
            expect(transportRequests.find(({action}) => action === 'updateNoteFields')?.params.note).toMatchObject({id: 202, fields: {Front: 'Alpha'}});
            expect(transportRequests).toContainEqual(expect.objectContaining({action: 'modelNamesAndIds', key: 'test-key'}));
            expect(transportRequests.filter(({action}) => action === 'multi')).toContainEqual(expect.objectContaining({
                action: 'multi',
                key: 'test-key',
                params: {actions: [{action: 'findNotes', key: 'test-key', params: {query: '"dupe:11,Alpha"'}}]},
            }));
            expect(updateAnkiNote).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.fetch = originalFetch;
            vi.unstubAllGlobals();
        }
    });

    test('all-model native duplicate search excludes a secondary-field false candidate', async () => {
        const originalFetch = globalThis.fetch;
        /** @type {import('anki').MessageBody[]} */
        const transportRequests = [];
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            const body = /** @type {import('anki').MessageBody} */ (JSON.parse(String(options?.body)));
            transportRequests.push(body);
            let result;
            switch (body.action) {
                case 'version': result = 6; break;
                case 'modelNamesAndIds': result = {Model: 11, 'Other Model': 12}; break;
                case 'canAddNotesWithErrorDetail': result = [{canAdd: false, error: 'cannot create note because it is a duplicate'}]; break;
                case 'findNotes': result = String(body.params.query).includes('front:Alpha') ? [101] : [101, 202]; break;
                case 'multi':
                    result = /** @type {{params: {query: string}}[]} */ (body.params.actions).map(({params: {query}}) => (query.includes('dupe:12,Alpha') ? [202] : []));
                    break;
                case 'notesInfo': result = [{
                    noteId: 202,
                    tags: [],
                    fields: {Front: {value: 'Gamma', order: 0}, Back: {value: 'Alpha', order: 1}},
                    modelName: 'Other Model',
                    cards: [1202],
                }]; break;
                case 'cardsInfo': result = [{cardId: 1202, noteId: 202, flags: 0, cardState: 0}]; break;
                default: throw new Error(`Unexpected AnkiConnect action: ${body.action}`);
            }
            return new Response(JSON.stringify(result));
        }));

        try {
            const anki = new AnkiConnect();
            anki.enabled = true;
            anki.server = 'http://localhost:8765';
            anki.apiKey = 'test-key';
            const oldFieldSearchCandidates = await anki.findNotes('"front:Alpha"');
            expect(oldFieldSearchCandidates).toEqual([101]);
            const backend = Object.create(Backend.prototype);
            backend._anki = anki;
            const [info] = await backend._onApiGetAnkiNoteInfo({
                notes: [{
                    fields: {Front: 'Alpha', Back: 'incoming content'},
                    tags: [],
                    deckName: 'Deck',
                    modelName: 'Model',
                    options: {
                        allowDuplicate: true,
                        duplicateScope: 'collection',
                        duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: true},
                    },
                }],
                fetchAdditionalInfo: true,
            });

            expect(info.noteIds).toEqual([202]);
            expect(info.noteInfos?.[0]).toMatchObject({noteId: 202, modelName: 'Other Model'});
            const queries = /** @type {{params: {query: string}}[]} */ (transportRequests.find(({action}) => action === 'multi')?.params.actions ?? []).map(({params: {query}}) => query);
            expect(queries).toHaveLength(1);
            expect(queries[0]).toContain('"dupe:11,Alpha"');
            expect(queries[0]).toContain('"dupe:12,Alpha"');
        } finally {
            globalThis.fetch = originalFetch;
            vi.unstubAllGlobals();
        }
    });

    test('stale anki field-template refresh does not overwrite newer dictionary-backed templates', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const firstRefreshDeferred = Promise.withResolvers();
        const secondRefreshDeferred = Promise.withResolvers();
        const {display} = createDisplay(window.document, dictionaryEntries);
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        vi.spyOn(displayAnki, '_getAnkiFieldTemplates')
            .mockImplementationOnce(() => firstRefreshDeferred.promise)
            .mockImplementationOnce(() => secondRefreshDeferred.promise);

        const firstRefresh = displayAnki._updateAnkiFieldTemplates(/** @type {import('settings').ProfileOptions} */ ({}));
        const secondRefresh = displayAnki._updateAnkiFieldTemplates(/** @type {import('settings').ProfileOptions} */ ({}));
        secondRefreshDeferred.resolve('newer templates');
        await secondRefresh;
        firstRefreshDeferred.resolve('older templates');
        await firstRefresh;

        expect(displayAnki._ankiFieldTemplates).toBe('newer templates');
    });

    test('preload uses duplicate-check notes instead of full note creation', {timeout: 15_000}, async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries, {
            getAnkiNoteInfo: vi.fn(async () => [{
                canAdd: true,
                valid: true,
                isDuplicate: true,
                noteIds: [123],
                noteInfos: [createNoteInfo(123, 'existing')],
            }]),
        });
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        displayAnki._checkForDuplicates = true;
        displayAnki._duplicateBehavior = 'overwrite';
        displayAnki._displayTagsAndFlags = 'never';
        displayAnki._cardFormats = [createFastProbeCardFormat()];
        displayAnki._dictionaryEntryDetails = null;

        const createDuplicateCheckNoteFastSpy = vi.spyOn(displayAnki, '_tryCreateDuplicateCheckNoteFast');
        const createNoteSpy = vi.spyOn(displayAnki, '_createNote');

        await displayAnki._updateDictionaryEntryDetails();

        expect(createDuplicateCheckNoteFastSpy).toHaveBeenCalledTimes(1);
        expect(createNoteSpy).not.toHaveBeenCalled();
        expect(api.getAnkiNoteInfo).toHaveBeenCalledWith([{
            fields: {Front: 'term'},
            tags: [],
            deckName: 'Deck',
            modelName: 'Model',
            options: {
                allowDuplicate: true,
                duplicateScope: 'collection',
                duplicateScopeOptions: {
                    deckName: null,
                    checkChildren: false,
                    checkAllModels: false,
                },
            },
        }], true);

        const saveButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="save-note"]');
        const viewNoteButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="view-note"]');
        expect(saveButton?.dataset.overwrite).toBe('true');
        expect(viewNoteButton?.dataset.noteIds).toBe('123');
    });

    test('preload fast path skips template fetching for standard duplicate probes', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries, {
            getAnkiNoteInfo: vi.fn(async () => [{
                canAdd: true,
                valid: true,
                isDuplicate: false,
                noteIds: null,
                noteInfos: [],
            }]),
        });
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        displayAnki._checkForDuplicates = true;
        displayAnki._duplicateBehavior = 'prevent';
        displayAnki._displayTagsAndFlags = 'never';
        displayAnki._cardFormats = [createFastProbeCardFormat()];
        displayAnki._dictionaryEntryDetails = null;

        await displayAnki._updateDictionaryEntryDetails();

        expect(api.getDefaultAnkiFieldTemplates).not.toHaveBeenCalled();
        expect(api.getDictionaryInfo).not.toHaveBeenCalled();
        expect(api.getAnkiNoteInfo).toHaveBeenCalledWith([
            {
                fields: {Front: 'term'},
                tags: [],
                deckName: 'Deck',
                modelName: 'Model',
                options: {
                    allowDuplicate: true,
                    duplicateScope: 'collection',
                    duplicateScopeOptions: {
                        deckName: null,
                        checkChildren: false,
                        checkAllModels: false,
                    },
                },
            },
        ], false);
    });

    test('cold save performs the two-pass note build before adding a note', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries);
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        displayAnki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        displayAnki._cardFormats = [cardFormat];
        displayAnki._duplicateBehavior = 'new';
        displayAnki._dictionaryEntryDetails = /** @type {import('display-anki').DictionaryEntryDetails[]} */ ([{
            noteMap: new Map([[0, {
                cardFormat,
                canAdd: true,
                valid: true,
                isDuplicate: false,
                noteIds: null,
                ankiError: null,
            }]]),
        }]);

        const dictionaryEntryDetails = displayAnki._dictionaryEntryDetails;
        if (dictionaryEntryDetails === null) {
            throw new Error('Expected dictionary entry details');
        }
        displayAnki._updateSaveButtons(dictionaryEntryDetails);

        const initialNote = createCollectionNote('initial');
        const finalNote = {...initialNote, fields: {Front: 'final'}};

        const createNoteSpy = vi.spyOn(displayAnki, '_createNote')
            .mockResolvedValueOnce({note: initialNote, errors: [], requirements: [{type: 'audio'}]})
            .mockResolvedValueOnce({note: finalNote, errors: [], requirements: []});

        await displayAnki._saveAnkiNote(0, 0);

        expect(createNoteSpy.mock.calls.map((args) => args.slice(0, 3))).toEqual([
            [dictionaryEntries[0], 0, []],
            [dictionaryEntries[0], 0, [{type: 'audio'}]],
        ]);
        expect(api.addAnkiNote).toHaveBeenCalledWith(finalNote);
    });

    test('prevent duplicate mode disables save without fetching duplicate note ids', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries, {
            getAnkiNoteInfo: vi.fn(async () => [{
                canAdd: true,
                valid: true,
                isDuplicate: true,
                noteIds: null,
                noteInfos: [],
            }]),
        });
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        displayAnki._checkForDuplicates = true;
        displayAnki._duplicateBehavior = 'prevent';
        displayAnki._displayTagsAndFlags = 'never';
        displayAnki._cardFormats = [createFastProbeCardFormat()];
        displayAnki._dictionaryEntryDetails = null;

        await displayAnki._updateDictionaryEntryDetails();

        expect(api.getAnkiNoteInfo).toHaveBeenCalledWith([{
            fields: {Front: 'term'},
            tags: [],
            deckName: 'Deck',
            modelName: 'Model',
            options: {
                allowDuplicate: true,
                duplicateScope: 'collection',
                duplicateScopeOptions: {
                    deckName: null,
                    checkChildren: false,
                    checkAllModels: false,
                },
            },
        }], false);
        const saveButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="save-note"]');
        expect(saveButton?.disabled).toBe(true);
    });

    test('new duplicate mode fetches duplicate note ids lazily after the initial status check', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const getAnkiNoteInfo = vi.fn()
            .mockResolvedValueOnce([{
                canAdd: true,
                valid: true,
                isDuplicate: true,
                noteIds: null,
                noteInfos: [],
            }])
            .mockResolvedValueOnce([{
                canAdd: true,
                valid: true,
                isDuplicate: true,
                noteIds: [123],
                noteInfos: [],
            }]);
        const {display} = createDisplay(window.document, dictionaryEntries, {getAnkiNoteInfo});
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        displayAnki._checkForDuplicates = true;
        displayAnki._duplicateBehavior = 'new';
        displayAnki._displayTagsAndFlags = 'never';
        displayAnki._cardFormats = [createFastProbeCardFormat()];
        displayAnki._dictionaryEntryDetails = null;

        await displayAnki._updateDictionaryEntryDetails();
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        expect(getAnkiNoteInfo).toHaveBeenNthCalledWith(1, [{
            fields: {Front: 'term'},
            tags: [],
            deckName: 'Deck',
            modelName: 'Model',
            options: {
                allowDuplicate: true,
                duplicateScope: 'collection',
                duplicateScopeOptions: {
                    deckName: null,
                    checkChildren: false,
                    checkAllModels: false,
                },
            },
        }], false);
        expect(getAnkiNoteInfo).toHaveBeenNthCalledWith(2, [{
            fields: {Front: 'term'},
            tags: [],
            deckName: 'Deck',
            modelName: 'Model',
            options: {
                allowDuplicate: true,
                duplicateScope: 'collection',
                duplicateScopeOptions: {
                    deckName: null,
                    checkChildren: false,
                    checkAllModels: false,
                },
            },
        }], false);

        const saveButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="save-note"]');
        const viewNoteButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="view-note"]');
        expect(saveButton?.title).toBe('Add duplicate Expression note');
        expect(viewNoteButton?.dataset.noteIds).toBe('123');
    });

    test('overwrite uses cached duplicate metadata without recomputing popup details', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries);
        const displayAnki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        displayAnki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        displayAnki._cardFormats = [cardFormat];
        displayAnki._duplicateBehavior = 'overwrite';
        displayAnki._dictionaryEntryDetails = [{
            noteMap: new Map([[0, {
                cardFormat,
                canAdd: true,
                valid: true,
                isDuplicate: true,
                noteIds: [123],
                noteInfos: [createNoteInfo(123, 'existing value')],
                ankiError: null,
            }]]),
        }];

        displayAnki._updateSaveButtons(displayAnki._dictionaryEntryDetails);

        const note = createCollectionNote('updated value');

        const getDictionaryEntryDetailsSpy = vi.spyOn(displayAnki, '_getDictionaryEntryDetails');
        vi.spyOn(displayAnki, '_createNote')
            .mockResolvedValueOnce({note, errors: [], requirements: []})
            .mockResolvedValueOnce({note, errors: [], requirements: []});

        await displayAnki._saveAnkiNote(0, 0);

        expect(getDictionaryEntryDetailsSpy).not.toHaveBeenCalled();
        expect(api.updateAnkiNote).toHaveBeenCalledWith({
            ...note,
            id: 123,
        });
    });
});


describe('DisplayAnki render-overlapped duplicate preparation', () => {
    /**
     * @param {Document} document
     * @param {Partial<Record<string, unknown>>} [apiOverrides]
     * @returns {{display: ReturnType<typeof createDisplay>['display'], api: ReturnType<typeof createDisplay>['api'], anki: DisplayAnki, update: import('vitest').MockInstance<DisplayAnki['_updateSaveButtons']>}}
     */
    function setup(document, apiOverrides = {}) {
        setupDocument(document);
        const {display, api} = createDisplay(document, [createTermEntry()], apiOverrides);
        const anki = new DisplayAnki(display, createDisplayAudio());
        anki._checkForDuplicates = true;
        anki._checkForDuplicates = true;
        anki._duplicateBehavior = 'prevent';
        anki._cardFormats = [createFastProbeCardFormat()];
        vi.spyOn(anki, '_getNoteContext').mockReturnValue(null);
        const update = vi.spyOn(anki, '_updateSaveButtons').mockImplementation(() => {});
        return {display, api, anki, update};
    }

    test('starts the real probe before completion but publishes buttons only afterwards', async ({window}) => {
        const {api, anki, update} = setup(window.document);
        anki._onContentUpdateStart();
        const preload = anki._dictionaryEntryDetailsPreload;
        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(preload).not.toBeNull();
        if (preload === null) { throw new Error('Expected preload'); }
        await preload.promise;
        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
        expect(anki._dictionaryEntryDetails).toBeNull();
        await anki._updateDictionaryEntryDetails();
        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
        expect(anki._dictionaryEntryDetailsPreload).toBeNull();
        expect(anki._updateSaveButtonsPromise).toBeNull();
    });

    /**
     * @param {Document} document
     * @param {'prevent'|'overwrite'} duplicateBehavior
     * @returns {Promise<{display: ReturnType<typeof createDisplay>['display'], anki: DisplayAnki, api: ReturnType<typeof createDisplay>['api'], note: import('anki').Note}>}
     */
    async function prepareCustomDuplicate(document, duplicateBehavior) {
        const customTemplate = `${defaultAnkiFieldTemplates}\n\n{{#*inline "expression"}}CUSTOM-EXPRESSION{{/inline}}`;
        /**
         * @param {import('anki').Note[]} notes
         * @returns {Promise<import('anki').NoteInfoWrapper[]>}
         */
        async function getDuplicateInfo(notes) {
            return notes.map((note) => {
                const custom = note.fields.Front === 'CUSTOM-EXPRESSION';
                const noteId = custom ? 456 : 789;
                return {
                    canAdd: true,
                    valid: true,
                    isDuplicate: true,
                    noteIds: duplicateBehavior === 'overwrite' ? [noteId] : null,
                    noteInfos: duplicateBehavior === 'overwrite' ? [createNoteInfo(noteId, 'old target')] : [],
                };
            });
        }
        setupDocument(document);
        const {display, api} = createDisplay(document, [createTermEntry()], {
            getAnkiNoteInfo: vi.fn(getDuplicateInfo),
        });
        const anki = new DisplayAnki(display, createDisplayAudio());
        display.getOptions = () => ({anki: {enable: true, fieldTemplates: customTemplate}});
        anki._duplicateBehavior = duplicateBehavior;
        anki._displayTagsAndFlags = 'never';
        anki._cardFormats = [createFastProbeCardFormat()];
        anki._noteContext = {url: 'chrome-extension://test/search.html', sentence: {text: 'term', offset: 0}, documentTitle: 'title', query: 'term', fullQuery: 'term'};
        anki._ankiFieldTemplates = customTemplate;
        anki._ankiFieldTemplatesCacheOptionsGeneration = 0;
        anki._ankiNoteBuilder = createTemplateNoteBuilder();
        anki._checkForDuplicates = true;
        anki._dictionaries = [];
        const details = await anki._getDictionaryEntryDetails(display.dictionaryEntries, true);
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const notes = api.getAnkiNoteInfo.mock.calls[0]?.[0];
        if (!Array.isArray(notes) || notes.length !== 1) { throw new Error('Expected one custom-template duplicate probe'); }
        expect(notes[0].fields.Front).toBe('CUSTOM-EXPRESSION');
        expect(notes[0].fields.Front).not.toBe('term');
        return {display, anki, api, note: notes[0]};
    }

    test('uses the rendered custom first field to prevent duplicate saves', async ({window}) => {
        const {display, api} = await prepareCustomDuplicate(window.document, 'prevent');
        const saveButton = display.dictionaryEntryNodes[0].querySelector('.action-button[data-action="save-note"]');
        expect(saveButton?.disabled).toBe(true);
        expect(api.getAnkiNoteInfo).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({fields: {Front: 'CUSTOM-EXPRESSION'}})], false);
    });

    test('overwrites the custom-template duplicate target with fields built by the real save pipeline', async ({window}) => {
        const {display, anki, api} = await prepareCustomDuplicate(window.document, 'overwrite');
        await anki._saveAnkiNote(0, 0);
        expect(api.updateAnkiNote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            id: 456,
            fields: {Front: 'CUSTOM-EXPRESSION'},
        }));
        expect(api.updateAnkiNote.mock.calls[0]?.[0].id).not.toBe(789);
    });

    test('custom first-field preload starts before completion and publishes only after it', async ({window}) => {
        const customTemplate = `${defaultAnkiFieldTemplates}\n\n{{#*inline "first"}}CUSTOM-FIRST{{/inline}}`;
        const {display, anki, api, update} = setup(window.document, {
            getAnkiNoteInfo: vi.fn(async () => [{canAdd: true, valid: true, isDuplicate: false, noteIds: null, noteInfos: []}]),
        });
        display.getOptions = () => ({anki: {enable: true, fieldTemplates: customTemplate}});
        anki._cardFormats = [createCardFormat()];
        anki._noteContext = {url: 'chrome-extension://test/search.html', sentence: {text: 'term', offset: 0}, documentTitle: 'title', query: 'term', fullQuery: 'term'};
        anki._ankiFieldTemplates = customTemplate;
        anki._ankiFieldTemplatesCacheOptionsGeneration = 0;
        anki._ankiNoteBuilder = createTemplateNoteBuilder();
        vi.spyOn(anki, '_getNoteContext').mockReturnValue({url: 'chrome-extension://test/search.html', sentence: {text: 'term', offset: 0}, documentTitle: 'title', query: 'term', fullQuery: 'term'});

        anki._onContentUpdateStart();
        const preload = anki._dictionaryEntryDetailsPreload;
        expect(preload).not.toBeNull();
        if (preload === null) { throw new Error('Expected custom-template preload'); }
        await preload.promise;
        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(api.getAnkiNoteInfo).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({fields: {Front: 'CUSTOM-FIRST'}})], false);
        expect(update).not.toHaveBeenCalled();
        expect(anki._dictionaryEntryDetails).toBeNull();
        await anki._updateDictionaryEntryDetails();
        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
    });

    test('superseded preload cannot publish to the next render', async ({window}) => {
        /** @type {(details: import('display-anki').DictionaryEntryDetails[]) => void} */
        let resolveOld = (_details) => { throw new Error('Preload was not started'); };
        const {display, anki, update} = setup(window.document);
        const oldDetails = [{noteMap: new Map()}];
        const newDetails = [{noteMap: new Map()}];
        const prepare = vi.spyOn(anki, '_getDictionaryEntryDetails')
            .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
            .mockResolvedValueOnce(newDetails);
        anki._onContentUpdateStart();
        const oldPromise = anki._dictionaryEntryDetailsPreload?.promise;
        anki._onContentClear();
        display.dictionaryEntries = [createTermEntry()];
        anki._onContentUpdateStart();
        const completion = anki._updateDictionaryEntryDetails();
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
        resolveOld(oldDetails);
        await oldPromise;
        await completion;
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(anki._dictionaryEntryDetails).toBe(newDetails);
        expect(update).toHaveBeenCalledExactlyOnceWith(newDetails);
    });

    test('cleared rejected preload is handled and does not publish', async ({window}) => {
        /** @type {(error: Error) => void} */
        let rejectOld = (_error) => { throw new Error('Preload was not started'); };
        const {anki, update} = setup(window.document);
        vi.spyOn(anki, '_getDictionaryEntryDetails').mockImplementation(() => new Promise((_, reject) => { rejectOld = reject; }));
        anki._onContentUpdateStart();
        const promise = anki._dictionaryEntryDetailsPreload?.promise;
        anki._onContentClear();
        rejectOld(new Error('obsolete preparation failed'));
        await expect(promise).rejects.toThrow('obsolete');
        expect(update).not.toHaveBeenCalled();
        expect(anki._dictionaryEntryDetailsPreload).toBeNull();
    });

    test('completion rejection releases the update lock', async ({window}) => {
        const {anki, update} = setup(window.document);
        vi.spyOn(anki, '_getDictionaryEntryDetails').mockRejectedValue(new Error('preparation failed'));
        anki._onContentUpdateStart();
        await expect(anki._updateDictionaryEntryDetails()).rejects.toThrow('preparation failed');
        expect(update).not.toHaveBeenCalled();
        expect(anki._updateSaveButtonsPromise).toBeNull();
    });

    test('stale quick duplicate completion cannot publish to a replacement render or start full work', async ({window}) => {
        const pendingInfo = Promise.withResolvers();
        const {display, api, anki} = setup(window.document, {
            getAnkiNoteInfo: vi.fn(() => pendingInfo.promise),
        });
        const oldEntries = display.dictionaryEntries;
        const oldRow = display.dictionaryEntryNodes[0];
        oldRow.innerHTML = '<div class="note-actions-container"></div>';
        anki._noteDupeCheckFirst = true;
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._ankiFieldTemplates = 'templates';
        anki._ankiFieldTemplatesCacheOptionsGeneration = 0;
        vi.spyOn(anki._ankiNoteBuilder, 'createNote').mockResolvedValue({note: createCollectionNote('front'), errors: [], requirements: []});
        const fullWork = vi.spyOn(anki, '_getDictionaryEntryDetails');

        const completion = anki._updateDictionaryEntryDetails();
        await vi.waitFor(() => expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1));
        anki._onContentClear();
        const replacementEntry = createTermEntry();
        display.dictionaryEntries = [replacementEntry];
        const replacementRow = window.document.createElement('div');
        replacementRow.innerHTML = '<div class="note-actions-container"></div>';
        display.dictionaryEntryNodes = [replacementRow];
        window.document.body.appendChild(replacementRow);
        pendingInfo.resolve([{noteIds: [777]}]);
        await completion;

        expect(oldEntries[0]).not.toBe(replacementEntry);
        expect(replacementRow.querySelector('.duplicate-indicator')).toBeNull();
        expect(fullWork).not.toHaveBeenCalled();
    });

    test('stale rejected quick duplicate check cannot start full work', async ({window}) => {
        const pendingConnectionCheck = Promise.withResolvers();
        const {display, api, anki} = setup(window.document, {
            isAnkiConnected: vi.fn(() => pendingConnectionCheck.promise),
        });
        anki._noteDupeCheckFirst = true;
        const fullWork = vi.spyOn(anki, '_getDictionaryEntryDetails');

        const completion = anki._updateDictionaryEntryDetails();
        await vi.waitFor(() => expect(api.isAnkiConnected).toHaveBeenCalledTimes(1));
        anki._onContentClear();
        display.dictionaryEntries = [createTermEntry()];
        pendingConnectionCheck.reject(new Error('connection check failed'));
        await completion;

        expect(fullWork).not.toHaveBeenCalled();
    });

    test('current quick duplicate completion publishes and continues the normal details pass', async ({window}) => {
        const {display, api, anki} = setup(window.document, {
            getAnkiNoteInfo: vi.fn(async () => [{noteIds: [777]}]),
        });
        display.dictionaryEntryNodes[0].innerHTML = '<div class="note-actions-container"></div>';
        anki._noteDupeCheckFirst = true;
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._ankiFieldTemplates = 'templates';
        anki._ankiFieldTemplatesCacheOptionsGeneration = 0;
        vi.spyOn(anki._ankiNoteBuilder, 'createNote').mockResolvedValue({note: createCollectionNote('front'), errors: [], requirements: []});
        const fullWork = vi.spyOn(anki, '_getDictionaryEntryDetails').mockResolvedValue([{noteMap: new Map()}]);

        await anki._updateDictionaryEntryDetails();

        expect(api.getAnkiNoteInfo).toHaveBeenCalledTimes(1);
        expect(display.dictionaryEntryNodes[0].querySelector('.duplicate-indicator .action-icon')?.dataset.icon).toBe('big-circle');
        expect(fullWork).toHaveBeenCalledTimes(1);
    });

    test('quick duplicate check probes literal fields exactly without fetching templates', async ({window}) => {
        const {display, api, anki} = setup(window.document, {getAnkiNoteInfo: vi.fn(createNoDuplicateInfo)});
        const cardFormat = createFastProbeCardFormat();
        cardFormat.fields.Front.value = 'literal-first-field';
        anki._cardFormats = [cardFormat];
        display.getOptions = () => ({anki: {enable: true, fieldTemplates: 'custom template'}});
        const token = /** @type {import('core').TokenObject} */ ({});
        anki._updateDictionaryEntryDetailsToken = token;
        const createNote = vi.spyOn(anki._ankiNoteBuilder, 'createNote');

        await anki._quickDupeCheck(display.dictionaryEntries, token, anki._optionsGeneration);

        expect(api.getAnkiNoteInfo.mock.calls[0]?.[0][0]?.fields).toStrictEqual({Front: 'literal-first-field'});
        expect(api.getDefaultAnkiFieldTemplates).not.toHaveBeenCalled();
        expect(createNote).not.toHaveBeenCalled();
    });

    test('quick duplicate check defers default reading and custom marker fields to full rendering', async ({window}) => {
        const {display, api, anki} = setup(window.document, {getAnkiNoteInfo: vi.fn(createNoDuplicateInfo)});
        const readingFormat = createFastProbeCardFormat();
        readingFormat.fields.Front.value = '{reading}';
        anki._cardFormats = [readingFormat];
        const token = /** @type {import('core').TokenObject} */ ({});
        anki._updateDictionaryEntryDetailsToken = token;

        const readingResult = await anki._quickDupeCheck(display.dictionaryEntries, token, anki._optionsGeneration);

        expect(readingResult).toBeUndefined();
        expect(api.getAnkiNoteInfo).not.toHaveBeenCalled();
        display.getOptions = () => ({anki: {enable: true, fieldTemplates: 'custom template'}});
        anki._cardFormats = [createFastProbeCardFormat()];

        const result = await anki._quickDupeCheck(display.dictionaryEntries, token, anki._optionsGeneration);

        expect(result).toBeUndefined();
        expect(api.getAnkiNoteInfo).not.toHaveBeenCalled();
        expect(api.getDefaultAnkiFieldTemplates).not.toHaveBeenCalled();
    });

    test('quick duplicate check keeps merge expression parity and filters card formats by entry type', async ({window}) => {
        const termEntry = createTermEntry();
        termEntry.headwords.push({index: 1, headwordIndex: 1, term: 'alternate', reading: 'alternate-reading', sources: [createSource('alternate')], tags: [], wordClasses: []});
        const kanjiEntry = /** @type {import('dictionary').DictionaryEntry} */ ({type: 'kanji', character: '字'});
        const {display, api, anki} = setup(window.document, {getAnkiNoteInfo: vi.fn(createNoDuplicateInfo)});
        display.dictionaryEntries = [termEntry, kanjiEntry];
        anki._resultOutputMode = 'merge';
        anki._cardFormats = [createFastProbeCardFormat(), {
            ...createFastProbeCardFormat(),
            type: 'kanji',
            name: 'Kanji',
            fields: {Front: {value: '{character}', overwriteMode: 'overwrite'}},
        }];
        const token = /** @type {import('core').TokenObject} */ ({});
        anki._updateDictionaryEntryDetailsToken = token;

        await anki._quickDupeCheck(display.dictionaryEntries, token, anki._optionsGeneration);

        expect(api.getAnkiNoteInfo.mock.calls[0]?.[0].map((/** @type {import('anki').Note} */ note) => note.fields.Front)).toEqual(['term、alternate', '字']);
    });

    for (const mode of ['disabled', 'duplicates-disabled', 'quick-check', 'busy', 'empty']) {
        test(`preserves the existing ${mode} path`, async ({window}) => {
            const {anki, display} = setup(window.document);
            if (mode === 'disabled') { display.getOptions = () => ({anki: {enable: false}}); }
            if (mode === 'duplicates-disabled') { anki._checkForDuplicates = false; }
            if (mode === 'quick-check') { anki._noteDupeCheckFirst = true; }
            if (mode === 'busy') { anki._updateSaveButtonsPromise = Promise.resolve(); }
            if (mode === 'empty') { display.dictionaryEntries = []; }
            const get = vi.spyOn(anki, '_getDictionaryEntryDetails');
            anki._onContentUpdateStart();
            expect(get).not.toHaveBeenCalled();
            expect(anki._dictionaryEntryDetailsPreload).toBeNull();
        });
    }
});

describe('DisplayAnki save invocation ownership', () => {
    /**
     * @param {Document} document
     * @param {'new'|'overwrite'} [behavior]
     * @returns {{anki: DisplayAnki, display: import('../ext/js/display/display.js').Display, api: any, replace: () => HTMLDivElement}}
     */
    function createSaveHarness(document, behavior = 'new') {
        setupDocument(document);
        const {display, api} = createDisplay(document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'original'});
        anki._ankiFieldTemplates = 'original template';
        anki._duplicateBehavior = behavior;
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: behavior === 'overwrite',
            noteIds: behavior === 'overwrite' ? [101] : null,
            noteInfos: behavior === 'overwrite' ? [createNoteInfo(101, 'original fields')] : [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const replace = () => {
            anki._onContentClear();
            const row = document.createElement('div');
            row.innerHTML = '<div class="note-actions-container"></div>';
            document.body.appendChild(row);
            display.dictionaryEntries[0] = createTermEntry();
            display.dictionaryEntryNodes[0] = row;
            anki._dictionaryEntryDetails = [{noteMap: new Map([[0, {
                cardFormat,
                canAdd: true,
                valid: true,
                isDuplicate: false,
                noteIds: null,
                noteInfos: [],
                ankiError: null,
            }]])}];
            anki._updateSaveButtons(anki._dictionaryEntryDetails);
            return row;
        };
        return {anki, display, api, replace};
    }

    for (const blockedPass of [1, 2]) {
        test('retains original overwrite when build pass ' + blockedPass + ' is pending', async ({window}) => {
            const {anki, api, replace} = createSaveHarness(window.document, 'overwrite');
            const pendingBuild = Promise.withResolvers();
            let calls = 0;
            const note = createCollectionNote('original saved payload');
            vi.spyOn(anki._ankiNoteBuilder, 'createNote').mockImplementation(() => {
                ++calls;
                return calls === blockedPass ? pendingBuild.promise : Promise.resolve({note, errors: [], requirements: []});
            });
            const saving = anki._saveAnkiNote(0, 0);
            await vi.waitFor(() => expect(calls).toBe(blockedPass));
            const replacement = replace();
            const replacementBefore = replacement.innerHTML;
            pendingBuild.resolve({note, errors: [], requirements: []});
            await saving;
            expect(api.updateAnkiNote).toHaveBeenCalledExactlyOnceWith({...note, id: 101});
            expect(replacement.innerHTML).toBe(replacementBefore);
        });
    }


    test('audio consent is reevaluated before the second media build pass', async ({window}) => {
        const {anki, api} = createSaveHarness(window.document);
        let allowed = true;
        const getAudio = vi.spyOn(anki._displayAudio, 'getAnkiNoteMediaAudioDetails').mockImplementation(() => ({
            sources: allowed ? [{type: 'custom', url: 'https://audio.example/{term}', voice: ''}] : [],
            preferredAudioIndex: null,
            enableDefaultAudioSources: allowed,
        }));
        const note = createCollectionNote('saved');
        const build = vi.spyOn(anki._ankiNoteBuilder, 'createNote')
            .mockImplementationOnce(async () => {
                allowed = false;
                return {note, errors: [], requirements: [{type: 'audio'}]};
            })
            .mockResolvedValueOnce({note, errors: [], requirements: []});
        await anki._saveAnkiNote(0, 0);
        expect(getAudio).toHaveBeenCalledTimes(2);
        expect(build.mock.calls[0][0].mediaOptions?.audio?.enableDefaultAudioSources).toBe(true);
        expect(build.mock.calls[1][0].mediaOptions?.audio).toMatchObject({sources: [], enableDefaultAudioSources: false});
        expect(api.addAnkiNote).toHaveBeenCalledTimes(1);
    });

    test('stale Anki failure cannot replace the current result notifications', async ({window}) => {
        const {anki, api, replace} = createSaveHarness(window.document);
        const pendingAdd = Promise.withResolvers();
        api.addAnkiNote.mockImplementation(() => pendingAdd.promise);
        vi.spyOn(anki._ankiNoteBuilder, 'createNote').mockResolvedValue({note: createCollectionNote('old'), errors: [], requirements: []});
        const show = vi.spyOn(anki, '_showErrorNotification').mockImplementation(() => {});
        const hide = vi.spyOn(anki, '_hideErrorNotification').mockImplementation(() => {});
        const saving = anki._saveAnkiNote(0, 0);
        await vi.waitFor(() => expect(api.addAnkiNote).toHaveBeenCalledTimes(1));
        const replacement = replace();
        const replacementBefore = replacement.innerHTML;
        show.mockClear();
        hide.mockClear();
        pendingAdd.reject(new Error('old save failed'));
        await saving;
        expect(show).not.toHaveBeenCalled();
        expect(hide).not.toHaveBeenCalled();
        expect(replacement.innerHTML).toBe(replacementBefore);
    });
    test('overwrite keeps the original target and field policy when the row is replaced during note building', async ({window}) => {
        setupDocument(window.document);
        const originalEntry = createTermEntry();
        const replacementEntry = createTermEntry();
        const {display, api} = createDisplay(window.document, [originalEntry]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._cardFormats = [cardFormat];
        anki._duplicateBehavior = 'overwrite';
        const originalDetails = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: true,
            noteIds: [101],
            noteInfos: [createNoteInfo(101, 'original value')],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = originalDetails;
        anki._updateSaveButtons(originalDetails);

        const firstBuild = Promise.withResolvers();
        const firstNote = createCollectionNote('first');
        const finalNote = createCollectionNote('updated value');
        const build = vi.spyOn(anki, '_createNote')
            .mockReturnValueOnce(firstBuild.promise)
            .mockResolvedValueOnce({note: finalNote, errors: [], requirements: []});
        const saving = anki._saveAnkiNote(0, 0);
        expect(build).toHaveBeenCalledTimes(1);

        cardFormat.fields.Front.overwriteMode = 'skip';
        const replacementRow = window.document.createElement('div');
        replacementRow.className = 'entry';
        replacementRow.innerHTML = '<div class="note-actions-container"></div>';
        display.dictionaryEntries = [replacementEntry];
        display.dictionaryEntryNodes = [replacementRow];
        window.document.body.appendChild(replacementRow);
        const replacementDetails = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: true,
            noteIds: [202],
            noteInfos: [createNoteInfo(202, 'replacement value')],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = replacementDetails;
        anki._updateSaveButtons(replacementDetails);

        firstBuild.resolve({note: firstNote, errors: [], requirements: []});
        await saving;

        expect(api.updateAnkiNote).toHaveBeenCalledWith({...finalNote, id: 101});
        expect(api.updateAnkiNote.mock.calls[0][0].fields.Front).toBe('updated value');
    });

    test('captures save inputs before synchronous progress observers replace the result', async ({window}) => {
        setupDocument(window.document);
        const originalEntry = createTermEntry();
        const replacementEntry = createTermEntry();
        const {display, api} = createDisplay(window.document, [originalEntry]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'original'});
        anki._ankiFieldTemplates = 'original template';
        anki._duplicateBehavior = 'overwrite';
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: true,
            noteIds: [101],
            noteInfos: [createNoteInfo(101, 'existing')],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const replacementRow = window.document.createElement('div');
        replacementRow.className = 'entry';
        replacementRow.innerHTML = '<div class="note-actions-container"></div>';
        const replacementDetails = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: true,
            noteIds: [202],
            noteInfos: [createNoteInfo(202, 'replacement')],
            ankiError: null,
        }]])}];
        const override = vi.fn(() => {
            display.dictionaryEntries = [replacementEntry];
            display.dictionaryEntryNodes = [replacementRow];
            window.document.body.appendChild(replacementRow);
            anki._dictionaryEntryDetails = replacementDetails;
            anki._cardFormats = [{...createCardFormat(), deck: 'Replacement Deck', model: 'Replacement Model'}];
            anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'replacement'});
            anki._ankiFieldTemplates = 'replacement template';
            return 9;
        });
        display.progressIndicatorVisible.setOverride = override;
        const build = vi.spyOn(anki._ankiNoteBuilder, 'createNote')
            .mockResolvedValueOnce({note: createCollectionNote('first'), errors: [], requirements: []})
            .mockResolvedValueOnce({note: createCollectionNote('saved'), errors: [], requirements: []});

        await anki._saveAnkiNote(0, 0);

        expect(api.updateAnkiNote).toHaveBeenCalledWith({...createCollectionNote('saved'), id: 101});
        expect(build).toHaveBeenCalledTimes(2);
        expect(build.mock.calls.map(([options]) => ({
            deck: options.cardFormat.deck,
            model: options.cardFormat.model,
            url: options.context.url,
            template: options.template,
        }))).toEqual(new Array(2).fill({deck: 'Deck', model: 'Model', url: 'original', template: 'original template'}));
        expect(override).toHaveBeenCalledTimes(1);
        expect(display.progressIndicatorVisible.clearOverride).toHaveBeenCalledWith(9);
    });

    test('cold save template lookup uses captured options and does not alter the shared template cache', async ({window}) => {
        setupDocument(window.document);
        const {display, api} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'captured'});
        anki._ankiFieldTemplates = null;
        anki._duplicateBehavior = 'new';
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const originalOptions = {anki: {enable: true, fieldTemplates: 'original options'}};
        let activeOptions = originalOptions;
        display.getOptions = () => activeOptions;
        const getTemplates = vi.spyOn(anki, '_getAnkiFieldTemplates').mockResolvedValue('captured template');
        const build = vi.spyOn(anki._ankiNoteBuilder, 'createNote')
            .mockResolvedValue({note: createCollectionNote('built'), errors: [], requirements: []});
        display.progressIndicatorVisible.setOverride = vi.fn(() => {
            activeOptions = {anki: {enable: true, fieldTemplates: 'replacement options'}};
            anki._ankiFieldTemplates = 'replacement cache';
            anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'replacement'});
            return 5;
        });

        await anki._saveAnkiNote(0, 0);

        expect(getTemplates).toHaveBeenCalledExactlyOnceWith(originalOptions);
        expect(build).toHaveBeenCalledTimes(2);
        expect(build.mock.calls.map(([options]) => options.template)).toEqual(['captured template', 'captured template']);
        expect(build.mock.calls.map(([options]) => options.context.url)).toEqual(['captured', 'captured']);
        expect(anki._ankiFieldTemplates).toBe('replacement cache');
        expect(api.addAnkiNote).toHaveBeenCalledTimes(1);
    });

    test('ordinary cold common-note preparation populates the reusable template cache', async ({window}) => {
        setupDocument(window.document);
        const {display} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        anki._cardFormats = [createCardFormat()];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        const getTemplates = vi.spyOn(anki, '_getAnkiFieldTemplates').mockResolvedValue('cached templates');

        await anki._getCommonNoteBuildData(0);
        await anki._getCommonNoteBuildData(0);

        expect(getTemplates).toHaveBeenCalledTimes(1);
        expect(anki._ankiFieldTemplates).toBe('cached templates');
    });

    test('ordinary common-note preparation returns its captured template after options change', async ({window}) => {
        setupDocument(window.document);
        const {display} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormatA = {...createCardFormat(), deck: 'Deck A', model: 'Model A'};
        const cardFormatB = {...createCardFormat(), deck: 'Deck B', model: 'Model B'};
        anki._cardFormats = [cardFormatA];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        const templateA = Promise.withResolvers();
        const getTemplates = vi.spyOn(anki, '_getAnkiFieldTemplates').mockImplementation((options) => (
            options.anki.fieldTemplates === 'A-template' ? templateA.promise : Promise.resolve('B-template')
        ));
        display.getOptions = () => createTemplateOptions(cardFormatA, 'A-template');

        const oldBuildData = anki._getCommonNoteBuildData(0);
        await vi.waitFor(() => expect(getTemplates).toHaveBeenCalledTimes(1));
        const optionsB = createTemplateOptions(cardFormatB, 'B-template');
        anki._onOptionsUpdated({options: optionsB});
        await anki._ankiFieldTemplatesPromise;
        templateA.resolve('A-template');
        const resultA = await oldBuildData;

        expect(resultA).toMatchObject({cardFormat: cardFormatA, template: 'A-template'});
        expect(anki._ankiFieldTemplates?.trimEnd()).toBe('B-template');
    });

    test('save waits for its options generation template and uses it in both build passes', async ({window}) => {
        setupDocument(window.document);
        const {display, api} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormatA = {...createCardFormat(), deck: 'Deck A', model: 'Model A'};
        const cardFormatB = {...createCardFormat(), deck: 'Deck B', model: 'Model B'};
        const details = [{noteMap: new Map([[0, {
            cardFormat: cardFormatA,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._cardFormats = [cardFormatA];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'original'});
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const dictionaryInfo = Promise.withResolvers();
        api.getDictionaryInfo = vi.fn(() => dictionaryInfo.promise);
        display.getOptions = () => createTemplateOptions(cardFormatB, 'B-template');
        /** @type {import('template-renderer').RenderMultiItem[][]} */
        const renderCalls = [];
        anki._ankiNoteBuilder._templateRenderer = /** @type {import('../ext/js/templates/template-renderer-proxy.js').TemplateRendererProxy} */ (/** @type {unknown} */ ({
            renderMulti: vi.fn(async (/** @type {import('template-renderer').RenderMultiItem[]} */ items) => {
                renderCalls.push(items);
                return items.flatMap(({template, templateItems}) => templateItems.flatMap(({datas}) => datas.map(({marker}) => ({result: {result: `${template.trimEnd()}::${marker}`, requirements: []}}))));
            }),
        }));
        anki._onOptionsUpdated({options: createTemplateOptions(cardFormatB, 'B-template')});
        expect(anki._ankiFieldTemplates).toBeNull();
        const saving = anki._saveAnkiNote(0, 0);
        await Promise.resolve();
        expect(renderCalls).toHaveLength(0);
        dictionaryInfo.resolve([]);
        await saving;

        expect(renderCalls).toHaveLength(2);
        expect(renderCalls.flatMap((items) => items.map(({template}) => template.trimEnd()))).toEqual(['B-template', 'B-template']);
        expect(api.addAnkiNote).toHaveBeenCalledTimes(1);
        expect(api.addAnkiNote.mock.calls[0][0]).toMatchObject({
            deckName: 'Deck B', modelName: 'Model B', fields: {Front: 'B-template::first'},
        });
    });

    test('accepted save keeps its original template after a newer options refresh completes', async ({window}) => {
        setupDocument(window.document);
        const {display, api} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormatA = {...createCardFormat(), deck: 'Deck A', model: 'Model A'};
        const cardFormatB = {...createCardFormat(), deck: 'Deck B', model: 'Model B'};
        const details = [{noteMap: new Map([[0, {
            cardFormat: cardFormatA,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._cardFormats = [cardFormatA];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({url: 'original'});
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        display.getOptions = () => createTemplateOptions(cardFormatA, 'A-template');
        anki._onOptionsUpdated({options: createTemplateOptions(cardFormatA, 'A-template')});
        await anki._ankiFieldTemplatesPromise;

        const firstRender = Promise.withResolvers();
        /** @type {import('template-renderer').RenderMultiItem[][]} */
        const renderCalls = [];
        anki._ankiNoteBuilder._templateRenderer = /** @type {import('../ext/js/templates/template-renderer-proxy.js').TemplateRendererProxy} */ (/** @type {unknown} */ ({
            renderMulti: vi.fn((/** @type {import('template-renderer').RenderMultiItem[]} */ items) => {
                renderCalls.push(items);
                if (renderCalls.length === 1) { return firstRender.promise; }
                return Promise.resolve(items.flatMap(({template, templateItems}) => templateItems.flatMap(({datas}) => datas.map(({marker}) => ({result: {result: `${template.trimEnd()}::${marker}`, requirements: []}})))));
            }),
        }));
        const saving = anki._saveAnkiNote(0, 0);
        await vi.waitFor(() => expect(renderCalls).toHaveLength(1));
        const dictionaryInfo = Promise.withResolvers();
        api.getDictionaryInfo = vi.fn(() => dictionaryInfo.promise);
        display.getOptions = () => createTemplateOptions(cardFormatB, 'B-template');
        anki._onOptionsUpdated({options: createTemplateOptions(cardFormatB, 'B-template')});
        dictionaryInfo.resolve([]);
        await anki._ankiFieldTemplatesPromise;
        firstRender.resolve(renderCalls[0].flatMap(({template, templateItems}) => templateItems.flatMap(({datas}) => datas.map(({marker}) => ({result: {result: `${template.trimEnd()}::${marker}`, requirements: []}})))));
        await saving;

        expect(renderCalls).toHaveLength(2);
        expect(renderCalls.flatMap((items) => items.map(({template}) => template.trimEnd()))).toEqual(['A-template', 'A-template']);
        expect(api.addAnkiNote.mock.calls[0][0]).toMatchObject({
            deckName: 'Deck A', modelName: 'Model A', fields: {Front: 'A-template::first'},
        });
        expect(anki._ankiFieldTemplates?.trimEnd()).toBe('B-template');
    });

    test('rejected template refresh retries on a save in the same options generation', async ({window}) => {
        setupDocument(window.document);
        const {display, api} = createDisplay(window.document, [createTermEntry()]);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const failedDictionaryInfo = Promise.withResolvers();
        api.getDictionaryInfo = vi.fn()
            .mockImplementationOnce(() => failedDictionaryInfo.promise)
            .mockResolvedValueOnce([]);
        const failedOptions = createTemplateOptions(cardFormat, 'failed-template');
        display.getOptions = () => failedOptions;
        anki._onOptionsUpdated({options: failedOptions});
        const failedRefresh = anki._ankiFieldTemplatesPromise;
        if (failedRefresh === null) { throw new Error('Expected template refresh'); }
        failedDictionaryInfo.reject(new Error('dictionary information unavailable'));
        await expect(failedRefresh).rejects.toThrow('dictionary information unavailable');

        /** @type {import('template-renderer').RenderMultiItem[][]} */
        const renderCalls = [];
        anki._ankiNoteBuilder._templateRenderer = /** @type {import('../ext/js/templates/template-renderer-proxy.js').TemplateRendererProxy} */ (/** @type {unknown} */ ({
            renderMulti: vi.fn(async (/** @type {import('template-renderer').RenderMultiItem[]} */ items) => {
                renderCalls.push(items);
                return items.flatMap(({template, templateItems}) => templateItems.flatMap(({datas}) => datas.map(({marker}) => ({result: {result: `${template.trimEnd()}::${marker}`, requirements: []}}))));
            }),
        }));

        await anki._saveAnkiNote(0, 0);

        expect(api.getDictionaryInfo).toHaveBeenCalledTimes(2);
        expect(renderCalls).toHaveLength(2);
        expect(renderCalls.flatMap((items) => items.map(({template}) => template.trimEnd()))).toEqual(['failed-template', 'failed-template']);
        expect(anki._ankiFieldTemplates?.trimEnd()).toBe('failed-template');
        expect(anki._ankiFieldTemplatesCacheOptionsGeneration).toBe(anki._optionsGeneration);
        expect(api.addAnkiNote.mock.calls[0][0]).toMatchObject({fields: {Front: 'failed-template::first'}});
    });

    test('add completion does not attach its note ID to a replacement row', async ({window}) => {
        setupDocument(window.document);
        const originalEntry = createTermEntry();
        const replacementEntry = createTermEntry();
        const add = Promise.withResolvers();
        const {display, api} = createDisplay(window.document, [originalEntry], {
            addAnkiNote: vi.fn(() => add.promise),
        });
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._cardFormats = [cardFormat];
        anki._duplicateBehavior = 'new';
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const note = createCollectionNote('pending note');
        vi.spyOn(anki, '_createNote')
            .mockResolvedValueOnce({note, errors: [], requirements: []})
            .mockResolvedValueOnce({note, errors: [], requirements: []});

        const saving = anki._saveAnkiNote(0, 0);
        await vi.waitFor(() => expect(api.addAnkiNote).toHaveBeenCalledTimes(1));

        const replacementRow = window.document.createElement('div');
        replacementRow.className = 'entry';
        replacementRow.innerHTML = '<div class="note-actions-container"></div>';
        display.dictionaryEntries = [replacementEntry];
        display.dictionaryEntryNodes = [replacementRow];
        window.document.body.appendChild(replacementRow);
        const replacementDetails = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = replacementDetails;
        anki._updateSaveButtons(replacementDetails);

        add.resolve(700);
        await saving;

        expect(api.addAnkiNote).toHaveBeenCalledWith(note);
        expect(replacementRow.querySelector('.action-button[data-action="view-note"]')).toBeNull();
    });

    test('both real note-build passes use the captured card format after an in-place options change', async ({window}) => {
        setupDocument(window.document);
        const dictionaryEntries = [createTermEntry()];
        const {display, api} = createDisplay(window.document, dictionaryEntries);
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._duplicateBehavior = 'new';
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._ankiFieldTemplates = 'captured template';
        const details = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._dictionaryEntryDetails = details;
        anki._updateSaveButtons(details);
        const build = vi.spyOn(anki._ankiNoteBuilder, 'createNote')
            .mockImplementationOnce(async () => {
                cardFormat.fields.Front.overwriteMode = 'skip';
                return {note: createCollectionNote('first pass'), errors: [], requirements: [{type: 'audio'}]};
            })
            .mockResolvedValueOnce({note: createCollectionNote('built'), errors: [], requirements: []});

        await anki._saveAnkiNote(0, 0);

        expect(build).toHaveBeenCalledTimes(2);
        expect(build.mock.calls.map(([options]) => options.cardFormat.fields.Front.overwriteMode)).toEqual(['overwrite', 'overwrite']);
        expect(build.mock.calls.map(([options]) => options.template)).toEqual(['captured template', 'captured template']);
        expect(cardFormat.fields.Front.overwriteMode).toBe('skip');
        expect(api.addAnkiNote).toHaveBeenCalledTimes(1);
    });

    test('same-row Anki failure is still reported', async ({window}) => {
        setupDocument(window.document);
        const {display} = createDisplay(window.document, [createTermEntry()], {
            addAnkiNote: vi.fn(async () => { throw new Error('Anki write failed'); }),
        });
        const anki = new DisplayAnki(display, createDisplayAudio());
        const cardFormat = createCardFormat();
        anki._cardFormats = [cardFormat];
        anki._duplicateBehavior = 'new';
        anki._noteContext = /** @type {import('anki-templates-internal').Context} */ ({});
        anki._dictionaryEntryDetails = [{noteMap: new Map([[0, {
            cardFormat,
            canAdd: true,
            valid: true,
            isDuplicate: false,
            noteIds: null,
            noteInfos: [],
            ankiError: null,
        }]])}];
        anki._updateSaveButtons(anki._dictionaryEntryDetails);
        const note = createCollectionNote('write attempt');
        vi.spyOn(anki, '_createNote')
            .mockResolvedValueOnce({note, errors: [], requirements: []})
            .mockResolvedValueOnce({note, errors: [], requirements: []});
        const showError = vi.spyOn(anki, '_showErrorNotification').mockImplementation(() => {});

        await anki._saveAnkiNote(0, 0);

        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0][0].message).toBe('Anki write failed');
    });
});
