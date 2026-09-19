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
import {createHash} from 'node:crypto'
import {Worker} from 'node:worker_threads'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {
    parseTermBankWithWasmColumnChunks, copyWasmBackedColumnChunk, consumeLastTermBankWasmParseProfile, inflateCompressedTermBankSourcesWasm,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {prepareTermLookupIndexesFromPreinternedPlan, hasCompletePreparedTermLookupIndexes} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {compactTermRecordPreinternedPlanRuns} from '../ext/js/dictionary/term-record-preinterned-plan.js'
import {createRetiredLookupScratchAllocator} from '../ext/js/dictionary/term-lookup-scratch.js'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {import('dictionary-importer').ImportExperiments} Flags */
const encoder = new TextEncoder()
const nativeFetch = globalThis.fetch
beforeAll(() => {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const url = input instanceof URL ? input : new URL(String(input))
        return url.protocol === 'file:' ? new Response(await readFile(url)) : nativeFetch(input)
    })
})
afterAll(() => { vi.unstubAllGlobals() })

/**
 * @param {number} count
 * @returns {Uint8Array[]}
 */
function makeBanks(count) {
    const rows = Array.from({length: count}, (_, i) => JSON.stringify([
        `単語${i}`,
i % 3 === 0 ? '' : `よみ${i}`,
'',
'',
i % 17,
[`meaning ${i % 4}`],
i % 7 === 0 ? -1 : i % 503,
'',
    ]))
    const bankSize = Math.min(10000, Math.ceil(count / 2))
    const banks = []
    for (let start = 0; start < count; start += bankSize) { banks.push(encoder.encode(`[${rows.slice(start, start + bankSize).join(',')}]`)) }
    return banks
}
/**
 * @param {Map<string, import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>} indexes
 * @returns {string}
 */
function digestIndexes(indexes) {
    const hash = createHash('sha256')
    for (const [key, entry] of indexes) {
        hash.update(key)
        hash.update(entry.bytes)
        const plan = entry.preinternedPlan
        // Optional offsets/hashes can be omitted by the established worker
        // transport. Compare their specified values, not object shape.
        const offsets = new Uint32Array(plan.stringLengths.length)
        const hashes = new Uint32Array(plan.stringLengths.length)
        let offset = 0
        for (let key = 0; key < offsets.length; ++key) {
            offsets[key] = offset
            const end = offset + plan.stringLengths[key]
            hashes[key] = hashTermKeyBytes(plan.stringsBuffer.subarray(offset, end))
            offset = end
        }
        for (const view of [plan.stringLengths,
            plan.stringOffsets ?? offsets,
            plan.stringHashes ?? hashes,
            plan.stringsBuffer,
            plan.expressionIndexes,
            plan.readingIndexes]) {
            hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        }
    }
    return hash.digest('hex')
}
/**
 * @param {Uint8Array[]} banks
 * @param {Flags} [flags={}]
 * @param {boolean} [preload=false]
 * @returns {Promise<{chunk: Chunk, indexes: Map<string, import('../ext/js/dictionary/term-lookup-index-preparation.js').PreparedTermLookupIndex>, profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 * @throws {Error} If the parser omits results.
 */
async function parse(banks, flags = {}, preload = false) {
    // Keep the portable oracle explicit after production native promotion.
    flags = {experimentalNativeSegmentedLookup: false, experimentalLookupScratchReuse: false, ...flags}
    const preloadedSource = preload ?
        await inflateCompressedTermBankSourcesWasm(banks.map((bank, i) => {
            const compressionMethod = /** @type {0|8} */ (i % 2 === 0 ? 8 : 0)
            const bytes = compressionMethod === 8 ? Uint8Array.from(deflateRawSync(bank)) : bank
            return {bytes, compressionMethod, compressedSize: bytes.length, uncompressedSize: bank.length, signature: crc32(bank)}
        }), flags) :
        undefined
    /** @type {Chunk|null} */
    let result = null
    await parseTermBankWithWasmColumnChunks(preload ? new Uint8Array(0) : banks, 3, (chunk) => { result = copyWasmBackedColumnChunk(chunk) }, 2048, {
        ...flags,
        preloadedSource,
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        prepareLookupIndexes: true,
    })
    if (result === null) { throw new Error('Missing parser chunk') }
    const chunk = /** @type {Chunk} */ (result)
    if (!chunk.preparedLookupIndexes) {
        chunk.preparedLookupIndexes = prepareTermLookupIndexesFromPreinternedPlan(chunk, null, flags)?.indexes
    }
    if (!chunk.preparedLookupIndexes) { throw new Error('Missing lookup indexes') }
    return {chunk, indexes: chunk.preparedLookupIndexes, profile: consumeLastTermBankWasmParseProfile()}
}

