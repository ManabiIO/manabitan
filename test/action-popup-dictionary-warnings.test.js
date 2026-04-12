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

import {afterAll, describe, expect, test, vi} from 'vitest';
import {updateDictionaryWarningTooltips} from '../ext/js/pages/action-popup-dictionary-warnings.js';
import {setupDomTest} from './fixtures/dom-test.js';

const {window, teardown} = await setupDomTest('ext/action-popup.html');

describe('action popup dictionary warnings', () => {
    test('shows no-dictionary warning when no enabled dictionaries are available', () => {
        const {document} = window;
        document.body.innerHTML = '<p class="tooltip">Hover over text to scan</p>';
        const tooltip = /** @type {HTMLElement} */ (document.querySelector('.tooltip'));
        const restoreDefaultTooltips = vi.fn();

        updateDictionaryWarningTooltips(document.querySelectorAll('.tooltip'), false, restoreDefaultTooltips);

        expect(tooltip.textContent).toBe('No dictionary enabled');
        expect(tooltip.classList.contains('enable-dictionary-tooltip')).toBe(true);
        expect(restoreDefaultTooltips).not.toHaveBeenCalled();
    });

    test('restores default tooltip state when enabled dictionaries become available', () => {
        const {document} = window;
        document.body.innerHTML = '<p class="tooltip enable-dictionary-tooltip">No dictionary enabled</p>';
        const tooltip = /** @type {HTMLElement} */ (document.querySelector('.tooltip'));
        const restoreDefaultTooltips = vi.fn(() => {
            tooltip.textContent = 'Hold Ctrl to scan';
        });

        updateDictionaryWarningTooltips(document.querySelectorAll('.tooltip'), true, restoreDefaultTooltips);

        expect(tooltip.textContent).toBe('Hold Ctrl to scan');
        expect(tooltip.classList.contains('enable-dictionary-tooltip')).toBe(false);
        expect(restoreDefaultTooltips).toHaveBeenCalledOnce();
    });
});

afterAll(() => teardown(global));
