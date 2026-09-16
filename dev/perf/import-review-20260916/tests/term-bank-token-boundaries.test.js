/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {setTermBankWasmModule, parseTermBankWithWasmColumnChunks} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {decodeRawTermContentTokenBinary} from '../ext/js/dictionary/raw-term-content.js'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** @typedef {[string, string, string, string, number, unknown[], number, string]} Row */
/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {{expression: string, reading: string, same: boolean, score: number, sequence: number, content: ReturnType<typeof decodeRawTermContentTokenBinary>}} Snapshot */

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    setTermBankWasmModule(await WebAssembly.compile(bytes))
})

/**
 * @param {Chunk} chunk
 * @returns {Snapshot[]}
 */
function snapshot(chunk) {
    const plan = chunk.termRecordPreinternedPlan
    const offsets = plan.stringOffsets ?? new Uint32Array(plan.stringLengths.length)
    if (!(plan.stringOffsets instanceof Uint32Array)) {
        let offset = 0
        for (let i = 0; i < offsets.length; ++i) {
            offsets[i] = offset
            offset += plan.stringLengths[i]
        }
    }
    /**
     * @param {number} index
     * @returns {string}
     */
    const key = (index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index]))
    if (!(chunk.contentBytesBuffer instanceof Uint8Array) || !(chunk.contentMetaList instanceof Uint32Array)) {
        throw new Error('Missing native content slab')
    }
    const {contentBytesBuffer, contentMetaList} = chunk
    return Array.from({length: chunk.rowCount}, (_, i) => {
        const start = contentMetaList[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
        const length = contentMetaList[i * 4 + 1]
        expect(start).toBeGreaterThanOrEqual(0)
        expect(length).toBeLessThanOrEqual(contentBytesBuffer.length - start)
        const bytes = contentBytesBuffer.subarray(start, start + length)
        expect(hashTermEntryContentBytesPair(bytes)).toEqual([contentMetaList[i * 4 + 2], contentMetaList[i * 4 + 3]])
        return {expression: key(plan.expressionIndexes[i]),
            reading: key(plan.readingIndexes[i]),
            same: chunk.readingEqualsExpressionList[i] !== 0,
            score: chunk.scoreList[i],
            sequence: chunk.sequenceList[i],
            content: decodeRawTermContentTokenBinary(bytes, decoder)}
    })
}

/**
 * Multi-bank input reaches the fused native parser without enabling experiments.
 * A small chunk also exercises the separate metadata/string-plan fallback path.
 * @param {Row[]} rows
 * @param {boolean} fused
 * @param {boolean} [escapedUnicode]
 * @returns {Promise<Snapshot[]>}
 */
async function parse(rows, fused, escapedUnicode = false) {
    /**
     * @param {Row[]} values
     * @returns {Uint8Array}
     */
    const encode = (values) => encoder.encode(escapedUnicode ? JSON.stringify(values).replaceAll('日', '\\u65e5') : JSON.stringify(values))
    const split = Math.floor(rows.length / 2)
    const input = fused ? [encode(rows.slice(0, split)), encode(rows.slice(split))] : encode(rows)
    /** @type {Snapshot[]} */
    const output = []
    await parseTermBankWithWasmColumnChunks(input, 3, (chunk) => { output.push(...snapshot(chunk)) }, fused ? Math.max(1, rows.length) : 7, {
        singleChunk: fused,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        computeContentHashes: true,
        mediaHintFastScan: true,
        prepareLookupIndexes: false,
    })
    return output
}

/**
 * @param {Row[]} rows
 * @returns {Snapshot[]}
 */
function expected(rows) {
    return rows.map(([expression, reading, definitionTags, rules, score, glossary, sequence, termTags]) => ({
        expression,
        reading: reading || expression,
        same: reading === '' || reading === expression,
        score,
        sequence,
        content: {definitionTags, rules, termTags, glossaryJson: JSON.stringify(glossary)},
    }))
}

describe('native token and dedup comparison boundaries', () => {
    test.each([false, true])('preserves every mismatching key byte around word tails (fused=%s)', async (fused) => {
        /** @type {Row[]} */
        const rows = []
        for (let length = 1; length <= 33; ++length) {
            const key = 'a'.repeat(length)
            for (let position = 0; position < length; ++position) {
                const reading = `${key.slice(0, position)}b${key.slice(position + 1)}`
                rows.push([key, reading, '', '', position, ['unchanged'], rows.length, ''], [reading, key, '', '', -position || 0, ['unchanged'], rows.length, ''])
            }
            rows.push([key, key, '', '', 0, ['unchanged'], rows.length, ''], [key, '', '', '', 0, ['unchanged'], rows.length, ''])
        }
        expect(await parse(rows, fused)).toEqual(expected(rows))
    })

    test.each([false, true])('keeps near-identical glossary/rules/tags distinct (fused=%s)', async (fused) => {
        /** @type {Row[]} */
        const rows = []
        for (let length = 1; length <= 33; ++length) {
            const value = 'x'.repeat(length)
            for (let position = 0; position < length; ++position) {
                const changed = `${value.slice(0, position)}y${value.slice(position + 1)}`
                /** @type {Row} */
                const original = ['entry', '', value, value, 0, [value], 1, value]
                for (const column of [2, 3, 5, 7]) {
                    /** @type {Row} */
                    const near = [...original]
                    switch (column) {
                        case 2: near[2] = changed; break
                        case 3: near[3] = changed; break
                        case 5: near[5] = [changed]; break
                        default: near[7] = changed; break
                    }
                    // Consecutive near matches exercise the recent-content window,
                    // including differences outside the first/middle/last signature.
                    rows.push(original, near, original, near)
                }
            }
        }
        expect(await parse(rows, fused)).toEqual(expected(rows))
    })

    test.each([false, true])('preserves escaped and multibyte keys at every word lane (fused=%s)', async (fused) => {
        /** @type {Row[]} */
        const rows = []
        for (let padding = 0; padding < 24; ++padding) {
            for (const value of ['\\', '"', '\n', '\t', '\u0000', '日本🙂', '\\"日']) {
                const key = `${'x'.repeat(padding)}${value}end`
                rows.push([key, `${key}different`, '', '', padding, ['definition'], rows.length, ''], [key, key, '', '', padding, ['definition'], rows.length, ''], [key, '', '', '', padding, ['definition'], rows.length, ''])
            }
        }
        expect(await parse(rows, fused)).toEqual(expected(rows))
        expect(await parse(rows, fused, true)).toEqual(expected(rows))
    })

    test.each([false, true])('retains empty, short and long glossary signatures (fused=%s)', async (fused) => {
        /** @type {Row[]} */
        const rows = []
        for (let length = 0; length <= 64; ++length) {
            for (const glossary of [[], [''], ['x'.repeat(length)], ['日'.repeat(length)], [length]]) {
                rows.push(['entry', 'reading', '', '', -2147483648, glossary, 2147483647, ''], ['other', 'reading', '', '', 2147483647, glossary, -2147483648, ''])
            }
        }
        expect(await parse(rows, fused)).toEqual(expected(rows))
    })
})
