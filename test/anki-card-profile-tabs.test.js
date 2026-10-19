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
 */

import {describe, expect} from 'vitest';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {string} name
 * @returns {import('settings').AnkiCardFormat}
 */
function createCardFormat(name) {
    return {
        name,
        type: 'term',
        deck: '',
        model: '',
        fields: {},
        icon: 'big-circle',
    };
}

describe('Anki card profile tabs', () => {
    test('switching to a profile with fewer formats selects its last valid format', ({window}) => {
        window.document.body.innerHTML = `
            <div id="anki-error-message"></div>
            <div id="anki-error-message-details"></div>
            <div id="anki-error-message-details-container"></div>
            <button id="anki-error-message-details-toggle"></button>
            <div id="anki-error-invalid-response-info"></div>
            <select data-setting="anki.duplicateBehavior"></select>
            <div id="anki-overwrite-warning"></div>
            <div id="anki-card-primary">
                <select class="anki-card-type"></select>
                <select class="anki-card-icon"></select>
            </div>
            <div id="anki-cards-tabs"></div>
            <input class="anki-card-name">
            <select class="anki-card-type"></select>
            <button class="anki-card-delete-format-button"></button>
            <div id="anki-card-format-remove-name"></div>
            <button id="anki-card-format-remove-confirm-button"></button>
        `;
        const controller = new AnkiController(
            /** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ ({
                instantiateTemplateFragment() {
                    const template = window.document.createElement('template');
                    template.innerHTML = '<label class="tab"><input type="radio"><span class="tab-label"></span></label>';
                    return /** @type {DocumentFragment} */ (template.content.cloneNode(true));
                },
            })),
            /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({})),
            /** @type {import('../ext/js/pages/settings/modal-controller.js').ModalController} */ (/** @type {unknown} */ ({})),
        );

        Reflect.set(controller, '_cardFormatIndex', 1);
        Reflect.apply(Reflect.get(Object.getPrototypeOf(controller), '_setupTabs'), controller, [{
            cardFormats: [createCardFormat('A1'), createCardFormat('A2')],
        }]);
        expect(/** @type {HTMLInputElement|null} */ (window.document.querySelector('input:checked'))?.dataset.cardFormatIndex).toBe('1');

        Reflect.apply(Reflect.get(Object.getPrototypeOf(controller), '_setupTabs'), controller, [{
            cardFormats: [createCardFormat('B1')],
        }]);

        expect(window.document.querySelectorAll('#anki-cards-tabs input:checked')).toHaveLength(1);
        expect(/** @type {HTMLInputElement|null} */ (window.document.querySelector('#anki-cards-tabs input:checked'))?.dataset.cardFormatIndex).toBe('0');
        expect(/** @type {HTMLElement|null} */ (window.document.querySelector('#anki-card-primary'))?.dataset.cardFormatIndex).toBe('0');
    });
});
