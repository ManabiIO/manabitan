/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * The full column projection remains an independent reference for fused media
 * selection. Copy each result before the parser can recycle its shared heap.
 * @param {string[]} banks
 * @param {boolean} fullProjection
 * @param {Parameters<typeof parseTermBankWithWasmColumnChunks>[4]} [options]
 * @returns {Promise<{chunks: ReturnType<typeof copyWasmBackedColumnChunk>[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(banks, fullProjection, options = {}) {
    /** @type {ReturnType<typeof copyWasmBackedColumnChunk>[]} */
    const chunks = []
    await parseTermBankWithWasmColumnChunks(banks.map((bank) => encoder.encode(bank)), 3, (chunk) => {
        const stable = copyWasmBackedColumnChunk(chunk)
        stable.expressionBytesList = []
        stable.readingBytesList = []
        stable.preparedLookupIndexEncodeMs = 0
        chunks.push(stable)
    }, 2, {
        singleChunk: true,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: fullProjection,
        mediaHintFastScan: true,
        prepareLookupIndexes: true,
        validateGlossaryTypes: true,
        experimentalNativeEscapedKeys: true,
        ...options,
    })
    return {chunks, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {string} glossary
 * @param {number} [index]
 * @param {string} [score]
 * @returns {string}
 */
function row(glossary, index = 0, score = String(index)) {
    return `["term-${index}","reading-${index}","","",${score},${glossary},${index},""]`
}

describe('fused whole-group media projection', () => {
    test('keeps the first hinted raw row when an earlier canonical row has no hint', async () => {
        const banks = [
            `[${row('["plain"]')}]`,
            `[${row('[{"type":"image","type":"text","text":"plain"}]', 1)},${row('[{"type":"image","type":"text","text":"plain"}]', 2)}]`,
        ]
        const actual = await parse(banks, false)
        expect(actual.chunks).toStrictEqual((await parse(banks, true)).chunks)
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
        const [chunk] = actual.chunks
        expect(chunk.contentUniqueIndexList).toEqual(new Uint32Array([0, 0, 0]))
        expect(chunk.contentDedupPlan.uniqueRowIndexes).toEqual(new Uint32Array([0]))
        expect(chunk.mediaRows).toHaveLength(1)
        expect(chunk.mediaRows[0].index).toBe(1)
        expect(chunk.mediaRows[0].row.glossaryMayContainMedia).toBe(true)
    })

    test.each([false, true])('preserves raw hint order, escapes and exact-content dedupe (strict=%s)', async (strict) => {
        const glossary = '[{"type":"structured-content","content":[{"tag":"img","path":"画像.webp"},"text"]}]'
        const banks = [
            `[${row('["plain"]')},${row(glossary, 1)},${row('["img"]', 2)}]`,
            `[${row(glossary.replace('"img"', '"\\u0069mg"'), 3)},${row('[{"type":"image","path":"second.png","width":12.5}]', 4)},${row(glossary, 5)}]`,
        ]
        const options = {validateGlossaryTypes: strict}
        const actual = await parse(banks, false, options)
        expect(actual.chunks).toStrictEqual((await parse(banks, true, options)).chunks)
        expect(actual.profile?.fusedParseFallbacks).toBe(0)
        expect(actual.chunks[0].mediaRows.map(({index}) => index)).toEqual([1, 2, 3, 4])
    })

    test.each([false, true])('preserves chunk-local diagnostics and duplicate suppression (single=%s)', async (singleChunk) => {
        const image = '[{"type":"image","path":"same.png"}]'
        const banks = [
            `[${row('["plain"]')},${row(image, 1)},${row(image, 2)}]`,
            `[${row(image, 3)},${row('[{"type":"image","path":"other.png"}]', 4)},${row(image, 5)}]`,
        ]
        const actual = await parse(banks, false, {singleChunk})
        expect(actual.chunks).toStrictEqual((await parse(banks, true, {singleChunk})).chunks)
        expect(actual.chunks.map(({mediaRows}) => mediaRows.map(({index}) => index))).toEqual(singleChunk ? [[1, 4]] : [[1], [], [0]])
    })

    test.each(['-0', '0.5', '2147483648'])('preserves numeric fallback with score %s', async (score) => {
        const banks = [`[${row('[{"type":"image","path":"a.png"}]', 0, score)}]`, `[${row('["plain"]', 1)}]`]
        const actual = await parse(banks, false)
        expect(actual.chunks).toStrictEqual((await parse(banks, true)).chunks)
        expect(actual.profile?.fusedParseFallbacks).toBe(1)
        expect(actual.chunks[0].mediaRows[0].index).toBe(0)
    })

    test('keeps media hints disabled and repeated requests independent', async () => {
        const imageBanks = [`[${row('[{"type":"image","path":"a.png"}]')}]`, '[]']
        const hinted = await parse(imageBanks, false)
        const snapshot = structuredClone(hinted.chunks)
        const disabled = await parse(imageBanks, false, {mediaHintFastScan: false})
        expect(disabled.chunks).toStrictEqual((await parse(imageBanks, true, {mediaHintFastScan: false})).chunks)
        expect(disabled.chunks[0].mediaRows).toHaveLength(0)
        expect((await parse(['[]', `[${row('["new content"]', 42)}]`], false)).chunks[0].mediaRows).toHaveLength(0)
        expect(hinted.chunks).toStrictEqual(snapshot)
    })
})
