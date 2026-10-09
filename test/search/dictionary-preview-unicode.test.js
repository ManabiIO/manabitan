/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {dictionaryPreview} from '../../ext/js/search/dictionary-preview.js';

/**
 * @param {string} term
 * @param {string} reading
 * @param {string} dictionary
 * @param {string} tag
 * @returns {import('dictionary').TermDictionaryEntry[]}
 */
function entries(term, reading, dictionary, tag) {
    return /** @type {import('dictionary').TermDictionaryEntry[]} */ (/** @type {unknown} */ ([{
        headwords: [{term, reading, headwordIndex: 0}],
        definitions: [{
            id: 1,
            dictionary,
            headwordIndices: [],
            entries: ['Japanese dictionary gloss'],
            tags: [{name: tag}],
        }],
    }]));
}

describe('dictionary search preview Unicode clipping', () => {
    test('a supplementary character split by display limits is omitted, not corrupted', () => {
        const term = 'a'.repeat(255) + '𠮷';
        const reading = 'b'.repeat(255) + '𠮷';
        const dictionary = 'c'.repeat(255) + '𠮷';
        const tag = 'd'.repeat(39) + '𠮷';
        const {items, hasMore} = dictionaryPreview(entries(term, reading, dictionary, tag));
        expect(hasMore).toBe(false);
        expect(items).toHaveLength(1);
        expect(items[0].term).toBe('a'.repeat(255));
        expect(items[0].reading).toBe('b'.repeat(255));
        expect(items[0].senses[0].source).toBe('c'.repeat(255));
        expect(items[0].senses[0].tags).toEqual(['d'.repeat(39)]);
        const [, idDictionary, , idTerm, idReading] = JSON.parse(items[0].id);
        expect([idDictionary, idTerm, idReading]).toEqual(['c'.repeat(255), 'a'.repeat(255), 'b'.repeat(255)]);
    });

    test('a complete supplementary character ending at the limit is preserved', () => {
        const term = 'a'.repeat(254) + '𠮷';
        const reading = 'b'.repeat(254) + '𠮷';
        const dictionary = 'c'.repeat(254) + '𠮷';
        const tag = 'd'.repeat(38) + '𠮷';
        const {items} = dictionaryPreview(entries(term, reading, dictionary, tag));
        expect(items[0].term).toBe(term);
        expect(items[0].reading).toBe(reading);
        expect(items[0].senses[0].source).toBe(dictionary);
        expect(items[0].senses[0].tags).toEqual([tag]);
        const [, idDictionary, , idTerm, idReading] = JSON.parse(items[0].id);
        expect([idDictionary, idTerm, idReading]).toEqual([dictionary, term, reading]);
    });

    test('ordinary short preview content and stable identity are unchanged', () => {
        const {items} = dictionaryPreview(entries('猫', 'ねこ', 'Jitendex', 'noun'));
        expect(items[0].term).toBe('猫');
        expect(items[0].reading).toBe('ねこ');
        expect(items[0].senses[0]).toEqual({source: 'Jitendex', text: 'Japanese dictionary gloss', tags: ['noun']});
        expect(JSON.parse(items[0].id)).toEqual([0, 'Jitendex', 1, '猫', 'ねこ']);
    });
});
