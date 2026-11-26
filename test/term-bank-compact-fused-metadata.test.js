/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {
    consumeLastTermBankWasmParseProfile,
    copyWasmBackedColumnChunk,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmChunks,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions} Options */
/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
const encoder = new TextEncoder()
/** @type {Options} */
const options = {
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    useNativeStringPlan: true,
    singleChunk: true,
    prepareLookupIndexes: true,
    validateGlossaryTypes: true,
    mediaHintFastScan: true,
    experimentalNativeEscapedKeys: true,
}

beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    setTermBankWasmModule(await WebAssembly.compile(bytes))
})

/**
 * @param {number} count
 * @returns {unknown[][]}
 */
function makeRows(count) {
    return Array.from({length: count}, (_, i) => [
        `語${i % 23}`,
        i % 3 ? `よみ${i % 29}` : '',
        i % 7 ? '' : 'tag',
        i % 11 ? '' : 'v1',
        i % 31 - 15,
        [{
            type: 'structured-content',
            content: [
                {tag: 'span', content: `${i % 4} 日本語 ${'shared '.repeat(100)}`},
                {tag: 'img', path: `image${i % 4}.png`},
            ],
        }],
        i % 13 ? i : null,
        i % 17 ? '' : 'popular',
    ])
}

/**
 * @param {unknown[][]} rows
 * @param {number} [size]
 * @returns {Uint8Array[]}
 */
function bankBytes(rows, size = Math.ceil(rows.length / 3)) {
    const result = []
    for (let i = 0; i < rows.length; i += size) {
        result.push(encoder.encode(`\r\n ${JSON.stringify(rows.slice(i, i + size))}\t`))
    }
    result.splice(1, 0, encoder.encode(' [ ] '))
    return result
}

/**
 * @param {Uint8Array[]} banks
 * @param {Options} [overrides]
 * @param {import('../ext/js/dictionary/term-bank-wasm-parser.js').PreloadedTermBankSource} [preloadedSource]
 * @returns {Promise<{chunks: Chunk[], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(banks, overrides = {}, preloadedSource = void 0) {
    /** @type {Chunk[]} */
    const chunks = []
    await parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        const owned = copyWasmBackedColumnChunk(chunk)
        delete owned.preparedLookupIndexEncodeMs
        chunks.push(owned)
    }, 2048, {...options, ...overrides, preloadedSource})
    return {chunks, profile: consumeLastTermBankWasmParseProfile()}
}

/**
 * @param {Uint8Array[]} banks
 * @returns {import('../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource[]}
 */
function compress(banks) {
    return banks.map((bank, i) => {
        const bytes = new Uint8Array(deflateRawSync(bank))
        return {bytes, compressionMethod: 8, compressedSize: bytes.length, uncompressedSize: bank.length, signature: crc32(bank), filename: `term_bank_${i + 1}.json`}
    })
}

