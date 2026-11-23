/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {
    consumeLastTermBankWasmParseProfile,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
    parseTermBankWithWasmColumnChunksOverlapped,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWasmExports} ParserExports */
/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} Chunk */
/** @type {ParserExports} */
let parser
const encoder = new TextEncoder()
const originalFetch = globalThis.fetch

beforeAll(async () => {
    const wasm = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    const {instance} = await WebAssembly.instantiate(wasm)
    parser = /** @type {ParserExports} */ (/** @type {unknown} */ (instance.exports))
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const url = input instanceof URL ? input : new URL(String(input))
        return url.protocol === 'file:' ? new Response(await readFile(url)) : await originalFetch(input)
    })
})
afterAll(() => { vi.unstubAllGlobals() })

/**
 * @param {string} object
 * @param {number} [index]
 * @param {string} [key]
 * @returns {string}
 */
function metadataRow(object, index = 0, key = '"data"') {
    return `["entry-${index}","","noun","",${index},[{"type":"structured-content","content":{"tag":"span",${key}:${object},"content":"definition-${index}"}}],${index},""]`
}

/**
 * @param {string[]} banks
 * @param {boolean} fused
 * @param {{capacity?: number, reset?: boolean, validate?: boolean, media?: boolean}} [options]
 * @returns {{result: number, count: number, metadata: number[][], hits: number, bytes: number}}
 */
function nativeParse(banks, fused, {capacity = 128, reset = true, validate = true, media = true} = {}) {
    if (reset) { parser.wasm_reset_heap() }
    const sources = banks.map((bank) => encoder.encode(bank))
    const sourceLength = sources.reduce((sum, bytes) => sum + bytes.length, 0)
    const input = parser.wasm_alloc(sourceLength)
    const spans = parser.wasm_alloc(sources.length * 8)
    let offset = 0
    for (const [i, bytes] of sources.entries()) {
        new Uint8Array(parser.memory.buffer, input + offset, bytes.length).set(bytes)
        new Uint32Array(parser.memory.buffer, spans + i * 8, 2).set([offset, bytes.length])
        offset += bytes.length
    }
    const metadata = parser.wasm_alloc(capacity * 17 * 4)
    let result
    let count
    if (!fused) {
        result = (media ? parser.parse_term_bank_with_media_hints : parser.parse_term_bank)(input, sourceLength, metadata, capacity, spans, sources.length, validate ? 1 : 0)
        count = Math.max(0, result)
    } else {
        const alloc = (/** @type {number} */ length) => parser.wasm_alloc(length)
        let tableSize = 1
        while (tableSize < capacity * 4) { tableSize *= 2 }
        const contentMetadata = alloc(capacity * 16)
        const contentTable = alloc(tableSize * 4)
        const uniqueIndexes = alloc(capacity * 4)
        const uniqueCount = alloc(4)
        const signatures = alloc(capacity * 12)
        const rowCount = alloc(4)
        const strings = alloc(1024 * 1024)
        const lengths = alloc(capacity * 4)
        const offsets = alloc(capacity * 8)
        const hashes = alloc(capacity * 8)
        const expressions = alloc(capacity * 4)
        const readings = alloc(capacity * 4)
        const stringTable = alloc(tableSize * 4)
        const stringCount = alloc(4)
        const stringBytes = alloc(4)
        const equals = alloc(capacity)
        const scores = alloc(capacity * 4)
        const sequences = alloc(capacity * 4)
        const recentHits = alloc(4)
        const stats = alloc(7 * 4)
        const output = alloc(1024 * 1024)
        new Uint32Array(parser.memory.buffer, contentTable, tableSize).fill(0)
        new Uint32Array(parser.memory.buffer, stringTable, tableSize).fill(0)
        new Uint32Array(parser.memory.buffer, rowCount, 1)[0] = 0
        new Uint32Array(parser.memory.buffer, stats, 7).fill(0x735a19bd)
        result = parser.parse_and_encode_term_bank_token_binary_dedup(
            input,
            sourceLength,
            metadata,
            capacity,
            output,
            1024 * 1024,
            contentMetadata,
            contentTable,
            tableSize,
            uniqueIndexes,
            uniqueCount,
            signatures,
            rowCount,
            strings,
            1024 * 1024,
            lengths,
            offsets,
            hashes,
            expressions,
            readings,
            stringTable,
            tableSize,
            stringCount,
            stringBytes,
            equals,
            scores,
            sequences,
            recentHits,
media ? 1 : 0,
1,
spans,
sources.length,
stats,
0,
0,
0,
validate ? 1 : 0,
        )
        count = result < 0 ? 0 : new Uint32Array(parser.memory.buffer, rowCount, 1)[0]
        expect([...new Uint32Array(parser.memory.buffer, stats + 20, 2)]).toEqual([0x735a19bd, 0x735a19bd])
    }
    expect(new Uint8Array(parser.memory.buffer, input, sourceLength)).toEqual(new Uint8Array(Buffer.concat(sources)))
    return {
        result,
        count,
        metadata: Array.from({length: count}, (_, i) => [...new Uint32Array(parser.memory.buffer, metadata + i * 17 * 4, 17)]),
        hits: (parser.wasm_get_last_metadata_reuse_count?.() ?? 0) >>> 0,
        bytes: (parser.wasm_get_last_metadata_reuse_bytes?.() ?? 0) >>> 0,
    }
}

