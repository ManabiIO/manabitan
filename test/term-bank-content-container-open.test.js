/*
 * Copyright (C) 2026 Manabitan authors
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
/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (size: number) => number, wasm_reset_heap: () => void, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    setTermBankWasmModule(module)
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {string} glossary
 * @returns {string}
 */
function bank(glossary) {
    return `[["語","ご","tag","rule",3,${glossary},41,"term"]]`
}

/**
 * Read the entire emitted token-content glossary with the platform JSON parser.
 * Capture owned values before the next parse can reuse the native memory.
 * @param {string[]} sources
 * @param {boolean} [fused]
 * @returns {Promise<{glossaries: unknown[], mediaRows: number[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(sources, fused = true) {
    /** @type {unknown[]} */
    const glossaries = []
    /** @type {number[]} */
    const mediaRows = []
    await parseTermBankWithWasmColumnChunks(sources.map((source) => encoder.encode(source)), 3, (chunk) => {
        const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk
        if (!contentMetaList || !contentBytesBuffer || typeof contentBytesBaseOffset !== 'number') {
            throw new Error('Missing complete content columns')
        }
        for (let row = 0; row < chunk.rowCount; ++row) {
            const start = contentBytesBaseOffset + contentMetaList[row * 4]
            const text = decoder.decode(contentBytesBuffer.subarray(start, start + contentMetaList[row * 4 + 1]))
            expect(text.startsWith('MBR6')).toBe(true)
            glossaries.push(JSON.parse(text.slice(text.lastIndexOf('\0') + 1)))
        }
        mediaRows.push(...chunk.mediaRows.map(({index}) => index))
    }, 2048, {
        singleChunk: true,
        emitTermByteLists: false,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        experimentalSkipFusedParse: !fused,
    })
    return {glossaries, mediaRows, profile: consumeLastTermBankWasmParseProfile()}
}

describe('content-key child container entry', () => {
    test.each([':', ': ', ':  ', ':\t', ' \t:\n'])('preserves nested content, siblings and media with separator %j', async (separator) => {
        for (const key of ['"content"', '"co\\u006etent"']) {
            const glossary = `[{"type":"structured-content",${key}${separator}[{"tag":"div","content":{"tag":"img","path":"cat.png"}},{"tag":"span","content":["a",{"tag":"rt","content":"読み"}]}]}]`
            const sources = [bank(glossary), '[]', bank('["after"]')]
            for (const fused of [false, true]) {
                const result = await parse(sources, fused)
                expect(result.glossaries).toStrictEqual([JSON.parse(glossary), ['after']])
                expect(result.mediaRows).toStrictEqual([0])
                if (fused) {
                    expect(result.profile?.fusedParseAttempts).toBe(1)
                    expect(result.profile?.fusedParseFallbacks ?? 0).toBe(0)
                }
            }
        }
    })

    test.each([
        '[{"content":{},"type":"structured-content"}]',
        '[{"type":"structured-content","content":null,"content":[]}]',
        '[{"type":"structured-content","content":[],"content":{}}]',
        '[{"type":"structured-content","content":{},"content":"last"}]',
        '[{"type":"text","content":[],"type":"structured-content"}]',
        '[{"type":"structured-content","contents":[],"content":{}}]',
    ])('preserves required-field ordering and last-value semantics: %s', async (glossary) => {
        expect((await parse([bank(glossary)])).glossaries).toStrictEqual([JSON.parse(glossary)])
    })

    test.each([
        '[{"type":"structured-content","content":[],"content":null}]',
        '[{"type":"structured-content","content":{},"content":false}]',
        '[{"type":"text","content":[]}]',
        '[{"type":"image","content":{}}]',
        '[{"type":"structured-content","contents":[]}]',
        '[{"type":"structured-content","content":[}]',
        '[{"type":"structured-content","content":{]}]',
        '[{"type":"structured-content","content":[,]}]',
        '[{"type":"structured-content","content":{"content":[],,}}]',
        '[{"type":"structured-content","content"::[]}]',
        '[{"type":"structured-content","content":[],}]',
    ])('rejects invalid required fields or child grammar: %s', async (glossary) => {
        await expect(parse([bank(glossary)])).rejects.toThrow()
    })

    test('retains the exact nesting limit for consecutive content objects', async () => {
        /**
         * @param {number} objects
         * @returns {string}
         */
        const nested = (objects) => `${'{"content":'.repeat(objects - 1)}{}${'}'.repeat(objects - 1)}`
        const accepted = `[{"type":"structured-content","content":${nested(254)}}]`
        expect((await parse([bank(accepted)])).glossaries).toStrictEqual([JSON.parse(accepted)])
        await expect(parse([bank(`[{"type":"structured-content","content":${nested(255)}}]`)])).rejects.toThrow()
    })

    test('never consumes a truncated child from bytes beyond the logical bank end', () => {
        const source = bank('[{"type":"structured-content","content":[{"content":{}}]}]')
        const bytes = encoder.encode(source)
        const firstContent = source.indexOf('"content"')
        for (let end = firstContent; end < bytes.length; ++end) {
            wasm.wasm_reset_heap()
            const input = wasm.wasm_alloc(bytes.length + 64)
            const output = wasm.wasm_alloc(68)
            const heap = new Uint8Array(wasm.memory.buffer)
            heap.fill(0x5d, input, input + bytes.length + 64)
            heap.set(bytes, input)
            expect(wasm.parse_term_bank_with_media_hints(input, end, output, 1)).toBeLessThan(0)
        }
    })

    test('rejects an unfinished child bank before a valid following bank', async () => {
        await expect(parse([
            bank('["before"]'),
            '[["語","ご","tag","rule",3,[{"type":"structured-content","content":[',
            bank('["after"]'),
        ])).rejects.toThrow()
    })
})