describe('compact native fused row metadata', () => {
    test('preserves complete columns, media, deduplication and lookup bytes across ring and bank boundaries', async () => {
        const banks = bankBytes(makeRows(113))
        const full = await parse(banks, {compactFusedMetadata: false})
        const compact = await parse(banks)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compact.profile?.fusedParseFallbacks ?? 0).toBe(0)
        expect(compact.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(compact.profile?.metaAllocatedBytes).toBe((full.profile?.metaAllocatedBytes ?? 0) * 7 / 17)
        expect(compact.profile?.recentContentDedupHitCount).toBe(full.profile?.recentContentDedupHitCount)
        const snapshot = structuredClone(compact.chunks)
        await parse(bankBytes(makeRows(2000)))
        assert.deepStrictEqual(compact.chunks, snapshot)
    })

    test('preserves escaped diagnostic keys and explicit-reading semantics', async () => {
        const rows = makeRows(23)
        rows[7][0] = '語\ud800'
        rows[7][1] = '語\ud800'
        const banks = bankBytes(rows).map((bank) => encoder.encode(new TextDecoder().decode(bank).replaceAll('語8', String.raw`\u8a9e8`)))
        const full = await parse(banks, {compactFusedMetadata: false})
        const compact = await parse(banks)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compact.profile?.escapedKeyDecodeCount).toBeGreaterThan(0)
    })

    test('preserves negative-zero media sequences without turning their sign bit into a media hint', async () => {
        const banks = [encoder.encode('[ ["negative","","","",0,[{"type":"image","path":"negative.png"}],-0,""], ["plain","","","",0,["text"],-0,""], ["positive","","","",0,[{"type":"image","path":"positive.png"}],0,""] ]')]
        const full = await parse(banks, {compactFusedMetadata: false})
        const compact = await parse(banks)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(Object.is(full.chunks[0].mediaRows[0].row.sequence, -0)).toBe(true)
        expect(Object.is(compact.chunks[0].mediaRows[0].row.sequence, -0)).toBe(true)
        expect(compact.chunks[0].mediaRows.map(({index}) => index)).toEqual([0, 2])
        expect(Object.is(compact.chunks[0].sequenceList[0], 0)).toBe(true)
    })

    test('keeps complete row history for the global raw-content experiment', async () => {
        const banks = bankBytes(makeRows(100))
        const full = await parse(banks, {compactFusedMetadata: false, experimentalGlobalExactContentReuse: true})
        const requested = await parse(banks, {experimentalGlobalExactContentReuse: true})
        assert.deepStrictEqual(requested.chunks, full.chunks)
        expect(requested.profile?.metaAllocatedBytes).toBe(full.profile?.metaAllocatedBytes)
    })

    test.each([-0, 0.5, 0x80000000])('preserves late full-layout fallback for score %s', async (score) => {
        const rows = makeRows(67)
        rows[65][4] = score
        const banks = bankBytes(rows).map((bank) => {
            if (!Object.is(score, -0)) { return bank }
            const row = JSON.stringify(rows[65])
            return encoder.encode(new TextDecoder().decode(bank).replace(row, row.replace(',0,[', ',-0,[')))
        })
        const full = await parse(banks, {compactFusedMetadata: false})
        const compact = await parse(banks)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compact.profile?.fusedParseFallbacks).toBe(1)
        expect(compact.profile?.metaAllocatedBytes).toBe(full.profile?.metaAllocatedBytes)
    })

    test('keeps the ordinary object parser on its full metadata layout', async () => {
        const banks = bankBytes(makeRows(18))
        /** @type {unknown[]} */
        const rows = []
        await parseTermBankWithWasmChunks(banks, 3, (chunk) => { rows.push(...chunk) }, 2048, {validateGlossaryTypes: true})
        expect(rows).toHaveLength(18)
        expect(consumeLastTermBankWasmParseProfile()?.metaAllocatedBytes).toBeGreaterThan(0)
        expect(rows[7]).toMatchObject({expression: '語7', definitionTags: 'tag', score: -8})
    })

    test('preserves segmented lookup output with compact metadata', async () => {
        const rows = Array.from({length: 70_003}, (_, i) => [`語${i}`, '', '', '', i % 31, [`glossary ${i % 3}`], i, ''])
        const banks = bankBytes(rows, 10_000)
        const full = await parse(banks, {compactFusedMetadata: false})
        const compact = await parse(banks)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compact.profile?.nativeSegmentedLookupSegments).toBe(full.profile?.nativeSegmentedLookupSegments)
        expect(compact.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(compact.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(compact.profile?.nativeSegmentedLookupFallbacks).toBe(0)
    }, 30_000)

    test.each(['content', 'keys'])('native lookup writes in unused %s capacity preserve every live source and output prefix', async (arena) => {
        /** @type {unknown[][]} */
        const rows = arena === 'content' ?
            Array.from({length: 20_001}, (_, i) => [`e${'x'.repeat(55)}${i}`, `r${'x'.repeat(55)}${i}`, '', '', i % 31, [`glossary ${i % 3}`], i, '']) :
            Array.from({length: 70_003}, (_, i) => [`e${'x'.repeat(20)}${i}`, `r${'x'.repeat(20)}${i}`, '', '', i % 31, [`glossary ${i % 3}`], i, ''])
        rows[7][5] = [{type: 'image', path: 'live.png'}]
        const banks = bankBytes(rows, 10_000)
        const full = await parse(banks, {compactFusedMetadata: false, experimentalLookupScratchReuse: false})
        const source = await inflateCompressedTermBankSourcesWasm(compress(banks), options, true)
        const {wasm} = source
        const originalParse = wasm.parse_and_encode_term_bank_token_binary_dedup
        const originalEncode = wasm.encode_term_lookup_index
        /** @type {Array<{pointer: number, bytes: Uint8Array}>} */
        const liveRanges = []
        let retiredPointer = 0
        let retiredLength = 0
        let retiredPoison = 0
        let encodedIndexes = 0
        /** @returns {void} */
        function assertLiveRanges() {
            for (const {pointer, bytes} of liveRanges) {
                expect(Buffer.compare(Buffer.from(wasm.memory.buffer, pointer, bytes.length), Buffer.from(bytes))).toBe(0)
            }
        }
        wasm.parse_and_encode_term_bank_token_binary_dedup = (...args) => {
            const length = originalParse(...args)
            expect(length).toBeGreaterThan(0)
            const stringLength = new Uint32Array(wasm.memory.buffer, args[23], 1)[0]
            const stringCount = new Uint32Array(wasm.memory.buffer, args[22], 1)[0]
            const rowCount = new Uint32Array(wasm.memory.buffer, args[12], 1)[0]
            const uniqueCount = new Uint32Array(wasm.memory.buffer, args[10], 1)[0]
            const prefixes = [[args[0], args[1]], [args[15], stringCount * 2], [args[16], stringCount * 4], [args[17], stringCount * 4]]
            for (const field of [18, 19, 25, 26]) { prefixes.push([args[field], rowCount * 4]) }
            prefixes.push([args[24], rowCount], [args[6], rowCount * 16], [args[9], rowCount * 4], [args[11], uniqueCount * 12])
            for (const region of [
                {name: 'content', pointer: args[4], length, capacity: wasm.wasm_get_last_content_capacity(), poison: 0xa5},
                {name: 'keys', pointer: args[13], length: stringLength, capacity: args[14], poison: 0x5a},
            ]) {
                const offset = Math.ceil(region.length / 8) * 8
                // Poison spare capacity and the alignment gap. Native lookup
                // may change only the aligned tail, never the protected prefix.
                new Uint8Array(wasm.memory.buffer, region.pointer + region.length, region.capacity - region.length).fill(region.poison)
                prefixes.push([region.pointer, offset])
                if (region.name === arena) {
                    retiredPointer = region.pointer + offset
                    retiredLength = region.capacity - offset
                    retiredPoison = region.poison
                }
            }
            expect(retiredLength).toBeGreaterThan(0)
            for (const [pointer, byteLength] of prefixes) {
                liveRanges.push({pointer, bytes: Uint8Array.from(new Uint8Array(wasm.memory.buffer, pointer, byteLength))})
            }
            return length
        }
        wasm.encode_term_lookup_index = (...args) => {
            assertLiveRanges()
            const result = originalEncode(...args)
            assertLiveRanges()
            ++encodedIndexes
            return result
        }
        let compact
        try {
            compact = await parse([], {}, source)
            assertLiveRanges()
            expect(encodedIndexes).toBe(arena === 'content' ? 1 : 3)
            expect(new Uint8Array(wasm.memory.buffer, retiredPointer, retiredLength).some((byte) => byte !== retiredPoison)).toBe(true)
        } finally {
            wasm.parse_and_encode_term_bank_token_binary_dedup = originalParse
            wasm.encode_term_lookup_index = originalEncode
        }
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compact.profile?.nativeLookupScratchReuseGroups).toBe(1)
        expect(compact.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(compact.profile?.nativeSegmentedLookupFallbacks).toBe(0)
    }, 30_000)

    test('preserves deferred source CRC witnesses and rejects corrupt sources before publication', async () => {
        const rows = makeRows(113)
        for (const row of rows) { row[5] = ['日本語'.repeat(6000), {type: 'image', path: 'live.png'}] }
        const banks = bankBytes(rows)
        const sources = compress(banks)
        const fullSource = await inflateCompressedTermBankSourcesWasm(sources, options, true)
        const full = await parse([], {compactFusedMetadata: false}, fullSource)
        const compactSource = await inflateCompressedTermBankSourcesWasm(sources, options, true)
        expect(compactSource.crcSignaturesPtr).toBeGreaterThan(0)
        const compact = await parse([], {}, compactSource)
        assert.deepStrictEqual(compact.chunks, full.chunks)
        expect(compactSource.crcVerified).toBe(true)
        expect(compactSource.crcReusedBytes).toBe(fullSource.crcReusedBytes)
        sources[2].signature = (sources[2].signature ^ 1) >>> 0
        const badSource = await inflateCompressedTermBankSourcesWasm(sources, options, true)
        const sink = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks([], 3, sink, 2048, {...options, preloadedSource: badSource})).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        expect(sink).not.toHaveBeenCalled()
    })

    test('rejects a malformed final bank after several reuse-window wraps', async () => {
        const banks = bankBytes(makeRows(67))
        banks[banks.length - 1] = encoder.encode('[["bad","","","",0,["value"],0,""]')
        const sink = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks(banks, 3, sink, 2048, options)).rejects.toThrow()
        expect(sink).not.toHaveBeenCalled()
    })
})
