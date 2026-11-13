/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {createAnkiMockState} from './e2e/anki-mock-state.js';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(reason: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

/**
 * @param {string} words
 * @returns {{controller: AnkiDeckGeneratorController, timers: (() => Promise<void>)[], saveBlob: ReturnType<typeof vi.fn>, sendNotes: ReturnType<typeof vi.fn>, generateNoteData: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn>}}
 */
function createController(words) {
    /** @type {(() => Promise<void>)[]} */
    const timers = [];
    /**
     * @param {(time: number) => void} callback
     * @returns {number}
     */
    const requestAnimationFrameStub = (callback) => {
        callback(0);
        return 0;
    };
    /**
     * @param {() => void} callback
     * @returns {number}
     */
    const setTimeoutStub = (callback) => {
        timers.push(/** @type {() => Promise<void>} */ (callback));
        return 0;
    };
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameStub);
    vi.stubGlobal('setTimeout', setTimeoutStub);

    const saveBlob = vi.fn();
    const sendNotes = vi.fn(async () => true);
    const generateNoteData = vi.fn(async () => ({fields: {}, tags: [], modelName: 'Basic', deckName: 'Japanese'}));
    const error = vi.fn();
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(
        Object.create(AnkiDeckGeneratorController.prototype),
        {
            _inProgress: false,
            _cancel: false,
            _wordInputTextarea: {value: words},
            _addMediaCheckbox: {checked: false, disabled: false},
            _disallowDuplicatesCheckbox: {checked: false, disabled: false},
            _exportButtonConfirmButton: {disabled: false},
            _sendToAnkiButtonConfirmButton: {disabled: false},
            _exportConfirmModal: null,
            _sendToAnkiConfirmModal: null,
            _progressContainers: [],
            _activeNoteType: 'Basic',
            _activeAnkiDeck: 'Japanese',
            _activeFlashcardFormatSelect: {value: '0'},
            _flashcardFormatDetails: [{type: 'term', name: 'Basic', model: 'Basic', deck: 'Japanese', fields: {Front: {value: '{expression}'}}}],
            _flashcardFormatDetailsOwnership: {optionsContext: {index: 0, profileId: 'profile-a'}, profileIndexChangeGeneration: 0, optionsRevision: 0},
            _flashcardFormatViewToken: 1,
            _generationButtons: [],
            _saveBlob: saveBlob,
            _sendNotes: sendNotes,
            _generateNoteData: generateNoteData,
            _settingsController: {
                profileIndexChangeGeneration: 0,
                optionsRevision: 0,
                getOptionsContext: () => ({index: 0, profileId: 'profile-a'}),
            },
            _fieldsToTSV: () => 'field',
            _updateProgressBar: vi.fn(),
            _updateProgressBarError: error,
        },
    ));
    return {controller, timers, saveBlob, sendNotes, generateNoteData, error};
}

/** @returns {MouseEvent} */
function createEvent() {
    return /** @type {MouseEvent} */ (/** @type {unknown} */ ({preventDefault: vi.fn()}));
}

/**
 * @param {string} expression
 * @returns {import('anki').Note}
 */
function createNote(expression) {
    return {
        fields: {Front: expression, Back: 'definition'},
        tags: [],
        modelName: 'Basic',
        deckName: 'Japanese',
        options: {allowDuplicate: true, duplicateScope: 'deck', duplicateScopeOptions: {deckName: 'Japanese', checkChildren: false, checkAllModels: false}},
    };
}

/**
 * Exercise the real client with the shared duplicate collection model.
 * AnkiConnect checks each bulk insertion against the collection after earlier
 * insertions, while its canAddNotes action never inserts candidates.
 * @param {boolean} [atomic]
 * @param {(() => void)|undefined} [beforeAdd]
 * @returns {{client: AnkiConnect, state: ReturnType<typeof createAnkiMockState>}}
 */
