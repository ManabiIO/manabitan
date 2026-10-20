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
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';
import {Backend} from '../ext/js/background/backend.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {SettingsController} from '../ext/js/pages/settings/settings-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @augments {EventDispatcher<import('settings-controller').Events>}
 */
class MockSettingsController extends EventDispatcher {
    constructor() {
        super();
        this.optionsRevision = 0;
        this.profileIndexChangeGeneration = 0;
        this._context = {index: 0, profileId: 'profile-a'};
        /** @type {import('vitest').Mock} */
        this.modifySettings = vi.fn(this._modifySettings.bind(this));
        /** @type {import('settings').ProfileOptions} */
        this._options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
            anki: {
                cardFormats: [{
                    type: 'term',
                    name: 'Expression',
                    deck: 'Deck',
                    model: '',
                    fields: {
                        Sentence: {
                            value: 'custom sentence',
                            overwriteMode: 'coalesce',
                        },
                    },
                    icon: 'big-circle',
                }],
            },
            dictionaries: [{
                name: 'Primary Dict',
                alias: 'Primary Dict',
                enabled: true,
                allowSecondarySearches: false,
                definitionsCollapsible: 'not-collapsible',
                partsOfSpeechFilter: true,
                useDeinflections: true,
                styles: '',
            }],
            general: {
                language: 'ja',
            },
        }));
    }

    /** @returns {Promise<import('settings').ProfileOptions>} */
    async getOptions() {
        return this._options;
    }

    /** @returns {Promise<import('dictionary-importer').Summary[]>} */
    async getDictionaryInfo() {
        return [
            {
                title: 'Primary Dict',
                revision: '1',
                sequenced: false,
                version: 3,
                importDate: 0,
                prefixWildcardsSupported: false,
                styles: '',
                sourceLanguage: 'ja',
                counts: {
                    terms: {total: 1},
                    termMeta: {total: 0, freq: 0},
                    kanji: {total: 0},
                    kanjiMeta: {total: 0},
                    tagMeta: {total: 0},
                    media: {total: 0},
                },
            },
        ];
    }

    /** @returns {import('settings').OptionsContext2} */
    getOptionsContext() {
        return {...this._context};
    }

    /**
     * @param {string} name
     * @returns {DocumentFragment}
     */
    instantiateTemplateFragment(name) {
        if (name !== 'anki-card-field') {
            throw new Error(`Unexpected template: ${name}`);
        }
        const template = document.createElement('template');
        template.innerHTML = `
            <div class="anki-card-field-name-container">
                <span class="anki-card-field-name"></span>
            </div>
            <div class="anki-card-field-value-container input-group">
                <input type="text" class="anki-card-field-value" autocomplete="off">
            </div>
            <div class="anki-card-field-overwrite-container">
                <select class="anki-card-field-overwrite"></select>
            </div>
        `;
        return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
    }

    /**
     * @param {import('settings-modifications').Modification[]} targets
     * @returns {Promise<import('settings-controller').ModifyResult[]>}
     */
    async modifyProfileSettings(targets) {
        const optionsContext = this.getOptionsContext();
        return await this.modifySettings(/** @type {import('settings-modifications').ScopedModification[]} */ (/** @type {unknown} */ (targets.map((target) => ({...target, scope: 'profile', optionsContext, profileId: optionsContext.profileId ?? void 0})))));
    }

    /**
     * @param {import('settings-modifications').ScopedModification[]} targets
     * @returns {Promise<import('settings-controller').ModifyResult[]>}
     */
    async _modifySettings(targets) {
        const results = [];
        for (const target of targets) {
            if (target.action !== 'set') { continue; }
            const actual = getObjectProperty(this._options, target.path);
            if (Object.hasOwn(target, 'expectedValue') && JSON.stringify(actual) !== JSON.stringify(target.expectedValue)) {
                results.push({error: {name: 'Error', message: 'stale setting', stack: ''}});
                continue;
            }
            setObjectProperty(this._options, target.path, target.value);
            results.push({result: target.value});
        }
        return results;
    }
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {HTMLElement}
 */
