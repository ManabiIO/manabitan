/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    parseTermBankWithWasmColumnChunks,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const nativeFetch = globalThis.fetch
const maybeTest = existsSync(fileURLToPath(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))) ? test : test.skip
/** @typedef {{expressions: string[], readings: string[], equality: number[], scores: number[], sequences: number[], content: number[][], lookup: number[]}} KeySnapshot */

beforeAll(() => {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ resource) => {
        const url = resource instanceof URL ? resource : new URL(String(resource))
        return url.protocol === 'file:' ? new Response(await readFile(fileURLToPath(url))) : nativeFetch(resource)
    })
})

afterAll(() => { vi.unstubAllGlobals() })

/**
 * Compare the fused columns with the independently decoded JavaScript plan.
 * Capture bytes inside the callback before the next parser resets its heap.
 * @param {Uint8Array[]} sources
 * @param {boolean} fused
 * @param {boolean} [nativeEscapedKeys]
 * @returns {Promise<{result: KeySnapshot, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function snapshot(sources, fused, nativeEscapedKeys = false) {
    /** @type {KeySnapshot|null} */
    let result = null
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = plan.stringOffsets
        if (!(offsets instanceof Uint32Array) || !(chunk.contentMetaList instanceof Uint32Array) || !(chunk.contentBytesBuffer instanceof Uint8Array)) {
            throw new Error('Missing complete parser columns')
        }
        const strings = Array.from(plan.stringLengths, (length, index) => (
            decoder.decode(plan.stringsBuffer.subarray(offsets[index], offsets[index] + length))
        ))
        const content = []
        for (let row = 0; row < chunk.rowCount; ++row) {
            const offset = (chunk.contentBytesBaseOffset ?? 0) + chunk.contentMetaList[row * 4]
            content.push([...chunk.contentBytesBuffer.subarray(offset, offset + chunk.contentMetaList[row * 4 + 1])])
        }
        result = {
            expressions: Array.from(plan.expressionIndexes, (index) => strings[index]),
            readings: Array.from(plan.readingIndexes, (index) => strings[index]),
            equality: [...chunk.readingEqualsExpressionList],
            scores: [...chunk.scoreList],
            sequences: [...chunk.sequenceList],
            content,
            lookup: [...encodePersistedTermLookupIndexFromPreinternedPlan(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount)],
        }
    }, 2048, {
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        emitTermByteLists: false,
        singleChunk: true,
        useNativeStringPlan: fused,
        experimentalSkipFusedParse: !fused,
        experimentalNativeEscapedKeys: nativeEscapedKeys,
    })
    const profile = consumeLastTermBankWasmParseProfile()
    if (result === null) { throw new Error('Expected parser output') }
    return {result, profile}
}

