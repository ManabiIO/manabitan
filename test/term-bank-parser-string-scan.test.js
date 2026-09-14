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
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test} from 'vitest'

/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank_with_media_hints: (...args: number[]) => number, inflate_and_join_term_banks: (...args: number[]) => number}} ParserExports */
/** @type {ParserExports} */
let wasm
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    const instance = await WebAssembly.instantiate(module)
    wasm = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * The adjacent allocation deliberately contains quotes/brackets. A truncated
 * input must not accidentally become valid by scanning beyond its logical end.
 * @param {string} source
 * @returns {{count: number, spans: number[], bytes: Uint8Array}}
 */
function parse(source) {
    const bytes = encoder.encode(source)
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(bytes.length)
    const adjacent = wasm.wasm_alloc(64)
    const output = wasm.wasm_alloc(68)
    const heap = new Uint8Array(wasm.memory.buffer)
    heap.fill(0x22, input, adjacent + 64)
    heap.set(bytes, input)
    const count = wasm.parse_term_bank_with_media_hints(input, bytes.length, output, 1)
    return {count, spans: [...new Uint32Array(wasm.memory.buffer, output, 17)], bytes}
}

/**
 * @param {ReturnType<typeof parse>} result
 * @param {number} offset
 * @returns {unknown}
 */
function readSpan(result, offset) {
    const start = result.spans[offset]
    return JSON.parse(decoder.decode(result.bytes.subarray(start, start + result.spans[offset + 1])))
}

/**
 * @param {ReturnType<typeof parse>} result
 * @returns {unknown[]}
 */
function readRow(result) {
    return [
        readSpan(result, 0),
        readSpan(result, 2),
        readSpan(result, 4),
        readSpan(result, 6),
        result.spans[8] | 0,
        readSpan(result, 9),
        result.spans[11] | 0,
        readSpan(result, 12),
    ]
}

/**
 * Uses the platform JSON parser as an independent acceptance and row-value
 * oracle for the public WASM parser.
 * @param {string} source
 */
function expectMatchesJson(source) {
    let expected
    try {
        expected = JSON.parse(source)
    } catch {
        expected = null
    }
    const result = parse(source)
    if (expected === null) {
        expect(result.count).toBeLessThan(0)
        return
    }
    expect(result.count).toBe(expected.length)
    expect(result.count).toBe(1)
    expect(readRow(result)).toEqual(expected[0])
}

/**
 * @param {string} expressionToken
 * @param {number} alignment
 * @returns {string}
 */
function createRowSource(expressionToken, alignment) {
    return `${' '.repeat(alignment)}[[${expressionToken},"reading","noun","rule",-42,[${expressionToken}],99,"common"]]`
}

const alignments = Array.from({length: 64}, (_, index) => index)
const differentialAlignments = Array.from({length: 16}, (_, index) => index)
const specialPositions = Array.from({length: 16}, (_, index) => index)

