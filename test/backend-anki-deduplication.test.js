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

import {describe, expect, test, vi} from 'vitest';

vi.mock('../ext/lib/kanji-processor.js', () => ({
    /**
     * @param {string} text
     * @returns {string}
     */
    convertVariants: (text) => text,
}));

vi.mock('../ext/js/comm/yomitan-api.js', () => ({
    YomitanApi: class {
        async setEnabled() {}
    },
}));

vi.mock('../ext/js/dictionary/dictionary-database.js', () => ({
    DictionaryDatabase: class {},
}));

vi.mock('../ext/js/dictionary/dictionary-worker.js', () => ({
    DictionaryWorker: class {},
}));

vi.mock('../ext/js/language/translator.js', () => ({
    Translator: class {},
}));

vi.mock('../ext/js/language/languages.js', () => ({
    getLanguageSummaries: () => [],
    isTextLookupWorthy: () => true,
}));

vi.mock('../ext/js/language/ja/japanese.js', () => ({
    distributeFuriganaInflected: () => [],
    getKanaScriptType: () => null,
    isCodePointJapanese: () => false,
    /**
     * @param {string} text
     * @returns {string}
     */
    convertKatakanaToHiragana: (text) => text,
}));

const {Backend} = await import('../ext/js/background/backend.js');

/**
 * @param {string} name
 * @returns {(this: unknown, ...args: unknown[]) => unknown}
 * @throws {Error}
 */
function getBackendMethod(name) {
    const method = Reflect.get(Backend.prototype, name);
    if (typeof method !== 'function') {
        throw new Error(`Expected ${name} method`);
    }
    return method;
}

/**
 * @param {string} front
 * @param {string} back
 * @returns {import('anki').Note}
 */
