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

import {crc32} from 'node:zlib';
import {TextReader, Uint8ArrayWriter, ZipWriter} from '@zip.js/zip.js';
import {describe, expect, test, vi} from 'vitest';
import {Uint8ArrayReader as BundledUint8ArrayReader, ZipReader} from '../ext/lib/zip.js';
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

/**
 * One physical bank has a valid Unicode Path name that differs from its raw
 * ASCII name. Both filename and payload CRCs remain valid.
 * @returns {Promise<ArrayBuffer>}
 */
async function createUnicodeBankAliasArchive() {
    const rawName = 'term_bank_1.json';
    const unicodeName = 'term_bank_2.json';
    const encoder = new TextEncoder();
    const unicodeBytes = encoder.encode(unicodeName);
    const extra = new Uint8Array(5 + unicodeBytes.length);
    extra[0] = 1;
    new DataView(extra.buffer).setUint32(1, crc32(encoder.encode(rawName)), true);
    extra.set(unicodeBytes, 5);
    const writer = new ZipWriter(new Uint8ArrayWriter(), {level: 0, extendedTimestamp: false});
    const options = {useWebWorkers: false};
    await writer.add('index.json', new TextReader(JSON.stringify({title: 'Unicode bank alias', revision: '1', format: 3})), options);
    await writer.add(rawName, new TextReader(JSON.stringify([['語', 'ご', '', '', 0, ['word'], 1, '']])), {
        ...options,
        extraField: new Map([[0x7075, extra]]),
    });
    const bytes = Uint8Array.from(await writer.close());
    const view = new DataView(bytes.buffer);
    const end = bytes.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    let central = view.getUint32(end + 16, true);
    let changed = false;
    for (let i = 0; i < view.getUint16(end + 10, true); ++i) {
        expect(view.getUint32(central, true)).toBe(0x02014b50);
        const nameLength = view.getUint16(central + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + nameLength));
        if (name === rawName) {
            const local = view.getUint32(central + 42, true);
            expect(view.getUint32(local, true)).toBe(0x04034b50);
            // Write the 16-bit custom field ID explicitly; the fixture writer
            // truncates custom IDs while copying its Uint16Array to byte storage.
            view.setUint16(local + 30 + view.getUint16(local + 26, true), 0x7075, true);
            view.setUint16(central + 46 + nameLength, 0x7075, true);
            for (const offset of [local + 6, central + 8]) {
                view.setUint16(offset, view.getUint16(offset, true) & ~0x0800, true);
            }
            changed = true;
        }
        central += 46 + nameLength + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
    }
    expect(changed).toBe(true);
    return bytes.buffer;
}

describe('DictionaryImporter ZIP filename aliases', () => {
    test('rejects conflicting bank aliases before storage ownership', async () => {
        const archiveContent = await createUnicodeBankAliasArchive();
        // Verify the real bundled reader honors the valid Unicode Path field.
        const reader = new ZipReader(new BundledUint8ArrayReader(new Uint8Array(archiveContent)));
        try {
            const entries = /** @type {import('@zip.js/zip.js').Entry[]} */ (await reader.getEntries());
            expect(entries).toHaveLength(2);
            const bank = entries.find((entry) => entry.filename === 'term_bank_2.json');
            if (typeof bank?.getData !== 'function') { throw new Error('Unicode bank fixture was not decoded'); }
            expect(new TextDecoder().decode(bank.rawFilename)).toBe('term_bank_1.json');
            const content = await bank.getData(new Uint8ArrayWriter(), {checkSignature: true, useWebWorkers: false});
            expect(JSON.parse(new TextDecoder().decode(content))).toHaveLength(1);
        } finally {
            await reader.close();
        }
        const addWithResult = vi.fn(async () => 1);
        const startBulkImport = vi.fn(async () => 'alias-session');
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const database = /** @type {import('../ext/js/dictionary/dictionary-database.js').DictionaryDatabase} */ (/** @type {unknown} */ ({
            isPrepared: () => true,
            setImportOptimizationFlags() {},
            setImportDebugLogging() {},
            setTermEntryContentDedupEnabled() {},
            dictionaryExists: async () => false,
            addWithResult,
            startBulkImport,
            abortBulkImport: async () => {},
            deleteDictionaryImportPlaceholder: async () => {},
        }));
        const result = await importer.importDictionary(database, archiveContent, {zipUseWebWorkers: false});
        expect(result.result).toBeNull();
        expect(result.errors.map(({message}) => message)).toContain("Ambiguous archive filename: 'term_bank_1.json'");
        expect(addWithResult).not.toHaveBeenCalled();
        expect(startBulkImport).not.toHaveBeenCalled();
    });

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
    test.each([
        ['term_bank_1.json', 'term_bank_2.json'],
        ['term_bank_1.json', 'kanji_bank_1.json'],
        ['term_meta_bank_1.json', 'assets/frequency.json'],
        ['kanji_meta_bank_1.json', 'assets/frequency.json'],
        ['tag_bank_1.json', 'assets/tags.json'],
        ['term_bank_1.mbtb', 'term_bank_2.mbtb'],
        ['index.json', 'metadata.json'],
        ['manabitan-import-artifact.json', 'manifest.json'],
        ['manabitan-term-banks-packed.bin', 'terms.bin'],
        ['manabitan-media-packed.bin', 'media.bin'],
        ['manabitan-term-glossary-shared.bin', 'glossary.bin'],
    ])('rejects conflicting data-file identities %s and %s in either direction', (first, second) => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const createArchiveFileMap = /** @type {(zipEntries: {filename: string, rawFilename: Uint8Array}[]) => Map<string, unknown>} */ (
            Reflect.get(importer, '_createArchiveFileMap')
        );
        for (const [filename, rawName] of [[first, second], [second, first]]) {
            expect(() => createArchiveFileMap.call(importer, [{filename, rawFilename: new TextEncoder().encode(rawName)}]))
                .toThrow(`Ambiguous archive filename: '${rawName}'`);
        }
    });


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

    test('preserves a leading U+FEFF in raw UTF-8 filename aliases', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const createArchiveFileMap = /** @type {(zipEntries: {filename: string, rawFilename: Uint8Array}[]) => Map<string, unknown>} */ (
            Reflect.get(importer, '_createArchiveFileMap')
        );
        const prefixed = {filename: '\ufeffimage.png', rawFilename: new TextEncoder().encode('\ufeffimage.png')};
        const plain = {filename: 'image.png', rawFilename: new TextEncoder().encode('image.png')};

        const map = createArchiveFileMap.call(importer, [prefixed, plain]);
        expect(map.get('\ufeffimage.png')).toBe(prefixed);
        expect(map.get('image.png')).toBe(plain);
        expect(map.size).toBe(2);
    });

    test('legacy-decoded raw alias retains every leading U+FEFF', () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const createArchiveFileMap = /** @type {(zipEntries: {filename: string, rawFilename: Uint8Array}[]) => Map<string, unknown>} */ (
            Reflect.get(importer, '_createArchiveFileMap')
        );
        const file = {filename: 'legacy', rawFilename: new TextEncoder().encode('\ufeff\ufeffimage.png')};

        const map = createArchiveFileMap.call(importer, [file]);
        expect(map.get('\ufeff\ufeffimage.png')).toBe(file);
        expect(map.has('\ufeffimage.png')).toBe(false);
        expect(map.has('image.png')).toBe(false);
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
