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
import {LanguagesController} from '../ext/js/pages/settings/languages-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('LanguagesController', () => {
    test('prepare replaces existing language options instead of duplicating them', async ({window}) => {
        window.document.body.innerHTML = '<select id="language-select"><option value="stale">Stale</option></select>';

        const getLanguageSummaries = vi.fn().mockResolvedValue([
            {iso: 'ja', name: 'Japanese'},
            {iso: 'en', name: 'English'},
        ]);
        const settingsController = {
            application: {
                api: {
                    getLanguageSummaries,
                },
            },
        };
        const controller = new LanguagesController(/** @type {any} */ (settingsController));

        await controller.prepare();
        await controller.prepare();

        const options = [...window.document.querySelectorAll('#language-select option')].map((option) => option.value);
        expect(options).toEqual(['en', 'ja']);
    });

    test('prepare preserves the current language selection when it still exists', async ({window}) => {
        window.document.body.innerHTML = `
            <select id="language-select">
                <option value="en">English</option>
                <option value="ja" selected>Japanese</option>
            </select>
        `;

        const getLanguageSummaries = vi.fn().mockResolvedValue([
            {iso: 'en', name: 'English'},
            {iso: 'ja', name: 'Japanese'},
            {iso: 'fr', name: 'French'},
        ]);
        const settingsController = {
            application: {
                api: {
                    getLanguageSummaries,
                },
            },
        };
        const controller = new LanguagesController(/** @type {any} */ (settingsController));

        await controller.prepare();

        expect((/** @type {HTMLSelectElement} */ (window.document.querySelector('#language-select'))).value).toBe('ja');
    });
});
