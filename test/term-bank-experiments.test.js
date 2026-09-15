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
import {Worker} from 'node:worker_threads'
import {createHash} from 'node:crypto'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest'
import {snapshotTermBankExperiments, getTermBankExperimentMask} from '../ext/js/dictionary/term-bank-experiments.js'
import {
    consumeLastTermBankWasmParseProfile,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {Parameters<Parameters<typeof parseTermBankWithWasmColumnChunks>[2]>[0]} Chunk */
/** @typedef {{expression: number[], reading: number[], score: number, sequence: number, readingEqualsExpression: number, content: {length: number, sha256: string}, hashes: number[], media: Array<{expression: string, reading: string, glossary: string, content: {length: number, sha256: string}}>}} SnapshotRow */
const encoder = new TextEncoder()
const nativeFetch = globalThis.fetch
const flagNames = /** @type {Array<keyof Experiments>} */ ([
    'experimentalTermBankSpans',
    'experimentalNativeEscapedKeys',
    'experimentalValidatedGlossaryReuse',
    'experimentalFusedSingleBank',
    'experimentalGlobalExactContentReuse',
    'experimentalFastGlossaryNormalization',
])
/**
 * @param {number} mask
 * @returns {Experiments}
 */
function flags(mask) {
    return snapshotTermBankExperiments(Object.fromEntries(flagNames.map((key, i) => [key, (mask & (1 << i)) !== 0])))
}

/**
 * @param {string|Uint8Array} source
 * @param {0|8} method
 * @returns {{bytes: Uint8Array, compressionMethod: 0|8, compressedSize: number, uncompressedSize: number, signature: number}}
 */
function compressed(source, method) {
    const decoded = typeof source === 'string' ? encoder.encode(source) : source
    const bytes = method === 8 ? Uint8Array.from(deflateRawSync(decoded)) : Uint8Array.from(decoded)
    return {bytes, compressionMethod: method, compressedSize: bytes.length, uncompressedSize: decoded.length, signature: crc32(decoded)}
}

/**
 * @param {Chunk} chunk
 * @returns {SnapshotRow[]}
 */
function snapshotChunk(chunk) {
    const plan = chunk.termRecordPreinternedPlan
    const offsets = plan.stringOffsets ?? new Uint32Array(plan.stringLengths.length)
    if (!(plan.stringOffsets instanceof Uint32Array)) {
        let offset = 0
        for (let i = 0; i < offsets.length; ++i) {
            offsets[i] = offset
            offset += plan.stringLengths[i]
        }
        if (offset !== plan.stringsBuffer.length) { throw new Error('Invalid packed key plan') }
    }
    /**
     * @param {number} index
     * @returns {number[]}
     */
    const key = (index) => [...plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index])]
    return Array.from({length: chunk.rowCount}, (_, i) => {
        let content = chunk.contentBytesList[i]
        let hashes = [chunk.contentHash1List[i], chunk.contentHash2List[i]]
        if (chunk.contentBytesBuffer instanceof Uint8Array && chunk.contentMetaList instanceof Uint32Array) {
            const meta = chunk.contentMetaList
            const start = meta[i * 4] + (chunk.contentBytesBaseOffset ?? 0)
            if (start < 0 || meta[i * 4 + 1] > chunk.contentBytesBuffer.length - start) { throw new Error('Content span out of bounds') }
            content = chunk.contentBytesBuffer.subarray(start, start + meta[i * 4 + 1])
            hashes = [meta[i * 4 + 2], meta[i * 4 + 3]]
        }
        return {expression: key(plan.expressionIndexes[i]),
            reading: key(plan.readingIndexes[i]),
            score: chunk.scoreList[i],
            sequence: chunk.sequenceList[i],
            readingEqualsExpression: chunk.readingEqualsExpressionList[i],
            content: {length: content.length, sha256: createHash('sha256').update(content).digest('hex')},
            hashes,
            media: chunk.mediaRows.filter((row) => row.index === i).map(({row}) => ({
                expression: row.expression,
                reading: row.reading,
                glossary: row.glossaryJson,
                content: {length: row.termEntryContentBytes.length, sha256: createHash('sha256').update(row.termEntryContentBytes).digest('hex')},
            }))}
    })
}