function createDuplicateCollection(atomic = false, beforeAdd) {
    const state = createAnkiMockState();
    state.beginScenario('batch-duplicate-prevention', []);
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ _url, /** @type {RequestInit} */ init) => {
        const request = JSON.parse(String(init.body));
        let response;
        if (request.action === 'addNotes') {
            beforeAdd?.();
            const previous = /** @type {{notes: unknown[]}} */ (state.getScenarioState().snapshots.at(-1));
            response = {
                error: null,
                result: request.params.notes.map((/** @type {import('anki').Note} */ note) => {
                    const check = state.handleRequestBody({action: 'canAddNotes', params: {notes: [note]}});
                    if (!(/** @type {boolean[]} */ (check.result))[0]) { return null; }
                    return state.handleRequestBody({action: 'addNote', params: {note}}).result;
                }),
            };
            if (atomic && response.result.includes(null)) {
                state.beginScenario('batch-duplicate-prevention', previous.notes);
                response = {result: null, error: "['cannot create note because it is a duplicate']"};
            }
        } else {
            response = state.handleRequestBody(request);
            if (request.action === 'canAddNotes') {
                // Native Anki validation also rejects an empty first field,
                // independently of the duplicate-prevention option.
                response.result = /** @type {boolean[]} */ (response.result).map((canAdd, i) => canAdd && request.params.notes[i].fields.Front !== '');
            }
        }
        return new Response(JSON.stringify(response.error === null ? response.result : {error: response.error}));
    });
    const client = new AnkiConnect();
    client.server = 'http://127.0.0.1:8765';
    client.enabled = true;
    return {client, state};
}

test.each([
    {atomic: false, preventDuplicates: false},
    {atomic: false, preventDuplicates: true},
    {atomic: true, preventDuplicates: false},
    {atomic: true, preventDuplicates: true},
])('duplicate prevention $preventDuplicates works with atomic=$atomic insertion without mutating generated notes', async ({atomic, preventDuplicates}) => {
    const {controller, error} = createController('');
    const {client} = createDuplicateCollection(atomic);
    Reflect.set(controller, '_ankiController', client);
    const notes = [createNote('食べる'), {...createNote('食べる'), fields: {Front: '食べる', Back: 'different definition'}}];

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, notes, preventDuplicates)).toBe(true);

    expect(await client.findNotes('')).toHaveLength(preventDuplicates ? 1 : 2);
    expect(notes.every(({options}) => options.allowDuplicate)).toBe(true);
    expect(error).not.toHaveBeenCalled();
});

test.each([false, true])('duplicate prevention handles a note added after preflight with atomic=%s insertion', async (atomic) => {
    const {controller, error} = createController('');
    const note = createNote('猫');
    const {client, state} = createDuplicateCollection(atomic, () => {
        state.handleRequestBody({action: 'addNote', params: {note}});
    });
    Reflect.set(controller, '_ankiController', client);

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [note], true)).toBe(true);

    expect(await client.findNotes('')).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
});

test.each([false, true])('duplicate preflight reports an empty required field with a valid sibling=%s', async (includeValid) => {
    const {controller, error} = createController('');
    const {client} = createDuplicateCollection();
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);
    const notes = includeValid ? [createNote('猫'), createNote('')] : [createNote('')];

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, notes, true)).toBe(false);

    expect(addNotes).not.toHaveBeenCalled();
    expect(await client.findNotes('')).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('validation'));
    expect(notes.every(({options}) => options.allowDuplicate)).toBe(true);
});

test('confirmed preflight duplicates remain skipped while fresh notes are inserted', async () => {
    const {controller, error} = createController('');
    const {client, state} = createDuplicateCollection();
    state.handleRequestBody({action: 'addNote', params: {note: createNote('猫')}});
    const canAddNotes = vi.spyOn(client, 'canAddNotes');
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [createNote('猫'), createNote('犬')], true)).toBe(true);

    expect(await client.findNotes('')).toHaveLength(2);
    expect(addNotes.mock.calls.map(([notes]) => notes.map(({fields}) => fields.Front))).toEqual([['犬']]);
    expect(canAddNotes.mock.calls.map(([notes]) => notes.map(({options}) => options.allowDuplicate))).toEqual([[false, false], [true]]);
    expect(error).not.toHaveBeenCalled();
});