function setupAnkiDom(window) {
    window.document.body.innerHTML = `
        <div id="anki-error-message"></div>
        <div id="anki-error-message-details"></div>
        <div id="anki-error-message-details-container"></div>
        <button id="anki-error-message-details-toggle"></button>
        <div id="anki-error-invalid-response-info"></div>
        <select data-setting="anki.duplicateBehavior"></select>
        <div id="anki-overwrite-warning"></div>
        <div id="anki-card-primary"></div>
        <div id="anki-cards-tabs"></div>
        <input class="anki-card-name">
        <select class="anki-card-type"></select>
        <button class="anki-card-delete-format-button"></button>
        <div id="anki-card-format-remove-name"></div>
        <button id="anki-card-format-remove-confirm-button"></button>
        <div class="anki-card" data-card-format-index="0">
            <select class="anki-card-deck"></select>
            <select class="anki-card-model"></select>
            <div class="anki-card-fields"></div>
        </div>
    `;
    return /** @type {HTMLElement} */ (window.document.querySelector('.anki-card'));
}

/**
 * @param {object} target
 * @param {string} path
 * @param {unknown} value
 */
function setObjectProperty(target, path, value) {
    const pathParts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    /** @type {any} */
    let current = target;
    for (let i = 0, ii = pathParts.length - 1; i < ii; ++i) {
        const key = getPathKey(pathParts[i]);
        current = current[key];
    }
    current[getPathKey(pathParts[pathParts.length - 1])] = value;
}

/**
 * @param {object} target
 * @param {string} path
 * @returns {unknown}
 */
function getObjectProperty(target, path) {
    const pathParts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    /** @type {any} */
    let current = target;
    for (const part of pathParts) { current = current[getPathKey(part)]; }
    return current;
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferredValue() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

/**
 * @returns {Promise<{settingsController: SettingsController, state: {options: import('settings').Options}}>}
 */
async function createRealSettingsController() {
    vi.stubGlobal('chrome', {permissions: {}});
    const profileOptions = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        anki: {
            cardFormats: [{type: 'term', name: 'Expression', deck: 'Deck', model: '', fields: {Sentence: {value: 'custom sentence', overwriteMode: 'coalesce'}}, icon: 'big-circle'}],
        },
        dictionaries: [],
        general: {language: 'ja'},
    }));
    const state = {
        options: /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
            profileCurrent: 0,
            profiles: [
                {id: 'profile-a', name: 'A', options: structuredClone(profileOptions), conditionGroups: []},
                {id: 'profile-b', name: 'B', options: structuredClone(profileOptions), conditionGroups: []},
            ],
        })),
    };
    const application = {
        on: vi.fn(),
        api: {
            optionsGetFull: async () => structuredClone(state.options),
            optionsGet: async (/** @type {import('settings').OptionsContext} */ optionsContext) => {
                const index = optionsContext.index ?? 0;
                return structuredClone(state.options.profiles[index].options);
            },
            modifySettings: vi.fn(async () => []),
            getDictionaryInfo: vi.fn(async () => []),
        },
    };
    const settingsController = new SettingsController(/** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ (application)));
    Reflect.set(settingsController, '_templates', {
        loadFromFiles: vi.fn(),
        instantiateFragment(/** @type {string} */ name) {
            if (name !== 'anki-card-field') { throw new Error(`Unexpected template: ${name}`); }
            const template = document.createElement('template');
            template.innerHTML = '<div class="anki-card-field-name-container"><span class="anki-card-field-name"></span></div><div class="anki-card-field-value-container input-group"><input class="anki-card-field-value"></div><div class="anki-card-field-overwrite-container"><select class="anki-card-field-overwrite"></select></div>';
            return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
        },
    });
    await settingsController.prepare();
    return {settingsController, state};
}

