/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'
import {getValidatedStringOffsets} from '../ext/js/dictionary/term-record-preinterned-plan.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
/** @typedef {{expressions: string[], readings: string[], equal: number[], scores: number[], sequences: number[], content: number[][], lookup: number[]}} Snapshot */

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * A valid row before the tested keys also checks that a rejected partial UTF-8
 * copy cannot publish an interner entry or alter the earlier accepted row.
 * @param {number[]} key
 * @param {number} [padding]
 * @returns {Uint8Array[]}
 */
function sourcesForKey(key, padding = 0) {
    const prefix = encoder.encode('[["')
    const middle = encoder.encode('","')
    const suffix = encoder.encode('","","",7,["definition"],19,""]]')
    const source = new Uint8Array(padding + prefix.length + key.length + middle.length + key.length + suffix.length)
    let offset = padding
    for (const part of [prefix, key, middle, key, suffix]) {
        source.set(part, offset)
        offset += part.length
    }
    return [encoder.encode('[["before","まえ","","",3,["prior"],17,""]]'), source.subarray(padding)]
}

/**
 * @param {Uint8Array[]} sources
 * @param {'javascript'|'native'|'fused'} mode
 * @returns {Promise<{result: Snapshot, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function snapshot(sources, mode) {
    /** @type {Snapshot|null} */
    let result = null
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = getValidatedStringOffsets(plan)
        const strings = Array.from(plan.stringLengths, (length, index) => decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length)))
        if (typeof chunk.contentMetaList === 'undefined' || typeof chunk.contentBytesBuffer === 'undefined') {
            throw new Error('Expected parser-owned content columns')
        }
        const content = []
        for (let row = 0; row < chunk.rowCount; ++row) {
            const start = (chunk.contentBytesBaseOffset ?? 0) + chunk.contentMetaList[row * 4]
            content.push([...chunk.contentBytesBuffer.subarray(start, start + chunk.contentMetaList[row * 4 + 1])])
        }
        result = {
            expressions: Array.from(plan.expressionIndexes, (index) => strings[index]),
            readings: Array.from(plan.readingIndexes, (index) => strings[index]),
            equal: [...chunk.readingEqualsExpressionList],
            scores: [...chunk.scoreList],
            sequences: [...chunk.sequenceList],
            content,
            lookup: [...encodePersistedTermLookupIndexFromPreinternedPlan(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount)],
        }
    }, 2048, {
        useNativeStringPlan: mode !== 'javascript',
        experimentalSkipFusedParse: mode !== 'fused',
        validateGlossaryTypes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        singleChunk: true,
    })
    if (result === null) { throw new Error('Missing parsed keys') }
    return {result, profile: consumeLastTermBankWasmParseProfile()}
}

/** @type {Array<[string, number[]]>} */
const malformed = [
    ['stray low continuation', [0x80]],
    ['stray high continuation', [0xbf]],
    ['overlong two-byte zero', [0xc0, 0x80]],
    ['overlong two-byte endpoint', [0xc1, 0xbf]],
    ['truncated two-byte start', [0xc2]],
    ['truncated two-byte endpoint', [0xdf]],
    ['two-byte low continuation', [0xc2, 0x7f]],
    ['two-byte high continuation', [0xdf, 0xc0]],
    ['truncated three-byte start', [0xe0]],
    ['truncated three-byte tail', [0xe1, 0x80]],
    ['truncated three-byte endpoint', [0xef, 0xbf]],
    ['overlong three-byte start', [0xe0, 0x9f, 0xbf]],
    ['UTF-16 high surrogate', [0xed, 0xa0, 0x80]],
    ['UTF-16 low surrogate', [0xed, 0xbf, 0xbf]],
    ['three-byte second byte low', [0xe1, 0x7f, 0x80]],
    ['three-byte second byte high', [0xe1, 0xc0, 0x80]],
    ['three-byte third byte low', [0xe1, 0x80, 0x7f]],
    ['three-byte third byte high', [0xe1, 0x80, 0xc0]],
    ['truncated four-byte start', [0xf0]],
    ['truncated four-byte middle', [0xf0, 0x90]],
    ['truncated four-byte tail', [0xf0, 0x90, 0x80]],
    ['overlong four-byte start', [0xf0, 0x8f, 0xbf, 0xbf]],
    ['beyond Unicode endpoint', [0xf4, 0x90, 0x80, 0x80]],
    ['four-byte second byte low', [0xf1, 0x7f, 0x80, 0x80]],
    ['four-byte second byte high', [0xf1, 0xc0, 0x80, 0x80]],
    ['four-byte third byte low', [0xf1, 0x80, 0x7f, 0x80]],
    ['four-byte third byte high', [0xf1, 0x80, 0xc0, 0x80]],
    ['four-byte fourth byte low', [0xf1, 0x80, 0x80, 0x7f]],
    ['four-byte fourth byte high', [0xf1, 0x80, 0x80, 0xc0]],
    ...Array.from({length: 11}, (_, i) => /** @type {[string, number[]]} */ ([`invalid lead ${String(0xf5 + i)}`, [0xf5 + i, 0x80, 0x80, 0x80]])),
]

describe.each(/** @type {const} */ (['native', 'fused']))('native key UTF-8 validation (%s)', (mode) => {
    test.each([0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff])('accepts Unicode boundary U+%i', async (codePoint) => {
        const key = String.fromCodePoint(codePoint)
        const sources = sourcesForKey([...encoder.encode(key)], codePoint % 4)
        const oracle = await snapshot(sources, 'javascript')
        const actual = await snapshot(sources, mode)
        expect(actual.result).toStrictEqual(oracle.result)
        expect(actual.result.expressions).toEqual(['before', key])
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(actual.profile?.nativeStringPlanFallbackChunkCount ?? 0).toBe(0)
    })

    test.each(malformed)('preserves replacement decoding for %s', async (_name, key) => {
        const sources = sourcesForKey(key, 5)
        const oracle = await snapshot(sources, 'javascript')
        const actual = await snapshot(sources, mode)
        expect(actual.result).toStrictEqual(oracle.result)
        expect(actual.result.expressions).toEqual(['before', decoder.decode(new Uint8Array(key))])
        if (mode === 'fused') {
            expect(actual.profile?.fusedParseAttempts).toBe(1)
            expect(actual.profile?.fusedParseFallbacks).toBe(1)
        }
        expect(actual.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
    })

    test('copies mixed-width keys across all short tail lengths', async () => {
        for (let prefixLength = 0; prefixLength < 8; ++prefixLength) {
            const key = `${'a'.repeat(prefixLength)}é日本語𠮷🙂\u0800\ud7ff\ue000\uFEFFtail`
            const sources = sourcesForKey([...encoder.encode(key)], prefixLength)
            const oracle = await snapshot(sources, 'javascript')
            const actual = await snapshot(sources, mode)
            expect(actual.result).toStrictEqual(oracle.result)
            expect(actual.result.expressions).toEqual(['before', key])
            expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
            expect(actual.profile?.nativeStringPlanFallbackChunkCount ?? 0).toBe(0)
        }
    })
})
