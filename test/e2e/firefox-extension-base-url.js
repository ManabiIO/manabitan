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

/**
 * @typedef {object} ExtensionDiscoveryDriver
 * @property {() => Promise<unknown>} getAllWindowHandles
 * @property {() => {window: (handle: string) => Promise<unknown>}} switchTo
 * @property {() => Promise<unknown>} getCurrentUrl
 * @property {(script: string) => Promise<unknown>} executeScript
 * @property {(duration: number) => Promise<unknown>} sleep
 */

/**
 * Discover an open extension page using its runtime identity. Firefox's
 * installAddon returns the manifest ID, which differs from the URL's UUID.
 * A caller with a known URL UUID can match it directly, but only on an open tab.
 * @param {ExtensionDiscoveryDriver} driver
 * @param {string} [installedAddonId]
 * @param {{timeoutMs?: number, pollIntervalMs?: number}} [options]
 * @returns {Promise<string>}
 * @throws {Error}
 */
export async function waitForExtensionBaseUrl(driver, installedAddonId = '', {timeoutMs = 30_000, pollIntervalMs = 500} = {}) {
    const expectedId = installedAddonId.trim();
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const handles = await driver.getAllWindowHandles();
            for (const handle of Array.isArray(handles) ? handles : []) {
                try {
                    await driver.switchTo().window(String(handle));
                    const baseUrl = getExtensionBaseUrl(await driver.getCurrentUrl());
                    if (baseUrl.length === 0) { continue; }
                    if (expectedId.length === 0 || baseUrl === `moz-extension://${expectedId}`) {
                        return baseUrl;
                    }
                    // Window exposes the page's extension APIs in Gecko WebDriver;
                    // the script's globalThis can be a separate execution sandbox.
                    const identity = await driver.executeScript(`
                        return {
                            url: window.location.href,
                            addonId: window.chrome?.runtime?.id ?? window.browser?.runtime?.id ?? '',
                        };
                    `);
                    if (
                        typeof identity === 'object' && identity !== null &&
                        'addonId' in identity && identity.addonId === expectedId &&
                        'url' in identity && getExtensionBaseUrl(identity.url) === baseUrl
                    ) {
                        return baseUrl;
                    }
                } catch (error) {
                    // A tab can close or navigate while its identity is queried.
                    lastError = error;
                }
            }
        } catch (error) {
            lastError = error;
        }
        await driver.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Failed to discover an open moz-extension page${expectedId.length > 0 ? ` for ${expectedId}` : ''}.`, {cause: lastError});
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function getExtensionBaseUrl(value) {
    if (typeof value !== 'string') { return ''; }
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'moz-extension:' || url.hostname.length === 0 ||
            url.username.length > 0 || url.password.length > 0 || url.port.length > 0
        ) { return ''; }
        return `moz-extension://${url.hostname}`;
    } catch {
        return '';
    }
}
