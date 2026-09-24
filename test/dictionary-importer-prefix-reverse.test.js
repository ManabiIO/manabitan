/*
 * Copyright (C) 2026 Manabitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js';

/** @returns {(value: string) => string} */
function createReverse() {
    const importer = /** @type {DictionaryImporter} */ (Object.create(DictionaryImporter.prototype));
    Reflect.set(importer, '_cacheReverseStrings', false);
    Reflect.set(importer, '_fastPrefixReverse', true);
    return /** @type {(value: string) => string} */ (Reflect.get(importer, '_reverseString')).bind(importer);
}

/**
 * Reverse by ECMAScript code point iteration. Valid surrogate pairs remain
 * paired while lone surrogates retain the established code-unit semantics.
 * @param {string} value
 * @returns {string}
 */
function referenceReverse(value) {
    return Array.from(value).reverse().join('');
}

describe('fast import prefix reversal', () => {
    const reverse = createReverse();

    test.each([
        '',
        'a',
        'abc',
        '日本語',
        'ありがとうございます',
        '猫🐈',
        '😀テスト',
        '𠮷野家',
        'a🧑‍💻b',
        '\ud800',
        '\udc00',
        '\ud800\ud800\udc00',
        '\udc00\ud800',
        '\udc00\udc00\ud800',
    ])('matches code-point reversal for %j', (value) => {
        expect(reverse(value)).toBe(referenceReverse(value));
    });

    test('matches the reference across surrogate edge combinations', () => {
        const atoms = ['a', '日', '\ud800', '\ud801', '\udc00', '\udc01', '😀', '𠮷'];
        for (const a of atoms) {
            for (const b of atoms) {
                for (const c of atoms) {
                    const value = a + b + c;
                    expect(reverse(value)).toBe(referenceReverse(value));
                }
            }
        }
    });

    test('handles long BMP and supplementary strings without changing output', () => {
        const bmp = '日本語abc'.repeat(512);
        const supplementary = ('日本😀語𠮷abc').repeat(256);
        expect(reverse(bmp)).toBe(referenceReverse(bmp));
        expect(reverse(supplementary)).toBe(referenceReverse(supplementary));
    });
});