/**
 * @param {string} value
 * @returns {string|number}
 */
function getPathKey(value) {
    return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}

describe('AnkiController known note type presets', () => {
    test('model changes apply known presets and keep the legacy heuristic for unknown models', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );

        ankiController.getAnkiData = vi.fn(async () => ({
            deckNames: ['Deck'],
            modelNames: ['Kiku', 'Custom'],
        }));
        ankiController.getModelFieldNames = vi.fn(async (model) => {
            switch (model) {
                case 'Kiku':
                    return ['Expression', 'Sentence', 'MainDefinition', 'Mystery'];
                case 'Custom':
                    return ['Sentence', 'Reading'];
                default:
                    return [];
            }
        });
        ankiController.getRequiredPermissions = vi.fn(() => []);

        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => {
            expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1);
        });

        await cardController._setModel('Kiku');

        expect(settingsController._options.anki.cardFormats[0].model).toBe('Kiku');
        expect(settingsController._options.anki.cardFormats[0].fields).toStrictEqual({
            Expression: {value: '{expression}', overwriteMode: 'coalesce'},
            Sentence: {value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', overwriteMode: 'coalesce'},
            MainDefinition: {value: '{single-glossary-primary-dict}', overwriteMode: 'coalesce'},
            Mystery: {value: '', overwriteMode: 'coalesce'},
        });

        await cardController._setModel('Custom');

        expect(settingsController._options.anki.cardFormats[0].model).toBe('Custom');
        expect(/** @type {HTMLSelectElement} */ (cardNode.querySelector('.anki-card-model')).value).toBe('Custom');
        expect(settingsController._options.anki.cardFormats[0].fields).toStrictEqual({
            Sentence: {value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', overwriteMode: 'coalesce'},
            Reading: {value: '{reading}', overwriteMode: 'coalesce'},
        });
    });

    test('validateFields clears stale validation state after a failed lookup', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );

        ankiController.getAnkiData = vi.fn(async () => ({
            deckNames: ['Deck'],
            modelNames: ['Model'],
        }));
        ankiController.getModelFieldNames = vi.fn().mockRejectedValue(new Error('model lookup failed'));
        ankiController.getRequiredPermissions = vi.fn(() => []);

        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => {
            expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1);
        });

        Reflect.set(cardController, '_modelController', {value: 'Model'});
        Reflect.set(cardController, '_fieldEntries', []);
        Reflect.set(cardController, '_validateFieldsToken', {});

        await expect(cardController._validateFields()).resolves.toBeUndefined();
        expect(Reflect.get(cardController, '_validateFieldsToken')).toBeNull();
    });

    test('setDeck restores the previous deck when saving fails', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        settingsController.modifySettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );

        ankiController.getAnkiData = vi.fn(async () => ({
            deckNames: ['Deck', 'Other Deck'],
            modelNames: ['Model'],
        }));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);

        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => {
            expect(cardNode.querySelector('.anki-card-deck')).not.toBeNull();
        });

        await expect(cardController._setDeck('Other Deck')).rejects.toThrow('save failed');
        expect(cardController._deckController.value).toBe('Deck');
        expect(/** @type {HTMLSelectElement} */ (cardNode.querySelector('.anki-card-deck')).value).toBe('Deck');
    });

    test('setModel restores the previous model and fields when saving fails', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        settingsController.modifySettings = vi.fn().mockRejectedValue(new Error('save failed'));
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );

        ankiController.getAnkiData = vi.fn(async () => ({
            deckNames: ['Deck'],
            modelNames: ['Model', 'Other Model'],
        }));
        ankiController.getModelFieldNames = vi.fn(async (model) => {
            switch (model) {
                case 'Other Model':
                    return ['Reading'];
                default:
                    return ['Sentence'];
            }
        });
        ankiController.getRequiredPermissions = vi.fn(() => []);

        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => {
            expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1);
        });

        const previousFields = structuredClone(cardController._fields);
        await expect(cardController._setModel('Other Model')).rejects.toThrow('save failed');

        expect(cardController._modelController.value).toBe('');
        expect(cardController._fields).toStrictEqual(previousFields);
    });

    test('delete confirmation rejects a replaced or reordered format snapshot', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        settingsController._options.anki.cardFormats.push({...structuredClone(settingsController._options.anki.cardFormats[0]), name: 'Second'});
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController._updateOptions = vi.fn();
        Reflect.set(ankiController, '_ankiOptions', settingsController._options.anki);
        const modal = {node: document.createElement('div'), setVisible: vi.fn()};
        Reflect.set(ankiController, '_cardFormatRemoveModal', modal);
        ankiController.openDeleteCardFormatModal(0);
        settingsController._options.anki.cardFormats.reverse();
        ankiController._onCardFormatRemoveConfirm();
        await Promise.resolve();
        expect(settingsController.modifySettings).not.toHaveBeenCalled();

        ankiController.openDeleteCardFormatModal(0);
        settingsController._context = {index: 1, profileId: 'profile-b'};
        settingsController.profileIndexChangeGeneration++;
        ankiController._onCardFormatRemoveConfirm();
        await Promise.resolve();
        expect(settingsController.modifySettings).not.toHaveBeenCalled();
    });

    test('delete and add use whole-list compare-and-set and preserve a nonempty format list', async ({window}) => {
        setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        settingsController._options.anki.cardFormats.push({...structuredClone(settingsController._options.anki.cardFormats[0]), name: 'Second'});
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController._updateOptions = vi.fn();
        Reflect.set(ankiController, '_ankiOptions', settingsController._options.anki);
        await ankiController.deleteCardFormat(0);
        expect(settingsController._options.anki.cardFormats).toHaveLength(1);
        await ankiController._addNewFormat();
        expect(settingsController._options.anki.cardFormats).toHaveLength(2);
        expect(settingsController.modifySettings.mock.calls[1][0][0]).toMatchObject({path: 'anki.cardFormats', expectedValue: expect.any(Array), value: expect.any(Array)});
        expect(settingsController.modifySettings).toHaveBeenCalledWith([expect.objectContaining({
            path: 'anki.cardFormats',
            expectedValue: expect.any(Array),
            value: expect.any(Array),
            scope: 'profile',
            optionsContext: {index: 0, profileId: 'profile-a'},
            profileId: 'profile-a',
        })]);
        await ankiController.deleteCardFormat(0);
        expect(settingsController._options.anki.cardFormats).toHaveLength(1);
    });

    test('newer model selection wins when an older lookup resolves later', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        const aFields = deferredValue();
        const bFields = deferredValue();
        ankiController.getModelFieldNames = vi.fn((model) => (model === 'A' ? aFields.promise : bFields.promise));
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck'], modelNames: ['A', 'B']}));
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1));

        const first = cardController._setModel('A');
        await vi.waitFor(() => expect(ankiController.getModelFieldNames).toHaveBeenCalledWith('A'));
        const second = cardController._setModel('B');
        aFields.resolve(['Old Field']);
        await vi.waitFor(() => expect(ankiController.getModelFieldNames).toHaveBeenCalledWith('B'));
        bFields.resolve(['New Field']);
        await Promise.all([first, second]);

        expect(settingsController._options.anki.cardFormats[0].model).toBe('B');
        expect(settingsController._options.anki.cardFormats[0].fields).toHaveProperty('New Field');
        expect(settingsController._options.anki.cardFormats[0].fields).not.toHaveProperty('Old Field');
    });

    test('model row write is atomic, serializes delayed saves, and uses row compare-and-set', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const originalModify = settingsController.modifySettings.bind(settingsController);
        const saveGate = deferredValue();
        let saveCount = 0;
        settingsController.modifySettings = vi.fn(async (targets) => {
            if (++saveCount === 1) { await saveGate.promise; }
            return await originalModify(targets);
        });
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck'], modelNames: ['A', 'B']}));
        ankiController.getModelFieldNames = vi.fn(async (model) => [`${model} Field`]);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1));

        const first = cardController._setModel('A');
        await vi.waitFor(() => expect(settingsController.modifySettings).toHaveBeenCalledTimes(1));
        const second = cardController._setModel('B');
        await Promise.resolve();
        expect(settingsController.modifySettings).toHaveBeenCalledTimes(1);
        saveGate.resolve(void 0);
        await Promise.all([first, second]);

        expect(settingsController._options.anki.cardFormats[0].model).toBe('B');
        expect(settingsController.modifySettings.mock.calls[0][0][0]).toMatchObject({
            action: 'set',
            path: 'anki.cardFormats[0]',
            expectedValue: expect.objectContaining({model: '', fields: expect.any(Object)}),
            value: expect.objectContaining({model: 'A', fields: expect.any(Object)}),
            scope: 'profile',
            profileId: 'profile-a',
        });
        expect(settingsController._options.anki.cardFormats[0].fields).toHaveProperty('B Field');
    });

    test('resolved per-target save errors reconcile the authoritative deck value', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other'], modelNames: ['Model']}));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelector('.anki-card-deck')).not.toBeNull());
        settingsController.modifySettings = vi.fn(async () => [{error: {name: 'Error', message: 'rejected target', stack: ''}}]);

        await expect(cardController._setDeck('Other')).rejects.toThrow('rejected target');
        expect(cardController._deckController.value).toBe('Deck');
        expect(settingsController._options.anki.cardFormats[0].deck).toBe('Deck');
    });

    test('a failed older deck save cannot roll back the later accepted deck choice', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const originalModify = settingsController.modifySettings.bind(settingsController);
        const firstSave = deferredValue();
        let saveCount = 0;
        settingsController.modifySettings = vi.fn(async (targets) => {
            if (++saveCount === 1) {
                await firstSave.promise;
                throw new Error('older save failed');
            }
            return await originalModify(targets);
        });
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'First', 'Second'], modelNames: ['Model']}));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelector('.anki-card-deck')).not.toBeNull());

        const first = cardController._setDeck('First');
        await vi.waitFor(() => expect(settingsController.modifySettings).toHaveBeenCalledTimes(1));
        const second = cardController._setDeck('Second');
        firstSave.resolve(void 0);
        await expect(first).rejects.toThrow('older save failed');
        await expect(second).resolves.toBeUndefined();

        expect(cardController._deckController.value).toBe('Second');
        expect(settingsController._options.anki.cardFormats[0].deck).toBe('Second');
        expect(settingsController.modifySettings).toHaveBeenCalledTimes(2);
    });

    test('card setup tolerates a missing format during transient empty-list setup', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        settingsController._options.anki.cardFormats = [];
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: [], modelNames: []}));
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);

        await expect(cardController.prepare()).resolves.toBeUndefined();
        expect(cardController._getCardFormat(/** @type {import('settings').AnkiOptions} */ (/** @type {unknown} */ ({cardFormats: []})), 0)).toBeNull();
        expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(0);
    });

    test('external same-profile revision invalidates delayed card model lookup', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        const fields = deferredValue();
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck'], modelNames: ['A']}));
        ankiController.getModelFieldNames = vi.fn(() => fields.promise);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1));

        const change = cardController._setModel('A');
        await vi.waitFor(() => expect(ankiController.getModelFieldNames).toHaveBeenCalled());
        settingsController.optionsRevision++;
        settingsController._options.anki.cardFormats[0] = {...settingsController._options.anki.cardFormats[0], deck: 'External Deck'};
        fields.resolve(['Sentence']);
        await change;
        expect(settingsController.modifySettings).not.toHaveBeenCalled();
        expect(settingsController._options.anki.cardFormats[0].deck).toBe('External Deck');
    });

    test('real SettingsController profile selection invalidates an in-flight card model lookup', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const {settingsController} = await createRealSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        const fields = deferredValue();
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck'], modelNames: ['A']}));
        ankiController.getModelFieldNames = vi.fn(() => fields.promise);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1));

        const change = cardController._setModel('A');
        await vi.waitFor(() => expect(ankiController.getModelFieldNames).toHaveBeenCalled());
        settingsController.setProfileSelection(1, 'profile-b');
        fields.resolve(['Sentence']);
        await change;

        expect(settingsController.getOptionsContext()).toEqual({index: 1, profileId: 'profile-b'});
        expect(settingsController.application.api.modifySettings).not.toHaveBeenCalled();
    });

    test('real SettingsController external same-ID refresh invalidates an in-flight card model lookup', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const {settingsController, state} = await createRealSettingsController();
        const ankiController = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({api: {}})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );
        const fields = deferredValue();
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck'], modelNames: ['A']}));
        ankiController.getModelFieldNames = vi.fn(() => fields.promise);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardNode.querySelectorAll('.anki-card-field-name')).toHaveLength(1));

        const change = cardController._setModel('A');
        await vi.waitFor(() => expect(ankiController.getModelFieldNames).toHaveBeenCalled());
        state.options.profiles[0].options.anki.cardFormats[0].deck = 'From another tab';
        const revision = settingsController.optionsRevision;
        const refresh = settingsController._onOptionsUpdatedInternal(false);
        expect(settingsController.optionsRevision).toBe(revision + 1);
        await refresh;
        fields.resolve(['Sentence']);
        await change;

        expect(settingsController.getOptionsContext()).toEqual({index: 0, profileId: 'profile-a'});
        expect(settingsController.application.api.modifySettings).not.toHaveBeenCalled();
        expect(state.options.profiles[0].options.anki.cardFormats[0].deck).toBe('From another tab');
    });

    test('production backend rejects a card row compare-and-set mismatch inside its mutation queue', async () => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        const originalRow = {
            type: 'term',
            name: 'Expression',
            deck: 'Externally changed',
            model: '',
            fields: {},
            icon: 'big-circle',
        };
        Reflect.set(backend, '_options', {
            profileCurrent: 0,
            profiles: [{id: 'profile-a', name: 'A', conditionGroups: [], options: {anki: {cardFormats: [originalRow]}}}],
        });
        const saveOptions = vi.fn(async (_source, value) => { Reflect.set(backend, '_options', value); });
        Reflect.set(backend, '_saveOptions', saveOptions);
        const target = /** @type {import('settings-modifications').ScopedModificationSet} */ ({
            action: 'set',
            scope: 'profile',
            optionsContext: {index: 0, profileId: 'profile-a'},
            profileId: 'profile-a',
            path: 'anki.cardFormats.0',
            expectedValue: {...originalRow, deck: 'Old Deck'},
            value: {...originalRow, model: 'Model'},
        });

        const results = await backend._modifySettings([target], 'card CAS mismatch');

        expect(results[0].error).toBeDefined();
        expect(saveOptions).not.toHaveBeenCalled();
        expect(/** @type {import('settings').Options} */ (Reflect.get(backend, '_options')).profiles[0].options.anki.cardFormats[0]).toEqual(originalRow);
    });
});