describe('fused parser consecutive key reuse', () => {
    maybeTest('preserves independent term fields across repeated keys and empty bank boundaries', async () => {
        const keys = [
            ['日本語', 'にほんご'],
            ['日本語', 'にっぽんご'],
            ['日本語学', 'にっぽんご'],
            ['日本語学', 'にっぽんご'],
            ['同じ', '同じ'],
            ['違う', '同じ'],
            ['違う', ''],
            ['別の語', ''],
            ['別の語', '別の語'],
            ['𠮷野家', 'よしのや'],
            ['𠮷野家', 'よしのや'],
            ['different-key', 'よしのや'],
        ]
        const rows = keys.map(([expression, reading], i) => [expression, reading, '', '', i - 3, [`definition ${i}`], i, ''])
        const sources = [
            encoder.encode(JSON.stringify(rows.slice(0, 3))),
            encoder.encode('[]'),
            encoder.encode(JSON.stringify(rows.slice(3, 10))),
            encoder.encode(JSON.stringify(rows.slice(10))),
        ]
        const fused = await snapshot(sources, true)
        const established = await snapshot(sources, false)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(fused.result).toStrictEqual(established.result)
        expect(fused.result.expressions).toStrictEqual(keys.map(([expression]) => expression))
        expect(fused.result.readings).toStrictEqual(keys.map(([expression, reading]) => reading || expression))
        expect(fused.result.equality).toStrictEqual([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0])
    })

    maybeTest.each([false, true])('preserves escaped and literal key equality with native escapes %s', async (nativeEscapedKeys) => {
        const sources = [
            encoder.encode(String.raw`[["a","a","","",1,["literal"],1,""],["a","\u0061","","",2,["escaped reading"],2,""]]`),
            encoder.encode(String.raw`[["a","\u0061","","",3,["repeated reading"],3,""],["\u0061","\u0061","","",4,["escaped equality"],4,""],["\u0061","a","","",5,["literal reading"],5,""],["\u0061","a","","",6,["repeated expression"],6,""],["\u0061","","","",7,["empty reading"],7,""],["other","","","",8,["different empty reading"],8,""]]`),
        ]
        const fused = await snapshot(sources, true, nativeEscapedKeys)
        const established = await snapshot(sources, false)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(nativeEscapedKeys ? 0 : 1)
        expect(fused.result).toStrictEqual(established.result)
        expect(fused.result.expressions).toStrictEqual(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'other'])
        expect(fused.result.readings).toStrictEqual(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'other'])
        expect(fused.result.equality).toStrictEqual([1, 0, 0, 1, 0, 0, 1, 1])
    })

    maybeTest('keeps malformed UTF-8 normalization on the established fallback after repeated keys', async () => {
        const valid = encoder.encode('[["same","reading","","",0,["valid"],1,""]]')
        const malformed = encoder.encode('[["same","X","","",1,["first"],2,""],["same","X","","",2,["second"],3,""]]')
        for (let i = 0; i < malformed.length; ++i) {
            if (malformed[i] === 0x58) { malformed[i] = 0xff }
        }
        const sources = [valid, malformed]
        const fused = await snapshot(sources, true)
        const established = await snapshot(sources, false)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks).toBe(1)
        expect(fused.result).toStrictEqual(established.result)
        expect(fused.result.readings).toStrictEqual(['reading', '\ufffd', '\ufffd'])
    })

    maybeTest('still rejects malformed JSON in a repeated key row', async () => {
        const sources = [
            encoder.encode('[["same","reading","","",0,["valid"],1,""]]'),
            encoder.encode('[["same","reading","","",0,["invalid"],1e,""]]'),
        ]
        await expect(snapshot(sources, true)).rejects.toThrow()
        await expect(snapshot(sources, false)).rejects.toThrow()
    })

    maybeTest('preserves negative zero fallback after reused keys and resets independent parses', async () => {
        const sources = [
            encoder.encode('[["same","reading","","",1,["first"],1,""],["same","reading","","",2,["second"],2,""]]'),
            encoder.encode('[["same","reading","","",-0,["negative zero"],3,""]]'),
        ]
        const fused = await snapshot(sources, true)
        const established = await snapshot(sources, false)
        expect(fused.profile?.fusedParseFallbacks).toBe(1)
        expect(fused.result).toStrictEqual(established.result)
        expect(Object.is(fused.result.scores[2], -0)).toBe(true)

        const freshSources = [
            encoder.encode('[["fresh","other","","",1,["first"],1,""]]'),
            encoder.encode('[["fresh","other","","",2,["second"],2,""]]'),
        ]
        const fresh = await snapshot(freshSources, true)
        expect(fresh.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(fresh.result).toStrictEqual((await snapshot(freshSources, false)).result)
        expect(fresh.result.expressions).toStrictEqual(['fresh', 'fresh'])
        expect(fresh.result.readings).toStrictEqual(['other', 'other'])
    })

    /** @type {Array<[number, 'ascii'|'utf8'|'escaped', boolean]>} */
    const boundaryCases = []
    for (const bytes of [31, 32, 33]) {
        boundaryCases.push(
            [bytes, 'ascii', false],
            [bytes, 'utf8', false],
            [bytes, 'escaped', false],
            [bytes, 'escaped', true],
        )
    }
    maybeTest.each(boundaryCases)('preserves %i-byte %s raw bodies with native escapes %s', async (bytes, spelling, nativeEscapedKeys) => {
        /**
         * End each equal-length key with a distinct ASCII or escaped character.
         * @param {string} last
         * @returns {string}
         */
        const body = (last) => {
            if (spelling === 'escaped') {
                return 'a'.repeat(bytes - 6) + `\\u00${last.charCodeAt(0).toString(16)}`
            }
            const prefix = spelling === 'utf8' ?
                '日'.repeat(Math.floor((bytes - 1) / 3)) + 'a'.repeat((bytes - 1) % 3) :
                'a'.repeat(bytes - 1)
            return prefix + last
        }
        const a = body('a')
        const b = body('b')
        const c = body('c')
        const d = body('d')
        for (const rawBody of [a, b, c, d]) { expect(encoder.encode(rawBody).byteLength).toBe(bytes) }
        const rawKeys = [[a, b], [a, b], [c, b], [c, ''], [c, b], [c, c], [d, c], [d, c]]
        const rows = rawKeys.map(([expression, reading], i) => (
            `["${expression}","${reading}","","",${i},["definition ${i}"],${i},""]`
        ))
        const sources = [
            encoder.encode(`[${rows.slice(0, 3).join(',')}]`),
            encoder.encode('[]'),
            encoder.encode(`[${rows.slice(3).join(',')}]`),
        ]
        const fused = await snapshot(sources, true, nativeEscapedKeys)
        const established = await snapshot(sources, false)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(spelling === 'escaped' && !nativeEscapedKeys ? 1 : 0)
        expect(fused.result).toStrictEqual(established.result)
        expect(fused.result.equality).toStrictEqual([0, 0, 0, 1, 0, 1, 0, 0])
    })
})
