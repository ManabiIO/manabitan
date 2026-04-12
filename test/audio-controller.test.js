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

import {describe, expect, vi} from 'vitest';
import {AudioController} from '../ext/js/pages/settings/audio-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @returns {AudioController}
 */
function createControllerForInternalTests() {
    return /** @type {AudioController} */ (Object.create(AudioController.prototype));
}

describe('AudioController consent refresh', () => {
    test('clears the consent token when a refresh fails', async ({window}) => {
        window.document.documentElement.dataset.browser = 'firefox';
        const controller = createControllerForInternalTests();
        const getOptionsFull = vi.fn().mockRejectedValue(new Error('lookup failed'));
        const initialToken = {};
        Reflect.set(controller, '_settingsController', {
            getOptionsFull,
        });
        Reflect.set(controller, '_consentStateToken', initialToken);
        Reflect.set(controller, '_setDataTransmissionConsentState', vi.fn());

        const refreshDataTransmissionConsentState = /** @type {(this: AudioController) => Promise<void>} */ (
            Reflect.get(AudioController.prototype, '_refreshDataTransmissionConsentState')
        );

        await refreshDataTransmissionConsentState.call(controller);

        expect(getOptionsFull).toHaveBeenCalledOnce();
        expect(Reflect.get(controller, '_consentStateToken')).not.toBe(initialToken);
    });
});

describe('AudioController source write rollback', () => {
    test('audio source entry restores type/url/voice UI when saving fails', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="audio-source-list"></div>
            <button id="audio-source-add"></button>
            <button id="audio-source-move-button"></button>
            <input id="text-to-speech-voice-test-text">
            <button id="text-to-speech-voice-test"></button>
        `;
        window.document.documentElement.dataset.browser = 'firefox';

        const source = {type: 'custom', url: 'https://old.example', voice: 'voice-a'};
        const setProfileSetting = vi.fn().mockRejectedValue(new Error('save failed'));
        const settingsController = {
            application: {api: {}},
            getOptions: vi.fn().mockResolvedValue({
                general: {language: 'en'},
                audio: {sources: [source]},
            }),
            getOptionsContext: vi.fn(() => ({})),
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
            modifyProfileSettings: vi.fn(),
            setProfileSetting,
            on: vi.fn(),
        };
        const modalController = {getModal: vi.fn(() => ({node: window.document.createElement('div'), setVisible() {}}))};
        const controller = new AudioController(/** @type {any} */ (settingsController), /** @type {any} */ (modalController));
        controller._audioSystem = /** @type {any} */ ({prepare() {}, on() {}, createTextToSpeechAudio() { return {play() {}, volume: 1}; }});
        controller._updateTextToSpeechVoices = vi.fn(function() {
            this._voices = [{voice: {voiceURI: 'voice-a', name: 'Voice A', lang: 'en', default: true}, isJapanese: false, index: 0}];
        });

        await controller.prepare();

        const entry = controller._audioSourceEntries[0];
        await expect(entry._setType('text-to-speech')).rejects.toThrow('save failed');
        expect(entry._type).toBe('custom');
        expect(entry._typeSelect.value).toBe('custom');

        await expect(entry._setUrl('https://new.example')).rejects.toThrow('save failed');
        expect(entry._url).toBe('https://old.example');
        expect(entry._urlInput.value).toBe('https://old.example');

        await expect(entry._setVoice('voice-b')).rejects.toThrow('save failed');
        expect(entry._voice).toBe('voice-a');
        expect(entry._voiceSelect.value).toBe('voice-a');
    });

    test('add/remove/move refresh audio sources when saving fails', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="audio-source-list"></div>
            <button id="audio-source-add"></button>
            <button id="audio-source-move-button"></button>
            <input id="text-to-speech-voice-test-text">
            <button id="text-to-speech-voice-test"></button>
        `;
        window.document.documentElement.dataset.browser = 'firefox';

        const persistedSources = [
            {type: 'custom', url: 'https://one.example', voice: ''},
            {type: 'text-to-speech', url: '', voice: 'voice-a'},
        ];
        const getOptions = vi.fn().mockImplementation(async () => ({
            general: {language: 'en'},
            audio: {sources: persistedSources.map((source) => ({...source}))},
        }));
        const settingsController = {
            application: {api: {}},
            getOptions,
            getOptionsContext: vi.fn(() => ({})),
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
                            </select>
                        </div>
                        <button id="audio-source-move-up"></button>
                        <button id="audio-source-move-down"></button>
                        <button class="audio-source-menu-button"></button>
                    </div>
                `;
                return /** @type {HTMLElement} */ (node.firstElementChild);
            }),
            modifyProfileSettings: vi.fn().mockRejectedValue(new Error('save failed')),
            setProfileSetting: vi.fn(),
            on: vi.fn(),
        };
        const modalController = {getModal: vi.fn(() => ({node: window.document.createElement('div'), setVisible() {}}))};
        const controller = new AudioController(/** @type {any} */ (settingsController), /** @type {any} */ (modalController));
        controller._audioSystem = /** @type {any} */ ({prepare() {}, on() {}, createTextToSpeechAudio() { return {play() {}, volume: 1}; }});
        controller._updateTextToSpeechVoices = vi.fn(function() {
            this._voices = [{voice: {voiceURI: 'voice-a', name: 'Voice A', lang: 'en', default: true}, isJapanese: false, index: 0}];
        });

        await controller.prepare();
        expect(controller._audioSourceEntries).toHaveLength(2);
        expect(controller._audioSourceEntries[0]._url).toBe('https://one.example');
        expect(controller._audioSourceEntries[1]._type).toBe('text-to-speech');

        await expect(controller._addAudioSource()).rejects.toThrow('save failed');
        expect(controller._audioSourceEntries).toHaveLength(2);
        expect(controller._audioSourceEntries[0]._url).toBe('https://one.example');
        expect(controller._audioSourceEntries[1]._type).toBe('text-to-speech');

        await expect(controller.removeSource(controller._audioSourceEntries[0])).rejects.toThrow('save failed');
        expect(controller._audioSourceEntries).toHaveLength(2);
        expect(controller._audioSourceEntries[0]._url).toBe('https://one.example');
        expect(controller._audioSourceEntries[1]._type).toBe('text-to-speech');

        await expect(controller.moveAudioSourceOptions(0, 1)).rejects.toThrow('save failed');
        expect(controller._audioSourceEntries).toHaveLength(2);
        expect(controller._audioSourceEntries[0]._url).toBe('https://one.example');
        expect(controller._audioSourceEntries[1]._type).toBe('text-to-speech');
        expect(getOptions).toHaveBeenCalledTimes(5);
    });
});
