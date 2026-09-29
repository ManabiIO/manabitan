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

import {readFile} from 'node:fs/promises';
import {afterAll, describe, expect, test} from 'vitest';
import {setupDomTest} from './fixtures/dom-test.js';

const {window, teardown} = await setupDomTest('ext/search.html');

afterAll(() => teardown());

describe('search page controls', () => {
    test('icon-only controls are native, named buttons', () => {
        const {document} = window;
        for (const [selector, label] of [
            ['#clear-button', 'Clear search'],
            ['#search-back-button', 'Previous search'],
            ['#search-button', 'Search'],
            ['#search-settings-button', 'Search settings'],
        ]) {
            const control = document.querySelector(selector);
            expect(control?.tagName).toBe('BUTTON');
            expect(control?.getAttribute('type')).toBe('button');
            expect(control?.getAttribute('aria-label')).toBe(label);
            expect(control?.getAttribute('title')).toBe(label);
            expect(control?.querySelector('.icon')?.getAttribute('aria-hidden')).toBe('true');
        }
    });

    test('search input has an explicit accessible name and mobile search hint', () => {
        const input = window.document.querySelector('#search-textbox');
        expect(input?.getAttribute('aria-label')).toBe('Search terms');
        expect(input?.getAttribute('enterkeyhint')).toBe('search');
        expect(input?.getAttribute('spellcheck')).toBe('false');
    });

    test('search controls retain a touch-size CSS floor', async () => {
        const css = await readFile(new URL('../ext/css/search.css', import.meta.url), 'utf8');
        expect(css).toContain('--search-control-min-size: 44px');
        expect(css).toContain('width: max(2.5em, var(--search-control-min-size))');
        expect(css).toContain('min-width: var(--search-control-min-size)');
        expect(css).toContain('min-height: var(--search-control-min-size)');
    });
});
