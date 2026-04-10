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
});