test('a known duplicate cannot hide a separate invalid note during preflight', async () => {
    const {controller, error} = createController('');
    const {client, state} = createDuplicateCollection();
    state.handleRequestBody({action: 'addNote', params: {note: createNote('猫')}});
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [createNote('猫'), createNote(''), createNote('犬')], true)).toBe(false);

    expect(addNotes).not.toHaveBeenCalled();
    expect(await client.findNotes('')).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('validation'));
});

test.each(['cancel', 'profile-change'])('%s during preflight classification prevents all writes', async (change) => {
    const {controller, error} = createController('');
    const {client, state} = createDuplicateCollection();
    state.handleRequestBody({action: 'addNote', params: {note: createNote('猫')}});
    const canAdd = client.canAddNotes.bind(client);
    const checking = deferred();
    const pending = /** @type {ReturnType<typeof deferred<boolean[]>>} */ (deferred());
    let calls = 0;
    vi.spyOn(client, 'canAddNotes').mockImplementation((notes) => {
        if (++calls === 2) {
            checking.resolve(true);
            return pending.promise;
        }
        return canAdd(notes);
    });
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);
    const owner = controller._captureViewSnapshot();
    const operation = AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [createNote('猫'), createNote('犬')], true, owner);
    await checking.promise;
    if (change === 'cancel') {
        controller._cancel = true;
    } else {
        const settings = Reflect.get(controller, '_settingsController');
        Reflect.set(settings, 'profileIndexChangeGeneration', settings.profileIndexChangeGeneration + 1);
    }
    pending.resolve([true]);

    expect(await operation).toBe(change === 'cancel');
    expect(addNotes).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(change === 'cancel' ? 0 : 1);
});

test.each([
    {atomic: false, preventDuplicates: false},
    {atomic: false, preventDuplicates: true},
    {atomic: true, preventDuplicates: false},
    {atomic: true, preventDuplicates: true},
])('101-note generation completes with duplicate prevention=$preventDuplicates and atomic=$atomic insertion', async ({atomic, preventDuplicates}) => {
    const words = Array.from({length: 101}, (_, i) => String(i));
    const {controller, timers, generateNoteData, error} = createController(words.join('\n'));
    const {client} = createDuplicateCollection(atomic);
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);
    Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
    controller._disallowDuplicatesCheckbox.checked = preventDuplicates;
    generateNoteData.mockImplementation(async (word) => createNote(word === '1' ? '0' : word));

    await controller._onSendToAnkiConfirm(createEvent());
    await timers[0]();

    const stored = await client.findNotes('');
    expect(stored).toHaveLength(preventDuplicates ? 100 : 101);
    expect(await client.findNotes('Front:"100"')).toHaveLength(1);
    if (!preventDuplicates) {
        expect(addNotes.mock.calls.map(([notes]) => notes.length)).toEqual([100, 1]);
    }
    expect(error).not.toHaveBeenCalled();
    expect(controller._inProgress).toBe(false);
});

test.each(['cancel', 'profile-change'])('%s between individually protected notes stops later insertions', async (change) => {
    const {controller, timers, generateNoteData, error} = createController('猫\n犬');
    const {client} = createDuplicateCollection(true, () => {
        if (change === 'cancel') {
            controller._cancel = true;
        } else {
            const settings = Reflect.get(controller, '_settingsController');
            Reflect.set(settings, 'profileIndexChangeGeneration', settings.profileIndexChangeGeneration + 1);
        }
    });
    Reflect.set(controller, '_ankiController', client);
    Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
    controller._disallowDuplicatesCheckbox.checked = true;
    generateNoteData.mockImplementation(async (word) => createNote(word));

    await controller._onSendToAnkiConfirm(createEvent());
    await timers[0]();

    expect(await client.findNotes('')).toHaveLength(1);
    expect(await client.findNotes('Front:"犬"')).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(change === 'cancel' ? 0 : 1);
    expect(controller._inProgress).toBe(false);
});

