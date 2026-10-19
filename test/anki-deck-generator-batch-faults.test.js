/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';

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
            _saveBlob: saveBlob,
            _sendNotes: sendNotes,
            _generateNoteData: generateNoteData,
            _settingsController: {
                profileIndexChangeGeneration: 0,
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


test('cancellation during duplicate detection prevents addNotes', async () => {
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
    duplicateResult.resolve([true]);
    await operation;
    expect(addNotes).not.toHaveBeenCalled();
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
    const result = await controller._sendNotes([], false);
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
                const state = {context: {index: 0, profileId: 'a'}, generation: 0};
                Reflect.set(controller, '_settingsController', {
                    getOptionsContext: () => ({...state.context}),
                    get profileIndexChangeGeneration() { return state.generation; },
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
        const state = {context: {index: 0, profileId: 'a'}, generation: 0};
        Reflect.set(controller, '_settingsController', {
            getOptionsContext: () => ({...state.context}),
            get profileIndexChangeGeneration() { return state.generation; },
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
