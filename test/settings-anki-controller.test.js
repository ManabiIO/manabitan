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
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @augments {EventDispatcher<import('settings-controller').Events>}
 */
class MockSettingsController extends EventDispatcher {
    constructor() {
        super();
        /** @type {import('settings').ProfileOptions} */
        this._options = {
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
        };
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

    /** @returns {import('settings').OptionsContext} */
    getOptionsContext() {
        return {index: 0};
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
        return template.content.cloneNode(true);
    }

    /**
     * @param {import('settings-modifications').Modification[]} targets
     * @returns {Promise<unknown[]>}
     */
    async modifyProfileSettings(targets) {
        for (const {path, value} of targets) {
            setObjectProperty(this._options, path, value);
        }
        return [];
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
    /** @type {Record<string, unknown>|unknown[]} */
    let current = /** @type {Record<string, unknown>|unknown[]} */ (target);
    for (let i = 0, ii = pathParts.length - 1; i < ii; ++i) {
        const key = getPathKey(pathParts[i]);
        current = /** @type {Record<string, unknown>|unknown[]} */ (current[key]);
    }
    current[getPathKey(pathParts[pathParts.length - 1])] = value;
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
        expect(settingsController._options.anki.cardFormats[0].fields).toStrictEqual({
            Sentence: {value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', overwriteMode: 'coalesce'},
            Reading: {value: '{reading}', overwriteMode: 'coalesce'},
        });
    });
});