/**
 * @param {Array<string|Uint8Array>} banks
 * @param {Experiments} [experiments]
 * @param {boolean} [preload]
 * @param {boolean} [singleChunk]
 * @returns {Promise<{rows: SnapshotRow[], profile: NonNullable<ReturnType<typeof consumeLastTermBankWasmParseProfile>>}>}
 */
async function parse(banks, experiments = {}, preload = false, singleChunk = true) {
    const preloadedSource = preload ?
await inflateCompressedTermBankSourcesWasm(banks.map((bank, i) => compressed(bank, i % 2 === 0 ? 8 : 0)), experiments) :
undefined
    /** @type {ReturnType<typeof snapshotChunk>} */
    const rows = []
    await parseTermBankWithWasmColumnChunks(
        preloadedSource ? new Uint8Array(0) : banks.map((bank) => (typeof bank === 'string' ? encoder.encode(bank) : bank)),
        3,
        (chunk) => { rows.push(...snapshotChunk(chunk)) },
        7,
        {...experiments,
            preloadedSource,
            computeContentHashes: true,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            singleChunk,
            prepareLookupIndexes: false},
    )
    const profile = consumeLastTermBankWasmParseProfile()
    if (profile === null) { throw new Error('Missing parser profile') }
    return {rows, profile}
}

/**
 * @param {string} expression
 * @param {unknown} [glossary]
 * @returns {unknown[]}
 */
function row(expression, glossary = ['shared definition']) {
    return [expression, '', 'noun', '', 2, glossary, 7, 'common']
}
/**
 * @param {string} token
 * @returns {string}
 */
function escapedBank(token) {
    return `[[${token},"","noun","",2,["shared definition"],7,"common"]]`
}

beforeAll(() => {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const url = input instanceof URL ? input : new URL(String(input))
        if (url.protocol === 'file:') { return new Response(await readFile(url)) }
        return await nativeFetch(input)
    })
})
afterAll(() => { vi.unstubAllGlobals() })

