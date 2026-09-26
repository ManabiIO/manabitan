/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

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

describe('DictionaryImporter artifact media manifest completeness', () => {
    test('marks the packed media source incomplete when any descriptor is malformed', async () => {
        const manifest = await readManifest({
            includesMediaFiles: true,
            mediaArtifact: {
                file: 'media.bin',
                entries: [
                    {path: 'ok.png', packedOffset: 0, packedLength: 4, mediaType: 'image/png'},
                    {path: 'bad.png', packedOffset: -1, packedLength: 4, mediaType: 'image/png'},
                    null,
                ],
            },
        });

        expect(manifest.packedMediaEntriesComplete).toBe(false);
        expect(manifest.packedMediaEntries.map((/** @type {{path: string}} */ {path}) => path)).toEqual(['ok.png']);
    });

    test.each([
        {entries: []},
        {entries: [{path: 'a.png', packedOffset: 0, packedLength: 4, mediaType: 'image/png'}]},
        {},
    ])('keeps a well-formed or absent descriptor list complete: $entries', async (mediaArtifact) => {
        const manifest = await readManifest({includesMediaFiles: true, mediaArtifact});
        expect(manifest.packedMediaEntriesComplete).toBe(true);
    });

    test('treats a non-array descriptor list as incomplete', async () => {
        const manifest = await readManifest({
            includesMediaFiles: true,
            mediaArtifact: {file: 'media.bin', entries: {}},
        });
        expect(manifest.packedMediaEntriesComplete).toBe(false);
        expect(manifest.packedMediaEntries).toEqual([]);
    });

    test.each([
        {uncompressedLength: null},
        {uncompressedLength: '4'},
        {uncompressedLength: 1.5},
        {uncompressedLength: Number.MAX_SAFE_INTEGER + 1},
        {compressionMethod: null},
        {compressionMethod: '0'},
        {compressionMethod: 0.5},
    ])('does not default explicitly malformed media metadata: %j', async (metadata) => {
        const manifest = await readManifest({
            mediaArtifact: {
                file: 'media.bin',
                entries: [{path: 'bad.png', packedOffset: 0, packedLength: 4, mediaType: 'image/png', ...metadata}],
            },
        });
        expect(manifest.packedMediaEntriesComplete).toBe(false);
        expect(manifest.packedMediaEntries).toEqual([]);
    });

    test('falls back to ordinary archive media instead of using an incomplete packed source', async () => {
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const packedReadFailure = new Error('packed media should not be read');
        const ordinaryMediaFailure = new Error('ordinary media fallback selected');
        const manifest = {
            termBanksByArtifact: new Map(),
            packedFileName: null,
            packedMediaFileName: 'media.bin',
            packedMediaEntries: [
                {
                    path: 'ok.png',
                    packedOffset: 0,
                    packedLength: 4,
                    mediaType: 'image/png',
                    compressionMethod: 0,
                    uncompressedLength: 4,
                },
            ],
            packedMediaEntriesComplete: false,
            sharedGlossaryFileName: null,
            sharedGlossaryPackedOffset: null,
            sharedGlossaryPackedLength: null,
            sharedGlossaryCompression: null,
            sharedGlossaryUncompressedLength: null,
            termContentMode: null,
            prunedAuxFiles: false,
            includesMediaFiles: true,
        };
        const fileMap = new Map([
            [MANIFEST_FILE, {filename: MANIFEST_FILE}],
            ['term_bank_1.mbtb', {filename: 'term_bank_1.mbtb'}],
            ['media.bin', {filename: 'media.bin'}],
            ['fallback.png', {filename: 'fallback.png'}],
        ]);
        Reflect.set(importer, '_getFilesFromArchive', vi.fn(async () => ({
            fileMap,
            zipReader: {close: async () => {}},
        })));
        Reflect.set(importer, '_readAndValidateIndex', vi.fn(async () => ({
            title: 'Incomplete media manifest',
            version: 3,
            revision: '1',
        })));
        Reflect.set(importer, '_readTermArtifactManifest', vi.fn(async () => manifest));
        const getData = vi.fn(async (entry) => {
            const filename = /** @type {{filename?: unknown}} */ (entry).filename;
            if (filename === 'media.bin') { throw packedReadFailure; }
            if (filename === 'fallback.png') { throw ordinaryMediaFailure; }
            return new Uint8Array(0);
        });
        Reflect.set(importer, '_getData', getData);

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

        const outcome = await importer.importDictionary(
            database,
            new ArrayBuffer(0),
            /** @type {import('dictionary-importer').ImportDetails} */ ({}),
        ).then(
            (result) => ({result, error: null}),
            (error) => ({result: null, error}),
        );

        expect(outcome.error).toBeNull();
        expect(outcome.result?.result).toBeNull();
        const readFileNames = getData.mock.calls.map(([entry]) => /** @type {{filename?: unknown}} */ (entry).filename);
        expect(readFileNames).toContain('fallback.png');
        expect(readFileNames).not.toContain('media.bin');
    });
});
