/*
 * Copyright (C) 2026 Manabitan authors
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

import {createGenerationMediaIndex} from './dictionary-generation-media-store.js';
import {readDenseZipDirectory} from './dense-zip-directory.js';
import {getImageMediaTypeFromFileName} from '../media/media-util.js';
import {preparePackedSourceZipMedia} from './source-zip-media-pack.js';
import {RawZipPayloadReader} from './term-bank-source-pipeline.js';

self.addEventListener('message', (event) => { void prepare(event.data); }, {once: true});

/** @param {unknown} archive */
async function prepare(archive) {
    try {
        if (!(archive instanceof Blob)) { throw new TypeError('Missing source ZIP'); }
        const entries = await readDenseZipDirectory(archive);
        if (entries === null) {
            self.postMessage(null);
            return;
        }
        /** @type {import('dictionary-importer').ArchiveFileMap} */
        const fileMap = new Map();
        /** @type {Array<{type: 'image', source: {path: string}}>} */
        const requirements = [];
        for (const entry of entries) {
            if (getImageMediaTypeFromFileName(entry.filename) === null) { continue; }
            if (fileMap.has(entry.filename)) {
                self.postMessage(null);
                return;
            }
            const {filename: path} = entry;
            fileMap.set(path, /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ (entry)));
            requirements.push({type: 'image', source: {path}});
        }
        const packed = await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {});
        if (packed === null) {
            self.postMessage(null);
            return;
        }
        const {blob, records, ...metrics} = packed;
        const plan = createGenerationMediaIndex(records, blob.size);
        if (plan === null) {
            self.postMessage(null);
            return;
        }
        self.postMessage({blob, plan, metrics}, [plan.index.buffer]);
    } catch (_) {
        // A malformed or unreferenced image declines speculative preparation.
        // The importer can still resolve the actually referenced entries.
        self.postMessage(null);
    }
}
