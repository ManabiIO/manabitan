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
import {ThemeController} from '../ext/js/app/theme-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const {window, teardown} = await setupDomTest();
const {document} = window;

describe('ThemeController', () => {
    afterAll(() => teardown(global));

    test('system mode follows the browser preference and preserves the selected preset', () => {
        const controller = new ThemeController(document.documentElement);
        controller.theme = 'browser';
        controller.themePreset = 'glass';
        controller.siteTheme = 'light';

        controller.updateTheme();
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(document.documentElement.dataset.themeRaw).toBe('browser');
        expect(document.documentElement.dataset.themePreset).toBe('glass');

        controller._onPrefersColorSchemeDarkChange({matches: true});
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(document.documentElement.dataset.browserTheme).toBe('dark');
    });

    test('light and dark modes resolve directly', () => {
        const controller = new ThemeController(document.documentElement);
        controller.siteTheme = 'light';

        controller.theme = 'light';
        controller.updateTheme();
        expect(document.documentElement.dataset.theme).toBe('light');

        controller.theme = 'dark';
        controller.updateTheme();
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    test('tokyo night preset forces the resolved theme to dark', () => {
        const controller = new ThemeController(document.documentElement);
        controller.theme = 'light';
        controller.themePreset = 'glass-tokyo-night';
        controller.siteTheme = 'light';

        controller.updateTheme();

        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(document.documentElement.dataset.themeRaw).toBe('light');
        expect(document.documentElement.dataset.themePreset).toBe('glass-tokyo-night');
    });
});