test('an ambiguous transport failure stops without retrying an insertion or sending later notes', async () => {
    const {controller, error} = createController('');
    const note = createNote('猫');
    const {client, state} = createDuplicateCollection(true, () => {
        state.handleRequestBody({action: 'addNote', params: {note}});
        throw new TypeError('Network disconnected after insertion');
    });
    const addNotes = vi.spyOn(client, 'addNotes');
    Reflect.set(controller, '_ankiController', client);

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [note, createNote('犬')], true)).toBe(false);

    expect(addNotes).toHaveBeenCalledOnce();
    expect(addNotes.mock.calls[0][0].map(({fields}) => fields.Front)).toEqual(['猫']);
    expect(await client.findNotes('')).toHaveLength(1);
    expect(error).toHaveBeenCalledWith('Ankiconnect error: Anki connection failure');
});

test.each([
    {name: 'duplicate-only', checks: [false, true], success: true},
    {name: 'insertion-failure', checks: [true, true], success: false},
    {name: 'invalid-note', checks: [false, false], success: false},
])('$name rejection is distinguished from expected duplicate skips', async ({checks, success}) => {
    const {controller, error} = createController('');
    const canAddNotes = vi.fn().mockResolvedValueOnce([true]).mockResolvedValueOnce(checks);
    Reflect.set(controller, '_ankiController', {canAddNotes, addNotes: vi.fn().mockResolvedValue([null])});

    expect(await AnkiDeckGeneratorController.prototype._sendNotes.call(controller, [createNote('猫')], true)).toBe(success);

    expect(error).toHaveBeenCalledTimes(success ? 0 : 1);
});

test('export generation failure settles state, keeps the error visible, and permits retry', async () => {
    const {controller, timers, generateNoteData, error} = createController('one');
    generateNoteData.mockRejectedValueOnce(new Error('lookup failed'));

    await controller._onExportConfirm(createEvent());
    await timers[0]();

    expect(controller._inProgress).toBe(false);
    expect(controller._exportButtonConfirmButton.disabled).toBe(false);
    expect(controller._sendToAnkiButtonConfirmButton.disabled).toBe(false);
    expect(error).toHaveBeenCalledWith('Failed to export Anki deck: lookup failed');

    await controller._onExportConfirm(createEvent());
    await timers[1]();
    expect(generateNoteData).toHaveBeenCalledTimes(2);
    expect(controller._inProgress).toBe(false);
});

test('send generation failure settles state and keeps the error visible', async () => {
    const {controller, timers, generateNoteData, sendNotes, error} = createController('one');
    generateNoteData.mockRejectedValueOnce(new Error('template failed'));

    await controller._onSendToAnkiConfirm(createEvent());
    await timers[0]();

    expect(controller._inProgress).toBe(false);
    expect(controller._sendToAnkiButtonConfirmButton.disabled).toBe(false);
    expect(sendNotes).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Failed to send Anki notes: template failed');
});

test('export cancellation during note generation prevents the file download', async () => {
    const {controller, timers, saveBlob, generateNoteData} = createController('one');
    /** @type {ReturnType<typeof deferred<any>>} */
    const pending = deferred();
    generateNoteData.mockReturnValueOnce(pending.promise);

    await controller._onExportConfirm(createEvent());
    const operation = timers[0]();
    await flush();
    controller._cancel = true;
    pending.resolve({fields: {}, tags: []});
    await operation;

    expect(saveBlob).not.toHaveBeenCalled();
    expect(controller._inProgress).toBe(false);
});

