/*
 * Copyright (C) 2023-2025  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {waitForExtensionBaseUrl} from './firefox-extension-base-url.js';

const addonId = '{accbebce-862b-48a9-bb9a-1da9ad1f8702}';
const uuid = '6d1d0bf0-9b57-4ff8-9d93-64e13ae0f5da';
const baseUrl = `moz-extension://${uuid}`;
const settingsUrl = `${baseUrl}/settings.html`;

/**
 * @param {{url?: string, id?: string}} [options]
 * @returns {import('./firefox-extension-base-url.js').ExtensionDiscoveryDriver & {sleeps: number[]}} Mock driver with a polling-controlled clock.
 */
function createDriver({url = settingsUrl, id = addonId} = {}) {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    /** @type {number[]} */
    const sleeps = [];
    return {
        getAllWindowHandles: vi.fn(async () => ['extension']),
        switchTo: () => ({window: vi.fn(async () => void 0)}),
        getCurrentUrl: vi.fn(async () => url),
        executeScript: vi.fn(async () => ({url, addonId: id})),
        sleeps,
        sleep: async (duration) => { sleeps.push(duration); now += duration; },
    };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Firefox extension page discovery', () => {
    test('resolves the manifest addon ID immediately using the page runtime', async () => {
        const driver = createDriver();
        expect(await waitForExtensionBaseUrl(driver, ` ${addonId} `)).toBe(baseUrl);
        expect(driver.sleeps).toHaveLength(0);
        expect(driver.executeScript).toHaveBeenCalledWith(expect.stringContaining('window.chrome?.runtime?.id'));
    });

    test('accepts a known runtime UUID only when its page is observed', async () => {
        const driver = createDriver();
        expect(await waitForExtensionBaseUrl(driver, uuid)).toBe(baseUrl);
        expect(driver.executeScript).not.toHaveBeenCalled();
        expect(driver.sleeps).toHaveLength(0);
    });

    test('can discover an extension without an expected ID', async () => {
        const driver = createDriver();
        expect(await waitForExtensionBaseUrl(driver)).toBe(baseUrl);
    });

    test('rejects a different addon instead of returning the last extension tab', async () => {
        const driver = createDriver({id: 'other@example.com'});
        await expect(waitForExtensionBaseUrl(driver, addonId, {timeoutMs: 20, pollIntervalMs: 10})).rejects.toThrow(addonId);
        expect(driver.sleeps).toHaveLength(2);
    });

    test('does not fabricate a URL when no extension tab exists', async () => {
        const driver = createDriver({url: 'about:blank'});
        await expect(waitForExtensionBaseUrl(driver, uuid, {timeoutMs: 20, pollIntervalMs: 10})).rejects.toThrow('Failed to discover');
        expect(driver.executeScript).not.toHaveBeenCalled();
    });

    test('retries a transient window-list failure and a closed tab', async () => {
        const driver = createDriver();
        vi.mocked(driver.getAllWindowHandles).mockRejectedValueOnce(new Error('window list not ready'));
        vi.mocked(driver.getCurrentUrl).mockRejectedValueOnce(new Error('tab closed'));
        expect(await waitForExtensionBaseUrl(driver, addonId, {timeoutMs: 30, pollIntervalMs: 10})).toBe(baseUrl);
        expect(driver.sleeps).toHaveLength(2);
    });

    test('continues to a matching addon after an unrelated extension tab', async () => {
        const driver = createDriver();
        vi.mocked(driver.getAllWindowHandles).mockResolvedValue(['other', 'extension']);
        vi.mocked(driver.getCurrentUrl).mockResolvedValueOnce('moz-extension://unrelated/settings.html');
        vi.mocked(driver.executeScript).mockResolvedValueOnce({url: 'moz-extension://unrelated/settings.html', addonId: 'other@example.com'});
        expect(await waitForExtensionBaseUrl(driver, addonId)).toBe(baseUrl);
        expect(driver.sleeps).toHaveLength(0);
    });

    test('retries when the page navigates between URL and runtime identity reads', async () => {
        const driver = createDriver();
        vi.mocked(driver.executeScript).mockResolvedValueOnce({url: 'https://example.com/', addonId});
        expect(await waitForExtensionBaseUrl(driver, addonId, {timeoutMs: 20, pollIntervalMs: 10})).toBe(baseUrl);
        expect(driver.sleeps).toHaveLength(1);
    });

    test('waits for an extension API to become available', async () => {
        const driver = createDriver();
        vi.mocked(driver.executeScript).mockResolvedValueOnce({url: settingsUrl, addonId: ''});
        expect(await waitForExtensionBaseUrl(driver, addonId, {timeoutMs: 20, pollIntervalMs: 10})).toBe(baseUrl);
        expect(driver.sleeps).toHaveLength(1);
    });

    test('does not discover a non-extension URL containing an extension URI', async () => {
        const driver = createDriver({url: `https://example.com/?redirect=${settingsUrl}`});
        await expect(waitForExtensionBaseUrl(driver, '', {timeoutMs: 10, pollIntervalMs: 10})).rejects.toThrow('Failed to discover');
    });
});
