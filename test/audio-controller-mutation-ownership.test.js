/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {AudioController} from '../ext/js/pages/settings/audio-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

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
 * @param {any} window
 * @param {import('settings').AudioSourceOptions[]} sources
 * @returns {Promise<{
 *   controller: AudioController,
 *   settingsController: any,
 *   getProfileIndex: () => number,
 *   setProfileIndex: (value: number) => void
 * }>}
 */
async function setup(window, sources) {
    window.document.body.innerHTML = `
        <div id="audio-source-list"></div>
        <button id="audio-source-add"></button>
        <button id="audio-source-move-button"></button>
        <input id="text-to-speech-voice-test-text">
        <button id="text-to-speech-voice-test"></button>
    `;
    window.document.documentElement.dataset.browser = 'firefox';

    let profileIndex = 0;
    const settingsController = /** @type {any} */ ({
        application: {api: {}},
        getOptions: vi.fn().mockImplementation(async () => ({
            general: {language: 'en'},
            audio: {sources: sources.map((source) => ({...source}))},
        })),
        getOptionsContext: vi.fn(() => ({index: profileIndex})),
        getOptionsFull: vi.fn().mockResolvedValue({}),
        instantiateTemplate: vi.fn((name) => {
            if (name !== 'audio-source') { throw new Error(`Unexpected template: ${name}`); }
            const node = window.document.createElement('div');
            node.innerHTML = `
                <div class="audio-source-entry">
                    <select class="audio-source-type-select">
                        <option value="custom">custom</option>
                        <option value="text-to-speech">text-to-speech</option>
                    </select>
                    <div class="audio-source-parameter-container" data-field="url">
                        <input class="audio-source-parameter">
                    </div>
                    <div class="audio-source-parameter-container" data-field="voice">
                        <select class="audio-source-parameter">
                            <option value="">None</option>
                            <option value="voice-a">voice-a</option>
                            <option value="voice-b">voice-b</option>
                        </select>
                    </div>
                    <button id="audio-source-move-up"></button>
                    <button id="audio-source-move-down"></button>
                    <button class="audio-source-menu-button"></button>
                </div>
            `;
            return /** @type {HTMLElement} */ (node.firstElementChild);
        }),
        modifyProfileSettings: vi.fn().mockResolvedValue([]),
        setProfileSetting: vi.fn().mockResolvedValue([]),
        on: vi.fn(),
    });
    const modalController = /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({
        getModal: vi.fn(() => ({node: window.document.createElement('div'), setVisible() {}})),
    }));
    const controller = new AudioController(settingsController, modalController);
    controller._audioSystem = /** @type {any} */ ({
        prepare() {},
        on() {},
        createTextToSpeechAudio() { return {play() {}, volume: 1}; },
    });
    controller._updateTextToSpeechVoices = vi.fn(function updateTextToSpeechVoices() {
        this._voices = [];
    });

    await controller.prepare();
    return {
        controller,
        settingsController,
        getProfileIndex: () => profileIndex,
        setProfileIndex: (value) => { profileIndex = value; },
    };
}

test('overlapping entry writes are serialized and the newest value survives an older failure', async ({window}) => {
    const {controller, settingsController} = await setup(window, [
        {type: 'custom', url: 'https://old.example', voice: ''},
    ]);
    const first = deferred();
    const second = deferred();
    const setProfileSetting = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.setProfileSetting);
    setProfileSetting
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);

    const entry = controller._audioSourceEntries[0];
    entry._urlInput.value = 'https://first.example';
    const firstWrite = entry._setUrl('https://first.example').then(() => null, (error) => error);
    entry._urlInput.value = 'https://second.example';
    const secondWrite = entry._setUrl('https://second.example');
    await flush();

    expect(setProfileSetting).toHaveBeenCalledTimes(1);
    expect(setProfileSetting).toHaveBeenNthCalledWith(1, 'audio.sources[0].url', 'https://first.example');

    const failure = new Error('first save failed');
    first.reject(failure);
    await flush();
    expect(setProfileSetting).toHaveBeenCalledTimes(2);
    expect(setProfileSetting).toHaveBeenNthCalledWith(2, 'audio.sources[0].url', 'https://second.example');

    second.resolve([]);
    expect(await firstWrite).toBe(failure);
    await secondWrite;
    expect(entry._url).toBe('https://second.example');
    expect(entry._urlInput.value).toBe('https://second.example');
});

