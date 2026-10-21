/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {YomitanApi} from '../ext/js/comm/yomitan-api.js';

/**
 * @param {string} dictionary
 * @param {import('dictionary-data').TermGlossaryContent[]} entries
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function entry(dictionary, entries) {
    return /** @type {import('dictionary').TermDictionaryEntry} */ ({
        type: 'term',
        headwords: [{term: '語', reading: 'ご'}],
        definitions: [{dictionary, entries}],
    });
}

for (const dictionary of ['__proto__', 'Images']) {
    test('native API preserves both serializable media records for ' + dictionary, async () => {
        const api = /** @type {YomitanApi} */ (Object.assign(Object.create(YomitanApi.prototype), {_getDictionaryStylesMapDomless: vi.fn(async () => new Map())}));
        const paths = ['first.png', 'second.png'];
        const dictionaryEntry = entry(dictionary, paths.map((path) => ({type: 'image', path, width: 1, height: 1})));
        const options = /** @type {import('settings').ProfileOptions} */ ({general: {resultOutputMode: 'split', glossaryLayoutMode: 'default', compactTags: false}, parsing: {readingMode: 'hiragana'}});
        const mediaDetails = paths.map((path) => ({dictionary, path, ankiFilename: path, content: '', mediaType: 'image/png', width: 1, height: 1}));
        const [result] = await api._createCommonDatas('語', [dictionaryEntry], mediaDetails, [], options, /** @type {Document} */ ({}));
        const records = result.media?.dictionaryMedia;
        expect(records).toBeDefined();
        expect(Object.hasOwn(/** @type {object} */ (records), dictionary)).toBe(true);
        const dictionaryRecords = records?.[dictionary];
        expect(dictionaryRecords).toEqual({'first.png': {value: 'first.png'}, 'second.png': {value: 'second.png'}});
        expect(Object.getPrototypeOf(records)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(dictionaryRecords)).toBe(Object.prototype);
        const serialized = /** @type {Record<string, Record<string, {value: string}>>} */ (JSON.parse(JSON.stringify(records)));
        expect(Object.hasOwn(serialized, dictionary)).toBe(true);
        expect(serialized[dictionary]).toEqual(dictionaryRecords);
    });
}
