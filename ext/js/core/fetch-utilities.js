/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {readResponseJson} from './json.js';

/**
 * Resolve package assets independently of the hosting page or extension API.
 * Leading slashes retain their historic package-root meaning. Already-resolved
 * URLs (e.g. display templates) must not be prefixed a second time.
 * @param {string} path
 * @param {URL} [packageRoot]
 * @returns {URL}
 * @throws {Error} The URL resolves outside this package.
 */
export function resolveAssetUrl(path, packageRoot = new URL('../../', import.meta.url)) {
    const url = new URL(path.startsWith('/') && !path.startsWith('//') ? path.slice(1) : path, packageRoot);
    // Extension URL origins are "null" in some URL implementations; compare
    // protocol and host explicitly instead of treating equal origins as proof.
    if (
        url.protocol !== packageRoot.protocol ||
        url.host !== packageRoot.host ||
        url.username.length > 0 || url.password.length > 0 ||
        !url.pathname.startsWith(packageRoot.pathname)
    ) {
        throw new Error(`Asset URL is outside the package: ${path}`);
    }
    return url;
}

/**
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchAsset(url) {
    const packageUrl = resolveAssetUrl(url);
    const runtime = typeof chrome === 'object' ? chrome.runtime : null;
    const requestUrl = typeof runtime?.getURL === 'function' && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//') ?
        runtime.getURL(url) :
        packageUrl;
    const response = await fetch(requestUrl, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'default',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response;
}


/**
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchText(url) {
    const response = await fetchAsset(url);
    return await response.text();
}

/**
 * @template [T=unknown]
 * @param {string} url
 * @returns {Promise<T>}
 */
export async function fetchJson(url) {
    const response = await fetchAsset(url);
    return await readResponseJson(response);
}
