/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {parseTermBankWithWasmChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank_with_media_hints: (input: number, length: number, output: number, capacity: number) => number}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const module = await WebAssembly.compile(bytes)
    setTermBankWasmModule(module)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * @param {string} glossary
 * @param {number} [logicalLength]
 * @returns {{count: number, hints: number[]}}
 */
function parseNative(glossary, logicalLength) {
    const bytes = encoder.encode(`[["word","","","",0,${glossary},1,""]]`)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length)
    const output = parser.wasm_alloc(17 * 4)
    new Uint8Array(parser.memory.buffer, input, bytes.length).set(bytes)
    const count = parser.parse_term_bank_with_media_hints(input, logicalLength ?? bytes.length, output, 1)
    return {count, hints: [...new Uint32Array(parser.memory.buffer, output + 14 * 4, 3)]}
}

/**
 * @param {string} glossary
 * @returns {Promise<unknown[]>}
 */
async function parseStrict(glossary) {
    /** @type {unknown[]} */
    const result = []
    await parseTermBankWithWasmChunks(encoder.encode(`[["word","","","",0,${glossary},1,""]]`), 3, (rows) => {
        result.push(...rows.map((row) => JSON.parse(row.glossaryJson)))
    }, 2048, {validateGlossaryTypes: true, mediaHintFastScan: true})
    return result
}

describe('complete structured-content type fields', () => {
    test.each(['', ' ', '\t', '\n', '\r', '  '])('preserves keys in either order and whitespace %j', async (space) => {
        for (const glossary of [
            `[{"type":${space}"structured-content","content":{"tag":"span","content":"value"}}]`,
            `[{"content":{"tag":"span","content":"value"},"type":${space}"structured-content"}]`,
        ]) {
            expect(parseNative(glossary)).toStrictEqual({count: 1, hints: [0, space.length === 0 ? 0 : 1, 0]})
            expect(await parseStrict(glossary)).toStrictEqual([JSON.parse(glossary)])
        }
    })

    test.each([
        '[{"ty\\u0070e":"structured-content","content":"value"}]',
        '[{"type":"structured-\\u0063ontent","content":"value"}]',
        '[{"type" :"structured-content","content":"value"}]',
        '[{"type":"other","type":"structured-content","content":"value"}]',
        '[{"type":null,"type":"structured-content","content":"value"}]',
        '[{"type":"structured-content","type":"image","path":"image.png"}]',
        '[{"type":"structured-content","content":[{"type":"structured-content","content":{"tag":"img","path":"image.png"}}]}]',
    ])('preserves escaped spellings, duplicates and nested values: %s', async (glossary) => {
        expect(parseNative(glossary).count).toBe(1)
        expect(await parseStrict(glossary)).toStrictEqual([JSON.parse(glossary)])
    })

    test('retains conservative media and text-normalization hints', () => {
        expect(parseNative('[{"type":"image","type":"structured-content","content":"value"}]').hints).toStrictEqual([1, 0, 0])
        expect(parseNative('[{"type":"structured-content","content":{"tag":"img","path":"image.png"}}]').hints).toStrictEqual([1, 0, 0])
        expect(parseNative('[{"type":"text","type":"structured-content","content":"value"}]').hints).toStrictEqual([0, 1, 1])
        expect(parseNative('[{"type":"structured-content","content":{"type":"text","text":"value"}}]').hints).toStrictEqual([0, 1, 1])
    })

    test.each([
        '[{"type":"structured-content"}]',
        '[{"type":"structured-content","content":null}]',
        '[{"type":"structured-content","content":"value","content":0}]',
        '[{"type":"structured-content","type":"other","content":"value"}]',
        '[{"type":"structured-content","type":null,"content":"value"}]',
        '[{"type":"structured-content","ty\\u0070e":"other","content":"value"}]',
        '[{"type":"structured-contentx","content":"value"}]',
        '[{"type":"structured-content\\"","content":"value"}]',
    ])('retains strict required-field and last-property semantics: %s', async (glossary) => {
        expect(parseNative(glossary).count).toBe(1)
        await expect(parseStrict(glossary)).rejects.toThrow()
    })

    test.each([
        '[{"type":"structured-content",}]',
        '[{"type":"structured-content" "content":"value"}]',
        '[{"type":"structured-content"x,"content":"value"}]',
        '[{"type":"structured-content":0}]',
        '[{"type":"structured-content",,"content":"value"}]',
        '[{"type":"structured-content",:"content"}]',
        '[{"type"::"structured-content"}]',
        '[{"type":"structured-content}]',
    ])('rejects malformed field boundaries: %s', (glossary) => {
        expect(parseNative(glossary).count).toBeLessThan(0)
    })

    test.each(['', ' '])('never consumes a type field outside the logical source boundary %j', (space) => {
        const prefix = '[["word","","","",0,'
        const glossary = `[{"type":${space}"structured-content","content":"value"}]`
        const typeEnd = prefix.length + glossary.indexOf(',"content"')
        for (let length = prefix.length; length <= typeEnd; ++length) {
            expect(parseNative(glossary, length).count).toBeLessThan(0)
        }
    })
})
