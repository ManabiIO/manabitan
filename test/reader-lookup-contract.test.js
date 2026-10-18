/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, test} from 'vitest';
import {exactReaderEntries, parseReaderLookup, readerEntriesWithSurface} from '../ext/js/app/reader-lookup-bridge.js';

/** @type {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} */
const request = {protocol: 1, term: '食べる', reading: 'たべる', surface: '食べた', sentence: '私は食べた。', offset: 2};

/**
 * Deliberately incomplete entries exercise rejection of malformed mixed groups.
 * @param {object} value
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function malformedEntry(value) {
    return /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ (value));
}

describe('Reader lookup protocol', () => {
    test('validates original surface sentence offsets', () => {
        expect(parseReaderLookup(JSON.stringify(request))).not.toBeNull();
        expect(parseReaderLookup(JSON.stringify({...request, offset: 0}))).toBeNull();
        for (const bad of [{term: ''}, {entryID: 12}, {entryID: '-1'}, {namespace: 'rowid'}, {namespace: null}, {namespace: 1}, {namespace: {}}, {surface: '食べる'}]) {
            expect(parseReaderLookup(JSON.stringify({...request, ...bad}))).toBeNull();
        }
    });

    test('refuses unrelated or malformed mixed-headword mining results', () => {
        const right = malformedEntry({headwords: [{term: '食べる', reading: 'たべる'}]});
        const wrong = malformedEntry({headwords: [{term: '食べる', reading: 'くう'}]});
        const mixed = malformedEntry({headwords: [...right.headwords, {term: '喰う', reading: 'くう'}]});
        expect(exactReaderEntries([right, wrong, mixed], request)).toStrictEqual([right]);
    });

    test('uses the inflected mining span without mutating cached entries', () => {
        const inflected = {...request, surface: '食べさせられた', sentence: '私は食べさせられた。'};
        const input = [malformedEntry({
            maxOriginalTextLength: 3,
            headwords: [{term: '食べる', reading: 'たべる', sources: [{isPrimary: true, originalText: '食べる', deinflectedText: '食べる'}]}],
        })];
        const output = readerEntriesWithSurface(input, inflected);
        expect(output[0].maxOriginalTextLength).toBe(inflected.surface.length);
        expect(output[0].headwords[0].sources[0].originalText).toBe(inflected.surface);
        expect(input[0].headwords[0].sources[0].originalText).toBe('食べる');
        expect(output[0].headwords[0].sources[0].deinflectedText).toBe('食べる');
    });
});