describe('default-off term-bank experiments', () => {
    test('snapshots exact booleans and freezes them without mutating the caller', () => {
        const input = {experimentalTermBankSpans: true}
        const snap = snapshotTermBankExperiments(input)
        input.experimentalTermBankSpans = false
        expect(snap).toEqual(flags(1))
        expect(Object.isFrozen(snap)).toBe(true)
        expect(snapshotTermBankExperiments()).toEqual(flags(0))
        expect(getTermBankExperimentMask(flags(63))).toBe(31)
        expect(snapshotTermBankExperiments(/** @type {Experiments} */ (/** @type {unknown} */ ({experimentalTermBankSpans: 'true'})))).toEqual(flags(0))
    })

    const glossary = [{type: 'structured-content', content: [{tag: 'span', content: '日本語'}, {tag: 'ruby', content: '読み'}]}]
    const banks = [
        JSON.stringify([row('猫', glossary), row('犬'), row('empty', [])]),
        ' \n[]\t',
        JSON.stringify([row('鳥', glossary), row('魚'), row('media', [{type: 'image', path: 'test.png'}])]),
        '[]',
        JSON.stringify([row('text', [{type: 'text', text: '  a\n b  '}]), row('猫', glossary)]),
    ]
    test.each(Array.from({length: 64}, (_, i) => i))('all flag combinations preserve row content/hash/key order: %i', async (mask) => {
        const baseline = await parse(banks)
        for (const preload of [false, true]) {
            const result = await parse(banks, flags(mask), preload)
            expect(result.rows).toEqual(baseline.rows)
            expect(result.profile.experiments).toEqual(flags(mask))
            expect(result.profile.bankSpanCount).toBe((mask & 1) !== 0 ? banks.length : 0)
            expect(result.profile.fusedParseAttempts).toBe(1)
            expect(result.profile.fusedParseFallbacks).toBe(0)
            expect(result.profile.maxWasmHeapBytes).toBeGreaterThan(0)
        }
    })

    test.each([false, true])('preserves dedup/content offsets across chunk boundaries and growth: preload=%s', async (preload) => {
        const large = Array.from({length: 170}, (_, i) => row(`key-${i}`, [String(i) + 'x'.repeat(50000)]))
        const sources = [JSON.stringify(large), JSON.stringify(large.slice(0, 15))]
        const baseline = await parse(sources, {}, preload, false)
        const candidate = await parse(sources, flags(15), preload, false)
        expect(candidate.rows).toEqual(baseline.rows)
        expect(candidate.profile.contentCapacity).toBeGreaterThan(4 * 1024 * 1024)
    })

    test('single-bank fusion executes only when enabled and does not leak to the next parse', async () => {
        const sources = [JSON.stringify(Array.from({length: 20}, (_, i) => row(`key-${i}`)))]
        const baseline = await parse(sources)
        const candidate = await parse(sources, {experimentalFusedSingleBank: true})
        expect(candidate.rows).toEqual(baseline.rows)
        expect(baseline.profile.fusedParseAttempts).toBe(0)
        expect(candidate.profile.fusedParseAttempts).toBe(1)
        expect(candidate.profile.fusedSingleBankGroups).toBe(1)
        const again = await parse(sources)
        expect(again.profile.experiments).toEqual(flags(0))
        expect(again.profile.fusedParseAttempts).toBe(0)
        expect(again.rows).toEqual(baseline.rows)
    })


    test('group-wide exact content reuse skips encoding for distant repeats', async () => {
        const repeatedGlossary = [{type: 'text', text: '  repeated text  '}, 'tail']
        const rows = [row('first', repeatedGlossary)]
        for (let i = 0; i < 12; ++i) { rows.push(row(`unique-${i}`, [`definition-${i}`])) }
        rows.push(row('last', repeatedGlossary))
        const sources = [JSON.stringify(rows), '[]']
        const baseline = await parse(sources)
        const result = await parse(sources, {experimentalGlobalExactContentReuse: true})
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.globalExactContentReuseCount).toBe(1)
        expect(result.profile.recentContentDedupHitCount).toBeGreaterThanOrEqual(1)
    })

    test('group-wide exact content reuse does not reuse same-shaped unique content', async () => {
        const rows = Array.from({length: 64}, (_, i) => row(`key-${i}`, [`${String(i).padStart(4, '0')}-${'x'.repeat(80)}-${i}`]))
        const sources = [JSON.stringify(rows.slice(0, 32)), JSON.stringify(rows.slice(32))]
        const baseline = await parse(sources)
        const result = await parse(sources, {experimentalGlobalExactContentReuse: true})
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.globalExactContentReuseCount).toBe(0)
    })

    test('fast glossary normalization preserves bytes and falls back on general structured content', async () => {
        const fastGlossary = [{type: 'text', text: '  alpha\n beta  '}, 'literal', 7, true, null]
        const nestedGlossary = [{type: 'structured-content', content: [{tag: 'span', content: [{type: 'text', text: 'nested'}]}]}]
        const sources = [JSON.stringify([row('fast', fastGlossary), row('nested', nestedGlossary)]), '[]']
        const baseline = await parse(sources)
        const result = await parse(sources, {experimentalFastGlossaryNormalization: true})
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.fastGlossaryNormalizationCount).toBeGreaterThan(0)
        expect(result.profile.fastGlossaryNormalizationFallbackCount).toBeGreaterThan(0)
    })

    test('all-empty span groups have no rows', async () => {
        for (const preload of [false, true]) {
            const result = await parse(['[]', '\n [ ] \r', '[]'], flags(15), preload)
            expect(result.rows).toEqual([])
            expect(result.profile.bankSpanCount).toBe(3)
        }
    })

    test('capacity fallback owns input before reset and still parses spans', async () => {
        const sources = [JSON.stringify(Array.from({length: 20001}, (_, i) => row(`a-${i}`))), JSON.stringify([row('last')])]
        const baseline = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.fusedParseFallbacks).toBe(1)
        expect(result.profile.discardedFusedRows).toBe(20000)
        expect(result.profile.bankSpanCount).toBe(2)
        expect(result.profile.parseBankMs).toBeGreaterThanOrEqual(result.profile.discardedFusedParseMs ?? 0)
    })
})

