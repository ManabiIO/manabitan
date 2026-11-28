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

/** @typedef {'parse_term_bank'|'parse_term_bank_with_media_hints'} NativeParseName */
/** @typedef {{memory: WebAssembly.Memory, wasm_reset_heap: () => void, wasm_alloc: (size: number) => number, parse_term_bank: (...args: number[]) => number, parse_term_bank_with_media_hints: (...args: number[]) => number}} NativeExports */
/** @type {NativeExports} */
let native

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    setTermBankWasmModule(module)
    native = /** @type {NativeExports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports))
})

const delimiterFields = ['"表現"', '"読み"', 'null', '"v1"', '0', '["meaning"]', '1', '"tag"']
const delimiterIndexes = Array.from({length: 7}, (_, index) => index)

/**
 * @param {number} field
 * @param {string} delimiter
 * @returns {string}
 */
function sourceWithDelimiter(field, delimiter) {
    return `[[${delimiterFields.slice(0, field + 1).join(',')}${delimiter}${delimiterFields.slice(field + 1).join(',')}]]`
}

/**
 * Call the actual strict native entry with a logical length independent of its
 * physical backing. Decode all published metadata against the source bytes.
 * @param {NativeParseName} entry
 * @param {string} source
 * @param {number} [logicalLength]
 * @returns {{count: number, rows: unknown[][]}}
 */
function parseNativeFields(entry, source, logicalLength) {
    const bytes = encoder.encode(source)
    native.wasm_reset_heap()
    const guard = 16
    const capacity = 4
    const metadataBytes = capacity * 17 * Uint32Array.BYTES_PER_ELEMENT
    const sourceBase = native.wasm_alloc(bytes.length + guard * 2)
    const metadataBase = native.wasm_alloc(metadataBytes + guard * 2)
    expect(sourceBase).toBeGreaterThan(0)
    expect(metadataBase).toBeGreaterThan(0)
    const sourceAllocation = new Uint8Array(native.memory.buffer, sourceBase, bytes.length + guard * 2)
    sourceAllocation.fill(0xa5)
    sourceAllocation.set(bytes, guard)
    const metadataAllocation = new Uint8Array(native.memory.buffer, metadataBase, metadataBytes + guard * 2)
    metadataAllocation.fill(0xcd)
    const count = native[entry](sourceBase + guard, logicalLength ?? bytes.length, metadataBase + guard, capacity, 0, 0, 1)
    expect(sourceAllocation.subarray(guard, guard + bytes.length)).toEqual(bytes)
    expect(sourceAllocation.subarray(0, guard)).toEqual(new Uint8Array(guard).fill(0xa5))
    expect(sourceAllocation.subarray(guard + bytes.length)).toEqual(new Uint8Array(guard).fill(0xa5))
    expect(metadataAllocation.subarray(0, guard)).toEqual(new Uint8Array(guard).fill(0xcd))
    expect(metadataAllocation.subarray(guard + metadataBytes)).toEqual(new Uint8Array(guard).fill(0xcd))
    expect(count).toBeLessThanOrEqual(capacity)
    const metadata = new Uint32Array(native.memory.buffer, metadataBase + guard, Math.max(0, count) * 17)
    /** @type {unknown[][]} */
    const rows = []
    for (let row = 0; row < count; ++row) {
        const base = row * 17
        /**
         * @param {number} start
         * @param {number} length
         * @returns {unknown}
         */
        const token = (start, length) => JSON.parse(decoder.decode(bytes.subarray(start, start + length)))
        /**
         * @param {number} start
         * @returns {unknown}
         */
        const scalar = (start) => {
            const tail = decoder.decode(bytes.subarray(start))
            const end = tail.search(/[,\]} \t\r\n]/u)
            expect(end).toBeGreaterThan(0)
            return JSON.parse(tail.slice(0, end))
        }
        rows.push([
            token(metadata[base], metadata[base + 1]),
            token(metadata[base + 2], metadata[base + 3]),
            token(metadata[base + 4], metadata[base + 5]),
            token(metadata[base + 6], metadata[base + 7]),
            scalar(metadata[base + 8]),
            token(metadata[base + 9], metadata[base + 10]),
            metadata[base + 11] === 0xffffffff ? null : scalar(metadata[base + 11]),
            token(metadata[base + 12], metadata[base + 13]),
        ])
    }
    return {count, rows}
}

const nativeEntries = /** @type {NativeParseName[]} */ (['parse_term_bank', 'parse_term_bank_with_media_hints'])
describe.each(nativeEntries)('%s strict field delimiters', (entry) => {
    test.each(delimiterIndexes)('preserves every independent JSON whitespace combination at field %i', (field) => {
        for (const before of ['', ' ', '\t', '\n', '\r']) {
            for (const after of ['', ' ', '\t', '\n', '\r']) {
                const source = sourceWithDelimiter(field, `${before},${after}`)
                const actual = parseNativeFields(entry, source)
                expect(actual.count).toBe(1)
                expect(actual.rows).toStrictEqual(JSON.parse(source))
            }
        }
    })

    test.each(delimiterIndexes)('matches independent JSON grammar for every ASCII boundary byte at field %i', (field) => {
        for (let code = 0; code < 128; ++code) {
            const character = String.fromCharCode(code)
            for (const delimiter of [`${character},`, `,${character}`]) {
                const source = sourceWithDelimiter(field, delimiter)
                /** @type {unknown} */
                let expected
                try { expected = JSON.parse(source) } catch { /* Malformed JSON must fail natively too. */ }
                const actual = parseNativeFields(entry, source)
                if (typeof expected === 'undefined') {
                    expect(actual.count).toBe(-1)
                } else {
                    expect(actual.count).toBe(1)
                    expect(actual.rows).toStrictEqual(expected)
                }
            }
        }
    })

    test('rejects Unicode whitespace outside the JSON whitespace set on either side', () => {
        for (const field of delimiterIndexes) {
            for (const whitespace of ['\u00a0', '\u2028', '\u2029', '\ufeff']) {
                for (const delimiter of [`${whitespace},`, `,${whitespace}`]) {
                    const source = sourceWithDelimiter(field, delimiter)
                    expect(() => JSON.parse(source)).toThrow()
                    expect(parseNativeFields(entry, source).count).toBe(-1)
                }
            }
        }
    })

    test.each(delimiterIndexes)('rejects missing and repeated field separators at field %i', (field) => {
        for (const delimiter of ['', ',,', ' \t,\r,\n']) {
            expect(parseNativeFields(entry, sourceWithDelimiter(field, delimiter)).count).toBe(-1)
        }
    })

    test.each(delimiterIndexes)('respects logical EOF at field %i with a valid physical suffix', (field) => {
        const prefixLength = encoder.encode(`[[${delimiterFields.slice(0, field + 1).join(',')}`).length
        for (const delimiter of [',', ', ', ',\t\r\n', ' \r\n,\t ']) {
            const source = sourceWithDelimiter(field, delimiter)
            expect(parseNativeFields(entry, source).count).toBe(1)
            for (let length = prefixLength; length <= prefixLength + delimiter.length; ++length) {
                expect(parseNativeFields(entry, source, length).count).toBe(-1)
            }
        }
    })

    test('rejects empty logical input despite a complete physical row', () => {
        const source = sourceWithDelimiter(0, ',')
        expect(parseNativeFields(entry, source, 0).count).toBe(-1)
        expect(parseNativeFields(entry, source).rows).toStrictEqual(JSON.parse(source))
    })
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
