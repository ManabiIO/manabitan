/* SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, test} from 'vitest';
import {
    encodePersistedTermLookupIndex,
    findExactRows,
    findPrefixRows,
    findPrefixRowMatches,
    findSequenceRows,
    parsePersistedTermLookupIndex,
    warmPersistedTermPrefixIndex,
} from '../ext/js/dictionary/term-lookup-index.js';

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {boolean} reverse
 * @returns {number}
 */
function compare(a, b, reverse) {
    const count = Math.min(a.length, b.length);
    for (let i = 0; i < count; ++i) {
        const x = a[reverse ? a.length - 1 - i : i];
        const y = b[reverse ? b.length - 1 - i : i];
        if (x !== y) { return x - y; }
    }
    return a.length - b.length;
}

/**
 * @param {Uint8Array[]} keys
 * @throws {Error} If transient order construction did not complete.
 */
function checkKeys(keys) {
    const rows = keys.map((expressionBytes, i) => ({
        expressionBytes,
        readingBytes: i % 3 === 0 ? null : keys[(i + 1) % keys.length],
        sequence: i % 7,
    }));
    const encoded = encodePersistedTermLookupIndex(rows);
    const before = encoded.slice();
    const index = parsePersistedTermLookupIndex(encoded);
    /** @type {Array<'expression'|'reading'>} */
    const fields = ['expression', 'reading'];
    const queries = [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(255)];
    for (const key of [keys[0], keys[keys.length >> 1], keys[keys.length - 1]]) {
        queries.push(key, key.subarray(0, Math.max(1, key.length >> 1)), key.subarray(key.length >> 1));
    }
    for (const reverse of [false, true]) {
        if (reverse) {
            findPrefixRows(index, Uint8Array.of(255), 'expression', true);
        } else {
            warmPersistedTermPrefixIndex(index);
        }
        const order = reverse ? index.keyReverseOrder : index.keyOrder;
        if (order === null) { throw new Error('Transient lookup order is missing'); }
        const expectedOrder = Array.from({length: index.keyOffsets.length - 1}, (_, i) => i);
        expectedOrder.sort((a, b) => compare(
            index.keyBytes.subarray(index.keyOffsets[a], index.keyOffsets[a + 1]),
            index.keyBytes.subarray(index.keyOffsets[b], index.keyOffsets[b + 1]),
            reverse,
        ));
        expect(Array.from(order)).toEqual(expectedOrder);
        for (const query of queries) {
            for (const field of fields) {
                const expected = rows.flatMap((row, i) => {
                    const key = field === 'expression' ? row.expressionBytes : row.readingBytes;
                    if (key === null || query.length === 0 || key.length < query.length) { return []; }
                    const start = reverse ? key.length - query.length : 0;
                    return compare(key.subarray(start, start + query.length), query, false) === 0 ? [{row: i, exact: key.length === query.length}] : [];
                });
                expect(findPrefixRows(index, query, field, reverse).sort((a, b) => a.row - b.row)).toEqual(expected);
                expect(findPrefixRowMatches(index, query, reverse)[field].sort((a, b) => a.row - b.row)).toEqual(expected);
                const exact = rows.flatMap((row, i) => {
                    const key = field === 'expression' ? row.expressionBytes : row.readingBytes;
                    return key !== null && compare(key, query, false) === 0 ? [i] : [];
                });
                expect(findExactRows(index, query, field).sort((a, b) => a - b)).toEqual(exact);
            }
        }
        expect(reverse ? index.keyReverseOrder : index.keyOrder).toBe(order);
    }
    for (let sequence = 0; sequence < 8; ++sequence) {
        expect(findSequenceRows(index, sequence).sort((a, b) => a - b)).toEqual(rows.flatMap((row, i) => row.sequence === sequence ? [i] : []));
    }
    expect(encoded).toEqual(before);
}

for (const count of [1, 2, 15, 16, 17, 31, 32, 33, 255, 256, 257]) {
    test(`transient byte ordering and postings at ${count} keys`, () => {
        checkKeys(Array.from({length: count}, (_, i) => Uint8Array.of(i % 3 === 0 ? 0 : 255, i >>> 8, i & 255, (i * 73) & 255)));
    });
}

for (const reverse of [false, true]) {
    test(`long common ${reverse ? 'suffix' : 'prefix'} with a cutoff boundary`, () => {
        checkKeys(Array.from({length: 17}, (_, i) => {
            const key = new Uint8Array(1027).fill(97);
            key.set(Uint8Array.of(i, 0, 255), reverse ? 0 : 1024);
            return key;
        }));
    });
    test(`maximum-length keys with ${reverse ? 'leading' : 'trailing'} differences`, () => {
        const first = new Uint8Array(65535).fill(97);
        const second = first.slice();
        second[reverse ? 0 : second.length - 1] = 98;
        checkKeys([first, second]);
    });
}

test('Unicode and variable-length prefix relationships retain byte order', () => {
    const encoder = new TextEncoder();
    checkKeys(['a', 'ab', 'abc', '猫', 'ねこ', '食べる', '食べ物', '𠮷野家', '🐈', '\uFEFF猫', '\u0000猫', 'café', 'e\u0301', 'é'].map((value) => encoder.encode(value)));
});