describe('native exceptional keys', () => {
    const tokens = [
        String.raw`"\u65e5本語"`,
        String.raw`"a\"b"`,
        String.raw`"a\\b"`,
        String.raw`"a\/b"`,
        String.raw`"\b\f\n\r\t"`,
        String.raw`"\u0000\u001f"`,
        String.raw`"\uD83D\uDE42"`,
        String.raw`"\uD800"`,
        String.raw`"\uDC00"`,
        String.raw`"\uD800\uD800\uDC00"`,
        String.raw`"\uDBFF\uDFFF"`,
        String.raw`"\uD800x\uDC00"`,
        String.raw`"é\u0080\u07ff\u0800"`,
        '"\ufeff\\u65e5"',
        String.raw`"\uFEFF日本"`,
        String.raw`"\udbff\udfff\uFFFF"`,
    ]
    test.each(tokens)('matches the JSON.parse/TextEncoder fallback: %s', async (token) => {
        const sources = [JSON.stringify([row('literal')]), escapedBank(token)]
        const baseline = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.rows[1].expression).toEqual([...encoder.encode(/** @type {string} */ (JSON.parse(token)))])
        expect(baseline.profile.fusedParseFallbacks).toBe(1)
        expect(result.profile.fusedParseFallbacks).toBe(0)
        expect(result.profile.escapedKeyDecodeCount).toBe(1)
    })

    test('interns equivalent literal/escaped keys with canonical hashes and preserves readings', async () => {
        const sources = [
            '[["日","\\u65e5","","",1,[],1,""],["\\u65e5","日","","",2,[],2,""]]',
            '[["日","日","","",3,[],3,""],["\\u65e5","","","",4,[],4,""]]',
        ]
        expect((await parse(sources, flags(15), true)).rows).toEqual((await parse(sources)).rows)
    })

    test.each([0xff, 0xc0, 0x80, 0xed, 0xf5])('invalid raw UTF-8 retains the replacement-decoder fallback: %i', async (byte) => {
        const bad = encoder.encode(escapedBank(String.raw`"x\n"`))
        bad[3] = byte
        const sources = [JSON.stringify([row('ordinary')]), bad]
        const baseline = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.fusedParseFallbacks).toBe(1)
    })

    test('native exceptional keys reach the existing 65534-byte limit', async () => {
        const token = `"${'x'.repeat(65533)}\\u0061"`
        const sources = [escapedBank(token), '[]']
        const baseline = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.rows[0].expression.length).toBe(65534)
        expect(result.profile.fusedParseFallbacks).toBe(0)
    })

    test('exhausted native key arena falls back without overwriting earlier interned keys', async () => {
        const tokens = Array.from({length: 24}, (_, i) => `"${i}-${'x'.repeat(65520)}\\u0061"`)
        const bank = `[${tokens.map((token) => escapedBank(token).slice(1, -1)).join(',')}]`
        const sources = [bank, '[]']
        const baseline = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(baseline.rows)
        expect(result.profile.fusedParseFallbacks).toBe(1)
        expect(result.profile.discardedFusedRows).toBeGreaterThan(0)
    })

    test('records early and late failed work without losing first-attempt accounting', async () => {
        for (const last of [false, true]) {
            const ordinary = Array.from({length: 64}, (_, i) => row(`key-${i}`))
            const sources = last ? [JSON.stringify(ordinary), escapedBank(String.raw`"\u65e5"`)] : [escapedBank(String.raw`"\u65e5"`), JSON.stringify(ordinary)]
            const baseline = await parse(sources)
            const result = await parse(sources, {experimentalNativeEscapedKeys: true})
            expect(result.rows).toEqual(baseline.rows)
            expect(baseline.profile.fusedParseFallbacks).toBe(1)
            expect(baseline.profile.discardedFusedRows).toBe(last ? 64 : 0)
            expect(result.profile.fusedParseFallbacks).toBe(0)
        }
    })
})