for (const kind of ['deck', 'model']) {
    test('initial ' + kind + ' options read failure restores the visible acknowledged selection', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settingsController = new MockSettingsController();
        const ankiController = new AnkiController(/** @type {any} */ (settingsController), /** @type {any} */ ({api: {}}), /** @type {any} */ ({}));
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other Deck'], modelNames: ['', 'Other Model']}));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const cardController = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(cardController._deckController._optionValues).toContain('Other Deck'));
        const select = /** @type {HTMLSelectElement} */ (cardNode.querySelector('.anki-card-' + kind));
        const oldValue = kind === 'deck' ? 'Deck' : '';
        const nextValue = kind === 'deck' ? 'Other Deck' : 'Other Model';
        select.value = nextValue;
        expect(select.value).toBe(nextValue);
        vi.spyOn(settingsController, 'getOptions').mockRejectedValueOnce(new Error('settings read failed'));
        await expect(cardController[kind === 'deck' ? '_setDeck' : '_setModel'](nextValue)).rejects.toThrow('settings read failed');
        expect(select.value).toBe(oldValue);
        expect(cardController[kind === 'deck' ? '_deckController' : '_modelController'].value).toBe(oldValue);
    });
}


for (const kind of ['deck', 'model']) {
    test('a rendered ' + kind + ' control cannot edit a replacement row while refresh is pending', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const {settingsController, state} = await createRealSettingsController();
        const ankiController = new AnkiController(/** @type {any} */ (settingsController), /** @type {any} */ ({api: {}}), /** @type {any} */ ({}));
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other Deck'], modelNames: ['', 'Other Model']}));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const controller = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(controller._deckController._optionValues).toContain('Other Deck'));
        const refreshRead = deferredValue();
        vi.spyOn(settingsController.application.api, 'optionsGetFull').mockReturnValueOnce(/** @type {any} */ (refreshRead.promise));
        state.options.profiles[0].options.anki.cardFormats[0] = {...state.options.profiles[0].options.anki.cardFormats[0], name: 'Replacement', deck: 'Replacement Deck'};
        const refresh = settingsController._onOptionsUpdatedInternal(true);
        const select = /** @type {HTMLSelectElement} */ (cardNode.querySelector('.anki-card-' + kind));
        select.value = kind === 'deck' ? 'Other Deck' : 'Other Model';
        await controller[kind === 'deck' ? '_setDeck' : '_setModel'](select.value);
        expect(settingsController.application.api.modifySettings).not.toHaveBeenCalled();
        expect(state.options.profiles[0].options.anki.cardFormats[0].deck).toBe('Replacement Deck');
        expect(select.value).toBe(kind === 'deck' ? 'Deck' : '');
        refreshRead.resolve(structuredClone(state.options));
        await refresh;
    });

    test('revision-cancelled ' + kind + ' choice restores its acknowledged value even when refresh fails', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const {settingsController, state} = await createRealSettingsController();
        const ankiController = new AnkiController(/** @type {any} */ (settingsController), /** @type {any} */ ({api: {}}), /** @type {any} */ ({}));
        ankiController.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other Deck'], modelNames: ['', 'Other Model']}));
        ankiController.getModelFieldNames = vi.fn(async () => ['Sentence']);
        ankiController.getRequiredPermissions = vi.fn(() => []);
        const controller = Reflect.get(ankiController, '_createCardController').call(ankiController, cardNode);
        await vi.waitFor(() => expect(controller._deckController._optionValues).toContain('Other Deck'));
        const editRead = deferredValue();
        const oldOptions = structuredClone(state.options.profiles[0].options);
        vi.spyOn(settingsController.application.api, 'optionsGet').mockReturnValueOnce(/** @type {any} */ (editRead.promise));
        const select = /** @type {HTMLSelectElement} */ (cardNode.querySelector('.anki-card-' + kind));
        const nextValue = kind === 'deck' ? 'Other Deck' : 'Other Model';
        select.value = nextValue;
        const operation = controller[kind === 'deck' ? '_setDeck' : '_setModel'](nextValue);
        await vi.waitFor(() => expect(settingsController.application.api.optionsGet).toHaveBeenCalled());
        vi.spyOn(settingsController.application.api, 'optionsGetFull').mockRejectedValueOnce(new Error('external refresh failed'));
        await settingsController._onOptionsUpdatedInternal(true);
        editRead.resolve(oldOptions);
        await operation;
        expect(settingsController.application.api.modifySettings).not.toHaveBeenCalled();
        expect(select.value).toBe(kind === 'deck' ? 'Deck' : '');
    });
}


