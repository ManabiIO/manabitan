/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Capture values while native spans remain valid. The generic row grammar is
 * an independent reference for valid inputs to strict format-3 validation.
 * @param {string} source
 * @param {boolean} strict
 * @param {boolean} columns
 * @returns {Promise<{rows: unknown[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(source, strict, columns) {
    /** @type {unknown[]} */
    const rows = []
    const options = {validateGlossaryTypes: strict,
        mediaHintFastScan: true,
        experimentalNativeEscapedKeys: true,
        experimentalValidatedGlossaryReuse: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        singleChunk: true}
    await (columns ?
parseTermBankWithWasmColumnChunks([encoder.encode(source), encoder.encode('[]')], 3, (chunk) => {
    const plan = chunk.termRecordPreinternedPlan
    const offsets = plan.stringOffsets
    const metadata = chunk.contentMetaList
    const content = chunk.contentBytesBuffer
    if (!offsets || !metadata || !content) { throw new Error('Missing native columns') }
    const strings = Array.from(plan.stringLengths, (length, index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length)))
    for (let i = 0; i < chunk.rowCount; ++i) {
        const offset = metadata[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
        rows.push({expression: strings[plan.expressionIndexes[i]],
            reading: strings[plan.readingIndexes[i]],
            score: chunk.scoreList[i],
            sequence: chunk.sequenceList[i],
            content: createHash('sha256').update(content.subarray(offset, offset + metadata[i * 4 + 1])).digest('hex'),
            hashes: [metadata[i * 4 + 2], metadata[i * 4 + 3]],
            media: chunk.mediaRows.filter((entry) => entry.index === i).map((entry) => entry.row.glossaryJson)})
    }
}, 8192, options) :
parseTermBankWithWasmChunks(encoder.encode(source), 3, (chunk) => {
    for (const row of chunk) {
        rows.push({expression: row.expression,
            reading: row.reading,
            definitionTags: row.definitionTags,
            rules: row.rules,
            score: row.score,
            sequence: row.sequence,
            termTags: row.termTags,
            glossary: JSON.parse(row.glossaryJson),
            media: row.glossaryMayContainMedia})
    }
}, 2, options))
    return {rows, profile: consumeLastTermBankWasmParseProfile()}
}

describe.each([false, true])('strict format-3 row grammar, columns=%s', (columns) => {
    test.each([
        '[]',
        '[ \r\n\t ]',
        '["","first","日本語🙂","escaped\\n\\\\\\"", "last"]',
        '["img","imagination","image"]',
        '["\\u0069mg", "i\\u006dage"]',
        '["prefix", {"type":"text","text":"normalized"}, "suffix"]',
        '["image", {"type":"structured-content","content":{"tag":"img","path":"photo.png"}}]',
        '["prefix", ["nested", {"type":"text","text":"value"}], null, true, 1.25]',
    ])('preserves plain glossary and mixed-list fallback %s', async (glossary) => {
        const source = `[["key","",null,"",0,${glossary},1,""]]`
        const actual = await parse(source, true, columns)
        expect(actual.rows).toStrictEqual((await parse(source, false, columns)).rows)
        expect(actual.rows).toHaveLength(1)
        if (columns) { expect(actual.profile?.fusedParseFallbacks).toBe(0) }
    })

    test.each([
        '["first",]',
        '["first",, "second"]',
        '["first" "second"]',
        '["first": "second"]',
        '["first", "bad\\q"]',
        '["first", "bad\\u123"]',
        '["first", "raw\u001fcontrol"]',
        '["first", {"type":"text","text":null}]',
        '["first", {"type":"unsupported","text":"value"}]',
    ])('rejects invalid grammar or glossary objects after a string prefix %s', async (glossary) => {
        const source = `[["key","",null,"",0,${glossary},1,""]]`
        await expect(parse(source, true, columns)).rejects.toThrow()
    })

    test.each(['', ' ', '\r\n\t'])('preserves nullable fields, escapes and reused glossary hints with whitespace %j', async (space) => {
        const glossary = [{type: 'structured-content', content: [{tag: 'img', path: 'image.webp'}, 'definition'.repeat(600)]}]
        const rows = [
            ['first\\key', 'reading\n一', null, '', 1, glossary, null, 'tag'],
            ['second', '', 'noun', 'v1', 2, glossary, 123, ''],
            ['third', 'third', '', '', 0, ['plain'], -1, 'last'],
        ]
        const source = `[${space}${rows.map((row) => `[${space}${row.map((field) => JSON.stringify(field)).join(`${space},${space}`)}${space}]`).join(`${space},${space}`)}${space}]`
        const actual = await parse(source, true, columns)
        expect(actual.rows).toStrictEqual((await parse(source, false, columns)).rows)
        expect(actual.rows).toHaveLength(3)
        if (columns) {
            expect(actual.profile?.fusedParseAttempts).toBe(1)
            expect(actual.profile?.fusedParseFallbacks).toBe(0)
            expect(actual.profile?.validatedGlossaryReuseCount).toBeGreaterThan(0)
        }
    })

    test.each(['-0', '0.5', '1e3', '-2147483649'])('preserves valid numeric fallback for score %s', async (score) => {
        const source = `[["key","",null,"",${score},["meaning"],null,""]]`
        const actual = await parse(source, true, columns)
        expect(actual.rows).toStrictEqual((await parse(source, false, columns)).rows)
        if (columns) { expect(actual.profile?.fusedParseFallbacks).toBe(1) }
    })

    test.each(Array.from({length: 8}, (_, count) => count))('rejects a row truncated to %i fields after a valid row', async (count) => {
        const row = ['key', '', null, '', 0, ['meaning'], null, '']
        await expect(parse(JSON.stringify([row, row.slice(0, count)]), true, columns)).rejects.toThrow()
    })

    test('rejects extra fields', async () => {
        await expect(parse('[["key","",null,"",0,["meaning"],null,"","extra"]]', true, columns)).rejects.toThrow()
    })

    test.each([
        '["key","",nullx,"",0,["meaning"],null,""]',
        '["key","",null,"",0,["meaning"],null0,""]',
        '["key","",null,"",0,["meaning"],null,"",]',
        '["key","",null,"",01,["meaning"],null,""]',
        '["key","",null,"",0,["meaning"],1e,""]',
        '["key","",null,"",0,["meaning"],null,"\\q"]',
    ])('rejects malformed field boundaries %s', async (row) => {
        await expect(parse(`[${row}]`, true, columns)).rejects.toThrow()
    })
})