describe('span boundaries and validated glossary witnesses', () => {
    test.each([false, true])('never splices a malformed row across banks, including fallback: %s', async (escaped) => {
        const key = escaped ? String.raw`"\u0078"` : '"x"'
        // Removing wrappers and inserting a comma manufactures a valid row.
        const banks = [`[[${key},"","","",0,[]]`, '[1,""]]']
        expect(JSON.parse(`[${banks.map((s) => s.slice(1, -1)).join(',')}]`)).toHaveLength(1)
        for (const preload of [false, true]) {
            await expect(parse(banks, {experimentalTermBankSpans: true}, preload)).rejects.toThrow()
        }
    })

    test.each(['[1,]', '{"a":}', '["\\q"]', '["\\u12xz"]', '["unterminated]', '{"a":[1,2]', '[01]'])('rejects malformed glossaries with reuse enabled: %s', async (bad) => {
        const valid = JSON.stringify([row('first', [{a: [1, 2]}])])
        await expect(parse([valid, `[["next","","","",0,${bad},1,""]]`], flags(15), true)).rejects.toThrow()
    })

    test('does not reuse after a same-length mutation outside sampled positions', async () => {
        const text = 'x'.repeat(300)
        const altered = text.slice(0, 40) + 'y' + text.slice(41)
        const sources = [JSON.stringify([row('a', [text]), row('b', [altered])]), JSON.stringify([row('c', [text])])]
        const base = await parse(sources)
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual(base.rows)
        expect(result.rows[0].content).not.toEqual(result.rows[1].content)
        expect(result.profile.validatedGlossaryReuseCount).toBe(1)
    })

    test('glossary equality does not imply rules/tag equality', async () => {
        const a = row('a')
        const b = row('b')
        b[2] = 'other-tag'
        b[3] = 'v5'
        const sources = [JSON.stringify([a]), JSON.stringify([b])]
        const result = await parse(sources, flags(15), true)
        expect(result.rows).toEqual((await parse(sources)).rows)
        expect(result.rows[0].content).not.toEqual(result.rows[1].content)
        expect(result.profile.validatedGlossaryReuseCount).toBe(1)
    })

    test.each([0, 8])('span source preparation keeps CRC, size, trailing-data and truncation validation: %i', async (method) => {
        const source = compressed(JSON.stringify([row('a')]), /** @type {0|8} */ (method))
        for (const modified of [
            {...source, signature: (source.signature ^ 1) >>> 0},
            {...source, uncompressedSize: source.uncompressedSize + 1},
            {...source, bytes: source.bytes.subarray(0, -1), compressedSize: source.compressedSize - 1},
            {...source, bytes: Uint8Array.from([...source.bytes, 0]), compressedSize: source.compressedSize + 1},
        ]) {
            await expect(inflateCompressedTermBankSourcesWasm([modified], {experimentalTermBankSpans: true})).rejects.toThrow()
        }
    })

    test('rejects overlapping and out-of-bounds span metadata without escaping the arena', async () => {
        for (const pair of [[0, 0xffffffff], [0xffffffff, 1], [0, 2]]) {
            const preloadedSource = await inflateCompressedTermBankSourcesWasm([
                compressed(JSON.stringify([row('a')]), 8), compressed(JSON.stringify([row('b')]), 8),
            ], {experimentalTermBankSpans: true})
            const spans = new Uint32Array(preloadedSource.wasm.memory.buffer, preloadedSource.bankSpansPtr, 4)
            spans[2] = pair[0]
            spans[3] = pair[1]
            await expect(parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, () => {}, 2048, {
                preloadedSource,
                experimentalTermBankSpans: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                computeContentHashes: true,
            })).rejects.toThrow()
        }
    })
})


describe('deterministic escaped-key differential', () => {
    test('4096 mixed UTF-16 keys match the independent JSON.parse/TextEncoder oracle', async () => {
        let seed = 0x651dcafe
        const next = () => {
            seed ^= seed << 13
            seed ^= seed >>> 17
            seed ^= seed << 5
            return seed >>> 0
        }
        const values = Array.from({length: 4096}, () => {
            let value = ''
            const length = next() % 24 + 1
            for (let i = 0; i < length; ++i) { value += String.fromCharCode(next() & 0xffff) }
            return value
        })
        const encoded = values.map((value) => {
            let token = '"'
            for (let i = 0; i < value.length; ++i) { token += `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}` }
            return `${token}"`
        })
        const source = `[${encoded.map((token) => `[${token},${token},"","",0,["shared"],1,""]`).join(',')}]`
        const baseline = await parse([source, '[]'])
        const candidate = await parse([source, '[]'], flags(15), true)
        expect(candidate.rows).toEqual(baseline.rows)
        expect(candidate.rows.map((value) => value.expression)).toEqual(values.map((value) => [...encoder.encode(value)]))
        expect(candidate.profile.fusedParseFallbacks).toBe(0)
        expect(candidate.profile.escapedKeyDecodeCount).toBeGreaterThan(0)
    })
})

