/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_alloc: (length: number) => number, wasm_reset_heap: () => void, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * Adjacent heap bytes must never complete a truncated discriminator.
 * @param {string} source
 * @param {boolean} validate
 * @param {boolean} hints
 * @returns {{count: number, metadata: number[]}}
 */
function parse(source, validate, hints) {
    const bytes = encoder.encode(source)
    parser.wasm_reset_heap()
    const input = parser.wasm_alloc(bytes.length + 64)
    const output = parser.wasm_alloc(17 * 4)
    const heap = new Uint8Array(parser.memory.buffer)
    heap.set(encoder.encode('"structured-content","type":"image","content":[]}]'), input + bytes.length)
    heap.set(bytes, input)
    const parseBank = hints ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank
    const count = parseBank(input, bytes.length, output, 1, 0, 0, validate ? 1 : 0)
    return {count, metadata: [...new Uint32Array(parser.memory.buffer, output, 17)]}
}

/**
 * @param {string} glossary
 * @returns {string}
 */
function row(glossary) { return `[["entry","","","",0,${glossary},1,""]]` }

describe('bounded glossary discriminator parsing', () => {
    const cases = [
        '[{"type":"text","text":"definition"}]',
        '[{"text":"definition","type":"text"}]',
        '[{"type":"image","path":"image.png"}]',
        '[{"path":"image.png","type":"image"}]',
        '[{"type":"structured-content","content":{"tag":"span","content":"definition"}}]',
        '[{"content":{"tag":"span","content":"definition"},"type":"structured-content"}]',
        '[{"type": "structured-content", "content": [{"tag": "div", "content": "definition"}]}]',
        '[{"type" \t:\r\n "structured-content", "content": []}]',
        '[{"type"\n:\t"image", "path":"image.png"}]',
        '[{"text":"definition","type" :\n "text" }]',
        '[{"content":[],"type":"image","type":"structured-content"}]',
        '[{"type":"structured-content","type":"text","text":"definition","content":[]}]',
        '[{"type":"text","text":"definition","type":"image","path":"image.png"}]',
        '[{"type":"structured-content","content":[]},{"type":"text","text":"definition"},{"type":"image","path":"image.png"}]',
        '[{"type":"structured-content","content":{"type":"image"}}]',
        String.raw`[{"ty\u0070e":"te\u0078t","text":"definition"}]`,
        String.raw`[{"type":"im\u0061ge","path":"image.png"}]`,
        String.raw`[{"type":"structured\u002dcontent","content":"definition"}]`,
        String.raw`[{"type":"unknown","ty\u0070e":"text","text":"definition"}]`,
    ]

    for (const hints of [false, true]) {
        test.each(cases)(`retains exact metadata and hints (media=${hints}): %s`, (glossary) => {
            const source = row(glossary)
            const ordinary = parse(source, false, hints)
            const validated = parse(source, true, hints)
            expect(ordinary.count).toBe(1)
            expect(validated).toEqual(ordinary)
        })

        test(`rejects every truncated discriminator token (media=${hints})`, () => {
            for (const glossary of cases) {
                const source = row(glossary)
                for (let end = 1; end < source.length; ++end) {
                    expect(parse(source.slice(0, end), true, hints).count).toBeLessThan(0)
                }
            }
        })
    }

    test.each([
        '[{"type":"textx","text":"definition"}]',
        '[{"type":"imagex","path":"image.png"}]',
        '[{"type":"structured-contentx","content":[]}]',
        '[{"type":"structured-conten","content":[]}]',
        '[{"type":"structured-content","content":[],"type":"image"}]',
        '[{"type":"structured-content","content":[],"type":"unknown"}]',
        String.raw`[{"type":"text","text":"definition","ty\u0070e":"unknown"}]`,
        String.raw`[{"type":"image","path":"image.png","ty\u0070e":null}]`,
        '[{"type":"text""text":"definition"}]',
        '[{"type":"image":,"path":"image.png"}]',
        '[{"type":"structured-content"true,"content":[]}]',
    ])('rejects unsupported, overwritten, or malformed type values: %s', (glossary) => {
        expect(parse(row(glossary), true, true).count).toBeLessThan(0)
    })

    test('tracks image and text normalization hints for literal values', () => {
        expect(parse(row('[{"type":"image","path":"image.png"}]'), true, true).metadata.slice(14)).toEqual([1, 0, 0])
        expect(parse(row('[{"type":"text","text":"definition"}]'), true, true).metadata.slice(14)).toEqual([0, 1, 1])
        expect(parse(row('[{"type":"structured-content","content":[]}]'), true, true).metadata.slice(14)).toEqual([0, 0, 0])
    })
})
