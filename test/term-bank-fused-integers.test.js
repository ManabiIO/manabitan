/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {string} score
 * @param {string|null} [sequence]
 * @param {string} [key]
 * @returns {string}
 */
function row(score, sequence = '1', key = 'word') {
    const ending = sequence === null ? '' : `,${sequence},""`
    return `["${key}","reading","tag","",${score},["definition"]${ending}]`
}

/**
 * @param {string[]} banks
 * @param {boolean} [fused]
 * @param {boolean} [validateGlossaryTypes]
 * @returns {Promise<{scores: number[], sequences: number[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function project(banks, fused = true, validateGlossaryTypes = false) {
    /** @type {number[]} */
    const scores = []
    /** @type {number[]} */
    const sequences = []
    await parseTermBankWithWasmColumnChunks(banks.map((bank) => encoder.encode(bank)), 3, (chunk) => {
        scores.push(...chunk.scoreList)
        sequences.push(...chunk.sequenceList)
    }, 64, {
        experimentalSkipFusedParse: !fused,
        experimentalFusedSingleBank: fused,
        singleChunk: true,
        emitTermByteLists: false,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        computeContentHashes: true,
        validateGlossaryTypes,
    })
    return {scores, sequences, profile: consumeLastTermBankWasmParseProfile()}
}

describe('fused integer projection during row validation', () => {
    test.each(['', ' ', '\t\r\n'])('preserves int32 values and numeric boundaries with whitespace %j', async (whitespace) => {
        const tokens = ['-2147483648', '-2147483647', '-214748364', '-10', '-1', '0', '1', '9', '10', '214748364', '2147483646', '2147483647']
        const rows = tokens.map((token, i) => row(`${whitespace}${token}${whitespace}`, `${whitespace}${i % 2 === 0 ? '2147483647' : '0'}${whitespace}`, `word${i}`))
        const banks = [`[${rows.slice(0, 5).join(',')}]`, '[]', `[${rows.slice(5).join(',')}]`]
        const actual = await project(banks, true, true)
        const oracle = await project(banks, false, true)
        expect(actual.scores).toStrictEqual(tokens.map(Number))
        expect(actual.scores).toStrictEqual(oracle.scores)
        expect(actual.sequences).toStrictEqual(oracle.sequences)
        expect(actual.profile?.fusedParseAttempts).toBe(1)
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
    })

    test.each([
        '-0',
        '-0.0',
        '-0e0',
        '1.0',
        '1e0',
        '1E+4',
        '1.25',
        '2147483648',
        '-2147483649',
        '9007199254740993',
        '1.7976931348623157e308',
        '5e-324',
    ])('retains number-preserving score fallback for %s', async (token) => {
        const banks = [`[${row('3', '1', 'first')},${row(token, '2', 'middle')},${row('-7', '3', 'last')}]`]
        const actual = await project(banks)
        expect(actual.scores).toStrictEqual([3, Number(token), -7])
        expect(actual.sequences).toStrictEqual([1, 2, 3])
        expect(actual.profile?.fusedParseFallbacks).toBe(1)
        expect(actual.profile?.discardedFusedRows).toBe(1)
        expect(actual.scores).toStrictEqual((await project(banks, false)).scores)
    })

    test.each(['2147483648', '9007199254740991', '1.0', '1e0'])('retains safe-integer sequence fallback for %s', async (token) => {
        const banks = [`[${row('3', '1', 'first')},${row('4', token, 'middle')},${row('5', '3', 'last')}]`]
        const actual = await project(banks)
        expect(actual.scores).toStrictEqual([3, 4, 5])
        expect(actual.sequences).toStrictEqual([1, Number(token), 3])
        expect(actual.profile?.fusedParseFallbacks).toBe(1)
        expect(actual.profile?.discardedFusedRows).toBe(1)
    })

    test('keeps missing, null, negative, and negative-zero sequence semantics per row', async () => {
        const tokens = [null, 'null', '-1', '-2', '-0', '0', '2147483647', null]
        const banks = [`[${tokens.map((token, i) => row(String(i), token, `word${i}`)).join(',')}]`]
        const actual = await project(banks)
        expect(actual.scores).toStrictEqual(tokens.map((_, i) => i))
        // Preserve the established fused column contract; negative values all
        // denote absent sequences downstream, while Int32 stores -0 as +0.
        expect(actual.sequences).toStrictEqual([-1, -1, -1, -2, 0, 0, 2147483647, -1])
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
        await expect(project(banks, true, true)).rejects.toThrow()
    })

    test.each([
        '00',
        '01',
        '-00',
        '-01',
        '+1',
        '--1',
        '-',
        '1x',
        '0x10',
        '1_0',
        '1e+',
        '1.',
        '1true',
        'null',
        'null0',
        'true',
        '"1"',
        '[]',
        '{}',
        '1\u000b',
        '1\u00a0',
    ])('never admits an integer prefix from malformed score %j', async (token) => {
        const banks = [`[${row('1', '1', 'first')},${row(token, '2', 'last')}]`]
        await expect(project(banks, true)).rejects.toThrow()
        await expect(project(banks, false)).rejects.toThrow()
    })

    test.each(['00', '-01', 'nullx', 'null0', '-null', '1e+', '1e309', '9007199254740992', '1.5'])('retains sequence rejection for %s', async (token) => {
        const banks = [`[${row('1', '1', 'first')},${row('2', token, 'last')}]`]
        await expect(project(banks, true)).rejects.toThrow()
        await expect(project(banks, false)).rejects.toThrow()
    })

    test.each(['1e309', '-1e309'])('retains non-finite score rejection for %s', async (token) => {
        await expect(project([`[${row(token)}]`])).rejects.toThrow()
    })

    test('does not publish a score when its row or bank ends during the token', async () => {
        await expect(project(['[["word","reading","tag","",2147483647'])).rejects.toThrow()
        await expect(project(['[["word","reading","tag","",214748364', '7,["definition"],1,""]]'])).rejects.toThrow()
        await expect(project(['[["word","reading","tag","",1,["definition"],nul', 'l,""]]'])).rejects.toThrow()
        await expect(project(['[["word","reading","tag",""]]'])).rejects.toThrow()
    })
})
