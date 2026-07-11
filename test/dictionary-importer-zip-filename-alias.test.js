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

describe('DictionaryImporter archive bank discovery', () => {
    test('sorts numbered bank files numerically regardless of ZIP entry order', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const getArchiveFiles = /** @type {(this: DictionaryImporter, fileMap: Map<string, {filename: string}>, queryDetails: [string, RegExp][]) => Map<string, {filename: string}[]>} */ (
            /** @type {unknown} */ (Reflect.get(importer, '_getArchiveFiles'))
        );
        const fileMap = new Map([
            ['term_bank_1.json', {filename: 'term_bank_1.json'}],
            ['term_bank_10.json', {filename: 'term_bank_10.json'}],
            ['term_bank_2.json', {filename: 'term_bank_2.json'}],
            ['term_bank_100.json', {filename: 'term_bank_100.json'}],
        ]);

        const results = getArchiveFiles.call(importer, fileMap, [['termFiles', /^term_bank_(\d+)\.json$/]]);

        expect(results.get('termFiles')?.map((entry) => entry.filename)).toEqual([
            'term_bank_1.json',
            'term_bank_2.json',
            'term_bank_10.json',
            'term_bank_100.json',
        ]);
    });
});

describe('DictionaryImporter archive filename validation', () => {
    test('rejects duplicate ZIP entry filenames', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const createArchiveFileMap = /** @type {(zipEntries: {filename: string}[]) => Map<string, unknown>} */ (
            Reflect.get(importer, '_createArchiveFileMap')
        );
        const entry = {filename: 'term_bank_1.json'};

        expect(() => createArchiveFileMap.call(importer, [entry, {...entry}])).toThrow(
            "Duplicate archive filename: 'term_bank_1.json'",
        );
    });

    test('rejects collisions between decoded filenames and UTF-8 aliases', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const createArchiveFileMap = /** @type {(zipEntries: {filename: string, rawFilename: Uint8Array}[]) => Map<string, unknown>} */ (
            Reflect.get(importer, '_createArchiveFileMap')
        );
        const rawFilename = new TextEncoder().encode('文-default.svg');

        expect(() => createArchiveFileMap.call(importer, [
            {filename: 'µûç-default.svg', rawFilename},
            {filename: '文-default.svg', rawFilename},
        ])).toThrow("Ambiguous archive filename: '文-default.svg'");
    });
});

describe('DictionaryImporter bank JSON validation', () => {
    test('rejects non-array auxiliary bank JSON', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const readFileSequence = /** @type {(files: {filename: string, bytes: Uint8Array}[], convertEntry: (entry: unknown, dictionaryTitle: string) => unknown, dictionaryTitle: string) => Promise<unknown[]>} */ (
            Reflect.get(importer, '_readFileSequence')
        );
        const file = {filename: 'tag_bank_1.json', bytes: new TextEncoder().encode('{}')};

        await expect(readFileSequence.call(importer, [file], (entry) => entry, 'Test dictionary')).rejects.toThrow(
            "Expected a JSON array in 'tag_bank_1.json'",
        );
    });

    test('rejects non-array term bank JSON before treating it as empty', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const readTermBankFile = /** @type {(termFile: {filename: string, bytes: Uint8Array}, version: number, dictionaryTitle: string, prefixWildcardsSupported: boolean, useMediaPipeline: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes') => Promise<unknown>} */ (
            /** @type {unknown} */ (Reflect.get(importer, '_readTermBankFile'))
        );
        const file = {filename: 'term_bank_1.json', bytes: new TextEncoder().encode('{}')};

        await expect(readTermBankFile.call(importer, file, 3, 'Test dictionary', false, false, true, 'baseline')).rejects.toThrow(
            "Expected a JSON array in 'term_bank_1.json'",
        );
    });
});
