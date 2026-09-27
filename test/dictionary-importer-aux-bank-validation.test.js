/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js';

const encoder = new TextEncoder();

/**
 * @param {string} methodName
 * @param {string} filename
 * @param {unknown[]} rows
 * @returns {Promise<unknown[]>}
 */
async function readBank(methodName, filename, rows) {
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
    const convertEntry = /** @type {(entry: import('core').SafeAny, dictionary: string) => unknown} */ (
        Reflect.get(importer, methodName).bind(importer)
    );
    const readFileSequence = /** @type {(files: import('dictionary-importer').ImportFileEntry[], convertEntry: (entry: import('core').SafeAny, dictionary: string) => unknown, dictionary: string) => Promise<unknown[]>} */ (
        Reflect.get(importer, '_readFileSequence').bind(importer)
    );
    const file = /** @type {import('dictionary-importer').ImportFileEntry} */ (/** @type {unknown} */ ({
        filename,
        bytes: encoder.encode(JSON.stringify(rows)),
    }));
    return await readFileSequence([file], convertEntry, 'Validation');
}

describe('DictionaryImporter auxiliary bank runtime validation', () => {
    test('accepts schema-valid term metadata variants', async () => {
        const rows = [
            ['猫', 'freq', 12],
            ['猫', 'freq', '12'],
            ['猫', 'freq', {value: 12, displayValue: '12'}],
            ['猫', 'freq', {reading: 'ねこ', frequency: {value: 12}}],
            ['猫', 'pitch', {
                reading: 'ねこ',
                pitches: [
                    {position: 0},
                    {position: 'HLL', nasal: 1, devoice: [2], tags: ['common']},
                ],
            }],
            ['猫', 'ipa', {
                reading: 'ねこ',
                transcriptions: [{ipa: 'neko'}, {ipa: 'neko', tags: ['standard']}],
            }],
        ];
        await expect(readBank('_convertTermMetaBankEntry', 'term_meta_bank_1.json', rows)).resolves.toHaveLength(rows.length);
    });

    test.each([
        [['猫', 'unknown', 1]],
        [[42, 'freq', 1]],
        [['猫', 'freq']],
        [['猫', 'freq', {value: 1, extra: true}]],
        [['猫', 'freq', {reading: 'ねこ'}]],
        [['猫', 'pitch', {reading: 'ねこ', pitches: [{position: -1}]}]],
        [['猫', 'pitch', {reading: 'ねこ', pitches: [{position: 'HX'}]}]],
        [['猫', 'pitch', {reading: 'ねこ', pitches: [{position: 1, nasal: [-1]}]}]],
        [['猫', 'ipa', {reading: 'ねこ', transcriptions: [{tags: []}]}]],
        [['猫', 'ipa', {reading: 'ねこ', transcriptions: [{ipa: 'neko', extra: 1}]}]],
    ])('rejects malformed term metadata: %j', async (rows) => {
        await expect(readBank('_convertTermMetaBankEntry', 'term_meta_bank_9.json', rows))
            .rejects.toThrow(/term metadata.*term_meta_bank_9\.json/u);
    });

    test('accepts schema-valid kanji metadata frequency forms', async () => {
        const rows = [
            ['猫', 'freq', 7],
            ['猫', 'freq', '7'],
            ['猫', 'freq', {value: 7}],
            ['猫', 'freq', {value: 7, displayValue: 'seven'}],
        ];
        await expect(readBank('_convertKanjiMetaBankEntry', 'kanji_meta_bank_1.json', rows)).resolves.toHaveLength(rows.length);
    });

    test.each([
        [['', 'freq', 1]],
        [['猫', 'pitch', 1]],
        [['猫', 'freq', {displayValue: 'missing value'}]],
        [['猫', 'freq', {value: '7'}]],
        [['猫', 'freq', 1, 'extra']],
    ])('rejects malformed kanji metadata: %j', async (rows) => {
        await expect(readBank('_convertKanjiMetaBankEntry', 'kanji_meta_bank_4.json', rows))
            .rejects.toThrow(/kanji metadata.*kanji_meta_bank_4\.json/u);
    });

    test('accepts legacy v1 trailing meanings and schema-valid v3 kanji rows', async () => {
        await expect(readBank('_convertKanjiBankEntryV1', 'kanji_bank_1.json', [
            ['猫', 'ビョウ', 'ねこ', 'common', 'cat', 'feline'],
        ])).resolves.toEqual([{
            character: '猫',
            onyomi: 'ビョウ',
            kunyomi: 'ねこ',
            tags: 'common',
            meanings: ['cat', 'feline'],
            dictionary: 'Validation',
        }]);
        await expect(readBank('_convertKanjiBankEntryV3', 'kanji_bank_2.json', [
            ['猫', 'ビョウ', 'ねこ', 'common', ['cat'], {grade: '8'}],
        ])).resolves.toHaveLength(1);
    });

    test.each([
        ['_convertKanjiBankEntryV1', [['', '', '', '']]],
        ['_convertKanjiBankEntryV1', [['猫', '', '', '', 42]]],
        ['_convertKanjiBankEntryV3', [['猫', '', '', '', ['cat']]]],
        ['_convertKanjiBankEntryV3', [['猫', '', '', '', ['cat', 42], {}]]],
        ['_convertKanjiBankEntryV3', [['猫', '', '', '', ['cat'], {grade: 8}]]],
        ['_convertKanjiBankEntryV3', [[42, '', '', '', ['cat'], {}]]],
    ])('rejects malformed kanji rows via %s: %j', async (methodName, rows) => {
        await expect(readBank(methodName, 'kanji_bank_7.json', rows))
            .rejects.toThrow(/kanji bank.*kanji_bank_7\.json/u);
    });

    test('accepts valid tag rows without coercion', async () => {
        const rows = [
            ['common', 'frequency', 1.5, 'Common term', 10],
            ['', '', -2, '', -0.5],
        ];
        await expect(readBank('_convertTagBankEntry', 'tag_bank_1.json', rows)).resolves.toHaveLength(rows.length);
    });

    test.each([
        [['name', 'category', 0, 'notes']],
        [['name', 'category', null, 'notes', 0]],
        [['name', 42, 0, 'notes', 0]],
        [['name', 'category', 0, 42, 0]],
        [['name', 'category', 0, 'notes', null]],
        [['name', 'category', 0, 'notes', 0, 'extra']],
    ])('rejects malformed tag rows: %j', async (rows) => {
        await expect(readBank('_convertTagBankEntry', 'tag_bank_3.json', rows))
            .rejects.toThrow(/tag bank.*tag_bank_3\.json/u);
    });
});
