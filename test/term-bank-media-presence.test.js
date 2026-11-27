/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterAll, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {typeof import('../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */
/** @typedef {Parameters<Parser['parseTermBankWithWasmColumnChunks']>[4]} Options */
/** @typedef {ReturnType<Parser['copyWasmBackedColumnChunk']>} Chunk */
/** @type {Parser} */
let parser
let legacyAbi = false
/** @type {Array<{status: number, before: number, after: number, zeroBefore: number, zeroAfter: number}>} */
const calls = []
const encoder = new TextEncoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
    const {exports} = await WebAssembly.instantiate(module)
    const memory = /** @type {WebAssembly.Memory} */ (exports.memory)
    const fusedParse = /** @type {(...args: number[]) => number} */ (exports.parse_and_encode_term_bank_token_binary_dedup)
    /** @type {(...args: number[]) => number} */
    const observeParse = (...args) => {
        const pointer = args[38]
        const before = new Uint32Array(memory.buffer, pointer, 1)[0]
        const zeroBefore = new Uint32Array(memory.buffer, 0, 1)[0]
        // Emulate an older WASM that ignores the appended output argument,
        // and an older caller that omits it when using the new WASM.
        const status = fusedParse(...(legacyAbi ? args.slice(0, 38) : args))
        calls.push({
            status,
            before,
            after: new Uint32Array(memory.buffer, pointer, 1)[0],
            zeroBefore,
            zeroAfter: new Uint32Array(memory.buffer, 0, 1)[0],
        })
        return status
    }
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({exports: {...exports, parse_and_encode_term_bank_token_binary_dedup: observeParse}})
    parser = await import('../ext/js/dictionary/term-bank-wasm-parser.js')
    parser.setTermBankWasmModule(module)
})

beforeEach(() => {
    legacyAbi = false
    calls.length = 0
})

afterAll(() => { vi.restoreAllMocks() })

/**
 * @param {string} expression
 * @param {unknown} [glossary]
 * @param {number} [score]
 * @returns {unknown[]}
 */
function row(expression, glossary = ['definition'], score = 1) {
    return [expression, '', '', '', score, glossary, 12, '']
}

/**
 * @param {string[]} banks
 * @param {Options} [options]
 * @returns {Promise<{chunks: Chunk[], profile: NonNullable<ReturnType<Parser['consumeLastTermBankWasmParseProfile']>>}>}
 */
async function parse(banks, options = {}) {
    /** @type {Chunk[]} */
    const chunks = []
    await parser.parseTermBankWithWasmColumnChunks(banks.map((bank) => encoder.encode(bank)), 3, (chunk) => {
        chunks.push(parser.copyWasmBackedColumnChunk(chunk))
    }, 2, {
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
        singleChunk: true,
        ...options,
    })
    const profile = parser.consumeLastTermBankWasmParseProfile()
    if (profile === null) { throw new Error('Missing parser profile') }
    return {chunks, profile}
}

/**
 * @param {Chunk[]} chunks
 * @returns {unknown[]}
 */
function columnsWithoutKeyByteLists(chunks) {
    return chunks.map(({expressionBytesList: _expressionBytesList, readingBytesList: _readingBytesList,
        preparedLookupIndexEncodeMs: _preparedLookupIndexEncodeMs, ...chunk}) => chunk)
}