/**
 * @param {Chunk} chunk
 * @returns {unknown[]}
 */
function snapshotChunk(chunk) {
    const plan = chunk.termRecordPreinternedPlan
    if (!(plan.stringOffsets instanceof Uint32Array)) { throw new Error('Missing string offsets') }
    const offsets = plan.stringOffsets
    const key = (/** @type {number} */ i) => [...plan.stringsBuffer.subarray(offsets[i], offsets[i] + plan.stringLengths[i])]
    return Array.from({length: chunk.rowCount}, (_, i) => {
        const meta = chunk.contentMetaList
        const buffer = chunk.contentBytesBuffer
        if (!(meta instanceof Uint32Array) || !(buffer instanceof Uint8Array)) { throw new Error('Missing content columns') }
        const start = (chunk.contentBytesBaseOffset ?? 0) + meta[i * 4]
        return {
            expression: key(plan.expressionIndexes[i]),
            reading: key(plan.readingIndexes[i]),
            equals: chunk.readingEqualsExpressionList[i],
            score: chunk.scoreList[i],
            sequence: chunk.sequenceList[i],
            content: [...buffer.subarray(start, start + meta[i * 4 + 1])],
            hashes: [meta[i * 4 + 2], meta[i * 4 + 3]],
            media: chunk.mediaRows.filter((row) => row.index === i).map(({row, imagePaths}) => ({
                imagePaths,
                expression: row.expression,
                reading: row.reading,
                glossary: row.glossaryJson,
                content: [...row.termEntryContentBytes],
            })),
        }
    })
}

/**
 * @param {string[]} banks
 * @param {boolean} [skipFused]
 * @param {boolean} [preload]
 * @returns {Promise<{rows: unknown[], profile: NonNullable<ReturnType<typeof consumeLastTermBankWasmParseProfile>>}>}
 */
async function parseColumns(banks, skipFused = false, preload = false) {
    const sources = banks.map((bank) => encoder.encode(bank))
    const preloadedSource = preload ?
await inflateCompressedTermBankSourcesWasm(sources.map((source, i) => {
    const compressionMethod = i % 2 === 0 ? 8 : 0
    const bytes = compressionMethod === 8 ? Uint8Array.from(deflateRawSync(source)) : source
    return {bytes, compressionMethod, compressedSize: bytes.length, uncompressedSize: source.length, signature: crc32(source)}
})) :
undefined
    /** @type {unknown[]} */
    const rows = []
    await parseTermBankWithWasmColumnChunks(preloadedSource ? new Uint8Array(0) : sources, 3, (chunk) => {
        rows.push(...snapshotChunk(chunk))
    }, 3, {
        preloadedSource,
        experimentalSkipFusedParse: skipFused,
        experimentalFusedSingleBank: true,
        experimentalValidatedGlossaryReuse: false,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
    })
    const profile = consumeLastTermBankWasmParseProfile()
    if (profile === null) { throw new Error('Missing parser profile') }
    return {rows, profile}
}

