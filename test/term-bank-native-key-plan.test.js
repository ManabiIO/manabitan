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
import {beforeAll, describe, expect, test} from 'vitest'
import {consumeLastTermBankWasmParseProfile, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {Array<string|Uint8Array>} banks
 * @returns {Promise<{rows: {expression: number[], reading: number[], equal: number, score: number, sequence: number}[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(banks) {
    /** @type {{expression: number[], reading: number[], equal: number, score: number, sequence: number}[]} */
    const rows = []
    const sources = banks.map((bank) => {
        const bytes = typeof bank === 'string' ? encoder.encode(bank) : bank
        const padded = new Uint8Array(bytes.length + 11)
        padded.set(bytes, 5)
        return padded.subarray(5, bytes.length + 5)
    })
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        let offset = 0
        const offsets = Array.from(plan.stringLengths, (length) => {
            const start = offset
            offset += length
            return start
        })
        /** @param {number} index @returns {number[]} */
        const key = (index) => [...plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index])]
        for (let i = 0; i < chunk.rowCount; ++i) {
            rows.push({expression: key(plan.expressionIndexes[i]), reading: key(plan.readingIndexes[i]),
                equal: chunk.readingEqualsExpressionList[i], score: chunk.scoreList[i], sequence: chunk.sequenceList[i]})
        }
    }, 2048, {singleChunk: true, experimentalSkipFusedParse: true, emitTermByteLists: false,
        computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, prepareLookupIndexes: true})
    return {rows, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {string} expression
 * @param {string} [reading]
 * @returns {string}
 */
function row(expression, reading = '""') {
    return `[${expression},${reading},"","",1.25,[],2147483648,""]`
}

describe('standalone native escaped-key interning', () => {
    const tokens = [String.raw`"back\\slash"`, String.raw`"quote\"here"`, String.raw`"slash\/here"`,
        String.raw`"\b\f\n\r\t"`, String.raw`"\u0000"`, String.raw`"\u65e5本"`,
        String.raw`"\ud83d\ude42"`, String.raw`"\ud800"`, String.raw`"\udfff"`,
        String.raw`"\ud800x\udfff"`, String.raw`"é\n𠮷"`]
    test.each(tokens)('keeps the native plan for a valid escaped token: %s', async (token) => {
        const result = await parse([`[${row('"ordinary"')}]`, `[${row(token)},${row(token)}]`])
        const bytes = [...encoder.encode(/** @type {string} */ (JSON.parse(token)))]
        expect(result.rows[1]).toEqual({expression: bytes, reading: bytes, equal: 1, score: 1.25, sequence: 2147483648})
        expect(result.rows[2]).toEqual(result.rows[1])
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
        expect(result.profile?.nativeStringPlanChunkCount).toBe(1)
    })

    test('preserves same raw token, empty reading and distinct escaped reading semantics', async () => {
        const token = String.raw`"\u65e5"`
        const result = await parse([`[${row(token, token)},${row(token)},${row(token, String.raw`"\u6708"`)}]`])
        expect(result.rows.map((value) => value.equal)).toEqual([1, 1, 0])
        expect(result.rows[2].reading).toEqual([...encoder.encode('月')])
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })

    test.each([
        ['"same"', String.raw`"\u0073ame"`],
        [String.raw`"\u0073ame"`, '"same"'],
    ])('preserves raw-token equality through fallback: %s / %s', async (expression, reading) => {
        const result = await parse([`[${row(expression, reading)}]`])
        expect(result.rows[0].equal).toBe(0)
        expect(result.rows[0].expression).toEqual(result.rows[0].reading)
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
    })

    test.each([0xff, 0xc0, 0x80, 0xed, 0xf5])('retains replacement decoding for invalid raw UTF-8: %s', async (byte) => {
        const source = encoder.encode(`[${row(String.raw`"x\n"`)}]`)
        source[source.indexOf(0x78)] = byte
        const result = await parse([source])
        expect(result.rows[0].expression).toEqual([...encoder.encode('\ufffd\n')])
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
    })

    test('accepts the maximum decoded key length', async () => {
        const token = `"${String.raw`\u0061`.repeat(65535)}"`
        const result = await parse([`[${row(token)}]`])
        expect(result.rows[0].expression).toEqual([...encoder.encode('a'.repeat(65535))])
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })

    test('still rejects a decoded key above the binary limit', async () => {
        const token = `"${String.raw`\u0061`.repeat(65536)}"`
        await expect(parse([`[${row(token)}]`])).rejects.toThrow()
    })
})
