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
 * @param {boolean} [includeLookup]
 * @returns {Promise<{result: KeySnapshot, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function snapshot(sources, fused, nativeEscapedKeys = false, includeLookup = true) {
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
            lookup: includeLookup ? [...encodePersistedTermLookupIndexFromPreinternedPlan(plan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount)] : [],
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

describe('fused parser key escape hints', () => {
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

    maybeTest.each([0, 1, 2, 3, 7, 8, 15, 16])('copies complete UTF-8 keys with a %i-byte prefix', async (padding) => {
        const characters = ['\u007f', '\u0080', '\u07ff', '\u0800', '\ud7ff', '\ue000', '\uffff', '\u{10000}', '\u{10ffff}', '日本語', 'é日本𠮷']
        const keys = characters.map((value) => `${'x'.repeat(padding)}${value}`)
        const rows = keys.flatMap((key, index) => [
            [key, `${key}reading`, '', '', index, ['definition'], index, ''],
            [key, '', '', '', index, ['definition'], index, ''],
        ])
        const sources = [encoder.encode('[]'), encoder.encode(JSON.stringify(rows))]
        const fused = await snapshot(sources, true)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(fused.result).toStrictEqual((await snapshot(sources, false)).result)
        expect(fused.result.expressions).toStrictEqual(keys.flatMap((key) => [key, key]))
        expect(fused.result.readings).toStrictEqual(keys.flatMap((key) => [`${key}reading`, key]))
    })

    maybeTest.each([
        [0xc2],
        [0xe0],
        [0xf0],
        [0xe1, 0x80],
        [0xf1, 0x80],
        [0xf1, 0x80, 0x80],
        [0xc2, 0x7f],
        [0xc2, 0xc0],
        [0xe1, 0x7f, 0x80],
        [0xe1, 0x80, 0x7f],
        [0xe1, 0x80, 0xc0],
        [0xf1, 0x7f, 0x80, 0x80],
        [0xf1, 0x80, 0x7f, 0x80],
        [0xf1, 0x80, 0x80, 0x7f],
        [0xf1, 0x80, 0x80, 0xc0],
        [0xe0, 0x9f, 0xbf],
        [0xed, 0xa0, 0x80],
        [0xf0, 0x8f, 0xbf, 0xbf],
        [0xf4, 0x90, 0x80, 0x80],
        [0xc0, 0x80],
        [0xc1, 0xbf],
        [0xf5, 0x80, 0x80, 0x80],
    ].map((bytes) => [bytes]))('preserves replacement decoding after a partially copied key: %j', async (invalidBytes) => {
        const prefix = encoder.encode('[["日本語","にほんご","","",0,["before"],1,""],["日本語')
        const suffix = encoder.encode('","","","",1,["invalid"],2,""],["日本語","にほんご","","",2,["after"],3,""]]')
        const source = new Uint8Array(prefix.length + invalidBytes.length + suffix.length)
        source.set(prefix)
        source.set(invalidBytes, prefix.length)
        source.set(suffix, prefix.length + invalidBytes.length)
        const sources = [encoder.encode('[]'), source]
        const fused = await snapshot(sources, true)
        const expected = await snapshot(sources, false)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks).toBe(1)
        expect(fused.result).toStrictEqual(expected.result)
        expect(fused.result.expressions).toStrictEqual(['日本語', `日本語${decoder.decode(new Uint8Array(invalidBytes))}`, '日本語'])
        expect(fused.result.readings[1]).toBe(fused.result.expressions[1])
    })

    maybeTest('still rejects malformed JSON in a repeated key row', async () => {
        const sources = [
            encoder.encode('[["same","reading","","",0,["valid"],1,""]]'),
            encoder.encode('[["same","reading","","",0,["invalid"],1e,""]]'),
        ]
        await expect(snapshot(sources, true)).rejects.toThrow()
        await expect(snapshot(sources, false)).rejects.toThrow()
    })

    maybeTest('preserves negative zero fallback and resets independent parses', async () => {
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

    /** @type {[number, number, boolean][]} */
    const alignments = []
    for (let offset = 0; offset < 16; ++offset) {
        for (const field of [0, 1]) {
            for (const nativeEscapedKeys of [false, true]) {
                alignments.push([offset, field, nativeEscapedKeys])
            }
        }
    }

    maybeTest.each(alignments)('retains escape hints at byte offset %i, field %i, native escapes %s', async (offset, field, nativeEscapedKeys) => {
        const keys = ['literal-expression', 'literal-reading']
        keys[field] = `${'x'.repeat(offset)}"\\\n終`
        const sources = [
            encoder.encode('[["before","before-reading","","",0,["before"],1,""]]'),
            encoder.encode(JSON.stringify([
                [keys[0], keys[1], '', '', 1, ['escaped'], 2, ''],
                ['after', 'after-reading', '', '', 2, ['after'], 3, ''],
            ])),
        ]
        const fused = await snapshot(sources, true, nativeEscapedKeys)
        expect(fused.result).toStrictEqual((await snapshot(sources, false)).result)
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(nativeEscapedKeys ? 0 : 1)
    })

    maybeTest.each([false, true])('preserves missing-reading fallback with native escapes %s', async (nativeEscapedKeys) => {
        const sources = [
            encoder.encode('[["before","before-reading","","",0,["before"],1,""]]'),
            encoder.encode('[["expression-only"]]'),
        ]
        /**
         * Preserve the generic caller's result or decoder rejection, and never
         * accept a WASM memory trap as an equivalent input-validation failure.
         * @param {boolean} fused
         * @returns {Promise<{result: KeySnapshot}|{error: string}>}
         */
        async function outcome(fused) {
            try {
                return {result: (await snapshot(sources, fused, nativeEscapedKeys)).result}
            } catch (error) {
                if (!(error instanceof Error) || error instanceof WebAssembly.RuntimeError) { throw error }
                return {error: error.message}
            }
        }
        expect(await outcome(true)).toStrictEqual(await outcome(false))
    })

    maybeTest.each([false, true])('preserves empty keys around an escaped row with native escapes %s', async (nativeEscapedKeys) => {
        const sources = [
            encoder.encode('[["","","","",0,["empty"],1,""]]'),
            encoder.encode(String.raw`[["\u0061","","","",1,["escaped"],2,""],["","","","",2,["empty again"],3,""]]`),
        ]
        const fused = await snapshot(sources, true, nativeEscapedKeys, false)
        expect(fused.result).toStrictEqual((await snapshot(sources, false, false, false)).result)
        expect(fused.result.expressions).toStrictEqual(['', 'a', ''])
        expect(fused.result.readings).toStrictEqual(['', 'a', ''])
        expect(fused.result.equality).toStrictEqual([1, 1, 1])
        expect(fused.profile?.fusedParseAttempts).toBe(1)
        expect(fused.profile?.fusedParseFallbacks ?? 0).toBe(nativeEscapedKeys ? 0 : 1)
    })

    maybeTest.each([false, true])('keeps malformed key JSON rejected with native escapes %s', async (nativeEscapedKeys) => {
        const malformedTokens = ['"bad\\q"', '"bad\\u12xz"', '"bad\u0001"', '"truncated\\']
        for (const token of malformedTokens) {
            const sources = [
                encoder.encode('[["before","before-reading","","",0,["before"],1,""]]'),
                encoder.encode(`[[${token},"reading","","",1,["bad"],2,""]]`),
            ]
            await expect(snapshot(sources, true, nativeEscapedKeys)).rejects.toThrow(/term-bank parser failed/)
            await expect(snapshot(sources, false)).rejects.toThrow(/term-bank parser failed/)
        }
    })
})