describe('bounded exact metadata witnesses', () => {
    test.each(['"data"', '"style"'])('reuses full flat objects under %s and preserves every native field', (key) => {
        const object = '{"content":"glossary","count":3,"valid":true,"empty":null}'
        const banks = [0, 1].map((bank) => `[${[0, 1, 2].map((i) => metadataRow(object, bank * 3 + i, key)).join(',')}]`)
        const baseline = nativeParse(banks, false)
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(baseline.metadata)
        expect(result.count).toBe(6)
        expect(result.hits).toBe(5)
        expect(result.bytes).toBe(5 * encoder.encode(object).length)
    })

    test.each([
        ['{"type":"image","type":"text","text":"x"}', [1, 1, 1]],
        [String.raw`{"t\u0079pe":"te\u0078t","text":"x"}`, [0, 1, 1]],
        [String.raw`{"\u0069mg":"value","value":"日本語"}`, [1, 0, 0]],
        [String.raw`{"value":"\u0069mage","other":"x"}`, [1, 0, 0]],
        ['{ \n"value"\t:\rfalse, "number":-0.25e+2 }', [0, 1, 0]],
        ['{"value":"image suffix","other":"img suffix"}', [0, 0, 0]],
    ])('replays exact hints for duplicate/escaped fields: %s', (object, hints) => {
        const banks = [`[${metadataRow(object, 0)},${metadataRow(object, 1)}]`]
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(nativeParse(banks, false).metadata)
        expect(result.metadata.map((row) => row.slice(14))).toEqual([hints, hints])
        expect(result.hits).toBe(1)
    })

    test('does not inherit hints from an earlier enclosing row', () => {
        const object = '{"content":"glossary"}'
        const first = metadataRow(object).replace('[{"type":"structured-content"', '["image", {"type":"text","text":"first"},{"type":"structured-content"')
        const banks = [`[${first},${metadataRow(object, 1)}]`]
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(nativeParse(banks, false).metadata)
        expect(result.metadata.map((row) => row.slice(14))).toEqual([[1, 1, 1], [0, 0, 0]])
        expect(result.hits).toBe(1)
    })

    test('retains full equality under common prefixes, unique objects, and eviction', () => {
        const objects = Array.from({length: 65}, (_, i) => `{"common-prefix":"unique-${i}"}`)
        const rows = [...objects, objects[0], objects[64]].map((object, i) => metadataRow(object, i))
        const banks = [`[${rows.join(',')}]`]
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(nativeParse(banks, false).metadata)
        expect(result.hits).toBe(1)
        expect(result.bytes).toBe(objects[64].length)
    })

    test.each([15, 16, 512, 513])('honors the fixed object byte boundary at %i', (length) => {
        const object = `{"value":"${'x'.repeat(length - 12)}"}`
        expect(encoder.encode(object)).toHaveLength(length)
        const banks = [`[${metadataRow(object, 0)},${metadataRow(object, 1)}]`]
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(nativeParse(banks, false).metadata)
        expect(result.hits).toBe(length >= 16 && length <= 512 ? 1 : 0)
    })

    test.each([
        ['{"value":{"nested":"child"}}', '"data"'],
        ['{"value":["nested child"]}', '"style"'],
        ['{"content":"glossary"}', String.raw`"d\u0061ta"`],
        ['{"content":"glossary"}', String.raw`"st\u0079le"`],
        ['{"content":"glossary"}', '"other"'],
    ])('keeps nested objects and ineligible keys on ordinary validation: %s %s', (object, key) => {
        const banks = [`[${metadataRow(object, 0, key)},${metadataRow(object, 1, key)}]`]
        const result = nativeParse(banks, true)
        expect(result.metadata).toEqual(nativeParse(banks, false).metadata)
        expect(result.hits).toBe(0)
    })

    test.each([255, 256, 257])('does not skip a nesting frame at depth %i', (depth) => {
        const object = '{"content":"glossary"}'
        const inner = `{"data":${object},"style":${object}}`
        const glossary = '['.repeat(depth - 2) + inner + ']'.repeat(depth - 2)
        const banks = [`[["entry","","","",0,${glossary},1,""]]`]
        const baseline = nativeParse(banks, false, {validate: false})
        const result = nativeParse(banks, true, {validate: false})
        expect(result.metadata).toEqual(baseline.metadata)
        expect(result.result < 0).toBe(baseline.result < 0)
        expect(result.result < 0).toBe(depth > 256)
        expect(result.hits).toBe(depth > 256 ? 0 : 1)
    })

    test.each([
        '{"content":"glossary"}true',
        '{"content":"glossary",}',
        '{"content":"glossary" "next":0}',
        '{"content":"glossary","next":01}',
        '{"content":"glossary","next":1e}',
        String.raw`{"content":"glossary","next":"\q"}`,
        String.raw`{"content":"glossary","next":"\u12xz"}`,
        '{"content":"glossary","next":"raw\ncontrol"}',
        '{"content":"glossary","next":}',
        '{"content":"glossary"]',
    ])('rejects malformed common-prefix successors without publishing rows: %s', (object) => {
        const good = metadataRow('{"content":"glossary"}')
        const banks = [`[${good},${good},${metadataRow(object, 2)}]`]
        expect(nativeParse(banks, false).result).toBe(-1)
        const result = nativeParse(banks, true)
        expect(result.result).toBe(-1)
        expect(result.hits).toBe(0)
        expect(result.bytes).toBe(0)
    })

    test.each([
        '"type":"unknown","content":"x"',
        '"type":"text","text":false',
        '"type":"image","path":null',
        '"type":"structured-content","content":true',
        '"type":"text","text":"x","text":null',
        '"type":"image","path":"x.png","type":"unknown"',
    ])('leaves top-level required-field and last-key validation intact: %s', (fields) => {
        const object = '{"content":"glossary"}'
        const bad = `["bad","","","",0,[{${fields},"data":${object},"style":${object}}],1,""]`
        const banks = [`[${metadataRow(object)},${bad}]`]
        expect(nativeParse(banks, false).result).toBe(-1)
        expect(nativeParse(banks, true).result).toBe(-1)
    })

    test('never reads a remembered object past the current logical bank end', () => {
        const row = metadataRow('{"content":"glossary"}')
        const split = row.indexOf('glossary') + 5
        const banks = [`[${row}]`, `[${row.slice(0, split)}`, `${row.slice(split)}]`]
        expect(nativeParse(banks, false).result).toBe(-1)
        expect(nativeParse(banks, true).result).toBe(-1)
    })

    test('clears witnesses and diagnostics on reset, retry, failure, and each public parse entry', () => {
        const row = metadataRow('{"content":"glossary"}')
        const banks = [`[${row},${row}]`]
        expect(nativeParse(banks, true).hits).toBe(1)
        expect(nativeParse([`[${row}]`], true, {reset: false}).hits).toBe(0)
        expect(nativeParse(banks, true).hits).toBe(1)
        parser.wasm_reset_heap()
        expect(parser.wasm_get_last_metadata_reuse_count?.()).toBe(0)
        expect(parser.wasm_get_last_metadata_reuse_bytes?.()).toBe(0)
        expect(nativeParse(banks, true, {capacity: 1}).result).toBe(-4)
        expect(parser.wasm_get_last_metadata_reuse_count?.()).toBe(0)
        expect(nativeParse(banks, true, {reset: false}).hits).toBe(1)
        expect(parser.parse_term_bank(0, 0, 0, 0)).toBe(-1)
        expect(parser.wasm_get_last_metadata_reuse_count?.()).toBe(0)
        expect(nativeParse(banks, true).hits).toBe(1)
        expect(parser.parse_term_bank_with_media_hints(0, 0, 0, 0)).toBe(-1)
        expect(parser.wasm_get_last_metadata_reuse_bytes?.()).toBe(0)
        expect(nativeParse(banks, true).hits).toBe(1)
        expect(parser.parse_and_encode_term_bank_token_binary_dedup()).toBe(-1)
        expect(parser.wasm_get_last_metadata_reuse_count?.()).toBe(0)
    })
})

