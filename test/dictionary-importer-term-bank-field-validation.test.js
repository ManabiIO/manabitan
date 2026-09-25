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

const importer = /** @type {DictionaryImporter} */ (Object.create(DictionaryImporter.prototype));
const convertV1 = /** @type {(entry: import('dictionary-data').TermV1, dictionary: string) => import('dictionary-database').DatabaseTermEntry} */ (
    Reflect.get(importer, '_convertTermBankEntryV1').bind(importer)
);
const convertV3 = /** @type {(entry: import('dictionary-data').TermV3, dictionary: string) => import('dictionary-database').DatabaseTermEntry} */ (
    Reflect.get(importer, '_convertTermBankEntryV3').bind(importer)
);

/**
 * @param {unknown} value
 * @returns {import('dictionary-data').TermV1}
 */
const asV1 = (value) => /** @type {import('dictionary-data').TermV1} */ (value);

/**
 * @param {unknown} value
 * @returns {import('dictionary-data').TermV3}
 */
const asV3 = (value) => /** @type {import('dictionary-data').TermV3} */ (value);

describe('slow term-bank row validation', () => {
    test.each([
        [123, '', '', '', 0],
        ['x', 123, '', '', 0],
        ['x', '', 123, '', 0],
        ['x', '', '', 123, 0],
        ['x', '', '', '', '0'],
        ['x', '', '', '', 0, 123],
    ])('rejects malformed version 1 row %#', (...entry) => {
        expect(() => convertV1(asV1(entry), 'test')).toThrow(TypeError);
    });

    test.each([
        [123, '', '', '', 0, ['x'], 1, ''],
        ['x', 123, '', '', 0, ['x'], 1, ''],
        ['x', '', 123, '', 0, ['x'], 1, ''],
        ['x', '', '', 123, 0, ['x'], 1, ''],
        ['x', '', '', '', '0', ['x'], 1, ''],
        ['x', '', '', '', 0, 'x', 1, ''],
        ['x', '', '', '', 0, ['x'], 1.5, ''],
        ['x', '', '', '', 0, ['x'], 1, 123],
        ['x', '', '', '', 0, ['x'], 1],
        ['x', '', '', '', 0, ['x'], 1, '', 'extra'],
    ])('rejects malformed version 3 row %#', (...entry) => {
        expect(() => convertV3(asV3(entry), 'test')).toThrow(TypeError);
    });

    test('preserves supported nullable fields and version 1 glossary strings', () => {
        expect(convertV1(asV1(['x', '', null, '', 0, 'one', 'two']), 'test')).toMatchObject({
            expression: 'x',
            reading: 'x',
            definitionTags: null,
            glossary: ['one', 'two'],
        });
        expect(convertV3(asV3(['x', '', null, '', 0, ['one'], null, '']), 'test')).toMatchObject({
            expression: 'x',
            reading: 'x',
            definitionTags: null,
            glossary: ['one'],
            sequence: null,
        });
    });
});