test('export uses generated note metadata when selection changes during generation', async () => {
    const {controller, timers, saveBlob, generateNoteData} = createController('one');
    /** @type {ReturnType<typeof deferred<any>>} */
    const pending = deferred();
    generateNoteData.mockReturnValueOnce(pending.promise);
    await controller._onExportConfirm(createEvent());
    const operation = timers[0]();
    await flush();
    controller._activeNoteType = 'Changed Model';
    controller._activeAnkiDeck = 'Changed Deck';
    pending.resolve({fields: {Front: 'word'}, tags: [], modelName: 'Basic', deckName: 'Japanese'});
    await operation;
    const blob = saveBlob.mock.calls[0][0];
    await expect(blob.text()).resolves.toContain('Basic\tJapanese\t');
});

test('export escapes quoted fields and delimiter-containing metadata for Anki text import', async () => {
    const {controller, timers, saveBlob, generateNoteData} = createController('one');
    Reflect.set(controller, '_fieldsToTSV', AnkiDeckGeneratorController.prototype._fieldsToTSV);
    generateNoteData.mockResolvedValueOnce({
        modelName: '"Basic"',
        deckName: 'Japanese\tReading',
        tags: ['"quoted"', 'normal'],
        fields: {
            Front: '"quoted"',
            Back: '<span title="reading">字</span>',
        },
    });

    await controller._onExportConfirm(createEvent());
    await timers[0]();

    const blob = /** @type {Blob} */ (saveBlob.mock.calls[0][0]);
    await expect(blob.text()).resolves.toBe(
        '#separator:tab\n#html:true\n#notetype column:1\n#deck column:2\n#tags column:3\n' +
        '"""Basic"""\t"Japanese\tReading"\t"""quoted"" normal"\t"""quoted"""\t"<span title=""reading"">字</span>"\t\n',
    );
});

test('export escapes comment-like note type names and retains normal field whitespace handling', async () => {
    const {controller, timers, saveBlob, generateNoteData} = createController('one');
    Reflect.set(controller, '_fieldsToTSV', AnkiDeckGeneratorController.prototype._fieldsToTSV);
    generateNoteData.mockResolvedValueOnce({
        modelName: '#Basic',
        deckName: 'Japanese',
        tags: [],
        fields: {Front: 'one\ttwo\r\nthree'},
    });

    await controller._onExportConfirm(createEvent());
    await timers[0]();

    const blob = /** @type {Blob} */ (saveBlob.mock.calls[0][0]);
    await expect(blob.text()).resolves.toContain('"#Basic"\tJapanese\t\tone&nbsp;&nbsp;&nbsp;twothree\t\n');
});


test('send cancellation during note generation prevents any Anki request', async () => {
    const {controller, timers, sendNotes, generateNoteData} = createController('one');
    /** @type {ReturnType<typeof deferred<any>>} */
    const pending = deferred();
    generateNoteData.mockReturnValueOnce(pending.promise);

    await controller._onSendToAnkiConfirm(createEvent());
    const operation = timers[0]();
    await flush();
    controller._cancel = true;
    pending.resolve({fields: {}, tags: []});
    await operation;

    expect(sendNotes).not.toHaveBeenCalled();
    expect(controller._inProgress).toBe(false);
});

test('concurrent confirm clicks start only one batch', async () => {
    const {controller, timers, generateNoteData} = createController('one');

    await controller._onExportConfirm(createEvent());
    await controller._onExportConfirm(createEvent());

    expect(timers).toHaveLength(1);
    await timers[0]();
    expect(generateNoteData).toHaveBeenCalledTimes(1);
});


