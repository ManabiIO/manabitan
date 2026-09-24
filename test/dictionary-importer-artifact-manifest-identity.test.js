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

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

const MANIFEST_FILE = 'manabitan-import-artifact.json';

/**
 * @param {unknown} manifest
 * @returns {Promise<import('core').SafeAny>}
 */
async function readManifest(manifest) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    Reflect.set(importer, '_getData', async () => JSON.stringify(manifest));
    const fileMap = /** @type {import('dictionary-importer').ArchiveFileMap} */ (
        /** @type {unknown} */ (new Map([[MANIFEST_FILE, {filename: MANIFEST_FILE}]]))
    );
    return await Reflect.get(importer, '_readTermArtifactManifest').call(importer, fileMap);
}

describe('DictionaryImporter artifact manifest identity', () => {
    test('rejects duplicate term artifact names instead of silently taking the last descriptor', async () => {
        await expect(readManifest({
            termBanks: [
                {artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: 10, rows: 1},
                {artifact: 'term_bank_1.mbtb', packedOffset: 10, packedLength: 20, rows: 2},
            ],
        })).rejects.toThrow(/Duplicate term artifact manifest entry/);
    });

    test('rejects duplicate packed media paths instead of persisting multiple logical rows', async () => {
        await expect(readManifest({
            mediaArtifact: {
                file: 'media.bin',
                entries: [
                    {path: 'image.png', packedOffset: 0, packedLength: 10, mediaType: 'image/png', compressionMethod: 0, uncompressedLength: 10},
                    {path: 'image.png', packedOffset: 10, packedLength: 20, mediaType: 'image/png', compressionMethod: 0, uncompressedLength: 20},
                ],
            },
        })).rejects.toThrow(/Duplicate packed media manifest path/);
    });

    test('keeps distinct artifact and media identities unchanged', async () => {
        const manifest = await readManifest({
            termBanks: [
                {artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: 10, rows: 1},
                {artifact: 'term_bank_2.mbtb', packedOffset: 10, packedLength: 20, rows: 2},
            ],
            mediaArtifact: {
                file: 'media.bin',
                entries: [
                    {path: 'a.png', packedOffset: 0, packedLength: 10, mediaType: 'image/png', compressionMethod: 0, uncompressedLength: 10},
                    {path: 'b.png', packedOffset: 10, packedLength: 20, mediaType: 'image/png', compressionMethod: 0, uncompressedLength: 20},
                ],
            },
        });

        expect([...manifest.termBanksByArtifact.keys()]).toEqual(['term_bank_1.mbtb', 'term_bank_2.mbtb']);
        expect(manifest.packedMediaEntries.map(({path}) => path)).toEqual(['a.png', 'b.png']);
    });

    test('continues to ignore malformed descriptors before identity checks', async () => {
        const manifest = await readManifest({
            termBanks: [
                {artifact: 'term_bank_1.mbtb', packedOffset: -1, packedLength: 10},
                {artifact: 'term_bank_1.mbtb', packedOffset: 0, packedLength: 10},
            ],
            mediaArtifact: {
                entries: [
                    {path: 'image.png', packedOffset: -1, packedLength: 10, mediaType: 'image/png'},
                    {path: 'image.png', packedOffset: 0, packedLength: 10, mediaType: 'image/png'},
                ],
            },
        });

        expect(manifest.termBanksByArtifact.size).toBe(1);
        expect(manifest.packedMediaEntries).toHaveLength(1);
    });
});
