/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {readFile} from 'node:fs/promises'
import {beforeAll, expect, test} from 'vitest'
import {consumeLastTermBankWasmParseProfile, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

const encoder = new TextEncoder()
const options = {emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true}

/**
 * @param {string[]} rows
 * @returns {Promise<{scores: number[], sequences: number[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(rows) {
    /** @type {number[]} */
    const scores = []
    /** @type {number[]} */
    const sequences = []
    const input = rows.map((row) => encoder.encode(`[${row}]`))
    const before = input.map((bytes) => new Uint8Array(bytes))
    await parseTermBankWithWasmColumnChunks(input, 3, (chunk) => {
        scores.push(...chunk.scoreList)
        sequences.push(...chunk.sequenceList)
    }, 64, options)
    expect(input).toEqual(before)
    return {scores, sequences, profile: consumeLastTermBankWasmParseProfile()}
}

for (const space of ['', ' ', '\t', '\r', '\n', ' \r\n\t ']) {
    test(`preserves integer admission and nested syntax with whitespace ${JSON.stringify(space)}`, async () => {
        const tokens = ['0', '1', '-1', '2147483647', '-2147483648']
        const rows = tokens.map((token, index) => {
            const glossary = JSON.stringify([{tag: 'span', content: ['x', {text: 'payload'}]}, false, 1.25])
            return `[${space}"key-${index}","","","",${space}${token}${space},${glossary},${space}${token}${space},""]`
        })
        const result = await parse(rows)
        expect(result.scores).toEqual(tokens.map(Number))
        expect(result.sequences).toEqual(tokens.map(Number))
        expect(result.profile?.fusedParseAttempts).toBe(1)
        expect(result.profile?.fusedParseFallbacks).toBe(0)
    })
}

for (const token of ['-0', '-0.0', '-0e0', '1.5', '-2.25', '1e3', '2147483648', '-2147483649', '1e-100']) {
    test(`preserves score fallback and following-bank content for ${token}`, async () => {
        const result = await parse([
            '["first","","","",1,["first"],1,""]',
            `["second","","","",${token},["second"],2,""]`,
            '["third","","","",3,["third"],3,""]',
        ])
        expect(Object.is(result.scores[1], Number(token))).toBe(true)
        expect(result.scores).toHaveLength(3)
        expect(result.sequences).toEqual([1, 2, 3])
        expect(result.profile?.fusedParseAttempts).toBe(1)
        expect(result.profile?.fusedParseFallbacks).toBe(1)
    })
}

for (const token of ['01', '+1', '1.', '1e', '--1', 'true', 'null', '"1"', '1e309']) {
    test(`rejects invalid scores before publishing a chunk: ${token}`, async () => {
        let published = false
        const input = encoder.encode(`[["key","","","",${token},["value"],1,""]]`)
        await expect(parseTermBankWithWasmColumnChunks(input, 3, () => { published = true }, 64, options)).rejects.toThrow()
        expect(published).toBe(false)
    })
}

test('preserves null and negative-zero sequence normalization', async () => {
    const result = await parse([
        '["a","","","",1,["g"],null,""]',
        '["b","","","",2,["g"],-0,""]',
    ])
    expect(result.sequences).toEqual([-1, 0])
    expect(result.profile?.fusedParseFallbacks).toBe(0)
})