/** @typedef {{type: string, id?: number, chunk?: ReturnType<typeof import('../ext/js/dictionary/term-bank-wasm-parser.js').copyWasmBackedColumnChunk>, profile?: ReturnType<typeof consumeLastTermBankWasmParseProfile>, error?: unknown}} WorkerReply */
/**
 * One request at a time, as required by the production parser worker's lease.
 * @param {Worker} worker
 * @param {unknown} request
 * @returns {Promise<WorkerReply>}
 */
function requestWorker(worker, request) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error('Parser worker timed out'))
        }, 10000)
        const cleanup = () => {
            clearTimeout(timer)
            worker.off('message', message)
            worker.off('error', error)
        }
        /** @param {WorkerReply} value */
        const message = (value) => {
            cleanup()
            resolve(value)
        }
        /** @param {Error} value */
        const error = (value) => {
            cleanup()
            reject(value)
        }
        worker.once('message', message)
        worker.once('error', error)
        if (request !== null) { worker.postMessage(request) }
    })
}

describe('actual parser worker flag propagation', () => {
    test.each([false, true])('preserves owned keys, lookup bytes and resets flags across requests: compressed=%s', async (preload) => {
        const workerUrl = new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href
        const bridge = `import {parentPort} from 'node:worker_threads'
            globalThis.self = {addEventListener: (_, fn) => parentPort.on('message', data => fn({data})),
                postMessage: (data, transfer) => parentPort.postMessage(data, transfer)}
            await import(${JSON.stringify(workerUrl)})
            parentPort.postMessage({type: 'loaded'})`
        const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`))
        try {
            expect((await requestWorker(worker, null)).type).toBe('loaded')
            const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
            expect((await requestWorker(worker, {type: 'initialize', module})).type).toBe('ready')
            const source = `[${[escapedBank(String.raw`"\u65e5本"`).slice(1, -1), JSON.stringify(row('猫')), JSON.stringify(row('犬')), String.raw`["日","\u65e5","","",0,[],1,""]`].join(',')}]`
            const oracle = await parse([source])
            let previousOwnedKeys
            let previousOwnedKeysCopy
            /** @type {Map<string, Uint8Array>|undefined} */
            let priorIndexes
            for (const mask of [15, 0, 15, 0]) {
                const payload = compressed(source, 8)
                const sourceBuffer = preload ? payload.bytes.buffer : encoder.encode(source).buffer
                const reply = await requestWorker(worker, {type: 'parse',
                    id: mask,
                    version: 3,
                    sourceBuffers: [sourceBuffer],
                    ...(preload ? {sourceMetadata: [payload]} : {}),
                    options: {...flags(mask),
                        computeContentHashes: true,
                        emitContentSlab: true,
                        emitTokenBinaryContent: true,
                        mediaHintFastScan: true,
                        prepareLookupIndexes: true}})
                expect(reply.type, JSON.stringify(reply.error)).toBe('result')
                const chunk = reply.chunk
                if (!chunk) { throw new Error('Missing worker chunk') }
                expect(snapshotChunk(chunk)).toEqual(oracle.rows)
                expect(reply.profile?.experiments).toEqual(flags(mask))
                expect(reply.profile?.bankSpanCount).toBe(mask === 15 ? 1 : 0)
                expect(reply.profile?.fusedSingleBankGroups).toBe(mask === 15 ? 1 : 0)
                expect(reply.profile?.fusedParseFallbacks).toBe(0)
                if (previousOwnedKeys) { expect(previousOwnedKeys).toEqual(previousOwnedKeysCopy) }
                previousOwnedKeys = chunk.termRecordPreinternedPlan.stringsBuffer
                previousOwnedKeysCopy = Uint8Array.from(previousOwnedKeys)
                const indexes = new Map([...chunk.preparedLookupIndexes ?? []].map(([key, value]) => [key, value.bytes]))
                expect(indexes.size).toBeGreaterThan(0)
                if (priorIndexes) { expect(indexes).toEqual(priorIndexes) }
                priorIndexes = indexes
            }
        } finally { await worker.terminate() }
    })
})
