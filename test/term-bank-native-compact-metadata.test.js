/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} Chunk */
/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions} Options */
const encoder = new TextEncoder()
const text = 'payload 日本語 '.repeat(2500)
/** @type {Options} */
const options = {
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    useNativeStringPlan: true,
    singleChunk: true,
    validateGlossaryTypes: true,
    mediaHintFastScan: true,
    prepareLookupIndexes: true,
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {(index: number) => unknown} glossary
 * @returns {unknown[][]}
 */
function makeRows(glossary = () => [text]) {
    return Array.from({length: 128}, (_, index) => [`word${index}`, `read${index % 7}`, '', '', index, glossary(index), index, ''])
}

/**
 * @param {unknown[][]} rows
 * @returns {import('../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource[]}
 */
function sourcesFor(rows) {
    return [rows.slice(0, 64), rows.slice(64)].map((bank, index) => {
        const bytes = encoder.encode(JSON.stringify(bank))
        const compressed = new Uint8Array(deflateRawSync(bytes))
        return {bytes: compressed, compressionMethod: 8, compressedSize: compressed.length, uncompressedSize: bytes.length, signature: crc32(bytes), filename: `term_bank_${index + 1}.json`}
    })
}

/**
 * @param {Chunk} chunk
 * @returns {Record<string, unknown>}
 */
function snapshot(chunk) {
    const {contentMetaList, contentUniqueIndexList, contentBytesBuffer} = chunk
    if (!contentMetaList || !contentUniqueIndexList || !contentBytesBuffer) { throw new Error('Missing content columns') }
    const contentBase = chunk.contentBytesBaseOffset ?? 0
    const rowMetadata = new Uint32Array(chunk.rowCount * 4)
    for (let row = 0; row < chunk.rowCount; ++row) {
        const source = (chunk.contentMetaByUniqueIndex ? contentUniqueIndexList[row] : row) * 4
        rowMetadata.set(contentMetaList.subarray(source, source + 4), row * 4)
    }
    return {
        count: chunk.rowCount,
        content: createHash('sha256').update(contentBytesBuffer.subarray(contentBase, contentBase + chunk.contentBytesLength)).digest('hex'),
        rowMetadata,
        identities: contentUniqueIndexList,
        keyPlan: chunk.termRecordPreinternedPlan,
        equals: chunk.readingEqualsExpressionList,
        scores: chunk.scoreList,
        sequences: chunk.sequenceList,
        indexes: chunk.preparedLookupIndexes,
        media: chunk.mediaRows.map(({index, row}) => ({index,
            row: {
                ...row,
                glossaryJsonBytes: row.glossaryJsonBytes && createHash('sha256').update(row.glossaryJsonBytes).digest('hex'),
                termEntryContentBytes: createHash('sha256').update(row.termEntryContentBytes).digest('hex'),
            }})),
    }
}

/**
 * @param {unknown[][]} rows
 * @param {boolean} compact
 * @param {Options} [overrides]
 * @returns {Promise<{snapshot: Record<string, unknown>, chunk: Chunk, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(rows, compact, overrides = {}) {
    const preloadedSource = await inflateCompressedTermBankSourcesWasm(sourcesFor(rows), options, true)
    expect(preloadedSource.crcSignaturesPtr).toBeGreaterThan(0)
    /** @type {Chunk|null} */
    let result = null
    await parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        expect(preloadedSource.crcVerified).toBe(true)
        result = copyWasmBackedColumnChunk(chunk)
    }, 2048, {...options, ...overrides, compactContentMetadata: compact, preloadedSource})
    if (result === null) { throw new Error('Missing native chunk') }
    return {snapshot: snapshot(result), chunk: result, profile: consumeLastTermBankWasmParseProfile()}
}

