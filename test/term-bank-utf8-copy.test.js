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

/** @typedef {{expressions: number[][], readings: number[][], equal: number[], scores: number[], sequences: number[], lookup: number[], content: number[][], hashes: number[][]}} Snapshot */

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Keep raw UTF-8 inside a complete, bounded JSON key. Repeated rows also cover
 * native intern hits, which must never promote malformed bytes into an entry.
 * @param {number[]} raw
 * @param {string} prefix
 * @returns {Uint8Array[]}
 */
function sourceBanks(raw, prefix) {
    const key = Uint8Array.from([...encoder.encode(prefix), ...raw])
    const first = encoder.encode('[["')
    const last = encoder.encode('","reading","","",7,["definition"],23,""]]')
    const source = new Uint8Array(first.length + key.length + last.length)
    source.set(first)
    source.set(key, first.length)
    source.set(last, first.length + key.length)
    return [source, new Uint8Array(source)]
}

/**
 * Use the JavaScript decoder/interner as an independent oracle, then compare
 * complete persisted lookup bytes and content fields before the heap resets.
 * @param {Uint8Array[]} sources
 * @param {'fused'|'native'|'javascript'} mode
 * @returns {Promise<{snapshot: Snapshot, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function project(sources, mode) {
    /** @type {Snapshot|null} */
    let snapshot = null
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = getValidatedStringOffsets(plan)
        const key = (/** @type {number} */ index) => [...plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index])]
        const meta = chunk.contentMetaList
        const bytes = chunk.contentBytesBuffer
        if (!(meta instanceof Uint32Array) || !(bytes instanceof Uint8Array)) { throw new Error('Missing native content columns') }
        snapshot = {
            expressions: Array.from(plan.expressionIndexes, key),
            readings: Array.from(plan.readingIndexes, key),
            equal: [...chunk.readingEqualsExpressionList],
            scores: [...chunk.scoreList],
            sequences: [...chunk.sequenceList],
            lookup: [...encodePersistedTermLookupIndexFromPreinternedPlan(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount)],
            content: Array.from({length: chunk.rowCount}, (_, i) => {
                const start = (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4]
                return [...bytes.subarray(start, start + meta[i * 4 + 1])]
            }),
            hashes: Array.from({length: chunk.rowCount}, (_, i) => [meta[i * 4 + 2], meta[i * 4 + 3]]),
        }
    }, 12000, {
        experimentalSkipFusedParse: mode !== 'fused',
        useNativeStringPlan: mode !== 'javascript',
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        singleChunk: true,
        validateGlossaryTypes: true,
    })
    if (snapshot === null) { throw new Error('Expected complete parser columns') }
    return {snapshot, profile: consumeLastTermBankWasmParseProfile()}
}

describe('bounded UTF-8 copying into native key arenas', () => {
    const valid = [
        [0x20],
        [0x7f],
        [0xc2, 0x80],
        [0xdf, 0xbf],
        [0xe0, 0xa0, 0x80],
        [0xe0, 0xbf, 0xbf],
        [0xe1, 0x80, 0x80],
        [0xec, 0xbf, 0xbf],
        [0xed, 0x80, 0x80],
        [0xed, 0x9f, 0xbf],
        [0xee, 0x80, 0x80],
        [0xef, 0xbb, 0xbf],
        [0xef, 0xbf, 0xbf],
        [0xf0, 0x90, 0x80, 0x80],
        [0xf0, 0xbf, 0xbf, 0xbf],
        [0xf1, 0x80, 0x80, 0x80],
        [0xf3, 0xbf, 0xbf, 0xbf],
        [0xf4, 0x80, 0x80, 0x80],
        [0xf4, 0x8f, 0xbf, 0xbf],
    ]
    const invalid = [
        [0x80],
        [0xbf],
        [0xc0, 0xaf],
        [0xc1, 0xbf],
        [0xc2],
        [0xc2, 0x7f],
        [0xdf, 0xc0],
        [0xe0],
        [0xe0, 0xa0],
        [0xe0, 0x9f, 0xbf],
        [0xe1, 0x80],
        [0xe1, 0x7f, 0x80],
        [0xe1, 0x80, 0x7f],
        [0xe1, 0xc0, 0x80],
        [0xe1, 0x80, 0xc0],
        [0xed, 0xa0, 0x80],
        [0xed, 0xbf, 0xbf],
        [0xf0],
        [0xf0, 0x90],
        [0xf0, 0x90, 0x80],
        [0xf0, 0x8f, 0xbf, 0xbf],
        [0xf1, 0x7f, 0x80, 0x80],
        [0xf1, 0x80, 0x7f, 0x80],
        [0xf1, 0x80, 0x80, 0x7f],
        [0xf1, 0xc0, 0x80, 0x80],
        [0xf1, 0x80, 0xc0, 0x80],
        [0xf1, 0x80, 0x80, 0xc0],
        [0xf4, 0x90, 0x80, 0x80],
        [0xf5, 0x80, 0x80, 0x80],
        [0xfe],
        [0xff],
    ]

    test.each(['', 'ASCII', '日本語', 'é𠮷'])('preserves every UTF-8 width boundary after prefix %j', async (prefix) => {
        for (const raw of valid) {
            const sources = sourceBanks(raw, prefix)
            const oracle = await project(sources, 'javascript')
            const expected = [...encoder.encode(prefix), ...raw]
            expect(oracle.snapshot.expressions).toStrictEqual([expected, expected])
            for (const mode of /** @type {const} */ (['fused', 'native'])) {
                const actual = await project(sources, mode)
                expect(actual.snapshot).toStrictEqual(oracle.snapshot)
                expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
                expect(actual.profile?.nativeStringPlanFallbackChunkCount ?? 0).toBe(0)
                expect(actual.profile?.nativeStringPlanChunkCount).toBe(1)
            }
        }
    })

    test.each(['', 'ASCII', '日本語', 'é𠮷'])('keeps replacement decoding for malformed or truncated UTF-8 after prefix %j', async (prefix) => {
        for (const raw of invalid) {
            const sources = sourceBanks(raw, prefix)
            const oracle = await project(sources, 'javascript')
            const expected = [...encoder.encode(decoder.decode(Uint8Array.from([...encoder.encode(prefix), ...raw])))]
            expect(oracle.snapshot.expressions).toStrictEqual([expected, expected])
            for (const mode of /** @type {const} */ (['fused', 'native'])) {
                const actual = await project(sources, mode)
                expect(actual.snapshot).toStrictEqual(oracle.snapshot)
                expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(mode === 'fused' ? 1 : 0)
                expect(actual.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
            }
        }
    })
})
