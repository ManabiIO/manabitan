/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {parseTermBankWithWasmChunks, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    setTermBankWasmModule(module)
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

/**
 * Empty-string prefixes must remain bounded even at the end of the memory.
 * The ordinary case also fills neighboring bytes with quotation marks.
 * @param {string} source
 * @param {boolean} physicalEnd
 * @returns {number}
 */
function parseBounded(source, physicalEnd) {
    const bytes = encoder.encode(source)
    wasm.wasm_reset_heap()
    const output = wasm.wasm_alloc(2 * 68)
    const allocation = wasm.wasm_alloc(bytes.length + 32)
    const heap = new Uint8Array(wasm.memory.buffer)
    const input = physicalEnd ? heap.length - bytes.length : allocation
    if (!physicalEnd) { heap.fill(0x22, allocation, allocation + bytes.length + 32) }
    heap.set(bytes, input)
    return wasm.parse_term_bank_with_media_hints(input, bytes.length, output, 2, 0, 0, 1)
}

describe('empty term-bank string boundaries', () => {
    test.each([false, true])('does not complete truncated strings from adjacent memory, physicalEnd=%s', (physicalEnd) => {
        const source = '[["","","","",0,[""],null,""]]'
        for (let end = 1; end < source.length; ++end) {
            expect(parseBounded(source.slice(0, end), physicalEnd), `prefix ${end}`).toBeLessThan(0)
        }
        expect(parseBounded(source, physicalEnd)).toBe(1)
    })

    test.each([false, true])('keeps separators after an empty field authoritative, physicalEnd=%s', (physicalEnd) => {
        for (const next of ['"', '\\', 'x', '0', ':', '[', '{']) {
            expect(parseBounded(`[[""${next},"","","",0,[""],null,""]]`, physicalEnd)).toBeLessThan(0)
        }
    })

    test('rejects malformed escapes and controls after a completed empty string', () => {
        for (const invalid of ['\\q', '\\u00xz', '\\u000', '\\', '\u0000', '\u001f']) {
            expect(parseBounded(`[["","","","",0,["","${invalid}"],null,""]]`, false)).toBeLessThan(0)
        }
    })

    test('preserves empty keys and values inside structured content', async () => {
        const glossary = [{type: 'structured-content', content: {tag: 'span', content: ['', {tag: 'span', data: {'': '', title: 'image'}, content: ''}]}}]
        const source = JSON.stringify([['key', '', '', '', 0, glossary, null, '']])
        /** @type {unknown[]} */
        const decoded = []
        await parseTermBankWithWasmChunks(encoder.encode(source), 3, (rows) => {
            decoded.push(...rows.map((row) => JSON.parse(row.glossaryJson)))
        }, 2, {validateGlossaryTypes: true, mediaHintFastScan: true})
        expect(decoded).toEqual([glossary])
    })

    test('resets escape state for empty keys after escaped rows in fused columns', async () => {
        const rows = [['escaped\\key', 'escaped\nreading', '', '', 0, [''], null, ''], ['', '', '', '', 0, [''], null, ''], ['after', '', '', '', 0, [''], null, '']]
        /** @type {string[][]} */
        const keys = []
        await parseTermBankWithWasmColumnChunks([encoder.encode(JSON.stringify(rows)), encoder.encode('[]')], 3, (chunk) => {
            const plan = chunk.termRecordPreinternedPlan
            const offsets = plan.stringOffsets
            if (!offsets) { throw new Error('Missing native key offsets') }
            const strings = Array.from(plan.stringLengths, (length, index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length)))
            for (let index = 0; index < chunk.rowCount; ++index) {
                keys.push([strings[plan.expressionIndexes[index]], strings[plan.readingIndexes[index]]])
            }
        }, 8192, {validateGlossaryTypes: true, singleChunk: true, emitTermByteLists: false, emitContentSlab: true, emitTokenBinaryContent: true})
        expect(keys).toEqual([['escaped\\key', 'escaped\nreading'], ['', ''], ['after', 'after']])
    })
})
