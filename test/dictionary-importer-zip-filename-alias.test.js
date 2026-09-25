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
import {TermBankWasmResourceError} from '../ext/js/dictionary/term-bank-wasm-parser.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

/**
 * Reproduce UTF-8 filename bytes incorrectly marked as legacy CP437, without
 * depending on a private multi-gigabyte dictionary outside the repository.
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
    // Clear general-purpose bit 11 in both the local and central headers.
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

describe('DictionaryImporter artifact bank admission', () => {
    /**
     * @param {string[]} termFileNames
     * @param {string[]} artifactFileNames
     * @returns {boolean}
     */
    const hasCompleteCoverage = (termFileNames, artifactFileNames) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const check = /** @type {(termFiles: {filename: string}[], artifactFileNames: Iterable<string>) => boolean} */ (
            Reflect.get(importer, '_hasCompleteTermArtifactCoverage')
        );
        return check.call(
            importer,
            termFileNames.map((filename) => ({filename})),
            artifactFileNames,
        );
    };

    test('falls back to ordinary term banks when standalone artifact coverage is partial', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const ordinaryFailure = new Error('ordinary term source selected');
        const artifactFailure = new Error('partial artifact source selected');
        const fileMap = new Map([
            ['term_bank_1.json', {filename: 'term_bank_1.json'}],
            ['term_bank_2.json', {filename: 'term_bank_2.json'}],
            ['term_bank_1.mbtb', {filename: 'term_bank_1.mbtb', getData: async () => new Uint8Array(0)}],
        ]);
        Reflect.set(importer, '_getFilesFromArchive', async () => ({
            fileMap,
            zipReader: {close: async () => {}},
        }));
        Reflect.set(importer, '_readAndValidateIndex', async () => ({
            title: 'Partial artifact coverage',
            version: 3,
            revision: '1',
        }));
        Reflect.set(importer, '_readTermBankFile', async () => { throw ordinaryFailure; });
        Reflect.set(importer, '_readTermBankArtifactFile', async () => { throw artifactFailure; });
        const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
            isPrepared: () => true,
            setImportOptimizationFlags() {},
            dictionaryExists: async () => false,
            setImportDebugLogging() {},
            setTermEntryContentDedupEnabled() {},
            addWithResult: async () => 1,
            startBulkImport: async () => 'test-session',
            abortBulkImport: async () => {},
            deleteDictionaryImportPlaceholder: async () => {},
        }));

        const result = await importer.importDictionary(
            database,
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        );

        expect(result.result).toBeNull();
        expect(result.errors).toContain(ordinaryFailure);
        expect(result.errors).not.toContain(artifactFailure);
    });

    test('rejects a partial standalone artifact replacement', () => {
        expect(hasCompleteCoverage(
            ['term_bank_1.json', 'term_bank_2.json'],
            ['term_bank_1.mbtb'],
        )).toBe(false);
    });

    test('accepts a complete standalone artifact replacement', () => {
        expect(hasCompleteCoverage(
            ['term_bank_1.json', 'term_bank_2.json'],
            ['term_bank_1.mbtb', 'term_bank_2.mbtb'],
        )).toBe(true);
    });

    test('rejects artifact banks which do not match the ordinary bank set', () => {
        expect(hasCompleteCoverage(
            ['term_bank_1.json', 'term_bank_2.json'],
            ['term_bank_1.mbtb', 'term_bank_2.mbtb', 'term_bank_3.mbtb'],
        )).toBe(false);
    });

    test('preserves exact bank index spelling when matching replacements', () => {
        expect(hasCompleteCoverage(['term_bank_01.json'], ['term_bank_1.mbtb'])).toBe(false);
        expect(hasCompleteCoverage(['term_bank_01.json'], ['term_bank_01.mbtb'])).toBe(true);
    });

    test('allows artifact-only dictionaries when no ordinary term banks exist', () => {
        expect(hasCompleteCoverage([], ['term_bank_1.mbtb'])).toBe(true);
        expect(hasCompleteCoverage([], [])).toBe(false);
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

    test('does not retry a WASM resource failure through the larger JSON fallback', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const readTermBankFile = /** @type {(termFile: {filename: string, bytes: Uint8Array}, version: number, dictionaryTitle: string, prefixWildcardsSupported: boolean, useMediaPipeline: boolean, enableTermEntryContentDedup: boolean, termContentStorageMode: 'baseline'|'raw-bytes') => Promise<unknown>} */ (
            /** @type {unknown} */ (Reflect.get(importer, '_readTermBankFile'))
        );
        let fallbackRead = false;
        Reflect.set(importer, '_readTermBankFileFast', async () => {
            throw new TermBankWasmResourceError('capacity exhausted');
        });
        Reflect.set(importer, '_getData', async () => {
            fallbackRead = true;
            return '[]';
        });
        const file = {filename: 'term_bank_1.json', bytes: new Uint8Array(0)};

        await expect(readTermBankFile.call(importer, file, 3, 'Test dictionary', false, false, true, 'baseline')).rejects.toThrow(
            'capacity exhausted',
        );
        expect(fallbackRead).toBe(false);
    });
});
