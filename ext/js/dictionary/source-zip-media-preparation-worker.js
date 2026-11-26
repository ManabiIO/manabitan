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

import {readDenseZipDirectory} from './dense-zip-directory.js';
import {getImageMediaTypeFromFileName} from '../media/media-util.js';
// eslint-disable-next-line @stylistic/semi
import {preparePackedSourceZipMediaIndex} from './source-zip-media-pack.js'
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
        /* eslint-disable @stylistic/semi */
        const imageEntries = /** @type {import('@zip.js/zip.js').Entry[]} */ (
            /** @type {unknown} */ (entries.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null))
        )
        const packed = await preparePackedSourceZipMediaIndex(archive, imageEntries, new RawZipPayloadReader(archive), () => {})
        /* eslint-enable @stylistic/semi */
        if (packed === null) {
            self.postMessage(null);
            return;
        }
        // eslint-disable-next-line @stylistic/semi
        const {blob, plan, ...metrics} = packed
        self.postMessage({blob, plan, metrics}, [plan.index.buffer]);
    } catch (_) {
        // A malformed or unreferenced image declines speculative preparation.
        // The importer can still resolve the actually referenced entries.
        self.postMessage(null);
    }
}
