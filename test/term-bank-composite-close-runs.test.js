/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test, vi} from 'vitest'
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
 * @param {string} glossary
 * @param {string} [score]
 * @returns {string}
 */
function bank(glossary, score = '1') {
    return `[["term","","","",${score},${glossary},1,""]]`
}

/**
 * @param {string[]} banks
 * @param {boolean} mediaHintFastScan
 * @param {boolean} [fused]
 * @returns {Promise<{rows: unknown[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function snapshot(banks, mediaHintFastScan, fused = true) {
    /** @type {unknown[]} */
    const rows = []
    await parseTermBankWithWasmColumnChunks(banks.map((source) => encoder.encode(source)), 3, (chunk) => {
        const metadata = chunk.contentMetaList
        const content = chunk.contentBytesBuffer
        if (!metadata || !content) { throw new Error('Missing native content columns') }
        for (let row = 0; row < chunk.rowCount; ++row) {
            const start = (chunk.contentBytesBaseOffset ?? 0) + metadata[row * 4]
            rows.push({
                score: chunk.scoreList[row],
                sequence: chunk.sequenceList[row],
                content: [...content.subarray(start, start + metadata[row * 4 + 1])],
                hashes: [...metadata.subarray(row * 4 + 2, row * 4 + 4)],
                media: chunk.mediaRows.filter((entry) => entry.index === row).map((entry) => JSON.parse(
                    entry.row.glossaryJsonBytes instanceof Uint8Array ?
                        decoder.decode(new Uint8Array(entry.row.glossaryJsonBytes)) :
                        entry.row.glossaryJson,
                )),
            })
        }
    }, 2048, {
        singleChunk: true,
        validateGlossaryTypes: true,
        mediaHintFastScan,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        useNativeStringPlan: fused,
        experimentalSkipFusedParse: !fused,
    })
    return {rows, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {string[]} banks
 * @param {boolean} mediaHintFastScan
 */
async function rejectBeforeDispatch(banks, mediaHintFastScan) {
    const onChunk = vi.fn()
    await expect(parseTermBankWithWasmColumnChunks(
        banks.map((source) => encoder.encode(source)),
        3,
        onChunk,
        2048,
        {
            singleChunk: true,
            validateGlossaryTypes: true,
            mediaHintFastScan,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
        },
    )).rejects.toThrow(/parser failed|term-bank source fragment/u)
    expect(onChunk).not.toHaveBeenCalled()
}

describe.each([false, true])('strict composite closing runs, media hints=%s', (mediaHints) => {
    test.each([
        '[{"type":"structured-content","content":[{"tag":"span","content":[[]]}]}]',
        '[{"type":"text","text":"value","extra":{"children":[{}]}}]',
        '[{"type":"text","text":[[{}]],"text":"value"}]',
        String.raw`[{"type":"text","text":[[{}]],"te\u0078t":"value"}]`,
        '[{"type":"image","path":[[{}]],"path":"image.png"}]',
        '[{"type":"text","content":[[{}]],"type":"structured-content"}]',
        '[{"type":"structured-content","content":{"type":"unsupported","content":[[]]}}]',
    ])('preserves valid fields after nested closes: %s', async (glossary) => {
        expect(() => JSON.parse(glossary)).not.toThrow()
        for (const score of ['1', '1.5']) {
            const actual = await snapshot([bank('["first"]', score), '[]', bank(glossary)], mediaHints)
            expect(actual.rows).toHaveLength(2)
            expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(score === '1.5' ? 1 : 0)
        }
    })

    test.each([
        '[{"type":"text","extra":{"children":[{}]}}]',
        '[{"type":"image","extra":{"children":[{}]}}]',
        '[{"type":"text","text":"value","text":[[{}]]}]',
        String.raw`[{"type":"text","text":"value","te\u0078t":[[{}]]}]`,
        '[{"type":"image","path":"image.png","path":[[{}]]}]',
        '[{"type":"structured-content","content":[[{}]],"type":"text"}]',
        '[{"type":"structured-content","content":[[{}]],"type":{"type":"text"}}]',
        '[{"content":{"type":"text","text":"nested","children":[[]]}}]',
        '[{"type":"structured-content","content":[[]]},{"type":"text","extra":[[]]}]',
    ])('rejects missing or overwritten required fields before publishing: %s', async (glossary) => {
        expect(() => JSON.parse(glossary)).not.toThrow()
        for (const score of ['1', '1.5']) {
            await rejectBeforeDispatch([bank('["first"]', score), bank(glossary)], mediaHints)
        }
    })

    test.each([
        '[[],]',
        '[[],,[]]',
        '[[], ,[]]',
        '[[]:[]]',
        '[[]{}]',
        '[{"type":"structured-content","content":[],}]',
        '[{"type":"structured-content","content":[],,"extra":0}]',
        '[{"type":"structured-content","content":[] "extra":0}]',
    ])('rejects invalid transitions immediately after a child closes: %s', async (glossary) => {
        expect(() => JSON.parse(glossary)).toThrow()
        await rejectBeforeDispatch([bank('["first"]'), bank(glossary)], mediaHints)
    })

    test.each([' ', '\t', '\r\n', ' \t\r\n'])('preserves encoded content and media for closing-run whitespace %j', async (space) => {
        const compact = '[{"type":"structured-content","content":[{"tag":"img","path":"image.png","content":[[]]}]},"tail"]'
        const spaced = compact.replaceAll(']', `${space}]`).replaceAll('}', `${space}}`).replaceAll(',', `,${space}`)
        expect(JSON.parse(spaced)).toStrictEqual(JSON.parse(compact))
        // Existing storage preserves raw whitespace inside some structured
        // JSON values. Compare the same source against the ordinary path.
        const expected = await snapshot([bank(spaced), bank('["last"]')], mediaHints, false)
        const actual = await snapshot([bank(spaced), bank('["last"]')], mediaHints)
        expect(actual.rows).toStrictEqual(expected.rows)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
    })

    test.each([254, 255, 256, 257, 258])('preserves the nesting limit for a %i-frame closing run', async (depth) => {
        const glossary = `${'['.repeat(depth)}"leaf"${']'.repeat(depth)}`
        if (depth <= 256) {
            expect((await snapshot([bank('["first"]'), bank(glossary)], mediaHints)).rows).toHaveLength(2)
        } else {
            await rejectBeforeDispatch([bank('["first"]'), bank(glossary)], mediaHints)
        }
    })

    test('checks every closer and keeps each bank independently bounded', async () => {
        const glossary = '[{"type":"structured-content","content":[{"tag":"span","content":[[]]}]}]'
        const source = bank(glossary)
        const run = /[\]}]{3,}/u.exec(source)
        if (!run) { throw new Error('Fixture omitted consecutive closing delimiters') }
        expect((await snapshot([bank('["first"]'), source, '[]', source], mediaHints)).rows).toHaveLength(3)
        for (let at = run.index; at < run.index + run[0].length; ++at) {
            const wrong = source.slice(0, at) + (source[at] === ']' ? '}' : ']') + source.slice(at + 1)
            expect(() => JSON.parse(wrong)).toThrow()
            await rejectBeforeDispatch([bank('["first"]'), wrong], mediaHints)
            await rejectBeforeDispatch([bank('["first"]'), source.slice(0, at + 1), source.slice(at + 1)], mediaHints)
        }
    })
})
