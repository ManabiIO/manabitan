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

const importer = new DictionaryImporter(new DictionaryImporterMediaLoader(), () => {});

/**
 * @param {Map<string, {packedOffset: number, packedLength: number, rows: number|null}>} termBanksByArtifact
 * @returns {NonNullable<Awaited<ReturnType<DictionaryImporter['_readTermArtifactManifest']>>>}
 */
function manifest(termBanksByArtifact) {
    return {
        termBanksByArtifact,
        packedFileName: null,
        packedMediaFileName: null,
        packedMediaEntries: [],
        packedMediaEntriesComplete: true,
        sharedGlossaryFileName: null,
        sharedGlossaryPackedOffset: null,
        sharedGlossaryPackedLength: null,
        sharedGlossaryCompression: null,
        sharedGlossaryUncompressedLength: null,
        termContentMode: null,
        prunedAuxFiles: false,
        includesMediaFiles: false,
    };
}

describe('DictionaryImporter expected term-content byte estimate', () => {
    test('sums ordinary manifest spans exactly', () => {
        const value = importer._estimateExpectedTermContentImportBytes(
            null,
            null,
            manifest(new Map([
                ['a.mbtb', {packedOffset: 0, packedLength: 10, rows: null}],
                ['b.mbtb', {packedOffset: 10, packedLength: 20, rows: null}],
            ])),
            null,
            [],
        );
        expect(value).toBe(30);
    });

    test('rejects aggregate manifest overflow', () => {
        const value = importer._estimateExpectedTermContentImportBytes(
            null,
            null,
            manifest(new Map([
                ['a.mbtb', {packedOffset: 0, packedLength: Number.MAX_SAFE_INTEGER, rows: null}],
                ['b.mbtb', {packedOffset: 0, packedLength: 1, rows: null}],
            ])),
            null,
            [],
        );
        expect(value).toBeNull();
    });

    test.each([
        Number.MAX_SAFE_INTEGER + 1,
        -1,
        Number.POSITIVE_INFINITY,
        1.5,
    ])('rejects invalid manifest packed length %s', (packedLength) => {
        const value = importer._estimateExpectedTermContentImportBytes(
            null,
            null,
            manifest(new Map([
                ['a.mbtb', {packedOffset: 0, packedLength, rows: null}],
            ])),
            null,
            [],
        );
        expect(value).toBeNull();
    });

    test.each([
        Number.MAX_SAFE_INTEGER + 1,
        -1,
        Number.POSITIVE_INFINITY,
        1.5,
    ])('rejects invalid source-file size estimate %s', (uncompressedSize) => {
        const value = importer._estimateExpectedTermContentImportBytes(
            null,
            null,
            null,
            null,
            [
                /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({
                    filename: 'term_bank_1.mbtb',
                    uncompressedSize,
                })),
            ],
        );
        expect(value).toBeNull();
    });

    test('includes an external shared glossary when term bytes are not already packed', () => {
        const value = importer._estimateExpectedTermContentImportBytes(
            null,
            new Uint8Array(7),
            null,
            new Map([['term_bank_1.mbtb', new Uint8Array(5)]]),
            [],
        );
        expect(value).toBe(12);
    });

    test('packed artifact bytes already include the packed shared glossary', () => {
        const value = importer._estimateExpectedTermContentImportBytes(
            new Uint8Array(13),
            new Uint8Array(7),
            null,
            null,
            [],
        );
        expect(value).toBe(13);
    });

    test('returns null for an empty estimate', () => {
        expect(importer._estimateExpectedTermContentImportBytes(null, null, null, null, [])).toBeNull();
    });
});
