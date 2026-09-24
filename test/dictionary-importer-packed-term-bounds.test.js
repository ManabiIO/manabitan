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

import {describe, expect, test} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js'

const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
const validate = /** @type {(termBanksByArtifact: Map<string, {packedOffset: number, packedLength: number, rows: number|null}>, payloadLength: number, sharedGlossaryPackedOffset: number|null, sharedGlossaryPackedLength: number|null) => void} */ (
    Reflect.get(importer, '_validatePackedTermArtifactRanges').bind(importer)
)

/**
 * @param {Partial<{packedOffset: number, packedLength: number, rows: number|null}>} overrides
 * @returns {Map<string, {packedOffset: number, packedLength: number, rows: number|null}>}
 */
function banks(overrides = {}) {
    return new Map([[
        'term_bank_1.mbtb',
        {packedOffset: 10, packedLength: 20, rows: 100, ...overrides},
    ]])
}

describe('DictionaryImporter packed term artifact validation', () => {
    test('accepts term ranges at both payload boundaries', () => {
        expect(() => validate(
            new Map([
                ['term_bank_1.mbtb', {packedOffset: 0, packedLength: 1, rows: 0}],
                ['term_bank_2.mbtb', {packedOffset: 80, packedLength: 20, rows: null}],
            ]),
            100,
            null,
            null,
        )).not.toThrow()
    })

    test('rejects negative, unsafe, zero-length, overflowing, and truncated term ranges', () => {
        expect(() => validate(banks({packedOffset: -1}), 100, null, null)).toThrow(/out of bounds/)
        expect(() => validate(banks({packedLength: 0}), 100, null, null)).toThrow(/out of bounds/)
        expect(() => validate(banks({packedOffset: Number.MAX_SAFE_INTEGER + 1}), 100, null, null)).toThrow(/out of bounds/)
        expect(() => validate(banks({packedLength: Number.MAX_SAFE_INTEGER + 1}), 100, null, null)).toThrow(/out of bounds/)
        expect(() => validate(banks({packedOffset: 90, packedLength: 20}), 100, null, null)).toThrow(/out of bounds/)
    })

    test('rejects invalid row-count hints before they affect import planning', () => {
        expect(() => validate(banks({rows: -1}), 100, null, null)).toThrow(/row count/)
        expect(() => validate(banks({rows: Number.MAX_SAFE_INTEGER + 1}), 100, null, null)).toThrow(/row count/)
        expect(() => validate(banks({rows: null}), 100, null, null)).not.toThrow()
    })

    test('rejects incomplete and out-of-bounds packed shared-glossary ranges', () => {
        expect(() => validate(banks(), 100, 30, null)).toThrow(/incomplete/)
        expect(() => validate(banks(), 100, null, 20)).toThrow(/incomplete/)
        expect(() => validate(banks(), 100, -1, 20)).toThrow(/out of bounds/)
        expect(() => validate(banks(), 100, 90, 20)).toThrow(/out of bounds/)
        expect(() => validate(banks(), 100, Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(/out of bounds/)
        expect(() => validate(banks(), 100, 80, 20)).not.toThrow()
    })

    test('closes the Uint8Array subarray clamping gap', () => {
        const payload = new Uint8Array(64)
        expect(payload.subarray(32, 96).byteLength).toBe(32)
        expect(() => validate(
            new Map([['term_bank_1.mbtb', {packedOffset: 32, packedLength: 64, rows: 1}]]),
            payload.byteLength,
            null,
            null,
        )).toThrow(/out of bounds/)
    })
})