test.each([true, false])('cancellation during duplicate detection prevents further Anki requests (%s)', async (canAdd) => {
    const {controller, timers, sendNotes} = createController('one');
    /** @type {ReturnType<typeof deferred<boolean[]>>} */
    const duplicateResult = deferred();
    const canAddNotes = vi.fn(() => duplicateResult.promise);
    const addNotes = vi.fn(async () => [123]);
    Reflect.set(controller, '_ankiController', {canAddNotes, addNotes});
    Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
    controller._disallowDuplicatesCheckbox.checked = true;
    await controller._onSendToAnkiConfirm(createEvent());
    const operation = timers[0]();
    await flush();
    expect(canAddNotes).toHaveBeenCalledOnce();
    controller._cancel = true;
    duplicateResult.resolve([canAdd]);
    await operation;
    expect(addNotes).not.toHaveBeenCalled();
    expect(canAddNotes).toHaveBeenCalledOnce();
    expect(sendNotes).not.toHaveBeenCalled();
    expect(controller._inProgress).toBe(false);
    expect(controller._sendToAnkiButtonConfirmButton.disabled).toBe(false);
});

test('successful completion unlocks every batch control', async () => {
    const {controller, timers} = createController('one');
    await controller._onExportConfirm(createEvent());
    await timers[0]();
    expect(controller._inProgress).toBe(false);
    expect(controller._exportButtonConfirmButton.disabled).toBe(false);
    expect(controller._sendToAnkiButtonConfirmButton.disabled).toBe(false);
    expect(controller._addMediaCheckbox.disabled).toBe(false);
    expect(controller._disallowDuplicatesCheckbox.disabled).toBe(false);
});

test('a new confirm can run after a cancelled generation', async () => {
    const {controller, timers, saveBlob, generateNoteData} = createController('one');
    /** @type {ReturnType<typeof deferred<any>>} */
    const pending = deferred();
    generateNoteData.mockReturnValueOnce(pending.promise);
    await controller._onExportConfirm(createEvent());
    const operation = timers[0]();
    await flush();
    controller._cancel = true;
    pending.resolve({fields: {}, tags: []});
    await operation;
    expect(saveBlob).not.toHaveBeenCalled();
    await controller._onExportConfirm(createEvent());
    await timers[1]();
    expect(saveBlob).toHaveBeenCalledOnce();
});

test('send and export share one batch ownership guard', async () => {
    const {controller, timers} = createController('one');
    await controller._onSendToAnkiConfirm(createEvent());
    await controller._onExportConfirm(createEvent());
    expect(timers).toHaveLength(1);
    await timers[0]();
});


test('non-Error Anki failures are reported instead of treated as a successful send', async () => {
    const {controller, error} = createController('one');
    Reflect.set(controller, '_ankiController', {addNotes: vi.fn().mockRejectedValue('offline')});
    Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
    const result = await controller._sendNotes([createNote('猫')], false);
    expect(result).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('offline'));
});


test('cancelling an already dispatched Anki batch prevents subsequent batches', async () => {
    const {controller, timers, generateNoteData} = createController(Array.from({length: 101}, (_, i) => String(i)).join('\n'));
    /** @type {ReturnType<typeof deferred<number[]>>} */
    const pending = deferred();
    /** @type {ReturnType<typeof deferred<void>>} */
    const dispatched = deferred();
    const addNotes = vi.fn(() => {
        dispatched.resolve();
        return pending.promise;
    });
    Reflect.set(controller, '_ankiController', {addNotes});
    Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
    await controller._onSendToAnkiConfirm(createEvent());
    const operation = timers[0]();
    await dispatched.promise;
    expect(addNotes).toHaveBeenCalledOnce();
    controller._cancel = true;
    pending.resolve(Array.from({length: 100}, (_, i) => i + 1));
    await operation;
    expect(addNotes).toHaveBeenCalledOnce();
    expect(generateNoteData).toHaveBeenCalledTimes(100);
    expect(controller._inProgress).toBe(false);
});