describe('native unique-content metadata', () => {
    test('writes unique descriptors directly with exact row/key/index/content and CRC parity', async () => {
        const rows = makeRows()
        const baseline = await parse(rows, false)
        const candidate = await parse(rows, true)
        expect(candidate.snapshot).toStrictEqual(baseline.snapshot)
        expect(candidate.chunk.contentMetaByUniqueIndex).toBe(true)
        expect(candidate.chunk.contentMetaList).toHaveLength(4)
        expect(candidate.profile?.nativeCompactContentMetadataGroups).toBe(1)
        expect(candidate.profile?.nativeCompactContentMetadataBytesAvoided).toBe((rows.length - 1) * 16)
        expect(candidate.profile?.nativeCompactContentMetadataGatherBytesAvoided).toBe(16)
        const saved = snapshot(candidate.chunk)
        await parse(makeRows((index) => [`${text}${index}`]), true)
        expect(snapshot(candidate.chunk)).toStrictEqual(saved)
    })

    test('preserves nonadjacent canonical matches and media projections', async () => {
        const rows = makeRows((index) => {
            const value = `${text}${index % 11}`
            return index % 2 === 0 ?
[value, {type: 'image', path: `image${index % 11}.png`}] :
                [{type: 'text', text: value}, {type: 'image', path: `image${index % 11}.png`}]
        })
        const baseline = await parse(rows, false)
        const candidate = await parse(rows, true)
        expect(candidate.snapshot).toStrictEqual(baseline.snapshot)
        expect(candidate.chunk.mediaRows).toHaveLength(11)
        expect(candidate.chunk.contentMetaList).toHaveLength(44)
        expect(candidate.profile?.nativeCompactContentMetadataGroups).toBe(1)
    })

    test.each([64, 65, 128])('retains row descriptors at %i unique contents and clears prior mode', async (uniqueCount) => {
        await parse(makeRows(), true)
        const rows = makeRows((index) => [`${text}${index % uniqueCount}`])
        const baseline = await parse(rows, false)
        const candidate = await parse(rows, true)
        expect(candidate.snapshot).toStrictEqual(baseline.snapshot)
        expect(candidate.chunk.contentMetaByUniqueIndex).not.toBe(true)
        expect(candidate.chunk.contentMetaList).toHaveLength(rows.length * 4)
        expect(candidate.profile?.nativeCompactContentMetadataGroups).toBe(0)
    })

    test('expands unusual low-duplication requests without overwriting representatives', async () => {
        const rows = makeRows((index) => [`${text}${index < 20 ? 0 : index}`])
        expect((await parse(rows, true)).snapshot).toStrictEqual((await parse(rows, false)).snapshot)
    })

    test('retains validated numeric fallback and compact JS projection', async () => {
        const rows = makeRows()
        // A wide score requires the established number-preserving fallback.
        rows[0][4] = 2147483648
        const baseline = await parse(rows, false)
        const candidate = await parse(rows, true)
        expect(candidate.snapshot).toStrictEqual(baseline.snapshot)
        expect(candidate.profile?.fusedParseFallbacks).toBe(1)
        expect(candidate.profile?.nativeCompactContentMetadataGroups).toBe(0)
        expect(candidate.chunk.contentMetaByUniqueIndex).toBe(true)
    })

    test('does not publish compact metadata before all source CRCs pass', async () => {
        const sources = sourcesFor(makeRows())
        sources[1].signature ^= 1
        sources[1].signature >>>= 0
        const preloadedSource = await inflateCompressedTermBankSourcesWasm(sources, options, true)
        const sink = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, sink, 2048, {
            ...options, compactContentMetadata: true, preloadedSource,
        })).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        expect(sink).not.toHaveBeenCalled()
        expect((await parse(makeRows(), true)).profile?.nativeCompactContentMetadataGroups).toBe(1)
    })

    test('keeps getter-less modules on the existing compact JS projection', async () => {
        const rows = makeRows()
        const baseline = await parse(rows, false)
        const preloadedSource = await inflateCompressedTermBankSourcesWasm(sourcesFor(rows), options, true)
        const getter = preloadedSource.wasm.wasm_get_last_content_metadata_mode
        preloadedSource.wasm.wasm_get_last_content_metadata_mode = void 0
        /** @type {Chunk|null} */
        let result = null
        try {
            await parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                result = copyWasmBackedColumnChunk(chunk)
            }, 2048, {...options, compactContentMetadata: true, preloadedSource})
        } finally {
            preloadedSource.wasm.wasm_get_last_content_metadata_mode = getter
        }
        if (result === null) { throw new Error('Missing compatibility chunk') }
        expect(snapshot(result)).toStrictEqual(baseline.snapshot)
        expect(consumeLastTermBankWasmParseProfile()?.nativeCompactContentMetadataGroups).toBe(0)
    })
})
