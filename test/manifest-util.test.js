/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {ManifestUtil} from '../dev/manifest-util.js';

const legacyFirefoxGeckoId = '{6b733b82-9261-47ee-a595-2dda294a4d08}';
const stableFirefoxGeckoId = '{1e12d533-8e72-4ec5-9edc-cd50e26d7d43}';
const devFirefoxGeckoId = '{accbebce-862b-48a9-bb9a-1da9ad1f8702}';
const devFirefoxUpdateUrl = 'https://raw.githubusercontent.com/ManabiIO/manabitan/metadata/updates.json';

describe('ManifestUtil firefox variants', () => {
    const manifestUtil = new ManifestUtil();

    test('stable firefox manifest uses the Manabitan gecko ID', () => {
        const manifest = manifestUtil.getManifest('firefox');

        expect(manifest.browser_specific_settings?.gecko?.id).toBe(stableFirefoxGeckoId);
        expect(manifest.browser_specific_settings?.gecko?.id).not.toBe(legacyFirefoxGeckoId);
        expect(manifest.browser_specific_settings?.gecko?.update_url).toBeUndefined();
    });

    test('firefox dev manifest keeps the offline update identity', () => {
        const manifest = manifestUtil.getManifest('firefox-dev');

        expect(manifest.browser_specific_settings?.gecko?.id).toBe(devFirefoxGeckoId);
        expect(manifest.browser_specific_settings?.gecko?.update_url).toBe(devFirefoxUpdateUrl);
    });

    test('firefox android manifest inherits the stable gecko ID', () => {
        const manifest = manifestUtil.getManifest('firefox-android');

        expect(manifest.browser_specific_settings?.gecko?.id).toBe(stableFirefoxGeckoId);
        expect(manifest.browser_specific_settings?.gecko?.update_url).toBeUndefined();
    });
});
