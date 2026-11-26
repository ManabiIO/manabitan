/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {consumeLastTermBankWasmParseProfile, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {(input: number, length: number, output: number, capacity: number, bankSpans: number, bankCount: number, strict: number) => number} ParseBank */
/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: ParseBank, parse_term_bank_with_media_hints: ParseBank}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const module = await WebAssembly.compile(bytes)
    setTermBankWasmModule(module)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * Preserve all raw metadata, including conservative hints that may outlive the
 * property which supplied them. The last argument selects the strict grammar
 * where the optimized top-level type-field dispatch executes.
 * @param {string} glossary
 * @param {boolean} strict
 * @param {boolean} mediaHints
 * @returns {{count: number, metadata: number[]}}
 */
function parseNative(glossary, strict, mediaHints) {
    const bytes = encoder.encode(`[["word","","","",1,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const parse = mediaHints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank
    const count = parse(input, bytes.length, output, 1, 0, 0, strict ? 1 : 0)
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)]}
}

describe('conservative hints after duplicate glossary types', () => {
    test.each([
        {name: 'overwritten image type', glossary: '[{"type":"image","type":"structured-content","content":"value"}]', hints: [1, 0, 0]},
        {name: 'overwritten text type', glossary: '[{"type":"text","type":"structured-content","content":"value"}]', hints: [0, 1, 1]},
        {name: 'nested overwritten image type', glossary: '[{"type":"structured-content","content":{"type":"image","type":"structured-content","content":"nested"}}]', hints: [1, 0, 0]},
        {name: 'nested overwritten text type', glossary: '[{"type":"structured-content","content":{"type":"text","type":"structured-content","content":"nested"}}]', hints: [0, 1, 1]},
        {name: 'both hints before final structured type', glossary: '[{"type":"image","content":{"type":"text","type":"structured-content","content":"nested"},"type":"structured-content"}]', hints: [1, 1, 1]},
    ])('preserves raw native metadata for $name', ({glossary, hints}) => {
        for (const mediaHints of [false, true]) {
            const actual = parseNative(glossary, true, mediaHints)
            expect(actual.count).toBe(1)
            expect(actual).toStrictEqual(parseNative(glossary, false, mediaHints))
            expect(actual.metadata.slice(14)).toStrictEqual([mediaHints ? hints[0] : 0, hints[1], hints[2]])
        }
    })

    test('preserves content when a null type is replaced by structured content', async () => {
        const glossary = '[{"type":null,"type":"structured-content","content":"value"}]'
        const native = parseNative(glossary, true, true)
        expect(native.count).toBe(1)
        expect(native).toStrictEqual(parseNative(glossary, false, true))
        expect(native.metadata.slice(14)).toStrictEqual([0, 0, 0])
        /** @type {unknown[]} */
        const content = []
        await parseTermBankWithWasmColumnChunks([
            encoder.encode(`[["word","","","",1,${glossary},1,""]]`),
            encoder.encode('[]'),
        ], 3, (chunk) => {
            const bytes = chunk.contentBytesBuffer
            const metadata = chunk.contentMetaList
            if (!bytes || !metadata) { throw new Error('Missing canonical content') }
            expect(chunk.rowCount).toBe(1)
            const start = (chunk.contentBytesBaseOffset ?? 0) + metadata[0]
            const encoded = decoder.decode(Uint8Array.from(bytes.subarray(start, start + metadata[1])))
            expect(encoded.startsWith('MBR6')).toBe(true)
            content.push(JSON.parse(encoded.slice(encoded.lastIndexOf('\0') + 1)))
        }, 2048, {
            singleChunk: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            validateGlossaryTypes: true,
            mediaHintFastScan: true,
        })
        expect(content).toStrictEqual([[{type: 'structured-content', content: 'value'}]])
        const profile = consumeLastTermBankWasmParseProfile()
        expect(profile?.fusedParseAttempts).toBe(1)
        expect(profile?.fusedParseFallbacks ?? 0).toBe(0)
    })
})
