/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

/**
 * @param {string[]} names
 * @returns {import('dictionary-importer').ArchiveFileMap}
 */
function createFileMap(names) {
    return /** @type {import('dictionary-importer').ArchiveFileMap} */ (
        new Map(names.map((filename) => [
            filename,
            /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({filename})),
        ]))
    );
}

/**
 * @param {string[]} artifactNames
 * @param {string|null} [packedFileName=null]
 * @returns {{termBanksByArtifact: Map<string, {packedOffset: number, packedLength: number, rows: number|null}>, packedFileName: string|null}}
 */
function createManifest(artifactNames, packedFileName = null) {
    return {
        termBanksByArtifact: new Map(artifactNames.map((name, index) => [
            name,
            {packedOffset: index, packedLength: 1, rows: 1},
        ])),
        packedFileName,
    };
}

/**
 * @param {DictionaryImporter} importer
 * @param {ReturnType<typeof createManifest>} manifest
 * @param {import('dictionary-importer').ArchiveFileMap} fileMap
 * @returns {boolean}
 */
function hasUsableArtifactTermSource(importer, manifest, fileMap) {
    return /** @type {(manifest: ReturnType<typeof createManifest>, fileMap: import('dictionary-importer').ArchiveFileMap) => boolean} */ (
        Reflect.get(importer, '_hasUsableArtifactTermSource').bind(importer)
    )(manifest, fileMap);
}

describe('pruned auxiliary artifact admission', () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());

    test('rejects a partial unpacked artifact set when ordinary banks need fallback', () => {
        const manifest = createManifest(['term_bank_1.mbtb', 'term_bank_2.mbtb']);
        const fileMap = createFileMap([
            'term_bank_1.json',
            'term_bank_2.json',
            'term_bank_1.mbtb',
            'tag_bank_1.json',
            'term_meta_bank_1.json',
        ]);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(false);
    });

    test('accepts a complete unpacked artifact set', () => {
        const manifest = createManifest(['term_bank_1.mbtb', 'term_bank_2.mbtb']);
        const fileMap = createFileMap([
            'term_bank_1.json',
            'term_bank_2.json',
            'term_bank_1.mbtb',
            'term_bank_2.mbtb',
        ]);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(true);
    });

    test('rejects a packed artifact whose manifest only partially covers ordinary banks', () => {
        const manifest = createManifest(['term_bank_1.mbtb'], 'terms.bin');
        const fileMap = createFileMap([
            'term_bank_1.json',
            'term_bank_2.json',
            'terms.bin',
            'kanji_bank_1.json',
        ]);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(false);
    });

    test('accepts a packed artifact with complete manifest coverage', () => {
        const manifest = createManifest(['term_bank_1.mbtb', 'term_bank_2.mbtb'], 'terms.bin');
        const fileMap = createFileMap([
            'term_bank_1.json',
            'term_bank_2.json',
            'terms.bin',
        ]);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(true);
    });

    test('accepts an artifact-only archive without ordinary JSON term banks', () => {
        const manifest = createManifest(['term_bank_1.mbtb']);
        const fileMap = createFileMap(['term_bank_1.mbtb']);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(true);
    });

    test('rejects a manifest when none of its artifact payloads are present', () => {
        const manifest = createManifest(['term_bank_1.mbtb']);
        const fileMap = createFileMap(['tag_bank_1.json']);

        expect(hasUsableArtifactTermSource(importer, manifest, fileMap)).toBe(false);
    });
});
