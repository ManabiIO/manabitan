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
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

describe('DictionaryImporter artifact manifest row counts', () => {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), () => {});

    test.each([
        -1,
        -100,
        Number.MAX_SAFE_INTEGER + 1,
        Number.POSITIVE_INFINITY,
        1.5,
        '250000',
        null,
        void 0,
    ])('treats invalid row count %s as unknown', (rows) => {
        expect(importer._getArtifactTermBankRowCount(rows)).toBeNull();
    });

    test.each([
        0,
        1,
        250000,
        Number.MAX_SAFE_INTEGER,
    ])('preserves safe non-negative row count %s', (rows) => {
        expect(importer._getArtifactTermBankRowCount(rows)).toBe(rows);
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
