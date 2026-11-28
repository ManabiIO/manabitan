/*
 * Copyright (C) 2026  Yomitan Authors
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
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {describe, expect, test, vi} from 'vitest'
import {
    encodePersistedTermLookupIndexFromPreinternedPlan,
    findSequenceRows,
    getPersistedTermSequence,
    parsePersistedTermLookupIndex,
} from '../ext/js/dictionary/term-lookup-index.js'

/**
 * @param {number[]|Int32Array|Float64Array} values
 * @returns {Uint8Array}
 */
function encode(values) {
    const count = values.length
    const plan = {
        stringsBuffer: new Uint8Array([97, 98]),
        stringLengths: new Uint16Array([1, 1]),
        stringOffsets: new Uint32Array([0, 1]),
        expressionIndexes: Uint32Array.from({length: count}, (_, i) => i % 2),
        readingIndexes: Uint32Array.from({length: count}, (_, i) => (i + 1) % 2),
    }
    const equals = Uint8Array.from({length: count}, (_, i) => Number(i % 3 === 0))
    return encodePersistedTermLookupIndexFromPreinternedPlan(plan, equals, values, count)
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

/**
 * Checks persisted sequence lookup against source rows, independently of the
 * interning plan. Comparisons treat signed zero as the same sequence ID; the
 * complete-byte fixtures additionally preserve its original representation.
 * @param {Uint8Array} bytes
 * @param {number[]|Int32Array|Float64Array} values
 */
function checkRows(bytes, values) {
    const index = parsePersistedTermLookupIndex(bytes)
    for (let row = 0; row < values.length; ++row) {
        const expected = values[row] < 0 ? null : values[row]
        expect(getPersistedTermSequence(index, row) === expected).toBe(true)
    }
    for (const sequence of new Set(values)) {
        const expected = [...values.keys()].filter((row) => values[row] === sequence && sequence >= 0).reverse()
        expect(findSequenceRows(index, sequence)).toEqual(expected)
    }
}

describe('JavaScript lookup sequence interning', () => {
    // Full persisted-byte SHA-256 oracles captured from develop
    // 7d1643e6147a10cb2165e9744cf0e63b59e46632 before changing the encoder.
    test.each([
        [[0], 'c8cde16cd6743969fb1a1e22312091d0546ddd6e50d557daf8e373a010f47f1d'],
        [[-1, -2, -2147483648], '1318545affaba208a38b1b5a2f6c8bba6096541494d3926ad8d4251bf3dc3271'],
        [[0, 1, 17, 1000, 2147483647], '090d281bdc3bc59e62045a381c434439aaaf8191c070cfb18e68717359bcfb22'],
        [[0, 0, 1, 1, 1, 2147483647, 2147483647], '9f1bed55c223005f13b7a7aa356b12f6001adc52dd2eb7671086985a8fdc1079'],
        [[-1, 0, -2, 0, 10, -2147483648, 10, 20, -1], '83bb1a4710689ec50f1e00aca15aa8216f543ef753b7caa56f00ef8f140ed265'],
        [[7, 3, 7, 9], '75e533718e7e79e72c069ac0286ffdb5981912bab8840843a32b1eeb5772a939'],
        [[0, 3, 7, 3, 7, 0, 10], '097942bd7d93a26803121c27921dd43a5a82c74e66ba9e1a68daec317849f297'],
        [[2, 4, 8, 6, 10, 4, 6, 0], '83d589eda8e78fdaf66b64a29a6b4e9e6a7f2b26b74e9a37be3b8cb04d241871'],
        [[0, 5, 9, -1, -2147483648, 5, -1, 0, 7], 'fdd65d695502295da53b0a85914cb793689b7545fbb723902fb571c470d72a88'],
        [[2147483647, 10000, 10, 9, 8, 1, 0], '696da3a32299b38537e670d5000c669acc6544081d867f7bc9be999d7f8a1387'],
        [[3, 4, 5, 2, 3, 1, 0, 5, 4, 3, 2, 1, 0], '23c2f2b9eeb5d2c5196421b7e75d685b0749a94a0bfc288014859e198cbc22cc'],
        [[0, 2147483647, 2147483648, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER],
            '4187d676013728bf83bc9c0f4b7884a2122a6c4cdefd2c2f4a2d2b9047e7fb46'],
        [[Number.MAX_SAFE_INTEGER, 4294967296, 4294967295, 2147483648, 2147483647, 0],
            '97431d4431824562d1cf9e05644bb7aaea8af466cba928d1808209359708883f'],
        [[-1, 2147483648, -1, 2147483648, Number.MAX_SAFE_INTEGER, -1, Number.MAX_SAFE_INTEGER],
            '1eeb9a7529ea0e6e38a58407407e24b64087d3e0f740af84f34cec1c3bdf2482'],
        [[0, 2147483648, 4294967296, Number.MAX_SAFE_INTEGER, 2147483648, Number.MAX_SAFE_INTEGER, 0],
            'e6465613bd83ec90732341a4f7664b15fc9d228a6a0bd11ebe416c7aed8f9d24'],
        [[0, 2147483648, 4294967296, Number.MAX_SAFE_INTEGER, 4294967295, 2147483649, Number.MAX_SAFE_INTEGER, 1],
            '25e9518b34246798165759c6f149ea9dfef2736d4cc42a9ff5fb261034d1091c'],
        [[-0, 0, Number.MAX_SAFE_INTEGER, -0, 1, Number.MAX_SAFE_INTEGER],
            '8792d7bf3212e6ad9ee51eaab74c2a097ec5bec2b7e7934f63aaed24aceea90c'],
    ])('preserves baseline bytes and lookup semantics for %j', (values, expectedHash) => {
        const sequences = /** @type {number[]} */ (values)
        const bytes = encode(sequences)
        expect(digest(bytes)).toBe(expectedHash)
        checkRows(bytes, sequences)
        const float64Bytes = encode(Float64Array.from(sequences))
        expect(float64Bytes).toEqual(bytes)
        if (sequences.every((value) => value >= -0x80000000 && value <= 0x7fffffff)) {
            expect(encode(Int32Array.from(sequences))).toEqual(bytes)
        }
    })

    test.each([
        ['ordered', Int32Array.from({length: 30000}, (_, i) => i), 0],
        ['constant', new Int32Array(30000).fill(42), 0],
        ['absent', new Int32Array(30000).fill(-1), 0],
        ['late decrease', Int32Array.from({length: 30000}, (_, i) => (i === 29999 ? 0 : i)), 1],
    ])('allocates a sequence hash table only when needed: %s', (_name, values, count) => {
        const Uint16 = Uint16Array
        let sequenceTableAllocations = 0
        vi.stubGlobal('Uint16Array', new Proxy(Uint16, {
            construct(target, args) {
                if (args.length === 1 && args[0] === 32768) { ++sequenceTableAllocations }
                return Reflect.construct(target, args)
            },
        }))
        try {
            const bytes = encode(/** @type {Int32Array} */ (values))
            expect(sequenceTableAllocations).toBe(count)
            expect(parsePersistedTermLookupIndex(bytes).expressionKeys.length).toBe(30000)
        } finally { vi.unstubAllGlobals() }
    })

    test.each([
        [Int32Array.from({length: 65534}, (_, i) => i), 'c66ccd0ef054828d187ce38efedada431f87884612db537e10ea06b7538e6ff8'],
        [Int32Array.from({length: 65534}, (_, i) => (i === 65533 ? 0 : i + 1)),
            '621f0b582cfad2e3b54985a17b5918f720dcd53a4f384ccdb7a4bb666fe5ec3d'],
        [Int32Array.from({length: 65534}, (_, i) => (i === 65533 ? 0 : i)),
            'fe15dc360e53c26909f226886900fd4e7ddab7043cee0ed60a2cb61a770414b2'],
        [Float64Array.from({length: 65534}, (_, i) => 4294967296 + i),
            '10c73d46132a35c836d17002f1abdeb7caf22b0293febbb29adb4c31887d1ac0'],
    ])('preserves maximum-cardinality bytes (%#)', (values, expectedHash) => {
        const sequences = /** @type {Int32Array|Float64Array} */ (values)
        const bytes = encode(sequences)
        expect(digest(bytes)).toBe(expectedHash)
        const index = parsePersistedTermLookupIndex(bytes)
        const last = sequences[sequences.length - 1]
        expect(findSequenceRows(index, last)).toEqual(
            [...sequences.keys()].filter((row) => sequences[row] === last).reverse(),
        )
    })

    test('preserves source bytes when the input sequences use shared memory', () => {
        const values = new Int32Array(new SharedArrayBuffer(32))
        values.set([0, 10, -1, 10, 20, 5, 0, 2147483647])
        const original = new Int32Array(values)
        expect(encode(values)).toEqual(encode(original))
        expect(values).toEqual(original)
    })

    test.each([Number.NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid sequence %s before and after an order break', (value) => {
        expect(() => encode([0, 5, value])).toThrow('Term lookup sequence must be a safe integer')
        expect(() => encode([5, 0, value])).toThrow('Term lookup sequence must be a safe integer')
    })
})