describe('term-bank string scanning', () => {
    test.each(alignments)('preserves string spans at byte alignment %i', (padding) => {
        const values = [
            '',
            'a',
            'a'.repeat(15),
            'a'.repeat(16),
            'a'.repeat(17),
            'a'.repeat(64),
            '日本語と🙂',
            '\\"/\b\f\n\r\t',
            '\u0000\u001f',
            'é\u0080\u07ff\u0800',
        ]
        for (const value of values) {
            const word = `${'x'.repeat(padding)}${value}`
            const row = [word, value, 'noun', '', -42, [value, {type: 'text', text: word}], 99, 'common']
            const result = parse(`${' '.repeat(padding)}${JSON.stringify([row])}`)
            expect(result.count).toBe(1)
            expect(readSpan(result, 0)).toBe(word)
            expect(readSpan(result, 2)).toBe(value)
            expect(readSpan(result, 9)).toEqual(row[5])
        }
    })

    test.each(alignments)('handles escaped Unicode and quotes across boundary %i', (padding) => {
        const prefix = 'x'.repeat(padding)
        const token = `"${prefix}\\u65e5\\u672c\\uD83D\\uDE42\\\\\\"end"`
        const result = parse(`[[${token},"","","",0,[${token}],1,""]]`)
        expect(result.count).toBe(1)
        expect(readSpan(result, 0)).toBe(`${prefix}日本🙂\\"end`)
        expect(readSpan(result, 9)).toEqual([`${prefix}日本🙂\\"end`])
    })

    test.each(alignments)('rejects unescaped controls at boundary %i', (padding) => {
        for (let control = 0; control < 32; ++control) {
            const source = `[["${'a'.repeat(padding)}${String.fromCharCode(control)}b","","","",0,["x"],1,""]]`
            expect(parse(source).count).toBeLessThan(0)
        }
    })

    test.each(alignments)('rejects truncated and invalid escapes at boundary %i', (padding) => {
        const prefix = `[["${'x'.repeat(padding)}`
        for (const ending of ['', '\\', '\\u', '\\u0', '\\u00', '\\u000']) {
            expect(parse(prefix + ending).count).toBeLessThan(0)
        }
        for (const escape of ['\\q', '\\u00xz', '\\u-001', '\\u 000', '\\U0001']) {
            expect(parse(`${prefix}${escape}","","","",0,[],1,""]]`).count).toBeLessThan(0)
        }
    })

    test('differentially handles quotes, escapes, Unicode runs, and every 16-byte position/alignment', () => {
        const escapes = ['\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t', '\\u65e5']
        const unicodeRuns = ['é'.repeat(19), '日本語'.repeat(11), '🙂'.repeat(13), 'é日🙂'.repeat(9)]
        for (const alignment of differentialAlignments) {
            for (const position of specialPositions) {
                const prefix = 'a'.repeat(position)
                expectMatchesJson(createRowSource(`"${prefix}"`, alignment))
                expectMatchesJson(createRowSource(`"${prefix}${escapes[(alignment + position) % escapes.length]}tail"`, alignment))
                expectMatchesJson(createRowSource(`"${prefix}${unicodeRuns[(alignment + position) % unicodeRuns.length]}tail"`, alignment))
            }
        }
    })

    test('differentially rejects every raw control byte at every 16-byte position/alignment', () => {
        for (const alignment of differentialAlignments) {
            for (const position of specialPositions) {
                const prefix = 'a'.repeat(position)
                for (let control = 0; control < 0x20; ++control) {
                    expectMatchesJson(createRowSource(`"${prefix}${String.fromCharCode(control)}tail"`, alignment))
                }
            }
        }
    })

    test('differentially rejects malformed escapes and bounded end-of-buffer tails', () => {
        const malformedEscapes = ['\\q', '\\U0001', '\\u', '\\u0', '\\u00', '\\u000', '\\u00xz', '\\u-001', '\\u 000', '\\]']
        for (const alignment of differentialAlignments) {
            for (const position of specialPositions) {
                const prefix = 'a'.repeat(position)
                const malformedEscape = malformedEscapes[(alignment + position) % malformedEscapes.length]
                expectMatchesJson(createRowSource(`"${prefix}${malformedEscape}tail"`, alignment))
                for (let tailLength = 0; tailLength < 8; ++tailLength) {
                    expectMatchesJson(`${' '.repeat(alignment)}[["${prefix}${'z'.repeat(tailLength)}`)
                }
            }
        }
    })

    test('stops at the real first special when byte-mask borrows mark later bytes', () => {
        for (const alignment of differentialAlignments) {
            for (const position of specialPositions) {
                const prefix = 'a'.repeat(position)
                expectMatchesJson(`${' '.repeat(alignment)}[["${prefix}"#`)
                expectMatchesJson(createRowSource(`"${prefix}\\]tail"`, alignment))
                expectMatchesJson(createRowSource(`"${prefix}${String.fromCharCode(0x1f)} tail"`, alignment))
            }
        }
    })
})

/**
 * @typedef {{source: string, method: 0|8}} JoinSource
 */