describe('lookup construction experiments', () => {
    test('retired scratch planning is disjoint, bounded, aligned and non-mutating', () => {
        const regions = [{pointer: 8, byteLength: 64}, {pointer: 128, byteLength: 16}]
        const allocator = createRetiredLookupScratchAllocator(regions, 144)
        expect(allocator.allocate(12)).toBe(128)
        expect(allocator.allocate(33)).toBe(8)
        expect(allocator.allocate(25)).toBeNull()
        expect(allocator.allocate(24)).toBe(48)
        expect(allocator.usedBytes()).toBe(80)
        expect(regions).toEqual([{pointer: 8, byteLength: 64}, {pointer: 128, byteLength: 16}])
        expect(() => allocator.allocate(-1)).toThrow(RangeError)
        expect(() => allocator.allocate(Infinity)).toThrow(RangeError)
        expect(() => createRetiredLookupScratchAllocator([{pointer: 8, byteLength: 16}, {pointer: 16, byteLength: 8}], 32)).toThrow(RangeError)
        expect(() => createRetiredLookupScratchAllocator([{pointer: 8, byteLength: 33}], 40)).toThrow(RangeError)
        expect(() => createRetiredLookupScratchAllocator([{pointer: 9, byteLength: 8}], 40)).toThrow(RangeError)
    })
    test('scratch reuse works independently for a small native index and preserves media payloads', async () => {
        const banks = makeBanks(20001)
        const rows = JSON.parse(new TextDecoder().decode(banks[0]))
        rows[0][5] = [{type: 'image', path: 'example.png'}]
        rows[1][5] = [{type: 'structured-content', content: {tag: 'span', content: 'live content'}}]
        banks[0] = encoder.encode(JSON.stringify(rows))
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalLookupScratchReuse: true})
        expect(candidate.profile?.nativeLookupScratchReuseGroups).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBeGreaterThan(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(candidate.chunk.mediaRows).toEqual(baseline.chunk.mediaRows)
    })

    test.each(Array.from({length: 16}, (_, i) => i))('all new lookup combinations with previous flags and compressed banks: mask=%i', async (mask) => {
        const banks = makeBanks(70001)
        const baseline = await parse(banks)
        const previous = {experimentalTermBankSpans: true,
            experimentalNativeEscapedKeys: true,
            experimentalValidatedGlossaryReuse: true,
            experimentalFusedSingleBank: true,
            experimentalGlobalExactContentReuse: true,
            experimentalFastGlossaryNormalization: true}
        const flags = {...previous,
            experimentalNativeSegmentedLookup: (mask & 1) !== 0,
            experimentalDirectLookupArena: (mask & 2) !== 0,
            experimentalSinglePassLookupCompaction: (mask & 4) !== 0,
            experimentalLookupScratchReuse: (mask & 8) !== 0}
        const candidate = await parse(banks, flags, true)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe((mask & 1) !== 0 ? 3 : 0)
        expect(candidate.profile?.nativeSegmentedLookupFallbacks).toBe(0)
        if ((mask & 9) === 9) { expect(candidate.profile?.nativeLookupScratchReusedBytes).toBeGreaterThan(0) }
    })
    test('insufficient retired workspace falls back without publishing a partial index', async () => {
        const banks = makeBanks(10000).map((bank) => {
            const rows = JSON.parse(new TextDecoder().decode(bank))
            for (const row of rows) {
                row[0] = 'a'.repeat(48) + row[0]
                row[1] = 'b'.repeat(48) + row[0].slice(48)
            }
            return encoder.encode(JSON.stringify(rows))
        })
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalLookupScratchReuse: true})
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBe(0)
    })
    test.each([65534, 65535, 65536])('native segmentation alone reuses retired scratch at the row boundary: %i', async (count) => {
        const banks = makeBanks(count)
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true}, true)
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(Math.ceil(count / 30000))
        expect(candidate.profile?.nativeLookupScratchReuseGroups).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBeGreaterThan(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(hasCompletePreparedTermLookupIndexes(candidate.indexes, count)).toBe(true)
        await parse(makeBanks(24))
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })
    test('native segmentation alone falls back when retired scratch cannot hold long keys', async () => {
        const banks = makeBanks(40001).map((bank) => {
            const rows = JSON.parse(new TextDecoder().decode(bank))
            for (const row of rows) {
                row[0] = 'a'.repeat(20) + row[0]
                row[1] = 'b'.repeat(20) + row[1]
            }
            return encoder.encode(JSON.stringify(rows))
        })
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(candidate.profile?.fusedParseFallbacks).toBe(0)
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(0)
        expect(candidate.profile?.nativeSegmentedLookupFallbacks).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBe(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(hasCompletePreparedTermLookupIndexes(candidate.indexes, 40001)).toBe(true)
        const recovered = await parse(makeBanks(70001), {experimentalNativeSegmentedLookup: true})
        expect(recovered.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(recovered.profile?.nativeLookupScratchReuseGroups).toBe(1)
    })
    test('segment-sized arenas keep a wide multi-segment group within retired workspace', async () => {
        const banks = makeBanks(90001).map((bank) => {
            const rows = JSON.parse(new TextDecoder().decode(bank))
            for (const row of rows) {
                row[0] = 'a'.repeat(20) + row[0]
                row[1] = 'b'.repeat(20) + row[1]
            }
            return encoder.encode(JSON.stringify(rows))
        })
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true, experimentalLookupScratchReuse: true})
        expect(candidate.profile?.fusedParseFallbacks).toBe(0)
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(4)
        expect(candidate.profile?.nativeLookupScratchReuseGroups).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBeGreaterThan(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        await parse(makeBanks(24))
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })
    test.each([false, true])('segment bounds preserve repeated keys and reading aliases: %s', async (aliases) => {
        const banks = makeBanks(70001).map((bank) => {
            const rows = JSON.parse(new TextDecoder().decode(bank))
            for (const row of rows) {
                row[0] = '共通'
                row[1] = aliases ? row[0] : ''
            }
            return encoder.encode(JSON.stringify(rows))
        })
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })
    test('segment bounds include the final partial segment and long boundary keys', async () => {
        const rows = Array.from({length: 60001}, (_, index) => [
            index < 60000 ? '共通' : '長'.repeat(1000),
            index === 30000 ? '読'.repeat(2000) : '',
            '',
            '',
            0,
            ['meaning'],
            index,
            '',
        ])
        // Unique earlier keys force native segmentation even below 65535 rows.
        for (let index = 0; index < 40000; ++index) {
            rows[index][0] = `単語${index}`
            rows[index][1] = `よみ${index}`
        }
        rows[30000][1] = '読'.repeat(2000)
        const banks = []
        for (let start = 0; start < rows.length; start += 10000) {
            banks.push(encoder.encode(JSON.stringify(rows.slice(start, start + 10000))))
        }
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true}, true)
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })
    test.each([false, true])('empty key tables preserve the existing index rejection: explicit reuse=%s', async (explicitReuse) => {
        const bank = encoder.encode(JSON.stringify(Array.from({length: 10000}, () => [
            '',
            '',
            '',
            '',
            0,
            ['meaning'],
            0,
            '',
        ])))
        const banks = [bank, bank, bank, bank, bank, bank, bank]
        // Empty lookup keys are rejected by the existing index format. Do not
        // replace that validation failure with an unrelated allocator error.
        await expect(parse(banks)).rejects.toThrow('Invalid term lookup index key boundary')
        await expect(parse(banks, {
            experimentalNativeSegmentedLookup: true,
            experimentalLookupScratchReuse: explicitReuse,
        })).rejects.toThrow('Invalid term lookup index key boundary')
        const recovered = await parse(makeBanks(70001), {experimentalNativeSegmentedLookup: true})
        expect(recovered.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(hasCompletePreparedTermLookupIndexes(recovered.indexes, 70001)).toBe(true)
    })
    test('native compactor rejects invalid source/rows/capacity and resets remap on retry', async () => {
        const binary = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
        const {instance} = await WebAssembly.instantiate(binary)
        const wasm = /** @type {{memory: WebAssembly.Memory, wasm_alloc: (n: number) => number, compact_term_lookup_keys: (...args: number[]) => number}} */ (instance.exports)
        /**
         * @param {ArrayBufferView} value
         * @returns {number}
         */
        const put = (value) => {
            const ptr = wasm.wasm_alloc(value.byteLength)
            new Uint8Array(wasm.memory.buffer, ptr, value.byteLength).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
            return ptr
        }
        const offsets = put(new Uint32Array([0, 2]))
        const expr = put(new Uint32Array([0, 1]))
        const equals = put(new Uint8Array([1, 1]))
        const output = put(new Uint8Array([0, 0, 0, 0, 0xaa, 0xbb]))
        const args = [put(encoder.encode('abcd')),
            4,
            put(new Uint16Array([2, 2])),
            offsets,
            put(new Uint32Array([1, 2])),
            2,
            expr,
            expr,
            equals,
            2,
            put(new Uint32Array([88, 99])),
            put(new Uint16Array(2)),
            put(new Uint32Array(2)),
            put(new Uint32Array(2)),
            put(new Uint32Array(2)),
            put(new Uint32Array(2)),
            output,
            4,
            2,
            put(new Uint32Array(1))]
        expect(wasm.compact_term_lookup_keys(...args)).toBe(2)
        new Uint32Array(wasm.memory.buffer, offsets, 2)[1] = 3
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-2)
        new Uint32Array(wasm.memory.buffer, offsets, 2)[1] = 2
        new Uint32Array(wasm.memory.buffer, expr, 2)[1] = 2
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-3)
        new Uint32Array(wasm.memory.buffer, expr, 2)[1] = 1
        new Uint8Array(wasm.memory.buffer, equals, 2)[1] = 2
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-3)
        new Uint8Array(wasm.memory.buffer, equals, 2)[1] = 1
        args[17] = 3
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-4)
        args[17] = 4
        args[18] = 1
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-4)
        args[18] = 2
        expect(wasm.compact_term_lookup_keys(...args)).toBe(2)
        expect([...new Uint8Array(wasm.memory.buffer, output, 6)]).toEqual([97, 98, 99, 100, 0xaa, 0xbb])
        args[9] = 65535
        expect(wasm.compact_term_lookup_keys(...args)).toBe(-1)
    })

    test('native segmented lookup matches all JS index and key-plan bytes and survives heap reuse', async () => {
        const banks = makeBanks(90001)
        const baseline = await parse(banks)
        const expected = digestIndexes(baseline.indexes)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(4)
        expect(hasCompletePreparedTermLookupIndexes(candidate.indexes, 90001)).toBe(true)
        expect(digestIndexes(candidate.indexes)).toBe(expected)
        for (const [key, value] of candidate.indexes) {
            const count = Number(key.split(':')[1])
            expect(value.preinternedPlan.expressionIndexes.length).toBe(count)
            expect(value.preinternedPlan.stringsBuffer.buffer).toBe(value.bytes.buffer)
            expect(value.bytes.buffer).toBeInstanceOf(ArrayBuffer)
        }
        await parse(makeBanks(24))
        expect(digestIndexes(candidate.indexes)).toBe(expected)
        expect(digestIndexes(baseline.indexes)).toBe(expected)
    })
    test.each([65534, 65535, 65536])('preserves uint16 sentinel boundaries: rows=%i', async (count) => {
        const banks = makeBanks(count)
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(hasCompletePreparedTermLookupIndexes(candidate.indexes, count)).toBe(true)
    })
    test.each([0, 1, 2, 3])('JS allocation flags preserve segmented bytes: mask=%i', async (mask) => {
        const banks = makeBanks(70001)
        const baseline = await parse(banks)
        const flags = {experimentalDirectLookupArena: (mask & 1) !== 0, experimentalSinglePassLookupCompaction: (mask & 2) !== 0}
        const result = prepareTermLookupIndexesFromPreinternedPlan(baseline.chunk, null, flags)
        if (result === null) { throw new Error('Missing lookup result') }
        expect(digestIndexes(result.indexes)).toBe(digestIndexes(baseline.indexes))
        expect(result.directArenaSegments).toBe((mask & 1) !== 0 ? 3 : 0)
        expect(result.compactionSourceValidationPasses).toBe((mask & 2) !== 0 ? 1 : 3)
    })
    test('single validation rejects malformed unused offsets and clears touched scratch after row failure', async () => {
        const baseline = await parse(makeBanks(70001))
        const plan = baseline.chunk.termRecordPreinternedPlan
        const scratch = new Uint32Array(plan.stringLengths.length)
        const offsets = plan.stringOffsets
        if (!offsets) { throw new Error('Missing offsets') }
        const original = offsets[1]
        offsets[1] = original + 1
        expect(() => compactTermRecordPreinternedPlanRuns(plan, 70001, 30000, scratch, baseline.chunk.readingEqualsExpressionList)).toThrow()
        offsets[1] = original
        const key = plan.expressionIndexes[45000]
        plan.expressionIndexes[45000] = 0xffffffff
        expect(() => compactTermRecordPreinternedPlanRuns(plan, 70001, 30000, scratch, baseline.chunk.readingEqualsExpressionList)).toThrow()
        expect(scratch.every((value) => value === 0)).toBe(true)
        plan.expressionIndexes[45000] = key
        expect(compactTermRecordPreinternedPlanRuns(plan, 70001, 30000, scratch, baseline.chunk.readingEqualsExpressionList)).toHaveLength(3)
    })
    test('switches reject truthy values and reset to their qualified defaults', () => {
        const keys = ['experimentalLookupScratchReuse', 'experimentalDirectLookupArena', 'experimentalSinglePassLookupCompaction', 'experimentalNativeSegmentedLookup']
        for (const key of keys) {
            expect(Reflect.get(snapshotTermBankExperiments({[key]: true}), key)).toBe(true)
            expect(Reflect.get(snapshotTermBankExperiments({[key]: 1}), key)).toBe(false)
            expect(Reflect.get(snapshotTermBankExperiments(), key)).toBe(key === 'experimentalLookupScratchReuse' || key === 'experimentalNativeSegmentedLookup')
        }
    })
    test('actual worker preserves native segment plans and resets the flag', async () => {
        const workerUrl = new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href
        const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`import {parentPort} from 'node:worker_threads'
            globalThis.self = {addEventListener: (_, fn) => parentPort.on('message', data => fn({data})),
                postMessage: (data, transfer) => parentPort.postMessage(data, transfer)}
            await import(${JSON.stringify(workerUrl)})
            parentPort.postMessage({type: 'loaded'})`)}`))
        /**
         * @param {unknown} message
         * @returns {Promise<{type: string, chunk: Chunk, profile: NonNullable<ReturnType<typeof consumeLastTermBankWasmParseProfile>>}>}
         */
        const request = (message) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker request timed out')), 15000)
            worker.once('error', reject)
            worker.once('message', (reply) => {
                clearTimeout(timer)
                worker.off('error', reject)
                resolve(reply)
            })
            if (message !== null) { worker.postMessage(message) }
        })
        try {
            expect((await request(null)).type).toBe('loaded')
            const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
            expect((await request({type: 'initialize', module})).type).toBe('ready')
            const banks = makeBanks(70001)
            let prior = ''
            for (const enabled of [true, false, undefined, false, undefined]) {
                const reply = await request({type: 'parse',
                    id: enabled === false ? 2 : 1,
                    version: 3,
                    sourceBuffers: banks.map((bank) => bank.buffer),
                    options: {experimentalNativeSegmentedLookup: enabled,
                        experimentalLookupScratchReuse: false,
                        singleChunk: true,
                        emitTermByteLists: false,
                        computeContentHashes: true,
                        emitContentSlab: true,
                        emitTokenBinaryContent: true,
                        prepareLookupIndexes: true}})
                expect(reply.type).toBe('result')
                expect(reply.profile.nativeSegmentedLookupSegments ?? 0).toBe(enabled === false ? 0 : 3)
                expect(reply.profile.nativeLookupScratchReuseGroups ?? 0).toBe(enabled === false ? 0 : 1)
                expect(hasCompletePreparedTermLookupIndexes(reply.chunk.preparedLookupIndexes, 70001)).toBe(true)
                const current = digestIndexes(/** @type {NonNullable<Chunk['preparedLookupIndexes']>} */ (reply.chunk.preparedLookupIndexes))
                if (prior) { expect(current).toBe(prior) }
                prior = current
            }
        } finally { await worker.terminate() }
    })
})
