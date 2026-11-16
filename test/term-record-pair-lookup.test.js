/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js';
import {encodePersistedTermLookupIndex, findExactRows, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js';


/**
 * @param {TermRecordOpfsStore} store
 * @param {string} dictionary
 * @param {string} expression
 * @param {string} reading
 * @returns {number[]}
 */
function findPairs(store, dictionary, expression, reading) {
    return store.findTermPairCandidates(dictionary, expression, [{reading}]).get(reading) ?? [];
}

/**
 * Only the lookup columns are read by these tests; no record file is opened.
 * @param {number} firstId
 * @param {import('../ext/js/dictionary/term-lookup-index.js').PersistedTermLookupIndex} lookupIndex
 * @returns {import('../ext/js/dictionary/term-record-opfs-store.js').PersistentRecordChunk}
 */
function lookupChunk(firstId, lookupIndex) {
    return {
        firstId,
        lookupIndex,
        count: lookupIndex.expressionKeys.length,
        fileName: 'fixture.mbtr',
        dictionaryName: 'Test',
        contentDictName: 'raw',
        contentOffsetBase: 0,
        recordFields: new Uint8Array(),
        recordFieldsFormat: 1,
        compactRecordFields: null,
    };
}

test('pair lookup preserves source-row identity for aliases, duplicates, Unicode and misses', () => {
    const encoder = new TextEncoder();
    const rows = [
        {expression: '橋', reading: 'はし'},
        {expression: '橋', reading: 'きょう'},
        {expression: '箸', reading: 'はし'},
        {expression: '橋', reading: 'はし'},
        {expression: 'ある', reading: null},
        {expression: 'ある', reading: '或る'},
        {expression: 'ある', reading: 'ある'},
        {expression: '𠮷🙂', reading: 'よし🙂'},
        ...Array.from({length: 200}, (_, i) => ({expression: `同音-${i}`, reading: 'はし'})),
    ];
    const lookupIndex = parsePersistedTermLookupIndex(encodePersistedTermLookupIndex(rows.map(({expression, reading}) => ({
        expressionBytes: encoder.encode(expression),
        readingBytes: reading === null ? null : encoder.encode(reading),
        sequence: null,
    }))));
    const store = new TermRecordOpfsStore();
    Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add('Test');
    Reflect.get(store, '_persistentRecordChunksByDictionary').set('Test', [lookupChunk(17, lookupIndex)]);
    for (const expression of ['橋', '箸', 'ある', '𠮷🙂', 'missing', '']) {
        for (const reading of ['はし', 'きょう', 'ある', '或る', 'よし🙂', 'missing', '']) {
            const expected = findExactRows(lookupIndex, encoder.encode(expression), 'expression')
                .filter((row) => (rows[row].reading ?? rows[row].expression) === reading)
                .map((row) => 17 + row);
            expect(findPairs(store, 'Test', expression, reading)).toEqual(expected);
        }
    }
});

test('persistent pair lookup combines chunk IDs and preserves aliased readings', () => {
    const encoder = new TextEncoder();
    const store = new TermRecordOpfsStore();
    const rows = [
        {expression: '橋', reading: 'はし'},
        {expression: '橋', reading: 'きょう'},
        {expression: 'はし', reading: null},
        {expression: 'はし', reading: '別'},
    ];
    const lookupIndex = parsePersistedTermLookupIndex(encodePersistedTermLookupIndex(rows.map(({expression, reading}) => ({
        expressionBytes: encoder.encode(expression),
        readingBytes: reading === null ? null : encoder.encode(reading),
        sequence: null,
    }))));
    Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add('Test');
    Reflect.get(store, '_persistentRecordChunksByDictionary').set('Test', [
        lookupChunk(17, lookupIndex), lookupChunk(100, lookupIndex),
    ]);
    expect(findPairs(store, 'Test', '橋', 'はし')).toEqual([17, 100]);
    expect(findPairs(store, 'Test', '橋', 'きょう')).toEqual([18, 101]);
    expect(findPairs(store, 'Test', 'はし', 'はし')).toEqual([19, 102]);
    expect(findPairs(store, 'Test', '橋', 'missing')).toEqual([]);
    expect(findPairs(store, 'Test', 'missing', 'はし')).toEqual([]);
    const first = store.findTermPairCandidates('Test', '橋', [
        {reading: 'はし'}, {reading: 'きょう'}, {reading: 'はし'}, {reading: 'missing'},
    ]);
    expect(first.get('はし')).toEqual([17, 100]);
    expect(first.get('きょう')).toEqual([18, 101]);
    expect(first.has('missing')).toBe(false);
    first.get('はし')?.push(999);
    expect(findPairs(store, 'Test', '橋', 'はし')).toEqual([17, 100]);
    const encode = vi.spyOn(Reflect.get(store, '_textEncoder'), 'encode');
    expect(store.findTermPairCandidates('Test', 'missing', [{reading: 'はし'}, {reading: 'きょう'}]).size).toBe(0);
    expect(encode.mock.calls).toEqual([['missing']]);
});

test('reading-only expression keys skip requested-reading encoding', () => {
    const encoder = new TextEncoder();
    const lookupIndex = parsePersistedTermLookupIndex(encodePersistedTermLookupIndex([
        {expressionBytes: encoder.encode('漢字'), readingBytes: encoder.encode('よみ'), sequence: null},
    ]));
    const store = new TermRecordOpfsStore();
    Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add('Test');
    Reflect.get(store, '_persistentRecordChunksByDictionary').set('Test', [lookupChunk(1, lookupIndex)]);
    const encode = vi.spyOn(Reflect.get(store, '_textEncoder'), 'encode');

    expect(store.findTermPairCandidates('Test', 'よみ', [{reading: 'not-encoded'}])).toEqual(new Map());
    expect(encode.mock.calls).toEqual([['よみ']]);
    encode.mockClear();
    expect(store.findTermPairCandidates('Test', 'よみ', [])).toEqual(new Map());
    expect(encode).not.toHaveBeenCalled();
});

test('pair candidates preserve distinct strings with byte-equivalent UTF-8 encodings', () => {
    const encoder = new TextEncoder();
    const lookupIndex = parsePersistedTermLookupIndex(encodePersistedTermLookupIndex([
        {expressionBytes: encoder.encode('語'), readingBytes: encoder.encode('\uFFFD'), sequence: null},
    ]));
    const store = new TermRecordOpfsStore();
    Reflect.get(store, '_persistentIndexLoadedDictionaryNames').add('Test');
    Reflect.get(store, '_persistentRecordChunksByDictionary').set('Test', [lookupChunk(1, lookupIndex)]);

    const matches = store.findTermPairCandidates('Test', '語', [{reading: '\uD800'}, {reading: '\uFFFD'}]);
    expect(matches.get('\uD800')).toEqual([1]);
    expect(matches.get('\uFFFD')).toEqual([1]);
});

test('legacy pair candidates retain the established posting intersection and equal-text shortcut', () => {
    const store = new TermRecordOpfsStore();
    vi.spyOn(store, 'getDictionaryIndex').mockReturnValue({
        expression: new Map([['a', [1, 2, 3]]]),
        reading: new Map([['reading', [2, 4]]]),
        expressionReverse: new Map(),
        readingReverse: new Map(),
        sequence: new Map(),
    });
    expect(findPairs(store, 'Legacy', 'a', 'reading')).toEqual([2]);
    expect(findPairs(store, 'Legacy', 'a', 'a')).toEqual([1, 2, 3]);
    expect(findPairs(store, 'Legacy', 'a', 'missing')).toEqual([]);
    expect(findPairs(store, 'Legacy', 'missing', 'reading')).toEqual([]);
});