/**
 * Reproduces the original compact join byte-for-byte without parsing JSON.
 * @param {string[]} sources
 * @returns {Uint8Array}
 */
function referenceJoin(sources) {
    const whitespace = new Set([0x20, 0x09, 0x0a, 0x0d])
    const contents = sources.map((source) => {
        const bytes = encoder.encode(source)
        let start = 0
        let end = bytes.length
        while (start < end && whitespace.has(bytes[start])) { ++start }
        while (end > start && whitespace.has(bytes[end - 1])) { --end }
        expect(bytes[start]).toBe(0x5b)
        expect(bytes[end - 1]).toBe(0x5d)
        ++start
        --end
        while (start < end && whitespace.has(bytes[start])) { ++start }
        while (end > start && whitespace.has(bytes[end - 1])) { --end }
        return bytes.subarray(start, end)
    }).filter((bytes) => bytes.length > 0)
    const length = contents.reduce((sum, bytes) => sum + bytes.length, 2 + Math.max(0, contents.length - 1))
    const result = new Uint8Array(length)
    let cursor = 0
    result[cursor++] = 0x5b
    for (let i = 0; i < contents.length; ++i) {
        if (i > 0) { result[cursor++] = 0x2c }
        result.set(contents[i], cursor)
        cursor += contents[i].length
    }
    result[cursor] = 0x5d
    return result
}

/**
 * @param {JoinSource[]} sources
 * @param {{capacity?: number, corruptCrcAt?: number, trailingDeflateAt?: number, truncateAt?: number}} [options]
 * @returns {{status: number, output: Uint8Array}}
 */
function inflateAndJoin(sources, options = {}) {
    const buffers = sources.map(({source}) => encoder.encode(source))
    const payloads = buffers.map((bytes, index) => {
        const payload = sources[index].method === 8 ? deflateRawSync(bytes) : bytes
        if (options.trailingDeflateAt === index) {
            return Buffer.concat([payload, Buffer.from([0xa5])])
        }
        if (options.truncateAt === index) {
            return payload.subarray(0, -1)
        }
        return payload
    })
    const inputLength = payloads.reduce((sum, bytes) => sum + bytes.length, 0)
    const capacity = options.capacity ?? buffers.reduce((sum, bytes) => sum + bytes.length, 2)
    wasm.wasm_reset_heap()
    const input = wasm.wasm_alloc(inputLength)
    const offsets = wasm.wasm_alloc(sources.length * 4)
    const compressedLengths = wasm.wasm_alloc(sources.length * 4)
    const uncompressedLengths = wasm.wasm_alloc(sources.length * 4)
    const methods = wasm.wasm_alloc(sources.length * 4)
    const checksums = wasm.wasm_alloc(sources.length * 4)
    const outputBlock = wasm.wasm_alloc(capacity + 64)
    const output = outputBlock + 32
    const heap = new Uint8Array(wasm.memory.buffer)
    const words = new Uint32Array(wasm.memory.buffer)
    let cursor = 0
    for (let i = 0; i < sources.length; ++i) {
        heap.set(payloads[i], input + cursor)
        words[offsets / 4 + i] = cursor
        words[compressedLengths / 4 + i] = payloads[i].length
        words[uncompressedLengths / 4 + i] = buffers[i].length
        words[methods / 4 + i] = sources[i].method
        words[checksums / 4 + i] = crc32(buffers[i]) ^ (options.corruptCrcAt === i ? 1 : 0)
        cursor += payloads[i].length
    }
    heap.fill(0xa5, outputBlock, output + capacity + 32)
    const length = wasm.inflate_and_join_term_banks(
        input,
        inputLength,
        offsets,
        compressedLengths,
        uncompressedLengths,
        methods,
        checksums,
        sources.length,
        output,
        capacity,
    )
    expect([...heap.subarray(outputBlock, output)]).toEqual(new Array(32).fill(0xa5))
    expect([...heap.subarray(output + capacity, output + capacity + 32)]).toEqual(new Array(32).fill(0xa5))
    return {status: length, output: heap.slice(output, output + Math.max(0, length))}
}