test('an edit of a surviving row waits for removal and uses its new index', async ({window}) => {
    const {controller, settingsController} = await setup(window, [
        {type: 'custom', url: 'https://one.example', voice: ''},
        {type: 'custom', url: 'https://two.example', voice: ''},
    ]);
    const removal = deferred();
    const modifyProfileSettings = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.modifyProfileSettings);
    const setProfileSetting = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.setProfileSetting);
    modifyProfileSettings.mockImplementationOnce(() => removal.promise);

    const removedEntry = controller._audioSourceEntries[0];
    const survivingEntry = controller._audioSourceEntries[1];
    const removePromise = controller.removeSource(removedEntry);
    await flush();
    expect(modifyProfileSettings).toHaveBeenCalledOnce();

    survivingEntry._urlInput.value = 'https://two-new.example';
    const editPromise = survivingEntry._setUrl('https://two-new.example');
    await flush();
    expect(setProfileSetting).not.toHaveBeenCalled();

    removal.resolve([]);
    await removePromise;
    await editPromise;
    expect(setProfileSetting).toHaveBeenCalledOnce();
    expect(setProfileSetting).toHaveBeenCalledWith('audio.sources[0].url', 'https://two-new.example');
    expect(survivingEntry.index).toBe(0);
    expect(survivingEntry._url).toBe('https://two-new.example');
});

test('an edit of a moved row waits for the reorder and follows that source to its new index', async ({window}) => {
    const {controller, settingsController} = await setup(window, [
        {type: 'custom', url: 'https://one.example', voice: ''},
        {type: 'custom', url: 'https://two.example', voice: ''},
    ]);
    const move = deferred();
    const modifyProfileSettings = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.modifyProfileSettings);
    const setProfileSetting = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.setProfileSetting);
    modifyProfileSettings.mockImplementationOnce(() => move.promise);

    const movedEntry = controller._audioSourceEntries[0];
    const otherEntry = controller._audioSourceEntries[1];
    const movePromise = controller.moveAudioSourceOptions(0, 1);
    await flush();
    expect(modifyProfileSettings).toHaveBeenCalledOnce();

    movedEntry._urlInput.value = 'https://one-new.example';
    const editPromise = movedEntry._setUrl('https://one-new.example');
    await flush();
    expect(setProfileSetting).not.toHaveBeenCalled();

    move.resolve([]);
    await movePromise;
    await editPromise;
    expect(controller._audioSourceEntries).toEqual([otherEntry, movedEntry]);
    expect(movedEntry.index).toBe(1);
    expect(setProfileSetting).toHaveBeenCalledWith('audio.sources[1].url', 'https://one-new.example');
    expect(controller._audioSourceContainer.children[1]).toBe(movedEntry.node);
});

test('a profile switch during a move read prevents writing the old source list into the new profile', async ({window}) => {
    const {controller, settingsController, setProfileIndex} = await setup(window, [
        {type: 'custom', url: 'https://one.example', voice: ''},
        {type: 'custom', url: 'https://two.example', voice: ''},
    ]);
    const options = deferred();
    const getOptions = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.getOptions);
    const modifyProfileSettings = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.modifyProfileSettings);
    getOptions.mockImplementationOnce(() => options.promise);

    const movePromise = controller.moveAudioSourceOptions(0, 1);
    await flush();
    setProfileIndex(1);
    options.resolve({
        general: {language: 'en'},
        audio: {sources: [
            {type: 'custom', url: 'https://one.example', voice: ''},
            {type: 'custom', url: 'https://two.example', voice: ''},
        ]},
    });
    await movePromise;

    expect(modifyProfileSettings).not.toHaveBeenCalled();
    expect(controller._audioSourceEntries[0]._url).toBe('https://one.example');
    expect(controller._audioSourceEntries[1]._url).toBe('https://two.example');
});


