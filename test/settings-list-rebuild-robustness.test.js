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
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';
import {ExtensionKeyboardShortcutController} from '../ext/js/pages/settings/extension-keyboard-shortcuts-controller.js';
import {ProfileConditionsUI} from '../ext/js/pages/settings/profile-conditions-ui.js';
import {ProfileController} from '../ext/js/pages/settings/profile-controller.js';
import {ScanInputsController} from '../ext/js/pages/settings/scan-inputs-controller.js';
import {SentenceTerminationCharactersController} from '../ext/js/pages/settings/sentence-termination-characters-controller.js';
import {TranslationTextReplacementsController} from '../ext/js/pages/settings/translation-text-replacements-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

function createSettingsController(overrides) {
    return {
        application: {
            api: {},
        },
        on: vi.fn(),
        getOptions: vi.fn().mockResolvedValue(overrides.options),
        getOptionsContext: vi.fn(() => ({index: 0})),
        instantiateTemplate: vi.fn(overrides.instantiateTemplate),
        modifyProfileSettings: vi.fn().mockResolvedValue([]),
        getDefaultOptions: vi.fn(),
        refresh: vi.fn(),
    };
}

describe('Settings list rebuild robustness', () => {
    test('translation text replacements skips broken entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="translation-text-replacement-add"></button>
            <div id="translation-text-replacement-list"></div>
            <template id="translation-text-replacement-entry-template">
                <div class="translation-text-replacement-entry">
                    <input class="translation-text-replacement-pattern">
                    <input class="translation-text-replacement-replacement">
                    <input class="translation-text-replacement-pattern-ignore-case" type="checkbox">
                    <button class="translation-text-replacement-button"></button>
                    <input class="translation-text-replacement-test-input">
                    <input class="translation-text-replacement-test-output">
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#translation-text-replacement-entry-template'));
        const settingsController = createSettingsController({
            options: {
                translation: {
                    textReplacements: {
                        groups: [[
                            {pattern: 'a', ignoreCase: false, replacement: 'b'},
                            {pattern: 'c', ignoreCase: false, replacement: 'd'},
                        ]],
                    },
                },
            },
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'translation-text-replacement-entry') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.translation-text-replacement-test-input')?.remove();
                }
                return node;
            }),
        });
        const controller = new TranslationTextReplacementsController(/** @type {any} */ (settingsController));

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#translation-text-replacement-list .translation-text-replacement-entry')).toHaveLength(1);
    });

    test('sentence termination characters skips broken entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="sentence-termination-character-list-add"></button>
            <button id="sentence-termination-character-list-reset"></button>
            <div id="sentence-termination-character-list-table"></div>
            <div id="sentence-termination-character-list"></div>
            <div id="sentence-termination-character-list-empty"></div>
            <template id="sentence-termination-character-entry-template">
                <div class="sentence-termination-character-entry">
                    <input class="sentence-termination-character-enabled" type="checkbox">
                    <select class="sentence-termination-character-type"></select>
                    <input class="sentence-termination-character-input1">
                    <input class="sentence-termination-character-input2">
                    <input class="sentence-termination-character-include-at-start" type="checkbox">
                    <input class="sentence-termination-character-include-at-end" type="checkbox">
                    <button class="sentence-termination-character-entry-button"></button>
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#sentence-termination-character-entry-template'));
        const settingsController = createSettingsController({
            options: {
                sentenceParsing: {
                    terminationCharacters: [
                        {enabled: true, character1: '.', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
                        {enabled: true, character1: '!', character2: null, includeCharacterAtStart: false, includeCharacterAtEnd: false},
                    ],
                },
            },
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'sentence-termination-character-entry') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.sentence-termination-character-input2')?.remove();
                }
                return node;
            }),
        });
        const controller = new SentenceTerminationCharactersController(/** @type {any} */ (settingsController));

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#sentence-termination-character-list .sentence-termination-character-entry')).toHaveLength(1);
        expect(window.document.querySelector('#sentence-termination-character-list-empty')?.hidden).toBe(true);
    });

    test('extension keyboard shortcuts skips broken entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="extension-hotkey-list-reset-all"></button>
            <button id="extension-hotkey-list-clear-all"></button>
            <div id="extension-hotkey-list"></div>
            <template id="extension-hotkey-list-item-template">
                <div class="extension-hotkey-list-item">
                    <div class="settings-item-label"></div>
                    <input>
                    <button class="extension-hotkey-list-item-button"></button>
                </div>
            </template>
        `;

        try {
            globalThis.browser = /** @type {any} */ ({
                commands: {
                    reset: vi.fn().mockResolvedValue(void 0),
                    update: vi.fn().mockResolvedValue(void 0),
                },
            });

            const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#extension-hotkey-list-item-template'));
            const settingsController = {
                application: {
                    api: {
                        getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'mac'}}),
                    },
                },
                instantiateTemplate: vi.fn((name) => {
                    if (name !== 'extension-hotkey-list-item') { throw new Error(`Unexpected template: ${name}`); }
                    const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                    const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                    if (callIndex === 2) {
                        node.querySelector('input')?.remove();
                    }
                    return node;
                }),
            };

            const getAll = vi.fn((callback) => callback([
                {name: 'toggle-1', description: 'Toggle 1', shortcut: 'Alt+A'},
                {name: 'toggle-2', description: 'Toggle 2', shortcut: 'Alt+B'},
            ]));
            globalThis.chrome = /** @type {any} */ ({
                commands: {getAll},
                runtime: {lastError: null},
            });

            const controller = new ExtensionKeyboardShortcutController(/** @type {any} */ (settingsController));

            await expect(controller.prepare()).resolves.toBeUndefined();

            expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
            expect(window.document.querySelectorAll('#extension-hotkey-list .extension-hotkey-list-item')).toHaveLength(1);
        } finally {
            delete globalThis.browser;
            delete globalThis.chrome;
        }
    });

    test('profile controller skips broken profile entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="profile-active-select"></select>
            <select id="profile-copy-source-select"></select>
            <div id="profile-reset-name"></div>
            <div id="profile-remove-name"></div>
            <button id="profile-add-button"></button>
            <button id="profile-reset-confirm-button"></button>
            <button id="profile-remove-confirm-button"></button>
            <button id="profile-copy-confirm-button"></button>
            <div id="profile-entry-list"></div>
            <div id="profile-conditions-profile-name"></div>
            <div id="profile-condition-groups"></div>
            <button id="profile-add-condition-group"></button>
            <template id="profile-entry-template">
                <div class="profile-entry">
                    <input class="profile-entry-is-default-radio" type="radio">
                    <input class="profile-entry-name-input">
                    <a class="profile-entry-condition-count-link"></a>
                    <span class="profile-entry-condition-count"></span>
                    <button class="profile-entry-menu-button"></button>
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#profile-entry-template'));
        const settingsController = {
            application: {
                api: {
                    getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'mac'}}),
                },
            },
            on: vi.fn(),
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'profile-entry') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.profile-entry-menu-button')?.remove();
                }
                return node;
            }),
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {name: 'Profile 1', conditionGroups: [], options: {}},
                    {name: 'Profile 2', conditionGroups: [], options: {}},
                ],
                profileCurrent: 0,
            }),
            profileIndex: 0,
            setGlobalSetting: vi.fn().mockResolvedValue(void 0),
        };
        const modalController = {
            getModal: vi.fn(() => ({node: window.document.createElement('div'), setVisible: vi.fn()})),
        };
        const controller = new ProfileController(/** @type {any} */ (settingsController), /** @type {any} */ (modalController));
        Reflect.set(controller, '_profileConditionsUI', {os: null, on: vi.fn(), cleanup: vi.fn(), prepare: vi.fn().mockResolvedValue(void 0)});

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#profile-entry-list .profile-entry')).toHaveLength(1);
    });

    test('dictionary controller skips broken dictionary entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="dictionary-error"></div>
            <div id="dictionary-check-integrity"></div>
            <div id="dictionary-list">
                <div class="dictionary-item-bottom"></div>
            </div>
            <template id="dictionary-template">
                <div class="dictionary-item">
                    <input class="dictionary-enabled" type="checkbox">
                    <button id="dictionary-move-up"></button>
                    <button id="dictionary-move-down"></button>
                    <button class="dictionary-menu-button"></button>
                    <button class="dictionary-outdated-button"></button>
                    <button class="dictionary-integrity-button-check"></button>
                    <button class="dictionary-integrity-button-warning"></button>
                    <button class="dictionary-integrity-button-error"></button>
                    <button class="dictionary-update-available"></button>
                    <div class="dictionary-alias"></div>
                    <div class="dictionary-revision"></div>
                    <div class="dictionary-item-title-container"></div>
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#dictionary-template'));
        const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
        Reflect.set(controller, '_dictionaryEntries', []);
        Reflect.set(controller, '_dictionaryEntryContainer', window.document.querySelector('#dictionary-list'));
        Reflect.set(controller, '_updateDictionaryEntryCount', vi.fn());
        Reflect.set(controller, 'instantiateTemplateFragment', vi.fn(() => {
            const callIndex = controller.instantiateTemplateFragment.mock.calls.length;
            const fragment = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
            if (callIndex === 2) {
                fragment.querySelector('.dictionary-menu-button')?.remove();
            }
            return fragment;
        }));
        Reflect.set(controller, 'isDictionaryInTaskQueue', vi.fn(() => false));

        const createDictionaryEntry = /** @type {(this: DictionaryController, index: number, dictionaryInfo: any, updateDownloadUrl: string|null, dictionaryDatabaseCounts: any) => void} */ (
            Reflect.get(DictionaryController.prototype, '_createDictionaryEntry')
        );

        createDictionaryEntry.call(controller, 0, {title: 'Dict 1', revision: '1', version: 3, importSuccess: true}, null, null);
        createDictionaryEntry.call(controller, 1, {title: 'Dict 2', revision: '1', version: 3, importSuccess: true}, null, null);

        expect(Reflect.get(controller, 'instantiateTemplateFragment')).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#dictionary-list .dictionary-item')).toHaveLength(1);
        expect(Reflect.get(controller, '_dictionaryEntries')).toHaveLength(1);
    });

    test('scan inputs controller skips broken entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <button id="scan-input-add"></button>
            <div class="scanning-input-count"></div>
            <div id="scan-input-list"></div>
            <template id="scan-input-template">
                <div class="scan-input">
                    <input class="scan-input-field" data-property="include">
                    <button class="mouse-button" data-property="include"></button>
                    <input class="scan-input-field" data-property="exclude">
                    <button class="mouse-button" data-property="exclude"></button>
                    <button class="scanning-input-menu-button"></button>
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#scan-input-template'));
        const settingsController = {
            application: {
                api: {
                    getEnvironmentInfo: vi.fn().mockResolvedValue({platform: {os: 'mac'}}),
                },
            },
            on: vi.fn(),
            getOptions: vi.fn().mockResolvedValue({
                scanning: {
                    inputs: [
                        {include: 'alt', exclude: '', types: {mouse: true, touch: false, pen: false}, options: {showAdvanced: false}},
                        {include: 'ctrl', exclude: '', types: {mouse: true, touch: false, pen: false}, options: {showAdvanced: false}},
                    ],
                },
            }),
            getOptionsContext: vi.fn(() => ({index: 0})),
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'scan-input') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.mouse-button[data-property=exclude]')?.remove();
                }
                return node;
            }),
            modifyProfileSettings: vi.fn().mockResolvedValue([]),
            trigger: vi.fn(),
        };

        const controller = new ScanInputsController(/** @type {any} */ (settingsController));

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#scan-input-list .scan-input')).toHaveLength(1);
        expect(window.document.querySelector('.scanning-input-count')?.textContent).toBe('1');
    });

    test('audio controller skips broken source entries during rebuild', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="audio-source-list"></div>
            <button id="audio-source-add"></button>
            <input id="text-to-speech-voice-test-text">
            <button id="text-to-speech-voice-test"></button>
            <button id="audio-source-move-button"></button>
            <template id="audio-source-template">
                <div class="audio-source">
                    <select class="audio-source-type-select"></select>
                    <div class="audio-source-parameter-container" data-field="url">
                        <input class="audio-source-parameter">
                    </div>
                    <div class="audio-source-parameter-container" data-field="voice">
                        <select class="audio-source-parameter"></select>
                    </div>
                    <button id="audio-source-move-up"></button>
                    <button id="audio-source-move-down"></button>
                    <button class="audio-source-menu-button"></button>
                </div>
            </template>
        `;

        const template = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#audio-source-template'));
        const settingsController = {
            on: vi.fn(),
            getOptions: vi.fn().mockResolvedValue({
                general: {language: 'ja'},
                audio: {
                    sources: [
                        {type: 'jpod101', url: '', voice: ''},
                        {type: 'custom', url: 'https://example.test', voice: ''},
                    ],
                },
            }),
            getOptionsContext: vi.fn(() => ({index: 0})),
            instantiateTemplate: vi.fn((name) => {
                if (name !== 'audio-source') { throw new Error(`Unexpected template: ${name}`); }
                const callIndex = settingsController.instantiateTemplate.mock.calls.length;
                const node = /** @type {HTMLElement} */ (template.content.firstElementChild.cloneNode(true));
                if (callIndex === 2) {
                    node.querySelector('.audio-source-menu-button')?.remove();
                }
                return node;
            }),
            modifyProfileSettings: vi.fn().mockResolvedValue([]),
            getOptionsFull: vi.fn().mockResolvedValue({profiles: []}),
        };
        const modalController = {
            getModal: vi.fn(() => ({node: window.document.createElement('div'), setVisible: vi.fn()})),
        };
        const controller = new AudioController(/** @type {any} */ (settingsController), /** @type {any} */ (modalController));
        Reflect.set(controller, '_audioSystem', {prepare: vi.fn(), on: vi.fn(), createTextToSpeechAudio: vi.fn()});

        await expect(controller.prepare()).resolves.toBeUndefined();

        expect(settingsController.instantiateTemplate).toHaveBeenCalledTimes(2);
        expect(window.document.querySelectorAll('#audio-source-list .audio-source')).toHaveLength(1);
        expect(controller.audioSourceCount).toBe(1);
    });

    test('profile conditions UI skips broken condition groups during prepare', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="profile-condition-groups"></div>
            <button id="profile-add-condition-group"></button>
            <template id="profile-condition-group-template">
                <div class="profile-condition-group">
                    <div class="profile-condition-list"></div>
                    <button class="profile-condition-add-button"></button>
                </div>
            </template>
            <template id="profile-condition-template">
                <div class="profile-condition">
                    <select class="profile-condition-type"><optgroup></optgroup></select>
                    <select class="profile-condition-operator"><optgroup></optgroup></select>
                    <div class="mouse-button-container"><button class="mouse-button"></button></div>
                    <button class="profile-condition-menu-button"></button>
                    <input class="profile-condition-input">
                </div>
            </template>
        `;

        const groupTemplate = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#profile-condition-group-template'));
        const conditionTemplate = /** @type {HTMLTemplateElement} */ (window.document.querySelector('#profile-condition-template'));
        const settingsController = {
            instantiateTemplate: vi.fn((name) => {
                if (name === 'profile-condition-group') {
                    return /** @type {HTMLElement} */ (groupTemplate.content.firstElementChild.cloneNode(true));
                }
                if (name === 'profile-condition') {
                    const callIndex = settingsController.instantiateTemplate.mock.calls.filter(([templateName]) => templateName === 'profile-condition').length;
                    const node = /** @type {HTMLElement} */ (conditionTemplate.content.firstElementChild.cloneNode(true));
                    if (callIndex === 2) {
                        node.querySelector('.profile-condition-menu-button')?.remove();
                    }
                    return node;
                }
                throw new Error(`Unexpected template: ${name}`);
            }),
            getOptionsFull: vi.fn().mockResolvedValue({
                profiles: [
                    {
                        conditionGroups: [
                            {conditions: [{type: 'popupLevel', operator: 'equal', value: '0'}]},
                            {conditions: [{type: 'popupLevel', operator: 'equal', value: '1'}]},
                        ],
                    },
                ],
            }),
            modifyGlobalSettings: vi.fn().mockResolvedValue([]),
            trigger: vi.fn(),
        };
        const controller = new ProfileConditionsUI(/** @type {any} */ (settingsController));
        controller.os = 'mac';

        await expect(controller.prepare(0)).resolves.toBeUndefined();

        expect(window.document.querySelectorAll('#profile-condition-groups .profile-condition-group')).toHaveLength(1);
        expect(window.document.querySelectorAll('#profile-condition-groups .profile-condition')).toHaveLength(1);
    });
});
