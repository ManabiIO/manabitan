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

import {afterAll, bench, describe, vi} from 'vitest';
import {DisplayAnki} from '../ext/js/display/display-anki.js';
import {setupDomTest} from '../test/fixtures/dom-test.js';

vi.mock('../ext/lib/kanji-processor.js', () => ({
    /**
     * @param {string} text
     * @returns {string}
     */
    convertVariants: (text) => text,
}));

const {Backend} = await import('../ext/js/background/backend.js');

const benchmarkOptions = Object.freeze({
    time: 3000,
    warmupTime: 1000,
    warmupIterations: 8,
});

const noteCount = 250;
const dictionaryEntries = /** @type {import('dictionary').DictionaryEntry[]} */ (
    Array.from({length: noteCount}, () => createTermEntry())
);

const {window, teardown} = await setupDomTest();
afterAll(async () => {
    await teardown(global);
});

const dictionaryEntryNodes = setupDocument(window.document, noteCount);
const backend = createBackendHarness();
const eagerDisplayAnki = createDisplayAnki(window.document, dictionaryEntries, dictionaryEntryNodes, backend, false);
const lazyDisplayAnki = createDisplayAnki(window.document, dictionaryEntries, dictionaryEntryNodes, backend, true);

describe('Display Anki duplicate note-id loading', () => {
    bench(`DisplayAnki._updateDictionaryEntryDetails - eager duplicate-id preload (n=${noteCount})`, async () => {
        eagerDisplayAnki._dictionaryEntryDetails = null;
        await eagerDisplayAnki._updateDictionaryEntryDetails();
    }, benchmarkOptions);

    bench(`DisplayAnki._updateDictionaryEntryDetails - lazy duplicate-id preload (n=${noteCount})`, async () => {
        lazyDisplayAnki._dictionaryEntryDetails = null;
        await lazyDisplayAnki._updateDictionaryEntryDetails();
    }, benchmarkOptions);
});

/**
 * @returns {import('dictionary').DictionaryEntry}
 */
function createTermEntry() {
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 0,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: 'Benchmark',
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: true,
        maxOriginalTextLength: 4,
        headwords: [
            {
                index: 0,
                term: 'term',
                reading: 'reading',
                sources: [
                    {
                        originalText: 'term',
                        transformedText: 'term',
                        deinflectedText: 'term',
                        matchType: 'exact',
                        matchSource: 'term',
                        isPrimary: true,
                    },
                ],
                tags: [],
                wordClasses: [],
            },
        ],
        definitions: [],
        pronunciations: [],
        frequencies: [],
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
 * @param {Document} document
 * @param {number} count
 * @returns {HTMLElement[]}
 */
function setupDocument(document, count) {
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

    /** @type {HTMLElement[]} */
    const result = [];
    for (let i = 0; i < count; ++i) {
        const node = document.createElement('div');
        node.className = 'entry';
        node.innerHTML = '<div class="note-actions-container"></div>';
        document.body.appendChild(node);
        result.push(node);
    }
    return result;
}

/**
 * @param {number} count
 * @returns {import('anki').Note[]}
 */
function createNotes(count) {
    /** @type {import('anki').Note[]} */
    const result = [];
    for (let i = 0; i < count; ++i) {
        result.push({
            fields: {
                Front: `term-${i}`,
                Back: 'x'.repeat(4096),
            },
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
        });
    }
    return result;
}

/**
 * @returns {any}
 */
function createBackendHarness() {
    const backend = Object.create(Backend.prototype);
    backend._anki = new DuplicateCheckBenchmarkAnki(createNotes(noteCount));
    return backend;
}

/**
 * @param {Document} document
 * @param {import('dictionary').DictionaryEntry[]} dictionaryEntries2
 * @param {HTMLElement[]} dictionaryEntryNodes
 * @param {any} backend2
 * @param {boolean} lazy
 * @returns {DisplayAnki}
 */
function createDisplayAnki(document, dictionaryEntries2, dictionaryEntryNodes, backend2, lazy) {
    const api = {
        getAnkiNoteInfo: vi.fn(async (notes, fetchAdditionalInfo, fetchDuplicateNoteIds) => (
            await backend2._onApiGetAnkiNoteInfo({notes, fetchAdditionalInfo, fetchDuplicateNoteIds})
        )),
        isAnkiConnected: vi.fn(async () => true),
        getDictionaryInfo: vi.fn(async () => []),
        getDefaultAnkiFieldTemplates: vi.fn(async () => ''),
    };
    const display = {
        application: {api},
        hotkeyHandler: {registerActions: vi.fn()},
        on: vi.fn(),
        displayGenerator: {
            /**
             * @param {string} name
             * @returns {HTMLElement}
             */
            instantiateTemplate(name) {
                const template = document.querySelector(`#${name}-template`);
                if (!(template instanceof HTMLTemplateElement)) {
                    throw new Error(`Missing template: ${name}`);
                }
                const {firstElementChild} = template.content;
                if (!(firstElementChild instanceof HTMLElement)) {
                    throw new Error(`Template has no element child: ${name}`);
                }
                return /** @type {HTMLElement} */ (firstElementChild.cloneNode(true));
            },
            createAnkiNoteErrorsNotificationContent() {
                return document.createElement('div');
            },
        },
        dictionaryEntries: dictionaryEntries2,
        dictionaryEntryNodes,
        getOptions: () => ({anki: {enable: true, fieldTemplates: ''}, dictionaries: []}),
        getContentOrigin: () => ({tabId: 1, frameId: 0}),
        getOptionsContext: () => /** @type {import('settings').OptionsContext} */ ({current: true}),
        getLanguageSummary: () => ({}),
        createNotification: () => ({setContent: vi.fn(), open: vi.fn(), close: vi.fn()}),
        progressIndicatorVisible: {
            setOverride: vi.fn(() => 1),
            clearOverride: vi.fn(),
        },
        _hotkeyHelpController: {
            setHotkeyLabel: vi.fn(),
            getHotkeyLabel: vi.fn(() => null),
            setupNode: vi.fn(),
        },
    };
    const displayAnki = new DisplayAnki(
        /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)),
        /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (/** @type {unknown} */ ({
            getAnkiNoteMediaAudioDetails: vi.fn(() => ({sources: [], preferredAudioIndex: null, enableDefaultAudioSources: true})),
        })),
    );
    displayAnki._checkForDuplicates = true;
    displayAnki._duplicateBehavior = 'new';
    displayAnki._displayTagsAndFlags = 'never';
    displayAnki._cardFormats = [createFastProbeCardFormat()];
    displayAnki._dictionaryEntryDetails = null;
    displayAnki._dictionaries = [];
    displayAnki._noteContext = {
        url: 'https://example.test',
        sentence: {text: 'term', offset: 0},
        documentTitle: 'title',
        query: 'term',
        fullQuery: 'term',
    };
    if (!lazy) {
        displayAnki._shouldFetchDuplicateNoteIdsLazily = () => false;
    }
    return displayAnki;
}