for (const kind of ['deck', 'model']) {
    test('unobserved replacement cannot be blessed by a fresh ' + kind + ' read', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settings = new MockSettingsController();
        const parent = new AnkiController(/** @type {any} */ (settings), /** @type {any} */ ({api: {}}), /** @type {any} */ ({}));
        parent.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other'], modelNames: ['', 'Other']}));
        parent.getModelFieldNames = vi.fn(async () => ['Sentence']);
        parent.getRequiredPermissions = vi.fn(() => []);
        const rerender = vi.fn(async () => {});
        Reflect.set(parent, 'refreshOptions', rerender);
        const controller = Reflect.get(parent, '_createCardController').call(parent, cardNode);
        await vi.waitFor(() => expect(controller._deckController._optionValues).toContain('Other'));
        settings._options.anki.cardFormats[0] = {...settings._options.anki.cardFormats[0], name: 'Replacement', deck: 'Replacement Deck'};
        await controller[kind === 'deck' ? '_setDeck' : '_setModel']('Other');
        expect(settings.modifySettings).not.toHaveBeenCalled();
        expect(settings._options.anki.cardFormats[0].name).toBe('Replacement');
        expect(settings._options.anki.cardFormats[0].deck).toBe('Replacement Deck');
        expect(rerender).toHaveBeenCalledOnce();
    });

    test('acknowledged local name icon and field edits remain usable before a ' + kind + ' change', async ({window}) => {
        const cardNode = setupAnkiDom(window);
        const settings = new MockSettingsController();
        const parent = new AnkiController(/** @type {any} */ (settings), /** @type {any} */ ({api: {}}), /** @type {any} */ ({}));
        parent.getAnkiData = vi.fn(async () => ({deckNames: ['Deck', 'Other'], modelNames: ['', 'Other']}));
        parent.getModelFieldNames = vi.fn(async () => ['Sentence']);
        parent.getRequiredPermissions = vi.fn(() => []);
        const controller = Reflect.get(parent, '_createCardController').call(parent, cardNode);
        await vi.waitFor(() => expect(controller._deckController._optionValues).toContain('Other'));
        const row = settings._options.anki.cardFormats[0];
        row.name = 'Local Name';
        row.icon = 'big-diamond';
        row.fields.Sentence.value = 'Local Field';
        row.fields.Sentence.overwriteMode = 'overwrite';
        for (const [path, value] of [['name', row.name], ['icon', row.icon], ['fields.Sentence.value', row.fields.Sentence.value], ['fields.Sentence.overwriteMode', row.fields.Sentence.overwriteMode]]) {
            const input = window.document.createElement('input');
            input.dataset.setting = 'anki.cardFormats[0].' + path;
            window.document.body.append(input);
            input.dispatchEvent(new window.CustomEvent('settingChanged', {detail: {value}}));
        }
        await controller[kind === 'deck' ? '_setDeck' : '_setModel']('Other');
        expect(settings.modifySettings).toHaveBeenCalledOnce();
        expect(settings.modifySettings.mock.calls[0][0][0].expectedValue).toMatchObject({name: 'Local Name', icon: 'big-diamond', fields: {Sentence: {value: 'Local Field', overwriteMode: 'overwrite'}}});
        expect(settings._options.anki.cardFormats[0]).toMatchObject({name: 'Local Name', icon: 'big-diamond', fields: {Sentence: {value: 'Local Field'}}});
        expect(kind === 'deck' ? settings._options.anki.cardFormats[0].deck : settings._options.anki.cardFormats[0].model).toBe('Other');
    });
}
