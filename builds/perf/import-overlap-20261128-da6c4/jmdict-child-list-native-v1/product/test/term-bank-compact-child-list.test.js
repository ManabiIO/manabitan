/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (source: number, length: number, metadata: number, capacity: number, spans: number, banks: number, strict: number) => number}} NativeParser */

/** @type {NativeParser} */
let native
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const bytes = await readFile(new URL('../dev/data/dictionary-wasm/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(bytes, {})
    native = /** @type {NativeParser} */ (/** @type {unknown} */ (instance.exports))
})

/** @param {string|string[]} text @returns {string} */
function list(text) {
    const leaf = (/** @type {string} */ value) => ({content: value, tag: 'li'})
    return JSON.stringify({content: typeof text === 'string' ? leaf(text) : text.map(leaf),
        data: {content: 'glossary'},
        lang: 'en',
        style: {listStyleType: 'circle'},
        tag: 'ul'})
}

/** @param {string} content @returns {string} */
function glossary(content) { return `[{"content":${content},"type":"structured-content"}]` }

/**
 * Read native metadata before the next call reuses the heap. A following row
 * checks that recognizing a child leaves its parent and row cursors intact.
 * @param {string} value
 * @param {boolean} [strict]
 * @returns {{count: number, glossary?: string, hints?: number[], following?: string}}
 */
function parse(value, strict = true) {
    const bytes = encoder.encode(`[["first","",null,"",0,${value},1,""],["following","",null,"",0,["tail"],2,""]]`)
    native.wasm_reset_heap()
    const source = native.wasm_alloc(bytes.length)
    const metadata = native.wasm_alloc(2 * 17 * 4)
    new Uint8Array(native.memory.buffer, source, bytes.length).set(bytes)
    const count = native.parse_term_bank_with_media_hints(source, bytes.length, metadata, 2, 0, 0, strict ? 1 : 0)
    if (count < 0) { return {count} }
    const words = new Uint32Array(native.memory.buffer, metadata, count * 17)
    return {count,
        glossary: decoder.decode(bytes.subarray(words[9], words[9] + words[10])),
        hints: Array.from(words.subarray(14, 17)),
        following: decoder.decode(bytes.subarray(words[17], words[17] + words[18]))}
}

describe('compact lists nested in general glossary grammar', () => {
    test.each([
        ['definition'],
        ['quoted " text', 'slash \\', '日本語'],
    ])('preserves list bytes and sibling transitions for %j', (...texts) => {
        const item = list(texts)
        for (const content of [`[${item},{"tag":"span","content":"note"}]`, `[{"tag":"span","content":"note"},${item}]`, `[${item},${item}]`]) {
            const value = glossary(content)
            expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
        }
    })

    test('preserves a single leaf object and escaped leaf text', () => {
        const value = glossary(`[${list('a\nb')},"sibling"]`)
        expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
    })

    test('finishes a matched child inside an object value before its next key', () => {
        const value = glossary(`[{"other":${list('definition')},"tag":"span"},"sibling"]`)
        expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
    })

    test.each(['image', 'img', '\\u0069mage', '\\u0069mg'])('keeps conservative media hints for %s', (marker) => {
        const item = list(['placeholder', 'ordinary']).replace('placeholder', marker)
        const value = glossary(`[${item},"sibling"]`)
        expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [1, 0, 0], following: '"following"'})
    })

    test('preserves media and normalization hints from siblings before and after a compact child', () => {
        const item = list('definition')
        for (const content of [`[ {"tag":"img","path":"image.webp"},${item}]`, `[${item}, {"tag":"img","path":"image.webp"}]`]) {
            const value = glossary(content)
            expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [1, 1, 0], following: '"following"'})
        }
    })

    test('preserves text-normalization hints around a matched child', () => {
        const item = list('definition')
        for (const content of [`[{"type":"text","text":"note"},${item}]`, `[${item},{"type":"text","text":"note"}]`]) {
            const value = glossary(content)
            expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 1, 1], following: '"following"'})
        }
    })

    test.each([
        (/** @type {string} */ value) => value.replace('"lang":"en"', '"lang":"ja"'),
        (/** @type {string} */ value) => value.replace('"circle"', '"disc"'),
        (/** @type {string} */ value) => value.replace('"tag":"li"', '"tag":"span"'),
        (/** @type {string} */ value) => value.replace('"data":', '"extra":0,"data":'),
        (/** @type {string} */ value) => value.replace('"content":"definition","tag":"li"', '"tag":"li","content":"definition"'),
        (/** @type {string} */ value) => value.replace('"definition"', '{"tag":"span","content":"definition"}'),
    ])('retains the generic parser for changed child shapes %#', (change) => {
        const value = glossary(`[${change(list('definition'))},"sibling"]`)
        expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
    })

    test.each([
        (/** @type {string} */ value) => value.replace('definition', 'bad\\q'),
        (/** @type {string} */ value) => value.replace(',"tag":"li"', '"tag":"li"'),
        (/** @type {string} */ value) => value.replace('"tag":"ul"}', '"tag":"ul",}'),
        (/** @type {string} */ value) => value.replace('"circle"}', '"circle"]'),
    ])('rejects malformed children after a probe fails %#', (change) => {
        expect(parse(glossary(`[${change(list('definition'))},"sibling"]`)).count).toBe(-1)
    })

    test('does not mistake a child list for a valid top-level glossary object', () => {
        const value = `[${list('definition')}]`
        expect(parse(value).count).toBe(-1)
        expect(parse(value, false)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
    })

    test('retains outer required-field checks and duplicate type semantics', () => {
        const content = `[${list('definition')},"sibling"]`
        for (const {value, hints} of [
            {value: `[{"type":"structured-content","content":${content}}]`, hints: [0, 0, 0]},
            {value: `[{"type":"text","content":${content},"type":"structured-content"}]`, hints: [0, 1, 1]},
        ]) {
            expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints, following: '"following"'})
        }
        for (const value of [
            `[{"content":${content}}]`,
            `[{"type":"structured-content","content":${content},"type":"text"}]`,
            `[{"type":"structured-content","content":${content},"content":null}]`,
        ]) {
            expect(parse(value).count).toBe(-1)
        }
    })

    test('rejects a child truncated at every closing-suffix byte', () => {
        const child = list(['first', 'second'])
        const suffixStart = child.indexOf(',"data":')
        expect(suffixStart).toBeGreaterThan(0)
        for (let end = suffixStart; end < child.length; end++) {
            expect(parse(glossary(`[${child.slice(0, end)},"sibling"]`)).count, `child end ${end}`).toBe(-1)
        }
    })

    test.each([
        {content: list('single'), allowedWrappers: 252},
        {content: list(['first', 'second']), allowedWrappers: 251},
    ])('preserves the exact nesting limit with $allowedWrappers wrappers', ({content, allowedWrappers}) => {
        const value = glossary('['.repeat(allowedWrappers) + content + ']'.repeat(allowedWrappers))
        expect(parse(value)).toStrictEqual({count: 2, glossary: value, hints: [0, 0, 0], following: '"following"'})
        const tooDeep = glossary('['.repeat(allowedWrappers + 1) + content + ']'.repeat(allowedWrappers + 1))
        expect(parse(tooDeep).count).toBe(-1)
    })
})
