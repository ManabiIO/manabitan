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

import {convertMdxToArchive} from './mdx/mdx-converter.js';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function getString(value, key, fallback) {
    const result = value[key];
    return typeof result === 'string' ? result : fallback;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {ArrayBuffer|null}
 */
function getArrayBuffer(value, key) {
    const result = value[key];
    return result instanceof ArrayBuffer ? result : null;
}

self.addEventListener('message', async (event) => {
    if (!isRecord(event.data)) { return; }
    const action = event.data.action;
    const params = event.data.params;
    if (action !== 'convertDictionary' || !isRecord(params)) { return; }

    try {
        const mdxFileName = getString(params, 'mdxFileName', 'dictionary.mdx');
        const mdxArrayBuffer = getArrayBuffer(params, 'mdxBytes');
        if (mdxArrayBuffer === null) {
            throw new Error('MDX conversion worker did not receive MDX bytes');
        }
        const mdxBytes = new Uint8Array(mdxArrayBuffer);
        const mddFilesRaw = Array.isArray(params.mddFiles) ? params.mddFiles : [];
        const options = isRecord(params.options) ? params.options : {};
        const mddFiles = mddFilesRaw
            .filter((value) => isRecord(value))
            .map((value) => ({
                name: getString(value, 'name', 'dictionary.mdd'),
                bytes: new Uint8Array(getArrayBuffer(value, 'bytes') ?? new ArrayBuffer(0)),
            }));

        const result = await convertMdxToArchive(
            mdxFileName,
            options,
            mdxBytes,
            mddFiles,
            (details) => self.postMessage({action: 'progress', params: {details}}),
        );
        self.postMessage({action: 'complete', params: {result}}, [result.archiveContent]);
    } catch (error) {
        self.postMessage({
            action: 'complete',
            params: {error: error instanceof Error ? error.message : String(error)},
        });
    }
});
