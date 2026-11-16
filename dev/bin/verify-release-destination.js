/*
 * Copyright (C) 2026  Manabitan authors
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

import {readResponseJson} from '../../ext/js/core/json.js';

/**
 * Resolve the release independently before signing or uploading its assets.
 * @param {Record<string, string|undefined>} environment
 * @param {typeof fetch} [request]
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function verifyReleaseDestination(environment, request = fetch) {
    const {GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN, RELEASE_TAG, RELEASE_UPLOAD_URL} = environment;
    if (typeof RELEASE_TAG !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(RELEASE_TAG) ||
    RELEASE_TAG === '0.0.0.0' || RELEASE_TAG.split('.').some((part) => Number(part) > 65535)) {
        throw new Error('Expected a nonzero four-part release version');
    }
    if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GH_TOKEN || !RELEASE_UPLOAD_URL) {
        throw new Error('Missing release lookup configuration');
    }
    const response = await request(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`, {
        headers: {Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json'},
    });
    if (!response.ok) { throw new Error(`Release lookup failed: HTTP ${response.status}`); }
    const release = await readResponseJson(response);
    if (release === null || typeof release !== 'object' || Array.isArray(release) ||
    !('tag_name' in release) || release.tag_name !== RELEASE_TAG ||
    !('draft' in release) || release.draft !== false ||
    !('upload_url' in release) || release.upload_url !== RELEASE_UPLOAD_URL) {
        throw new Error('Upload destination does not match the selected published release');
    }
}

// Node 22.22 supports this entry-point flag; the Node type declarations predate it.
if (/** @type {ImportMeta & {main?: boolean}} */ (import.meta).main) { await verifyReleaseDestination(process.env); }
