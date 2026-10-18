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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
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
import {encodePersistedTermLookupIndexFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index.js'
import {getValidatedStringOffsets} from '../ext/js/dictionary/term-record-preinterned-plan.js'

const encoder = new TextEncoder()
/** @typedef {ReturnType<typeof copyWasmBackedColumnChunk>} Chunk */

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {string|Uint8Array} input
 * @param {boolean} native
 * @param {number} [chunkSize]
 * @param {number} [version]
 * @returns {Promise<{chunks: Chunk[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function project(input, native, chunkSize = 12000, version = 3) {
    /** @type {Chunk[]} */
    const chunks = []
    const bytes = typeof input === 'string' ? encoder.encode(input) : input
    const padded = new Uint8Array(bytes.length + 11)
    padded.set(bytes, 5)
    await parseTermBankWithWasmColumnChunks(padded.subarray(5, 5 + bytes.length), version, (chunk) => {
        chunks.push(copyWasmBackedColumnChunk(chunk))
    }, chunkSize, {
        experimentalSkipFusedParse: true,
        useNativeStringPlan: native,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTermByteLists: false,
        emitTokenBinaryContent: true,
        prepareLookupIndexes: true,
    })
    return {chunks, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {Chunk[]} chunks
 * @returns {Array<{expression: Uint8Array, reading: Uint8Array, equal: number, score: number, sequence: number, content: Uint8Array, hashes: number[]}>}
 */
function snapshot(chunks) {
    return chunks.flatMap((chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = getValidatedStringOffsets(plan)
        if (typeof chunk.contentMetaList === 'undefined' || typeof chunk.contentBytesBuffer === 'undefined') {
            throw new Error('Expected owned key and content columns')
        }
        /**
         * @param {number} id
         * @returns {Uint8Array}
         */
        const key = (id) => plan.stringsBuffer.slice(offsets[id], offsets[id] + plan.stringLengths[id])
        const meta = chunk.contentMetaList
        const contentBytes = chunk.contentBytesBuffer
        return Array.from({length: chunk.rowCount}, (_, i) => {
            const start = (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4]
            return {
                expression: key(plan.expressionIndexes[i]),
                reading: key(plan.readingIndexes[i]),
                equal: Number(chunk.readingEqualsExpressionList[i]),
                score: chunk.scoreList[i],
                sequence: chunk.sequenceList[i],
                content: contentBytes.slice(start, start + meta[i * 4 + 1]),
                hashes: [meta[i * 4 + 2], meta[i * 4 + 3]],
            }
        })
    })
}

describe('escaped keys in the non-fused native interner', () => {
    test.each([1, 7, 12000])('matches the JavaScript oracle at chunk size %i', async (chunkSize) => {
        const keys = ['quote"', 'back\\slash', '\b\f\n\r\t', '\u0000nul', '\uFEFFleading', '𠮷', '\ud800', '\udc00', '\ud800x\udc00', 'ordinary', '']
        const rows = keys.map((key, i) => [key, i % 3 === 0 ? '' : `${key}reading`, 'noun', '', i === 0 ? -0.5 : i, ['definition', {type: 'text', text: 'a\nb'}], i, 'tag'])
        const source = JSON.stringify(rows)
        const oracle = await project(source, false, chunkSize)
        const candidate = await project(source, true, chunkSize)
        const actual = snapshot(candidate.chunks)
        expect(actual).toStrictEqual(snapshot(oracle.chunks))
        expect(actual.map((row) => row.expression)).toStrictEqual(keys.map((key) => encoder.encode(key)))
        expect(candidate.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
        expect(candidate.profile?.nativeStringPlanChunkCount).toBe(candidate.chunks.length)
        for (const chunk of candidate.chunks) {
            const nativeIndex = chunk.preparedLookupIndexes?.get(`0:${chunk.rowCount}`)?.bytes
            if (chunk.termRecordPreinternedPlan.stringLengths.includes(0)) { continue }
            expect(nativeIndex).toStrictEqual(encodePersistedTermLookupIndexFromPreinternedPlan(chunk.termRecordPreinternedPlan, chunk.readingEqualsExpressionList, chunk.sequenceList, chunk.rowCount))
        }
    })

    test('preserves raw-token reading equality when decoded keys intern together', async () => {
        const source = '[["a","\\u0061","","",0,[],0,""],["a","a","","",0,[],0,""],["\\u0061","a","","",0,[],0,""],["\\u0061","\\u0061","","",0,[],0,""],["\\u0061","","","",0,[],0,""]]'
        const oracle = await project(source, false)
        const result = await project(source, true)
        expect(snapshot(result.chunks)).toStrictEqual(snapshot(oracle.chunks))
        expect(snapshot(result.chunks).map((row) => row.equal)).toEqual([0, 1, 0, 1, 1])
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })

    test.each([
        '"\\/"',
        '"\\u65e5本"',
        '"\\ud83d\\ude42"',
        '"\\ud800x\\udfff"',
        '"é\\n𠮷"',
    ])('matches decoded bytes for explicit JSON spelling %s', async (token) => {
        const source = `[[${token},"","","",0,[],0,""]]`
        const oracle = await project(source, false)
        const result = await project(source, true)
        const rows = snapshot(result.chunks)
        expect(rows).toStrictEqual(snapshot(oracle.chunks))
        expect(rows[0].expression).toStrictEqual(encoder.encode(/** @type {string} */ (JSON.parse(token))))
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })

    test.each([0xff, 0xc0, 0x80, 0xed, 0xf5])('retains the JavaScript fallback for invalid UTF-8 byte %i', async (invalidByte) => {
        const prefix = encoder.encode('[["\\u0061')
        const suffix = encoder.encode('","","","",0,[],0,""]]')
        const source = new Uint8Array(prefix.length + 1 + suffix.length)
        source.set(prefix)
        source[prefix.length] = invalidByte
        source.set(suffix, prefix.length + 1)
        const oracle = await project(source, false)
        const result = await project(source, true)
        expect(snapshot(result.chunks)).toStrictEqual(snapshot(oracle.chunks))
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
    })

    test('accepts an escaped key at the 65535-byte binary limit', async () => {
        const source = `[["${'x'.repeat(65534)}\\u0078","","","",0,[],0,""]]`
        const oracle = await project(source, false)
        const result = await project(source, true)
        expect(snapshot(result.chunks)).toStrictEqual(snapshot(oracle.chunks))
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })


    test('still rejects escaped keys beyond the persisted binary limit', async () => {
        const source = `[["${'x'.repeat(65535)}\\u0078","","","",0,[],0,""]]`
        await expect(project(source, false)).rejects.toThrow('binary record limit')
        await expect(project(source, true)).rejects.toThrow('binary record limit')
    })

    test('keeps legacy row rejection in the columnar parser unchanged', async () => {
        const source = JSON.stringify([['back\\slash', '', '', '', 1, 'one', 'two'], ['"quote', 'reading', '', '', -1, 'three']])
        await expect(project(source, false, 1, 1)).rejects.toThrow('term-bank parser failed')
        await expect(project(source, true, 1, 1)).rejects.toThrow('term-bank parser failed')
    })

    test('one early escape does not abandon a 25000-row native plan', async () => {
        const source = JSON.stringify(Array.from({length: 25000}, (_, i) => [`${i === 1 ? 'quo"te' : 'term'}${i}`, '', '', '', 0, ['definition'], i, '']))
        const oracle = await project(source, false, 25000)
        const result = await project(source, true, 25000)
        expect(snapshot(result.chunks)).toStrictEqual(snapshot(oracle.chunks))
        expect(result.profile?.nativeStringPlanChunkCount).toBe(1)
        expect(result.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
    })
})
