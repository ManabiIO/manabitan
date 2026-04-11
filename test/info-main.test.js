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

import {afterAll, describe, expect, test} from 'vitest';
import {setupDomTest} from './fixtures/dom-test.js';

const {window, teardown} = await setupDomTest('ext/info.html');

describe('info page dictionary rendering', () => {
    test('renderDictionaryInfo updates installed dictionaries and none-installed state', async () => {
        const {renderDictionaryInfo} = await import('../ext/js/pages/info-dictionary-info.js');
        const {document} = window;

        renderDictionaryInfo([{title: 'JMdict'}, {title: 'Jitendex'}]);

        const container = /** @type {HTMLElement} */ (document.querySelector('#installed-dictionaries'));
        const noneElement = /** @type {HTMLElement} */ (document.querySelector('#installed-dictionaries-none'));

        expect(container.textContent).toBe('JMdict, Jitendex');
        expect(noneElement.hidden).toBe(true);

        renderDictionaryInfo([]);

        expect(container.textContent).toBe('');
        expect(noneElement.hidden).toBe(false);
    });
});

afterAll(() => teardown(global));
