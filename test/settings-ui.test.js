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

import fs from 'fs';
import {fileURLToPath} from 'node:url';
import path from 'path';
import {describe, expect, test} from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Settings UI scan length exposure', () => {
    test('settings page renders a manual hover scan length cap', () => {
        const html = fs.readFileSync(path.join(dirname, '..', 'ext', 'settings.html'), {encoding: 'utf8'});

        expect(html).toContain('data-setting="scanning.length"');
        expect(html).toContain('Hover scan length cap');
    });

    test('recommended settings no longer modify scanning.length', () => {
        const json = /** @type {Record<string, Array<{modification: {path: string}}>>} */ (
            JSON.parse(fs.readFileSync(path.join(dirname, '..', 'ext', 'data', 'recommended-settings.json'), {encoding: 'utf8'}))
        );

        for (const entries of Object.values(json)) {
            const hasScanLengthSetting = entries.some((entry) => entry.modification.path === 'scanning.length');
            expect(hasScanLengthSetting).toBe(false);
        }
    });

    test('settings page renders separate mode, theme, and shadow controls', () => {
        const html = fs.readFileSync(path.join(dirname, '..', 'ext', 'settings.html'), {encoding: 'utf8'});

        expect(html).toContain('data-setting="general.popupTheme"');
        expect(html).toContain('data-setting="general.popupThemePreset"');
        expect(html).toContain('data-setting="general.popupOuterTheme"');
        expect(html).toContain('<option value="browser">System</option>');
        expect(html).toContain('<option value="default">Default</option>');
        expect(html).toContain('<option value="glass">Glass</option>');
        expect(html).toContain('<option value="glass-autumnal">Autumnal (Glass)</option>');
        expect(html).toContain('<option value="glass-tokyo-night">Tokyo Night (Glass)</option>');
    });

    test('welcome page renders separate mode and theme controls', () => {
        const html = fs.readFileSync(path.join(dirname, '..', 'ext', 'welcome.html'), {encoding: 'utf8'});

        expect(html).toContain('data-setting="general.popupTheme"');
        expect(html).toContain('data-setting="general.popupThemePreset"');
        expect(html).toContain('<div class="settings-item-group-item-label">Mode</div>');
        expect(html).toContain('<div class="settings-item-group-item-label">Theme</div>');
        expect(html).toContain('<option value="browser">System</option>');
        expect(html).toContain('<option value="glass-tokyo-night">Tokyo Night (Glass)</option>');
    });
});