describe('metadata witnesses through parser columns', () => {
    const metadata = ['{"content":"glossary"}', '{"type":"text","text":"metadata"}', String.raw`{"value":"\u0069mg"}`, '{ "fontSize": "65%", "verticalAlign": "middle" }']
    const banks = Array.from({length: 4}, (_, bank) => `[${metadata.map((object, i) => metadataRow(object, bank * 4 + i)).join(',')},["image-${bank}","","","",0,[{"type":"image","path":"img/猫.webp"}],1,""]]`)

    test.each([false, true])('preserves all content bytes, hashes, keys, and media rows: preload=%s', async (preload) => {
        const baseline = await parseColumns(banks, true, preload)
        const result = await parseColumns(banks, false, preload)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.fusedParseFallbacks).toBe(0)
        expect(result.profile.nestedMetadataReuseCount).toBe(12)
        expect(result.profile.nestedMetadataReuseBytes).toBe(3 * metadata.reduce((sum, object) => sum + encoder.encode(object).length, 0))
        expect(baseline.profile.nestedMetadataReuseCount).toBe(0)
    })

    test('preserves bounded numeric counters through grouped result aggregation', async () => {
        const object = '{"content":"glossary"}'
        const sources = Array.from({length: 4}, (_, i) => encoder.encode(`[${metadataRow(object, i * 2)},${metadataRow(object, i * 2 + 1)}]`))
        let rows = 0
        expect(await parseTermBankWithWasmColumnChunksOverlapped(sources, 3, (chunk) => { rows += chunk.rowCount }, {
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            experimentalFusedSingleBank: true,
            experimentalValidatedGlossaryReuse: false,
            validateGlossaryTypes: true,
        })).toBe(true)
        const profile = consumeLastTermBankWasmParseProfile()
        expect(rows).toBe(8)
        expect(profile?.fusedParseAttempts).toBe(1)
        expect(profile?.nestedMetadataReuseCount).toBe(7)
        expect(profile?.nestedMetadataReuseBytes).toBe(7 * object.length)
    })

    test('drops partial witness diagnostics on escaped-key fallback and clears the next parse', async () => {
        const object = '{"content":"glossary"}'
        const rows = [metadataRow(object, 0), metadataRow(object, 1), metadataRow(object, 2).replace('entry-2', String.raw`entry-\u0032`)]
        const result = await parseColumns([`[${rows.join(',')}]`])
        expect(result.rows).toEqual((await parseColumns([`[${rows.join(',')}]`], true)).rows)
        expect(result.profile.fusedParseFallbacks).toBe(1)
        expect(result.profile.nestedMetadataReuseCount).toBe(0)
        expect(result.profile.nestedMetadataReuseBytes).toBe(0)
        expect((await parseColumns([`[${metadataRow(object)}]`])).profile.nestedMetadataReuseCount).toBe(0)
    })

    test('does not emit a chunk for malformed input after successful metadata matches', async () => {
        const good = metadataRow('{"content":"glossary"}')
        const source = encoder.encode(`[${good},${good},${metadataRow('{"content":"glossary"}0')}]`)
        const onChunk = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks([source, encoder.encode('[]')], 3, onChunk, 1, {
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            validateGlossaryTypes: true,
        })).rejects.toThrow(/term-bank parser failed/)
        expect(onChunk).not.toHaveBeenCalled()
    })
})
