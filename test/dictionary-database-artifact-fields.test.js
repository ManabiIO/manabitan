/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js';

const encoder = new TextEncoder();
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Exercise the public, hashless artifact fallback without depending on OPFS.
 * @param {Uint8Array} expressionBytes
 * @param {Uint8Array} readingBytes
 * @param {boolean} [sameReading]
 * @returns {Promise<import('dictionary-database').DatabaseTermEntry>}
 */
async function materialize(expressionBytes, readingBytes, sameReading = false) {
    const database = new DictionaryDatabase();
    /** @type {import('dictionary-database').DatabaseTermEntry[]} */
    let result = [];
    Reflect.set(database, '_enableTermEntryContentDedup', true);
    Reflect.set(database, '_bulkAddTerms', async (/** @type {typeof result} */ rows) => { result = rows; });
    await database.bulkAddArtifactTermsChunk({
        dictionary: 'Artifact field regression',
        rowCount: 1,
        expressionBytesList: [expressionBytes],
        readingBytesList: [readingBytes],
        readingEqualsExpressionList: [sameReading],
        scoreList: [1],
        sequenceList: [42],
        contentBytesList: [encoder.encode('{}')],
        contentDictNameList: null,
    });
    expect(result).toHaveLength(1);
    return result[0];
}

describe('hashless artifact term-field decoding', () => {
    test.each([
        ['\ufeff語', '\ufeffご'],
        ['\ufeff\ufeff語', '\ufeff\ufeffご'],
        ['語\ufeff', 'ご\ufeff'],
        ['語', 'ご'],
        ['𠮷野', 'よしの'],
        ['', ''],
    ])('preserves expression %j and reading %j', async (expression, reading) => {
        const expressionBytes = encoder.encode(expression);
        const readingBytes = encoder.encode(reading);
        const row = await materialize(expressionBytes, readingBytes);
        expect(row.expression).toBe(expression);
        expect(row.reading).toBe(reading);
        expect(row.expressionBytes).toBe(expressionBytes);
        expect(row.readingBytes).toBe(readingBytes);
        expect(row.score).toBe(1);
        expect(row.sequence).toBe(42);
    });

    test('preserves BOM data when reading shares the expression', async () => {
        const row = await materialize(encoder.encode('\ufeff語'), encoder.encode('unused'), true);
        expect(row.expression).toBe('\ufeff語');
        expect(row.reading).toBe('\ufeff語');
        expect(row.readingBytes).toBeUndefined();
    });

    test.each([false, true])('decodes bounded views with shared storage %s', async (shared) => {
        const expression = encoder.encode('\ufeff語');
        const reading = encoder.encode('\ufeffご');
        const buffer = shared ? new SharedArrayBuffer(128) : new ArrayBuffer(128);
        const arena = new Uint8Array(buffer);
        arena.fill(0x78);
        arena.set(expression, 7);
        arena.set(reading, 61);
        const before = [...arena];
        const expressionBytes = arena.subarray(7, 7 + expression.length);
        const readingBytes = arena.subarray(61, 61 + reading.length);
        const originalDecode = TextDecoder.prototype.decode;
        /** @type {ArrayBufferView[]} */
        const inputs = [];
        /**
         * @this {TextDecoder}
         * @param {Parameters<TextDecoder['decode']>[0]} input
         * @param {TextDecodeOptions|undefined} options
         * @returns {string}
         */
        function decode(input, options) {
            if (ArrayBuffer.isView(input)) {
                // Chromium rejects shared views even though Node accepts them.
                if (!(input.buffer instanceof ArrayBuffer)) { throw new TypeError('Shared view not accepted'); }
                inputs.push(input);
            }
            return originalDecode.call(this, input, options);
        }
        vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(decode);
        const row = await materialize(expressionBytes, readingBytes);
        expect(row.expression).toBe('\ufeff語');
        expect(row.reading).toBe('\ufeffご');
        expect([...arena]).toEqual(before);
        expect(inputs).toHaveLength(2);
        expect(inputs.map(({byteLength}) => byteLength)).toEqual([expression.length, reading.length]);
        expect(inputs[0] === expressionBytes).toBe(!shared);
        expect(inputs[1] === readingBytes).toBe(!shared);
    });
});