class DuplicateCheckBenchmarkAnki {
    /**
     * @param {import('anki').Note[]} notesToDuplicate
     */
    constructor(notesToDuplicate) {
        this._duplicateNoteIds = new Map();
        let noteId = 1;
        for (let i = 0; i < notesToDuplicate.length; i += 2) {
            this._duplicateNoteIds.set(getDuplicateNoteKey(notesToDuplicate[i]), noteId);
            noteId += 1;
        }
    }

    /**
     * @param {import('anki').Note[]} notes
     * @returns {Promise<import('anki').CanAddNotesDetail[]>}
     */
    async canAddNotesWithErrorDetail(notes) {
        return notes.map((note) => ({
            canAdd: !this._duplicateNoteIds.has(getDuplicateNoteKey(note)),
            error: this._duplicateNoteIds.has(getDuplicateNoteKey(note)) ? 'cannot create note because it is a duplicate' : null,
        }));
    }

    /**
     * @param {import('anki').Note[]} notes
     * @returns {Promise<import('anki').NoteId[][]>}
     */
    async findNoteIds(notes) {
        return notes.map((note) => {
            const noteId = this._duplicateNoteIds.get(getDuplicateNoteKey(note));
            return typeof noteId === 'number' ? [noteId] : [];
        });
    }

    /**
     * @param {number[]} noteIds
     * @returns {Promise<(?import('anki').NoteInfo)[]>}
     */
    async notesInfo(noteIds) {
        return noteIds.map((noteId) => ({
            noteId,
            fields: {},
            modelName: 'Model',
            cards: [noteId + 1000],
            cardsInfo: [],
            tags: [],
        }));
    }

    /**
     * @param {number[]} cardIds
     * @returns {Promise<(?import('anki').CardInfo)[]>}
     */
    async cardsInfo(cardIds) {
        return cardIds.map((cardId) => ({
            noteId: cardId - 1000,
            cardId,
            cardState: 0,
            flags: 0,
        }));
    }
}

/**
 * @param {import('anki').Note} note
 * @returns {string}
 */
function getDuplicateNoteKey(note) {
    const fieldEntries = Object.entries(note.fields);
    return JSON.stringify([
        note.deckName,
        note.modelName,
        note.options?.duplicateScope ?? null,
        note.options?.duplicateScopeOptions?.deckName ?? null,
        note.options?.duplicateScopeOptions?.checkChildren ?? false,
        note.options?.duplicateScopeOptions?.checkAllModels ?? false,
        fieldEntries[0] ?? null,
    ]);
}
