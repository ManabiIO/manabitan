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
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Pass raw tokens through real native validation and non-fused JS projection.
 * The offset input view must not accidentally include its surrounding bytes.
 * @param {string[]} scores
 * @param {string[]} sequences
 * @param {boolean} [splitBanks]
 * @param {number} [chunkSize]
 * @returns {Promise<{scores: number[], sequences: number[]}>}
 */
async function project(scores, sequences, splitBanks = false, chunkSize = 64) {
    const rows = scores.map((score, i) => `["term${i}","","","",${score},[],${sequences[i]},""]`)
    const split = Math.ceil(rows.length / 2)
    const banks = splitBanks ? [rows.slice(0, split), rows.slice(split)] : [rows]
    const sources = banks.map((bank) => {
        const bytes = encoder.encode(`prefix[${bank.join(',')}]suffix`)
        return bytes.subarray(6, -6)
    })
    /** @type {{scores: number[], sequences: number[]}} */
    const result = {scores: [], sequences: []}
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        result.scores.push(...chunk.scoreList)
        result.sequences.push(...chunk.sequenceList)
    }, chunkSize, {
        experimentalSkipFusedParse: true,
        computeContentHashes: true,
        emitTermByteLists: false,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
    })
    return result
}

describe('term-bank numeric projection', () => {
    test.each([
        [false, 1], [false, 64], [true, 1], [true, 64],
    ])('preserves Number semantics across split banks=%s and chunk size=%s', async (splitBanks, chunkSize) => {
        const tokens = [
            '0',
            '-0',
            '1',
            '-1',
            '37',
            '-97',
            '2147483647',
            '2147483648',
            '-2147483649',
            '999999999999999',
            '-999999999999999',
            '1000000000000000',
            '9007199254740991',
            '9007199254740992',
            '9007199254740993',
            '-9007199254740993',
            '9999999999999999',
            '1000000000000000100',
            '0.0',
            '-0.0',
            '1.25',
            '-1.25',
            '1e4',
            '1E+4',
            '-0e10',
            '1.0000000000000001',
            '1e-320',
            '5e-324',
            '2.2250738585072014e-308',
            '1.7976931348623157e308',
            '1e-999',
        ]
        const result = await project(tokens, tokens.map(() => '3'), Boolean(splitBanks), Number(chunkSize))
        expect(result.scores).toEqual(tokens.map(Number))
        expect(result.sequences).toEqual(tokens.map(() => 3))
    })

    test('preserves sequence sentinels and safe integers above int32', async () => {
        const tokens = [
            'null',
            '-1',
            '-0',
            '0',
            '2147483647',
            '2147483648',
            '999999999999999',
            '9007199254740991',
            '1e6',
            '1.0',
            '-2',
        ]
        const result = await project(tokens.map(() => '37'), tokens)
        expect(result.sequences).toEqual(tokens.map((token) => (token === 'null' || Number(token) < 0 ? -1 : Number(token))))
    })

    test.each(['9007199254740992', '9007199254740993', '1.25', '1e309'])('still rejects unsafe sequence %s', async (token) => {
        await expect(project(['37'], [token])).rejects.toThrow()
    })

    test.each(['1e309', '-1e309'])('still rejects non-finite score %s', async (token) => {
        await expect(project([token], ['3'])).rejects.toThrow()
    })

    test('decodes short integer columns without TextDecoder allocation', async () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        try {
            const result = await project(['37', '-97', '0', '-0', '999999999999999'], ['3', '-1', '0', '12', '2147483648'])
            expect(result.scores).toEqual([37, -97, 0, -0, 999999999999999])
            expect(result.sequences).toEqual([3, -1, 0, 12, 2147483648])
            expect(decode).not.toHaveBeenCalled()
        } finally {
            decode.mockRestore()
        }
    })
})