for (const method of ['_onExportConfirm', '_onSendToAnkiConfirm']) {
    for (const boundary of ['before timer', 'pending generation']) {
        for (const replacement of ['different ID', 'same-ID settings import']) {
            test(method + ' stops ' + replacement + ' at the same index during ' + boundary, async () => {
                const {controller, timers, generateNoteData, saveBlob, sendNotes, error} = createController('one');
                const state = {context: {index: 0, profileId: 'profile-a'}, generation: 0};
                Reflect.set(controller, '_settingsController', {
                    getOptionsContext: () => ({...state.context}),
                    get profileIndexChangeGeneration() { return state.generation; },
                    get optionsRevision() { return state.generation; },
                });
                /** @type {ReturnType<typeof deferred<any>>} */
                const pending = deferred();
                generateNoteData.mockReturnValueOnce(pending.promise);
                await Reflect.apply(Reflect.get(controller, method), controller, [createEvent()]);
                const operation = boundary === 'pending generation' ? timers[0]() : null;
                await flush();
                if (replacement === 'different ID') {
                    state.context = {index: 0, profileId: 'b'};
                } else {
                    ++state.generation;
                }
                pending.resolve({fields: {Front: 'word'}, tags: [], modelName: 'Basic', deckName: 'Japanese'});
                await (operation ?? timers[0]());
                expect(saveBlob).not.toHaveBeenCalled();
                expect(sendNotes).not.toHaveBeenCalled();
                expect(error).toHaveBeenCalledWith(expect.stringContaining('Profile changed'));
                expect(controller._inProgress).toBe(false);
                expect(controller._sendToAnkiButtonConfirmButton.disabled).toBe(false);
                expect(controller._exportButtonConfirmButton.disabled).toBe(false);
            });
        }
    }
}

for (const replacement of ['different ID', 'same-ID settings import']) {
    test(replacement + ' during duplicate detection prevents actual addNotes dispatch', async () => {
        const {controller, timers} = createController('one');
        const state = {context: {index: 0, profileId: 'profile-a'}, generation: 0};
        Reflect.set(controller, '_settingsController', {
            getOptionsContext: () => ({...state.context}),
            get profileIndexChangeGeneration() { return state.generation; },
            get optionsRevision() { return state.generation; },
        });
        /** @type {ReturnType<typeof deferred<boolean[]>>} */
        const pending = deferred();
        const canAddNotes = vi.fn(() => pending.promise);
        const addNotes = vi.fn(async () => [123]);
        Reflect.set(controller, '_ankiController', {canAddNotes, addNotes});
        Reflect.set(controller, '_sendNotes', AnkiDeckGeneratorController.prototype._sendNotes);
        controller._disallowDuplicatesCheckbox.checked = true;
        await controller._onSendToAnkiConfirm(createEvent());
        const operation = timers[0]();
        await flush();
        expect(canAddNotes).toHaveBeenCalledOnce();
        if (replacement === 'different ID') {
            state.context = {index: 0, profileId: 'b'};
        } else {
            ++state.generation;
        }
        pending.resolve([true]);
        await operation;
        expect(addNotes).not.toHaveBeenCalled();
        expect(controller._inProgress).toBe(false);
    });
}

test("export labels each row with that generated note's own model and deck", async () => {
    const {controller, timers, generateNoteData, saveBlob} = createController('one\ntwo');
    Reflect.set(controller, '_fieldsToTSV', AnkiDeckGeneratorController.prototype._fieldsToTSV);
    generateNoteData.mockResolvedValueOnce({fields: {Front: 'first'}, tags: [], modelName: 'First Model', deckName: 'First Deck'});
    generateNoteData.mockResolvedValueOnce({fields: {Front: 'second'}, tags: [], modelName: 'Second Model', deckName: 'Second Deck'});
    await controller._onExportConfirm(createEvent());
    await timers[0]();
    /** @type {string} */
    const contents = await saveBlob.mock.calls[0][0].text();
    const rows = contents.split('\n').slice(5, -1).map((row) => row.split('\t'));
    expect(rows).toStrictEqual([
        ['First Model', 'First Deck', '', 'first', ''],
        ['Second Model', 'Second Deck', '', 'second', ''],
    ]);
});
