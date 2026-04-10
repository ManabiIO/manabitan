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
import {AnkiTemplatesController} from '../ext/js/pages/settings/anki-templates-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('AnkiTemplatesController', () => {
    test('restores the previous textarea value when saving templates fails', async ({window}) => {
        vi.stubGlobal('chrome', {runtime: {getURL: vi.fn((path) => path)}});
        window.document.body.innerHTML = `
            <textarea id="anki-card-templates-textarea"></textarea>
            <div id="anki-card-templates-compile-result"></div>
            <input id="anki-card-templates-test-field-input">
            <input id="anki-card-templates-test-text-input">
            <div id="anki-card-templates-render-result"></div>
            <button id="anki-card-templates-test-field-menu-button"></button>
            <button id="anki-card-templates-test-render-button"></button>
            <button id="anki-card-templates-reset-button"></button>
            <button id="anki-card-templates-reset-button-confirm"></button>
            <div data-modal-action="show,anki-card-templates"></div>
        `;

        const settingsController = {
            application: {
                api: {
                    getDefaultAnkiFieldTemplates: vi.fn().mockResolvedValue('default templates'),
                },
            },
            getOptions: vi.fn().mockResolvedValue({
                anki: {fieldTemplates: 'saved templates'},
                dictionaries: [],
                general: {language: 'en'},
            }),
            getOptionsContext: vi.fn(() => ({})),
            setProfileSetting: vi.fn().mockRejectedValue(new Error('save failed')),
            on: vi.fn(),
        };
        const controller = new AnkiTemplatesController(
            /** @type {any} */ ({api: {getLanguageSummaries: vi.fn().mockResolvedValue([{iso: 'en', exampleText: 'text'}])}}),
            /** @type {any} */ (settingsController),
            /** @type {any} */ ({getModal: vi.fn(() => null)}),
            /** @type {any} */ ({}),
        );
        vi.spyOn(controller, '_onValidateCompile').mockImplementation(() => {});

        await controller.prepare();

        const textarea = /** @type {HTMLTextAreaElement} */ (window.document.querySelector('#anki-card-templates-textarea'));
        textarea.value = 'unsaved templates';

        await expect(controller._onChanged(/** @type {Event} */ (/** @type {unknown} */ ({currentTarget: textarea})))).rejects.toThrow('save failed');
        expect(textarea.value).toBe('saved templates');
        expect(textarea.dataset.value).toBe('saved templates');

        vi.unstubAllGlobals();
    });
});
