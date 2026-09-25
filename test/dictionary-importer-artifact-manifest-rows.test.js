/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * @param {unknown} rows
 */
async function readManifestRows(rows) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), () => {});
    vi.spyOn(importer, '_getData').mockResolvedValue(JSON.stringify({
        termBanks: [{
            artifact: 'term_bank_1.mbtb',
            packedOffset: 0,
            packedLength: 16,
            rows,
        }],
    }));
    const fileMap = new Map([
        ['term_bank_artifact_manifest.json', /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({}))],
    ]);
    const manifest = await importer._readTermArtifactManifest(fileMap);
    return manifest?.termBanksByArtifact.get('term_bank_1.mbtb')?.rows;
}

describe('DictionaryImporter artifact manifest row counts', () => {
    test.each([
        -1,
        -100,
        Number.MAX_SAFE_INTEGER + 1,
        Number.POSITIVE_INFINITY,
        1.5,
        '250000',
    ])('treats invalid row count %s as unknown', async (rows) => {
        await expect(readManifestRows(rows)).resolves.toBeNull();
    });

    test.each([
        0,
        1,
        250000,
        Number.MAX_SAFE_INTEGER,
    ])('preserves safe non-negative row count %s', async (rows) => {
        await expect(readManifestRows(rows)).resolves.toBe(rows);
    });
});


describe('DictionaryImporter artifact record byte estimate', () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), () => {});
    const maxSafeRows = Math.floor(Number.MAX_SAFE_INTEGER / 128);

    test.each([
        null,
        0,
        -1,
        Number.MAX_SAFE_INTEGER,
        maxSafeRows + 1,
    ])('rejects unsafe or unusable row estimate %s', (rows) => {
        expect(importer._getExpectedTermRecordImportBytes(rows)).toBeNull();
    });

    test.each([
        [1, 128],
        [250000, 32000000],
        [maxSafeRows, maxSafeRows * 128],
    ])('returns a safe byte estimate for %s rows', (rows, expectedBytes) => {
        expect(importer._getExpectedTermRecordImportBytes(rows)).toBe(expectedBytes);
        expect(Number.isSafeInteger(expectedBytes)).toBe(true);
    });
});
