/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {prepareTermLookupIndexesFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {getValidatedStringOffsets} from '../ext/js/dictionary/term-record-preinterned-plan.js'

const encoder = new TextEncoder()
/** @typedef {ReturnType<typeof copyWasmBackedColumnChunk>} Chunk */
/** @typedef {'javascript'|'native'|'fused'} Mode */

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {string} expression
 * @param {string} [reading]
 * @param {number} [sequence]
 * @returns {unknown[]}
 */
function row(expression, reading = '', sequence = 1) {
    return [expression, reading, 'noun', '', 7, [`definition ${sequence}`], sequence, 'common']
}

/**
 * @param {Array<string|Uint8Array>} banks
 * @param {Mode} mode
 * @param {number} [chunkSize]
 * @param {import('dictionary-importer').ImportExperiments} [experiments]
 * @returns {Promise<{chunks: Chunk[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function project(banks, mode, chunkSize = 0, experiments = {}) {
    /** @type {Chunk[]} */
    const chunks = []
    const sources = banks.map((bank) => {
        const bytes = typeof bank === 'string' ? encoder.encode(bank) : bank
        const padded = new Uint8Array(bytes.length + 11)
        padded.set(bytes, 5)
        return padded.subarray(5, 5 + bytes.length)
    })
    await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        if (!chunk.preparedLookupIndexes) {
            const prepared = prepareTermLookupIndexesFromPreinternedPlan(chunk)
            if (!prepared) { throw new Error('Expected a complete lookup plan') }
            chunk.preparedLookupIndexes = prepared.indexes
        }
        chunks.push(copyWasmBackedColumnChunk(chunk))
    }, chunkSize || 2048, {
        experimentalSkipFusedParse: mode !== 'fused',
        experimentalFusedSingleBank: mode === 'fused',
        experimentalNativeEscapedKeys: true,
        useNativeStringPlan: mode !== 'javascript',
        singleChunk: chunkSize === 0,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTermByteLists: false,
        emitTokenBinaryContent: true,
        prepareLookupIndexes: true,
        ...experiments,
    })
    return {chunks, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * Compare persisted lookup bytes and first-use IDs as well as decoded rows.
 * Content offsets can differ between fused and ordinary deduplication.
 * @param {Chunk[]} chunks
 * @returns {unknown[]}
 */
function snapshot(chunks) {
    return chunks.map((chunk) => {
        const plan = chunk.termRecordPreinternedPlan
        const offsets = getValidatedStringOffsets(plan)
        const meta = chunk.contentMetaList
        const content = chunk.contentBytesBuffer
        if (!meta || !content) { throw new Error('Expected content columns') }
        return {
            keys: Array.from(plan.stringLengths, (length, i) => plan.stringsBuffer.slice(offsets[i], offsets[i] + length)),
            expressionIds: [...plan.expressionIndexes],
            readingIds: [...plan.readingIndexes],
            readingEqualsExpression: [...chunk.readingEqualsExpressionList],
            scores: [...chunk.scoreList],
            sequences: [...chunk.sequenceList],
            content: Array.from({length: chunk.rowCount}, (_, i) => {
                const start = (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4]
                return {bytes: content.slice(start, start + meta[i * 4 + 1]), hashes: [...meta.subarray(i * 4 + 2, i * 4 + 4)]}
            }),
            lookupIndexes: [...(chunk.preparedLookupIndexes ?? [])].map(([key, entry]) => [key, entry.bytes]),
        }
    })
}

describe.each(/** @type {const} */ (['native', 'fused']))('adjacent %s term keys', (mode) => {
    test('preserves repeated senses, spelling variants, distinct suffixes, and first-use key order', async () => {
        const words = [
            ['猫', 'ねこ'],
            ['猫', 'ねこ'],
            ['猫', 'ネコ'],
            ['猫', ''],
            ['猫', '猫'],
            ['ねこ', '猫'],
            ['ねこ', '猫'],
            ['ねこ', 'ねこ'],
            ['ねこ', '猫'],
            ['prefix-a', 'prefix-b'],
            ['prefix-b', 'prefix-b'],
            ['prefix-b', 'prefix-c'],
            ['prefix-b', 'prefix-c'],
            ['prefix-long', 'prefix-c'],
            ['prefix-longer', 'prefix-c'],
            ['𠮷\ufeff', 'よし'],
            ['𠮷\ufeff', 'よし'],
            ['\ufeff𠮷', 'よし'],
            ['\ufeff𠮷', 'よし'],
        ]
        const banks = [JSON.stringify(words.map(([expression, reading], i) => row(expression, reading, i)))]
        const oracle = await project(banks, 'javascript')
        const actual = await project(banks, mode)
        expect(snapshot(actual.chunks)).toStrictEqual(snapshot(oracle.chunks))
        expect(actual.profile?.nativeStringPlanFallbackChunkCount ?? 0).toBe(0)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
    })

    test('retains raw reading equality while literal and escaped spellings share a decoded key', async () => {
        const pairs = [
            ['"a"', '"\\u0061"'],
            ['"a"', '"\\u0061"'],
            ['"a"', '"a"'],
            ['"\\u0061"', '"a"'],
            ['"\\u0061"', '"a"'],
            ['"\\u0061"', '"\\u0061"'],
            ['"\\u0061"', '""'],
            ['"\\u0061"', '""'],
            ['"a"', '"\\u0061"'],
            ['"\\ud800"', '"\\udfff"'],
            ['"\\ud800"', '"\\udfff"'],
        ]
        const banks = [`[${pairs.map(([expression, reading], i) => `[${expression},${reading},"noun","",7,["definition"],${i},"common"]`).join(',')}]`]
        const actual = await project(banks, mode)
        expect(snapshot(actual.chunks)).toStrictEqual(snapshot((await project(banks, 'javascript')).chunks))
        expect([...actual.chunks[0].readingEqualsExpressionList]).toEqual([0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0])
        expect(actual.profile?.nativeStringPlanFallbackChunkCount ?? 0).toBe(0)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(0)
    })

    test('keeps repeated maximum-length UTF-8 keys and their aliases intact', async () => {
        const key = '語'.repeat(21845)
        const banks = [JSON.stringify([row(key, 'よみ'), row(key, 'よみ'), row(key), row(key, key), row('next', key)])]
        expect(snapshot((await project(banks, mode)).chunks)).toStrictEqual(snapshot((await project(banks, 'javascript')).chunks))
        await expect(project([JSON.stringify([row(key + 'x'), row(key + 'x')])], mode)).rejects.toThrow('binary record limit')
    })

    test('reuses only complete rows across independent banks and empty banks', async () => {
        const banks = [JSON.stringify([row('first'), row('猫', 'ねこ')]), '[]', JSON.stringify([row('猫', 'ねこ'), row('cat', 'ねこ')])]
        expect(snapshot((await project(banks, mode)).chunks)).toStrictEqual(snapshot((await project(banks, 'javascript')).chunks))
        await expect(project([banks[0], '[["猫","ねこ","noun","",7,[],1,"common"'], mode)).rejects.toThrow()
    })

    test.each([0xff, 0x80, 0xed])('preserves invalid UTF-8 replacement fallback for repeated byte %i', async (invalidByte) => {
        const bank = encoder.encode(JSON.stringify([row('prefixA', 'reading'), row('prefix!', 'reading'), row('prefix!', 'reading')]))
        for (let i = 0; i < bank.length; ++i) {
            if (bank[i] === 0x21) { bank[i] = invalidByte }
        }
        const actual = await project([bank], mode)
        expect(snapshot(actual.chunks)).toStrictEqual(snapshot((await project([bank], 'javascript')).chunks))
        expect(actual.profile?.nativeStringPlanFallbackChunkCount).toBe(1)
        expect(actual.profile?.fusedParseFallbacks ?? 0).toBe(mode === 'fused' ? 1 : 0)
    })

    test.each(['\\q', '\\u00xz', '\\u000'])('rejects malformed repeated-key continuation %s', async (escape) => {
        const valid = JSON.stringify(row('prefix', 'reading'))
        await expect(project([`[${valid},["prefix${escape}","reading","noun","",7,[],1,"common"]]`], mode)).rejects.toThrow()
    })

    test('resets key IDs when the same arena is reused for another parse', async () => {
        await project([JSON.stringify([row('old-one'), row('old-two'), row('shared', 'shared-reading')])], mode)
        const banks = [JSON.stringify([row('shared', 'shared-reading'), row('shared', 'shared-reading'), row('new-key')])]
        const actual = await project(banks, mode)
        expect(snapshot(actual.chunks)).toStrictEqual(snapshot((await project(banks, 'javascript')).chunks))
        expect([...actual.chunks[0].termRecordPreinternedPlan.expressionIndexes]).toEqual([0, 0, 2])
    })
})

test.each([1, 2, 3])('non-fused plans preserve local IDs across %i-row chunk resets', async (chunkSize) => {
    const banks = [JSON.stringify(Array.from({length: 13}, (_, i) => row(i < 6 ? '猫' : '犬', 'よみ', i)))]
    const actual = await project(banks, 'native', chunkSize)
    expect(snapshot(actual.chunks)).toStrictEqual(snapshot((await project(banks, 'javascript', chunkSize)).chunks))
    expect(actual.profile?.nativeStringPlanFallbackChunkCount).toBe(0)
})

test('keeps fused escaped-key opt-out fallback even after a decoded-equivalent literal', async () => {
    const banks = ['[["a","","", "",0,[],1,""],["\\u0061","","","",0,[],1,""],["\\u0061","","","",0,[],1,""]]']
    const actual = await project(banks, 'fused', 0, {experimentalNativeEscapedKeys: false})
    expect(snapshot(actual.chunks)).toStrictEqual(snapshot((await project(banks, 'javascript')).chunks))
    expect(actual.profile?.fusedParseFallbacks).toBe(1)
})