function createNote(front, back) {
    return {
        fields: {
            Front: front,
            Back: back,
        },
        tags: ['benchmark'],
        deckName: 'deck',
        modelName: 'model',
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

/**
 * @param {Partial<import('settings').AnkiCardFormat>} [overrides]
 * @returns {import('settings').AnkiCardFormat}
 */
function createCardFormat(overrides = {}) {
    return {
        type: 'term',
        name: 'Test',
        deck: 'deck',
        model: 'model',
        fields: {
            Front: {value: '{expression}', overwriteMode: 'overwrite'},
            Back: {value: '{glossary}', overwriteMode: 'overwrite'},
        },
        icon: 'big-circle',
        ...overrides,
    };
}

/**
 * @param {{
 *   duplicateScope?: import('settings').AnkiDuplicateScope,
 *   duplicateScopeCheckAllModels?: boolean,
 *   cardFormats?: import('settings').AnkiCardFormat[],
 * }} [overrides]
 * @returns {import('settings').ProfileOptions}
 */
function createProfileOptions(overrides = {}) {
    const {
        duplicateScope = 'collection',
        duplicateScopeCheckAllModels = false,
        cardFormats = [createCardFormat()],
    } = overrides;
    return /** @type {import('settings').ProfileOptions} */ ({
        anki: {
            enable: true,
            duplicateScope,
            duplicateScopeCheckAllModels,
            cardFormats,
        },
    });
}

/**
 * @param {import('anki').Note} note
 * @returns {import('anki').Note}
 */
function createDuplicateProbeNote(note) {
    const [firstFieldName] = Object.keys(note.fields);
    return {
        ...note,
        fields: {[firstFieldName]: note.fields[firstFieldName]},
        options: {...note.options, allowDuplicate: false},
    };
}

/**
 * @param {number} noteId
 * @param {string} fieldName
 * @param {string} fieldValue
 * @param {string} [modelName='model']
 * @returns {import('anki').NoteInfo}
 */
function createNoteInfo(noteId, fieldName, fieldValue, modelName = 'model') {
    return {
        noteId,
        fields: {
            [fieldName]: {value: fieldValue, order: 0},
        },
        modelName,
        cards: [noteId + 1000],
        cardsInfo: [],
        tags: [],
    };
}

/**
 * @param {import('anki').CanAddNotesDetail[]} canAddNotesWithErrorDetail
 * @param {number[][]} duplicateNoteIds
 * @param {{
 *   profileOptions?: import('settings').ProfileOptions,
 *   findNotes?: ReturnType<typeof vi.fn>,
 *   findNoteIds?: ReturnType<typeof vi.fn>,
 *   notesInfo?: ReturnType<typeof vi.fn>,
 *   cardsInfo?: ReturnType<typeof vi.fn>,
 *   canAddNotesWithErrorDetailFn?: ReturnType<typeof vi.fn>,
 *   canAddNotes?: ReturnType<typeof vi.fn>,
 *   addNote?: ReturnType<typeof vi.fn>,
 *   updateNoteFields?: ReturnType<typeof vi.fn>,
 * }} [overrides]
 * @returns {any}
 */
function createBackendContext(canAddNotesWithErrorDetail, duplicateNoteIds, overrides = {}) {
    const notesInfo = overrides.notesInfo ?? vi.fn(async (/** @type {number[]} */ noteIds) => noteIds.map((/** @type {number} */ noteId) => ({
        noteId,
        fields: {},
        modelName: 'Model',
        cards: [noteId + 1000],
        cardsInfo: [],
        tags: [],
    })));
    const cardsInfo = overrides.cardsInfo ?? vi.fn(async (/** @type {number[]} */ cardIds) => cardIds.map((/** @type {number} */ cardId) => ({
        noteId: cardId - 1000,
        cardId,
        cardState: 0,
        flags: 0,
    })));
    return /** @type {any} */ ({
        _anki: {
            server: 'http://anki.invalid',
            apiKey: null,
            enabled: true,
            canAddNotesWithErrorDetail: overrides.canAddNotesWithErrorDetailFn ?? vi.fn(async () => canAddNotesWithErrorDetail),
            canAddNotes: overrides.canAddNotes ?? vi.fn(async () => canAddNotesWithErrorDetail.map(({canAdd}) => canAdd)),
            findNotes: overrides.findNotes ?? vi.fn(async () => []),
            findNoteIds: overrides.findNoteIds ?? vi.fn(async () => duplicateNoteIds),
            notesInfo,
            cardsInfo,
            addNote: overrides.addNote ?? vi.fn(async () => null),
            updateNoteFields: overrides.updateNoteFields ?? vi.fn(async () => null),
        },
        _ankiDuplicateCache: new Map(),
        _getProfileOptions: overrides.profileOptions ? vi.fn(() => overrides.profileOptions) : vi.fn(() => createProfileOptions()),
        _stripNotesArray: getBackendMethod('_stripNotesArray'),
        _findDuplicates: getBackendMethod('_findDuplicates'),
        _findDuplicatesFallback: getBackendMethod('_findDuplicatesFallback'),
        _findDuplicatesLive: getBackendMethod('_findDuplicatesLive'),
        _getAnkiDuplicateCacheDescriptor: getBackendMethod('_getAnkiDuplicateCacheDescriptor'),
        _createAnkiDuplicateCacheStartupNote: getBackendMethod('_createAnkiDuplicateCacheStartupNote'),
        _getAnkiDuplicateCacheStartupDescriptors: getBackendMethod('_getAnkiDuplicateCacheStartupDescriptors'),
        _warmAnkiDuplicateCacheStartupBuckets: getBackendMethod('_warmAnkiDuplicateCacheStartupBuckets'),
        _warmAnkiDuplicateCacheBucket: getBackendMethod('_warmAnkiDuplicateCacheBucket'),
        _getAnkiDuplicateCacheFieldValueFromNoteInfo: getBackendMethod('_getAnkiDuplicateCacheFieldValueFromNoteInfo'),
        _getAnkiDuplicateCacheNoteIds: getBackendMethod('_getAnkiDuplicateCacheNoteIds'),
        _addAnkiDuplicateCacheNote: getBackendMethod('_addAnkiDuplicateCacheNote'),
        _removeAnkiDuplicateCacheNoteId: getBackendMethod('_removeAnkiDuplicateCacheNoteId'),
        _findDuplicatesWithCache: getBackendMethod('_findDuplicatesWithCache'),
        partitionAddibleNotes: getBackendMethod('partitionAddibleNotes'),
        _notesCardsInfoBatched: getBackendMethod('_notesCardsInfoBatched'),
    });
}

/**
 * @param {any} context
 * @param {import('anki').Note} note
 * @param {'pending'|'ready'|'error'} status
 * @param {Map<string, number[]>} [noteIdsByFieldValue]
 * @returns {any}
 */
function setDuplicateCacheBucket(context, note, status, noteIdsByFieldValue = new Map()) {
    const descriptor = /** @type {any} */ (
        getBackendMethod('_getAnkiDuplicateCacheDescriptor').call(context, createDuplicateProbeNote(note))
    );
    context._ankiDuplicateCache.set(descriptor.key, {
        status,
        fieldNameLower: descriptor.fieldNameLower,
        query: descriptor.query,
        noteIdsByFieldValue,
    });
    return descriptor;
}

describe('Backend Anki deduplication', () => {
    test.each([
        [
            'collection scope',
            createProfileOptions({duplicateScope: 'collection'}),
            '"note:model" "front:*"',
        ],
        [
            'exact deck scope',
            createProfileOptions({
                duplicateScope: 'deck',
                cardFormats: [createCardFormat({deck: 'Deck'})],
            }),
            '"deck:Deck" "-deck:Deck::*" "note:model" "front:*"',
        ],
        [
            'deck-root scope',
            createProfileOptions({
                duplicateScope: 'deck-root',
                cardFormats: [createCardFormat({deck: 'Root::Child'})],
            }),
            '"deck:Root" "note:model" "front:*"',
        ],
        [
            'all-model collection scope',
            createProfileOptions({duplicateScopeCheckAllModels: true}),
            '"front:*"',
        ],
    ])('startup warmup builds the right %s query', (_label, profileOptions, expectedQuery) => {
        const context = createBackendContext([], [], {profileOptions});

        const [descriptor] = /** @type {any[]} */ (
            getBackendMethod('_getAnkiDuplicateCacheStartupDescriptors').call(context)
        );

        expect(descriptor?.query).toBe(expectedQuery);
    });

    test('getAnkiNoteInfo looks up duplicate note ids using stripped probe notes', async () => {
        const notes = [
            createNote('term-1', 'back-field-1'),
            createNote('term-2', 'back-field-2'),
        ];
        const context = createBackendContext([
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
            {canAdd: true, error: null},
        ], [[42]]);

        const result = /** @type {import('anki').NoteInfoWrapper[]} */ (
            await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {notes, fetchAdditionalInfo: false})
        );

        expect(context._anki.findNoteIds).toHaveBeenCalledTimes(1);
        expect(context._anki.findNoteIds).toHaveBeenCalledWith([
            {
                ...notes[0],
                fields: {Front: 'term-1'},
                options: {...notes[0].options, allowDuplicate: false},
            },
        ]);
        expect(result).toStrictEqual([
            {canAdd: true, valid: true, isDuplicate: true, noteIds: [42], noteInfos: []},
            {canAdd: true, valid: true, isDuplicate: false, noteIds: null, noteInfos: []},
        ]);
        expect(notes[0].fields).toStrictEqual({
            Front: 'term-1',
            Back: 'back-field-1',
        });
        expect(notes[0].options.allowDuplicate).toBe(true);
    });

    test('getAnkiNoteInfo can skip duplicate note id lookups when only duplicate status is needed', async () => {
        const notes = [
            createNote('term-1', 'back-field-1'),
            createNote('term-2', 'back-field-2'),
        ];
        const context = createBackendContext([
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
            {canAdd: true, error: null},
        ], [[42]]);

        const result = /** @type {import('anki').NoteInfoWrapper[]} */ (
            await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {
                notes,
                fetchAdditionalInfo: false,
                fetchDuplicateNoteIds: false,
            })
        );

        expect(context._anki.findNoteIds).not.toHaveBeenCalled();
        expect(result).toStrictEqual([
            {canAdd: true, valid: true, isDuplicate: true, noteIds: null, noteInfos: []},
            {canAdd: true, valid: true, isDuplicate: false, noteIds: null, noteInfos: []},
        ]);
    });

    test('getAnkiNoteInfo uses ready duplicate cache buckets before live Anki duplicate checks', async () => {
        const note = createNote('cached-term', 'back-field');
        const context = createBackendContext([
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
        ], [[42]]);
        const descriptor = setDuplicateCacheBucket(
            context,
            note,
            'ready',
            new Map([['cached-term', [777]]]),
        );

        const result = /** @type {import('anki').NoteInfoWrapper[]} */ (
            await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {notes: [note], fetchAdditionalInfo: false})
        );

        expect(descriptor.query).toBe('"note:model" "front:cached-term"');
        expect(context._anki.canAddNotesWithErrorDetail).not.toHaveBeenCalled();
        expect(context._anki.findNoteIds).not.toHaveBeenCalled();
        expect(result).toStrictEqual([
            {canAdd: true, valid: true, isDuplicate: true, noteIds: [777], noteInfos: []},
        ]);
    });

    test('pending duplicate cache buckets fall back to live Anki duplicate checks', async () => {
        const note = createNote('pending-term', 'back-field');
        const context = createBackendContext([
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
        ], [[42]]);
        setDuplicateCacheBucket(context, note, 'pending');

        const result = /** @type {import('anki').NoteInfoWrapper[]} */ (
            await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {
                notes: [note],
                fetchAdditionalInfo: false,
                fetchDuplicateNoteIds: false,
            })
        );

        expect(context._anki.canAddNotesWithErrorDetail).toHaveBeenCalledTimes(1);
        expect(result).toStrictEqual([
            {canAdd: true, valid: true, isDuplicate: true, noteIds: null, noteInfos: []},
        ]);
    });

    test('fallback duplicate checks do not populate the startup cache', async () => {
        const note = createNote('uncached-term', 'back-field');
        const context = createBackendContext([
            {canAdd: true, error: null},
        ], []);

        await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {
            notes: [note],
            fetchAdditionalInfo: false,
            fetchDuplicateNoteIds: false,
        });

        expect(context._anki.canAddNotesWithErrorDetail).toHaveBeenCalledTimes(1);
        expect(context._ankiDuplicateCache.size).toBe(0);
    });

    test('getAnkiNoteInfo batches additional note lookups across duplicates', async () => {
        const notes = [
            createNote('term-1', 'back-field-1'),
            createNote('term-2', 'back-field-2'),
        ];
        const context = createBackendContext([
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
            {canAdd: false, error: 'cannot create note because it is a duplicate'},
        ], [[101], [202]]);

        const result = /** @type {import('anki').NoteInfoWrapper[]} */ (
            await getBackendMethod('_onApiGetAnkiNoteInfo').call(context, {notes, fetchAdditionalInfo: true})
        );

        expect(context._anki.notesInfo).toHaveBeenCalledTimes(1);
        expect(context._anki.notesInfo).toHaveBeenCalledWith([101, 202]);
        expect(context._anki.cardsInfo).toHaveBeenCalledTimes(1);
        expect(context._anki.cardsInfo).toHaveBeenCalledWith([1101, 1202]);
        expect(result.map(({isDuplicate}) => isDuplicate)).toStrictEqual([true, true]);
        expect(result.map(({noteInfos}) => noteInfos?.[0]?.noteId ?? null)).toStrictEqual([101, 202]);
        expect(result.map(({noteInfos}) => noteInfos?.[0]?.cardsInfo.length ?? 0)).toStrictEqual([1, 1]);
    });

    test('startup warmup caches duplicate field values by query bucket', async () => {
        const findNotes = vi.fn(async () => [11, 12]);
        const notesInfo = vi.fn(async () => [
            createNoteInfo(11, 'Front', 'alpha'),
            createNoteInfo(12, 'Front', 'beta'),
        ]);
        const context = createBackendContext([], [], {
            profileOptions: createProfileOptions(),
            findNotes,
            notesInfo,
        });

        await getBackendMethod('_warmAnkiDuplicateCacheStartupBuckets').call(context);
        await vi.waitFor(() => {
            expect(findNotes).toHaveBeenCalledWith('"note:model" "front:*"');
            const [bucket] = context._ankiDuplicateCache.values();
            expect(bucket?.status).toBe('ready');
        });

        const [bucket] = context._ankiDuplicateCache.values();
        expect(bucket?.noteIdsByFieldValue.get('alpha')).toStrictEqual([11]);
        expect(bucket?.noteIdsByFieldValue.get('beta')).toStrictEqual([12]);
    });

    test('backend add and update note operations keep ready duplicate cache buckets in sync', async () => {
        const addNote = vi.fn(async () => 301);
        const updateNoteFields = vi.fn(async () => null);
        const note = createNote('initial-term', 'back-field');
        const context = createBackendContext([], [], {addNote, updateNoteFields});
        setDuplicateCacheBucket(context, note, 'ready');

        await getBackendMethod('_onApiAddAnkiNote').call(context, {note});

        let [bucket] = context._ankiDuplicateCache.values();
        expect(bucket?.noteIdsByFieldValue.get('initial-term')).toStrictEqual([301]);

        const updatedNote = {
            ...note,
            id: 301,
            fields: {
                Front: 'updated-term',
                Back: 'back-field',
            },
        };

        await getBackendMethod('_onApiUpdateAnkiNote').call(context, {noteWithId: updatedNote});

        [bucket] = context._ankiDuplicateCache.values();
        expect(bucket?.noteIdsByFieldValue.get('initial-term')).toBeUndefined();
        expect(bucket?.noteIdsByFieldValue.get('updated-term')).toStrictEqual([301]);
    });
});
