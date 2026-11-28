/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Copy every semantic field while the parser owns its native memory. The
 * comparison path scans every key and builds its key plan in JavaScript.
 * @param {Uint8Array[]} banks
 * @param {boolean} fused
 * @param {boolean} [nativeEscapes]
 * @returns {Promise<{rows: unknown[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function snapshot(banks, fused, nativeEscapes = true) {
    /** @type {unknown[]} */
    const rows = []
    await parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = plan.stringOffsets
        const metadata = chunk.contentMetaList
        const content = chunk.contentBytesBuffer
        if (!offsets || !metadata || !content) { throw new Error('Missing parser columns') }
        const strings = Array.from(plan.stringLengths, (length, index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length)))
        for (let row = 0; row < chunk.rowCount; ++row) {
            const start = (chunk.contentBytesBaseOffset ?? 0) + metadata[row * 4]
            rows.push({expression: strings[plan.expressionIndexes[row]],
                reading: strings[plan.readingIndexes[row]],
                equality: chunk.readingEqualsExpressionList[row],
                score: chunk.scoreList[row],
                sequence: chunk.sequenceList[row],
                content: [...content.subarray(start, start + metadata[row * 4 + 1])],
                hashes: [...metadata.subarray(row * 4 + 2, row * 4 + 4)]})
        }
    }, 2048, {
        singleChunk: true,
        validateGlossaryTypes: true,
        useNativeStringPlan: fused,
        experimentalSkipFusedParse: !fused,
        experimentalNativeEscapedKeys: nativeEscapes,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
    })
    return {rows, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {string} expression
 * @param {string} reading
 * @param {number} sequence
 * @param {string} [space]
 * @returns {string}
 */
function row(expression, reading, sequence, space = '') {
    return `[${space}${[expression, reading, 'null', '""', String(sequence), '["definition"]', String(sequence), '""'].join(`${space},${space}`)}${space}]`
}

describe('validated adjacent key spans in strict rows', () => {
    test.each(['', ' ', '\t\r\n'])('preserves reading equality and independent fields across bank boundaries with whitespace %j', async (space) => {
        const rawKeys = [
            ['"日本語"', '"にほんご"'],
            ['"日本語"', '"にっぽんご"'],
            ['"別の語"', '"にっぽんご"'],
            ['"別の語"', '""'],
            ['"fresh"', '""'],
            ['"fresh"', '"fresh"'],
            ['"different"', '"fresh"'],
            ['"different"', '"fresh"'],
            [String.raw`"\uD800"`, String.raw`"\uD800\uDC00"`],
            [String.raw`"\uD800"`, String.raw`"\uD800\uDC00"`],
        ]
        const sourceRows = rawKeys.map(([expression, reading], i) => row(expression, reading, i, space))
        const banks = [encoder.encode(`[${sourceRows.slice(0, 2).join(',')}]`), encoder.encode('[]'), encoder.encode(`[${sourceRows.slice(2).join(',')}]`)]
        const actual = await snapshot(banks, true)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(actual.rows).toStrictEqual((await snapshot(banks, false)).rows)
        // Capture must remain owned after another parse resets native memory.
        expect(actual.rows).toHaveLength(rawKeys.length)
    })

    test.each([0, 1, 7, 8, 15, 16, 31, 32, 33, 63])('preserves the %i-byte boundary with repeated, shorter, longer and escaped keys', async (length) => {
        const token = JSON.stringify('a'.repeat(length))
        const escape = JSON.stringify('a'.repeat(Math.max(0, length - 2)) + '"')
        const keys = [token, token, JSON.stringify('a'.repeat(length) + 'b'), token, escape, escape]
        const banks = [encoder.encode('[]'), encoder.encode(`[${keys.map((key, i) => row(key, key, i)).join(',')}]`)]
        const actual = await snapshot(banks, true)
        expect(actual.rows).toStrictEqual((await snapshot(banks, false)).rows)
        if (length > 0) { expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0) }
    })

    test.each([false, true])('preserves escaped-key fallback with native escapes %s', async (nativeEscapes) => {
        const keys = ['"literal"', String.raw`"\u0061\uD800"`, String.raw`"\u0061\uD800"`, String.raw`"a\uD800"`]
        const banks = [encoder.encode('[]'), encoder.encode(`[${keys.map((key, i) => row(key, '"reading"', i)).join(',')}]`)]
        const actual = await snapshot(banks, true, nativeEscapes)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(nativeEscapes ? 0 : 1)
        expect(actual.rows).toStrictEqual((await snapshot(banks, false)).rows)
    })

    test.each(['"same"x', '"sam\\q"', '"sam\u0000"', '"same', '"sam\\"', '"same" "other"'])('rejects malformed key %j after a valid predecessor', async (token) => {
        const banks = [encoder.encode(`[${row('"same"', '"reading"', 1)}]`), encoder.encode(`[${row(token, '"reading"', 2)}]`)]
        await expect(snapshot(banks, true)).rejects.toThrow()
        await expect(snapshot(banks, false)).rejects.toThrow()
    })

    test('never borrows a quote from the next independently bounded bank', async () => {
        const valid = `[${row('"same"', '"reading"', 1)}]`
        const source = `[${row('"same"', '"reading"', 2)}]`
        for (let split = 1; split < 18; ++split) {
            const banks = [encoder.encode(valid), encoder.encode(source.slice(0, split)), encoder.encode(source.slice(split))]
            await expect(snapshot(banks, true)).rejects.toThrow()
        }
    })

    test('keeps invalid UTF-8 on replacement-decoding fallback before it can become a witness', async () => {
        const malformed = encoder.encode(`[${row('"sameX"', '"reading"', 2)},${row('"sameX"', '"reading"', 3)}]`)
        for (let i = 0; i < malformed.length; ++i) {
            if (malformed[i] === 0x58) { malformed[i] = 0xff }
        }
        const banks = [encoder.encode(`[${row('"same"', '"reading"', 1)}]`), malformed]
        const actual = await snapshot(banks, true)
        expect(actual.profile?.fusedParseFallbacks).toBe(1)
        expect(actual.rows).toStrictEqual((await snapshot(banks, false)).rows)
    })
})
