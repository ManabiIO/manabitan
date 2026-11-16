/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect} from 'vitest';
import {HtmlTemplateCollection} from '../ext/js/dom/html-template-collection.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('./ext/templates-settings.html');

test('refreshing the selected Kanji format retains its field menu, including after its index changes', ({window}) => {
    const {document} = window;
    const templates = new HtmlTemplateCollection();
    templates.load(document);
    const primary = document.createElement('div');
    primary.innerHTML = '<select class="anki-card-type"></select><select class="anki-card-icon"></select>';
    const tabs = document.createElement('div');
    const options = /** @type {import('settings').AnkiOptions} */ (/** @type {unknown} */ ({
        cardFormats: [{name: 'Words', type: 'term'}, {name: 'Characters', type: 'kanji'}],
    }));
    const controller = /** @type {AnkiController} */ (Object.assign(Object.create(AnkiController.prototype), {
        _settingsController: {instantiateTemplateFragment: (/** @type {string} */ name) => templates.instantiateFragment(name)},
        _ankiCardsTabs: tabs,
        _ankiCardPrimary: primary,
        _ankiCardNameInput: document.createElement('input'),
        _cardFormatDeleteButton: document.createElement('button'),
        _cardFormatIndex: 0,
        _cardFormatDeleteSnapshot: null,
        _ankiOptions: options,
    }));

    controller._setupTabs(options);
    const kanjiTab = /** @type {HTMLInputElement} */ (tabs.querySelector('[data-card-format-index="1"]'));
    kanjiTab.checked = true;
    kanjiTab.dispatchEvent(new window.Event('change'));
    expect(primary.dataset.ankiCardMenu).toBe('anki-card-kanji-field-menu');

    // Opening the card settings modal again runs this same tab refresh.
    controller._setupTabs(options);
    expect(primary.dataset.ankiCardMenu).toBe('anki-card-kanji-field-menu');

    options.cardFormats.splice(0, 1);
    controller._setupTabs(options);
    expect(primary.dataset.cardFormatIndex).toBe('0');
    expect(primary.dataset.ankiCardMenu).toBe('anki-card-kanji-field-menu');
});
