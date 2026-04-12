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

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daijirinArchivePath = path.resolve(__dirname, '../../../data/daijirin4_bench.zip');

describe('DictionaryImporter ZIP filename aliases', () => {
    test('indexes UTF-8 raw filenames alongside mojibake decoded ZIP names', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const archiveContent = await readFile(daijirinArchivePath);
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