test('the settings voice test owns asynchronous playback rejection', async ({window}) => {
    const {controller} = await setup(window, [
        {type: 'text-to-speech', url: '', voice: 'voice-a'},
    ]);
    const catchHandler = vi.fn();
    const play = vi.fn(() => ({catch: catchHandler}));
    controller._audioSystem.createTextToSpeechAudio = /** @type {any} */ (vi.fn(() => ({play, volume: 0})));

    controller._voiceTestTextInput.value = 'test';
    controller._voiceTestTextInput.dataset.voice = 'voice-a';
    controller._onTestTextToSpeech();

    expect(play).toHaveBeenCalledOnce();
    expect(catchHandler).toHaveBeenCalledOnce();
});


test('rapid relative moves follow the same source instead of replaying a stale index', async ({window}) => {
    const {controller, settingsController} = await setup(window, [
        {type: 'custom', url: 'https://one.example', voice: ''},
        {type: 'custom', url: 'https://two.example', voice: ''},
        {type: 'custom', url: 'https://three.example', voice: ''},
    ]);
    const movedEntry = controller._audioSourceEntries[0];
    const secondEntry = controller._audioSourceEntries[1];
    const thirdEntry = controller._audioSourceEntries[2];

    movedEntry._move(1);
    movedEntry._move(1);
    await controller._audioSourceMutationPromise;

    expect(controller._audioSourceEntries).toEqual([secondEntry, thirdEntry, movedEntry]);
    expect(controller._audioSourceEntries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    const modifyProfileSettings = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.modifyProfileSettings);
    expect(modifyProfileSettings).toHaveBeenCalledTimes(2);
    expect(modifyProfileSettings.mock.calls[0][0][0].value.map((/** @type {import('settings').AudioSourceOptions} */ source) => source.url)).toEqual([
        'https://two.example',
        'https://one.example',
        'https://three.example',
    ]);
    expect(modifyProfileSettings.mock.calls[1][0][0].value.map((/** @type {import('settings').AudioSourceOptions} */ source) => source.url)).toEqual([
        'https://two.example',
        'https://three.example',
        'https://one.example',
    ]);
});


test('a stale options event cannot replace the current profile audio-source UI', async ({window}) => {
    const {controller, setProfileIndex} = await setup(window, [
        {type: 'custom', url: 'https://profile-a.example', voice: ''},
    ]);
    setProfileIndex(1);
    controller._onOptionsChanged({
        options: {
            general: {language: 'en'},
            audio: {sources: [{type: 'custom', url: 'https://profile-b.example', voice: ''}]},
        },
        optionsContext: {index: 1},
    });
    const profileBEntry = controller._audioSourceEntries[0];

    controller._onOptionsChanged({
        options: {
            general: {language: 'ja'},
            audio: {sources: [{type: 'custom', url: 'https://stale-profile-a.example', voice: ''}]},
        },
        optionsContext: {index: 0},
    });

    expect(controller._audioSourceEntries).toEqual([profileBEntry]);
    expect(controller._audioSourceEntries[0]._url).toBe('https://profile-b.example');
    expect(controller._language).toBe('en');
});

test('a refresh that resolves after a profile switch cannot relabel the old snapshot as current', async ({window}) => {
    const {controller, settingsController, setProfileIndex} = await setup(window, [
        {type: 'custom', url: 'https://profile-a.example', voice: ''},
    ]);
    const staleRead = deferred();
    const getOptions = /** @type {ReturnType<typeof vi.fn>} */ (settingsController.getOptions);
    getOptions.mockImplementationOnce(() => staleRead.promise);

    const refresh = controller._refreshAudioSources();
    await flush();
    setProfileIndex(1);
    controller._onOptionsChanged({
        options: {
            general: {language: 'en'},
            audio: {sources: [{type: 'custom', url: 'https://profile-b.example', voice: ''}]},
        },
        optionsContext: {index: 1},
    });
    const profileBEntry = controller._audioSourceEntries[0];

    staleRead.resolve({
        general: {language: 'ja'},
        audio: {sources: [{type: 'custom', url: 'https://stale-profile-a.example', voice: ''}]},
    });
    await refresh;

    expect(controller._audioSourceEntries).toEqual([profileBEntry]);
    expect(controller._audioSourceEntries[0]._url).toBe('https://profile-b.example');
    expect(controller._language).toBe('en');
});