describe('native media-presence summary', () => {
    test.each([false, true])('skips media-only projection without changing columns (singleChunk=%s)', async (singleChunk) => {
        const banks = [
            JSON.stringify([row('first'), row('second', ['different'])]),
            JSON.stringify([row('third', [{type: 'structured-content', content: {tag: 'span', content: 'plain'}}]), row('fourth')]),
        ]
        const skipped = await parse(banks, {singleChunk})
        expect(skipped.profile.fusedParseFallbacks).toBe(0)
        expect(skipped.profile.mediaHintRowsSkipped).toBe(4)
        expect(skipped.profile.rowDecodeMs).toBe(0)
        expect(skipped.chunks.flatMap((chunk) => chunk.mediaRows)).toEqual([])
        expect(calls[0].before).toBe(1)
        expect(calls[0].after).toBe(0)
        const projected = await parse(banks, {singleChunk, emitTermByteLists: true})
        expect(projected.profile.mediaHintRowsSkipped).toBe(0)
        expect(columnsWithoutKeyByteLists(skipped.chunks)).toStrictEqual(columnsWithoutKeyByteLists(projected.chunks))
    })

    test.each([
        '[{"type":"image","path":"direct.png"}]',
        '[{"ty\\u0070e":"im\\u0061ge","pa\\u0074h":"escaped.png"}]',
        '[{"type":"structured-content","content":{"tag":"div","content":["plain",{"tag":"img","path":"nested.png"}]}}]',
        '[{"type":"structured-content","content":{"tag":"i\\u006dg","path":"escaped-tag.png"}}]',
        '[{"type":"image","type":"text","text":"duplicate property"}]',
    ])('preserves mixed-bank media projection for %s', async (glossary) => {
        await parse([JSON.stringify([row('previous')]), '[]'])
        const banks = [JSON.stringify([row('plain')]), `[["image","","","",1,${glossary},12,""]]`]
        const actual = await parse(banks)
        expect(actual.profile.mediaHintRowsSkipped).toBe(0)
        expect(calls.at(-1)?.after).toBe(1)
        expect(actual.chunks[0].mediaRows.map(({index}) => index)).toEqual([1])
        legacyAbi = true
        const legacy = await parse(banks)
        expect(columnsWithoutKeyByteLists(actual.chunks)).toStrictEqual(columnsWithoutKeyByteLists(legacy.chunks))
    })

    test('retains media hints copied from validated duplicate glossaries', async () => {
        const glossary = [{type: 'structured-content', content: [{tag: 'img', path: 'shared.png'}, 'definition'.repeat(600)]}]
        const banks = [JSON.stringify([row('first', glossary)]), JSON.stringify([row('second', glossary)])]
        const actual = await parse(banks, {experimentalValidatedGlossaryReuse: true})
        expect(actual.profile.validatedGlossaryReuseCount).toBeGreaterThan(0)
        expect(actual.profile.mediaHintRowsSkipped).toBe(0)
        expect(actual.chunks[0].mediaRows).toHaveLength(1)
        legacyAbi = true
        const legacy = await parse(banks, {experimentalValidatedGlossaryReuse: true})
        expect(columnsWithoutKeyByteLists(actual.chunks)).toStrictEqual(columnsWithoutKeyByteLists(legacy.chunks))
    })

    test('keeps the scan when the native presence output is absent', async () => {
        const banks = [JSON.stringify([row('plain')]), '[]']
        const current = await parse(banks)
        legacyAbi = true
        const legacy = await parse(banks)
        expect(legacy.profile.mediaHintRowsSkipped).toBe(0)
        expect(columnsWithoutKeyByteLists(legacy.chunks)).toStrictEqual(columnsWithoutKeyByteLists(current.chunks))
        const call = calls.at(-1)
        expect(call?.after).toBe(1)
        expect(call?.zeroAfter).toBe(call?.zeroBefore)
    })

    test('does not claim absence when hint detection is disabled', async () => {
        const banks = [JSON.stringify([row('plain')]), '[]']
        await parse(banks)
        const disabled = await parse(banks, {mediaHintFastScan: false})
        expect(disabled.profile.mediaHintRowsSkipped).toBe(0)
        expect(calls.at(-1)?.after).toBe(1)
        expect((await parse(banks)).profile.mediaHintRowsSkipped).toBe(1)
    })

    test('discards absence from a prior parse when fused numeric fallback is required', async () => {
        await parse([JSON.stringify([row('previous')]), '[]'])
        const banks = [JSON.stringify([row('plain')]), JSON.stringify([row('fraction', [{type: 'image', path: 'fallback.png'}], 0.5)])]
        const actual = await parse(banks)
        expect(actual.profile.fusedParseFallbacks).toBe(1)
        expect(actual.profile.mediaHintRowsSkipped).toBe(0)
        expect(actual.chunks[0].mediaRows.map(({index}) => index)).toEqual([1])
        expect(calls.at(-1)?.status).toBe(-5)
        expect(calls.at(-1)?.after).toBe(1)
    })

    test.each([
        '[] trailing',
        '[["bad","","","",1,"not an array",12,""]]',
        '[["bad","","","",1,[{"type":"image",}],12,""]]',
        '[["bad","","","",1,[{"type":"image"}],12,""]]',
    ])('does not publish absence or rows for malformed later banks: %s', async (invalid) => {
        await parse([JSON.stringify([row('previous')]), '[]'])
        calls.length = 0
        await expect(parse([JSON.stringify([row('valid')]), invalid])).rejects.toThrow()
        for (const call of calls) {
            expect(call.status).toBeLessThan(0)
            expect(call.after).toBe(1)
        }
        expect((await parse([JSON.stringify([row('next')]), '[]'])).profile.mediaHintRowsSkipped).toBe(1)
    })
})
