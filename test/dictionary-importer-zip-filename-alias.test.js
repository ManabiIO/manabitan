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

import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * Reproduce UTF-8 filename bytes incorrectly marked as legacy CP437, without
 * depending on a private dictionary archive outside the repository.
 * @returns {Promise<ArrayBuffer>}
 */
async function createLegacyFilenameArchive() {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0, extendedTimestamp: false});
    await writer.add('daijirin2/文-default.svg', new TextReader('<svg/>'));
    const bytes = await writer.close();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = bytes.byteLength - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    const localOffset = view.getUint32(centralOffset + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    for (const offset of [localOffset + 6, centralOffset + 8]) {
        view.setUint16(offset, view.getUint16(offset, true) & ~0x0800, true);
    }
    return new Uint8Array(bytes).buffer;
}

describe('DictionaryImporter ZIP filename aliases', () => {
    test('indexes UTF-8 raw filenames alongside mojibake decoded ZIP names', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const archiveContent = await createLegacyFilenameArchive();
        const getFilesFromArchive = /** @type {(archiveContent: ArrayBuffer|Blob) => Promise<{fileMap: Map<string, unknown>, zipReader: {close: () => Promise<void>}}>} */ (
            Reflect.get(importer, '_getFilesFromArchive')
        );

        const {fileMap, zipReader} = await getFilesFromArchive.call(importer, archiveContent);
        try {
            expect(fileMap.has('daijirin2/µûç-default.svg')).toBe(true);
            expect(fileMap.has('daijirin2/文-default.svg')).toBe(true);
            expect(fileMap.get('daijirin2/文-default.svg')).toBe(fileMap.get('daijirin2/µûç-default.svg'));
        } finally {
            await zipReader.close();
        }
    });
});