describe('term-bank join integrity', () => {
    test.each([0, 8])('preserves bytes and source order for compression method %i', (method) => {
        for (const padding of alignments) {
            const value = JSON.stringify(['x'.repeat(padding), '日本語', '\\"'])
            const whitespace = ' '.repeat(padding)
            const sources = ['[]', `${whitespace}[ ${value} ]\n`, '[ ]', `[${value}]`, '[]']
            const result = inflateAndJoin(sources.map((source) => ({source, method: /** @type {0|8} */ (method)})))
            expect(result.status).toBe(referenceJoin(sources).length)
            expect(result.output).toEqual(referenceJoin(sources))
        }
    })

    test.each([0, 8])('handles all-empty arrays for compression method %i', (method) => {
        const sources = ['[]', ' \n[ \t ]\r', '[]']
        const result = inflateAndJoin(sources.map((source) => ({source, method: /** @type {0|8} */ (method)})))
        expect(result.output).toEqual(referenceJoin(sources))
    })

    test.each([0, 8])('preserves join copies at overlap boundaries using method %i', (method) => {
        /** @type {Array<{distance: number, wrap: (content: string) => string}>} */
        const wrappers = [
            {distance: 0, wrap: (content) => `[${content}]`},
            {distance: 1, wrap: (content) => `[ ${content}\t]`},
            {distance: 2, wrap: (content) => `\r[\n${content}\t ]`},
        ]
        for (const contentLength of [16, 32, 64]) {
            const content = JSON.stringify('x'.repeat(contentLength - 2))
            expect(encoder.encode(content)).toHaveLength(contentLength)
            for (const {distance, wrap} of wrappers) {
                const sources = ['["prefix"]', wrap(content)]
                expect(encoder.encode(sources[1]).indexOf(encoder.encode(content)[0]) - 1).toBe(distance)
                const result = inflateAndJoin(sources.map((source) => ({source, method: /** @type {0|8} */ (method)})))
                expect(result.output).toEqual(referenceJoin(sources))
            }
        }
    })

    test('matches the reference for mixed STORE/DEFLATE banks and arbitrary array values', () => {
        const hugeValue = 'plain-bank-value'.repeat(65536)
        const sources = [
            {source: ' \n[]\t', method: /** @type {const} */ (0)},
            {source: '[1,{"nested":[true,false,null,{"text":"日本語"}]},"first"]', method: /** @type {const} */ (0)},
            {source: '[ ]', method: /** @type {const} */ (8)},
            {source: `\r\n["${hugeValue}"] \t`, method: /** @type {const} */ (0)},
            {source: '[{"last":3},[4,5]]', method: /** @type {const} */ (8)},
            {source: '[]', method: /** @type {const} */ (0)},
        ]
        const result = inflateAndJoin(sources)
        const expected = referenceJoin(sources.map(({source}) => source))
        expect(result.status).toBe(expected.length)
        expect(result.output).toEqual(expected)
    })

    test('preserves the conservative capacity boundary', () => {
        const sources = [{source: '["value"]', method: /** @type {const} */ (0)}]
        const admittedCapacity = encoder.encode(sources[0].source).length + 1
        const result = inflateAndJoin(sources, {capacity: admittedCapacity})
        expect(result.output).toEqual(referenceJoin(sources.map(({source}) => source)))
        expect(inflateAndJoin(sources, {capacity: admittedCapacity - 1}).status).toBe(-1)
    })

    test('rejects CRC failure, trailing DEFLATE bytes, truncation, and non-array input', () => {
        const deflated = [{source: '[{"valid":true}]', method: /** @type {const} */ (8)}]
        expect(inflateAndJoin(deflated, {corruptCrcAt: 0}).status).toBe(-4)
        expect(inflateAndJoin(deflated, {trailingDeflateAt: 0}).status).toBe(-6)
        expect(inflateAndJoin(deflated, {truncateAt: 0}).status).toBe(-2)
        expect(inflateAndJoin([{source: '{"not":"array"}', method: 0}]).status).toBe(-5)
    })
})
