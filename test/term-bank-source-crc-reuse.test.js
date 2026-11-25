/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {crc32, deflateRawSync} from 'node:zlib'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionarySourceIntegrityError} from '../ext/js/dictionary/dictionary-source-integrity-error.js'
import {verifyTermBankSourceCrc} from '../ext/js/dictionary/term-bank-source-crc.js'
import {
    consumeLastTermBankWasmParseProfile,
    inflateCompressedTermBankSourcesWasm,
    parseTermBankWithWasmColumnChunks,
    setTermBankWasmModule,
} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
const glossary = `Unicode 日本語 𠮷 \uFEFF ${'repeat '.repeat(600)}`
const rows = Array.from({length: 800}, (_, i) => [`term${i}`, 'reading', '', '', i, [glossary], i, ''])
const banks = [encoder.encode(`\r\n${JSON.stringify(rows)}\t `), encoder.encode(' \n[]\r '), encoder.encode(`\t${JSON.stringify(rows)}\n`)]
/** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions} */
const options = {
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    useNativeStringPlan: true,
    singleChunk: true,
    validateGlossaryTypes: true,
    mediaHintFastScan: true,
}

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * @param {Uint8Array[]} [values]
 * @returns {import('../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource[]}
 */
function sourcesFor(values = banks) {
    return values.map((value, i) => {
        const bytes = new Uint8Array(deflateRawSync(value))
        return {bytes, compressionMethod: 8, compressedSize: bytes.length, uncompressedSize: value.length, signature: crc32(value), filename: `term_bank_${i + 1}.json`}
    })
}

/**
 * @param {import('../ext/js/dictionary/term-bank-wasm-parser.js').PreloadedTermBankSource} preloadedSource
 * @param {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions} [overrides]
 * @returns {Promise<{digest: string, rows: number, firstContentBytes: string[], firstContentHashes: number[][], profile: ReturnType<typeof consumeLastTermBankWasmParseProfile>}>}
 */
async function parse(preloadedSource, overrides = {}) {
    const hash = createHash('sha256')
    let count = 0
    /** @type {string[]} */
    const firstContentBytes = []
    /** @type {number[][]} */
    const firstContentHashes = []
    await parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        if (preloadedSource.crcSignaturesPtr) { expect(preloadedSource.crcVerified).toBe(true) }
        count += chunk.rowCount
        const plan = chunk.termRecordPreinternedPlan
        for (const value of [
            chunk.readingEqualsExpressionList,
            chunk.scoreList,
            chunk.sequenceList,
            chunk.contentMetaList,
            chunk.contentUniqueIndexList,
            plan.stringLengths,
            plan.stringOffsets,
            plan.stringHashes,
            plan.stringsBuffer,
            plan.expressionIndexes,
            plan.readingIndexes,
        ]) {
            if (!value) { throw new Error('Missing column') }
            hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        }
        if (!chunk.contentBytesBuffer || typeof chunk.contentBytesLength !== 'number') { throw new Error('Missing content') }
        const start = chunk.contentBytesBaseOffset ?? 0
        hash.update(chunk.contentBytesBuffer.subarray(start, start + chunk.contentBytesLength))
        if (!chunk.contentMetaList) { throw new Error('Missing content metadata') }
        for (let row = 0; row < Math.min(2, chunk.rowCount); ++row) {
            const meta = row * 4
            const offset = start + chunk.contentMetaList[meta]
            firstContentBytes.push(Buffer.from(chunk.contentBytesBuffer.subarray(offset, offset + chunk.contentMetaList[meta + 1])).toString('base64'))
            firstContentHashes.push([...chunk.contentMetaList.subarray(meta + 2, meta + 4)])
        }
    }, 2048, {...options, ...overrides, preloadedSource})
    return {digest: hash.digest('hex'), rows: count, firstContentBytes, firstContentHashes, profile: consumeLastTermBankWasmParseProfile()}
}

describe('raw glossary witness source CRC verification', () => {
    test('verifies newly eligible stored banks before exposing exact ordinary output', async () => {
        /** @type {import('../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource[]} */
        const source = banks.map((bytes, index) => ({
            bytes,
            compressionMethod: 0,
            compressedSize: bytes.length,
            uncompressedSize: bytes.length,
            signature: crc32(bytes),
            filename: `term_bank_${index + 1}.json`,
        }))
        const ordinary = await parse(await inflateCompressedTermBankSourcesWasm(source, options))
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        expect(preloaded.compressedBytes).toBe(preloaded.uncompressedBytes)
        expect(preloaded.crcSignaturesPtr).toBeGreaterThan(0)
        expect((await parse(preloaded)).digest).toBe(ordinary.digest)
        expect(preloaded.crcVerified).toBe(true)
        source[2].signature = (source[2].signature ^ 1) >>> 0
        const corrupt = await inflateCompressedTermBankSourcesWasm(source, options, true)
        const sink = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, sink, 2048, {...options, preloadedSource: corrupt})).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        expect(sink).not.toHaveBeenCalled()
    })

    test('matches ordinary CRC and every result byte across whitespace, empty banks, and cross-bank witnesses', async () => {
        const source = sourcesFor()
        const ordinary = await parse(await inflateCompressedTermBankSourcesWasm(source, options))
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        expect(preloaded.crcSignaturesPtr).toBeGreaterThan(0)
        const reused = await parse(preloaded)
        expect(reused.digest).toBe(ordinary.digest)
        expect(reused.rows).toBe(banks.reduce((sum, bytes) => sum + JSON.parse(new TextDecoder().decode(bytes)).length, 0))
        expect(preloaded.crcReusedGlossaryCount).toBe(rows.length * 2 - 1)
        expect((preloaded.crcScannedBytes ?? 0) + (preloaded.crcReusedBytes ?? 0)).toBe(preloaded.uncompressedBytes)
        expect(preloaded.crcReusedBytes).toBeGreaterThan(preloaded.uncompressedBytes * 0.9)
    })

    test('keeps canonical-equal but raw-distinct glossary encodings independent', async () => {
        const variants = rows.map((row, i) => [...row.slice(0, 5), i % 2 ? [{type: 'text', text: glossary}] : [glossary], ...row.slice(6)])
        const literal = JSON.stringify(variants)
        const escaped = literal.replaceAll('日本語', String.raw`\u65e5\u672c\u8a9e`).replaceAll('repeat', String.raw`\u0072epeat`)
        expect(escaped).not.toBe(literal)
        expect(JSON.parse(escaped)).toEqual(JSON.parse(literal))
        expect(JSON.stringify(variants[0][5])).not.toBe(JSON.stringify(variants[1][5]))
        const source = sourcesFor([encoder.encode(literal), encoder.encode(JSON.stringify(variants, null, 1)), encoder.encode(escaped)])
        const ordinary = await parse(await inflateCompressedTermBankSourcesWasm(source, options))
        // The ordinary encoder really collapses the text object to its string:
        // these distinct raw spans share both persisted bytes and both hashes.
        expect(ordinary.firstContentBytes[0]).toBe(ordinary.firstContentBytes[1])
        expect(ordinary.firstContentHashes[0]).toEqual(ordinary.firstContentHashes[1])
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        const reused = await parse(preloaded)
        expect(reused.digest).toBe(ordinary.digest)
        expect(preloaded.crcVerified).toBe(true)
    })


    test('does not grant a CRC witness from equal canonical bytes alone', async () => {
        const text = 'a日本語'.repeat(230000)
        const first = ['key', '', '', '', 0, [text], 1, '']
        const second = ['key2', '', '', '', 0, [{type: 'text', text}], 2, '']
        const source = sourcesFor([encoder.encode(JSON.stringify([first])), encoder.encode(JSON.stringify([second]))])
        const ordinary = await parse(await inflateCompressedTermBankSourcesWasm(source, options))
        expect(ordinary.firstContentBytes[0]).toBe(ordinary.firstContentBytes[1])
        expect(ordinary.firstContentHashes[0]).toEqual(ordinary.firstContentHashes[1])
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        expect(preloaded.crcSignaturesPtr).toBeGreaterThan(0)
        expect((await parse(preloaded)).digest).toBe(ordinary.digest)
        expect(preloaded.crcReusedGlossaryCount).toBe(0)
        expect(preloaded.crcReusedBytes).toBe(0)
        expect(preloaded.crcScannedBytes).toBe(preloaded.uncompressedBytes)
        source[1].signature = (source[1].signature ^ 1) >>> 0
        await expect(parse(await inflateCompressedTermBankSourcesWasm(source, options, true))).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
    })

    test.each([0, 1, 2])('rejects a wrong source CRC for bank %i before emitting any rows', async (index) => {
        const source = sourcesFor()
        source[index].signature = (source[index].signature ^ 1) >>> 0
        await expect(inflateCompressedTermBankSourcesWasm(source, options)).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        const sink = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, sink, 2048, {...options, preloadedSource: preloaded})).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        expect(sink).not.toHaveBeenCalled()
        expect(preloaded.crcVerified).not.toBe(true)
        expect(() => verifyTermBankSourceCrc(preloaded)).toThrow(DictionarySourceIntegrityError)
        expect((await parse(await inflateCompressedTermBankSourcesWasm(sourcesFor(), options, true))).rows).toBe(1600)
    })

    test.each(['invalid-json', 'escaped-key', 'skip-fused', 'native-throw', 'allocation-failure'])('preserves CRC failure precedence through %s', async (mode) => {
        const changed = [...banks]
        if (mode === 'invalid-json') {
            changed[2] = new Uint8Array(banks[2])
            changed[2][20] = 1
        } else if (mode === 'escaped-key') {
            changed[0] = encoder.encode(new TextDecoder().decode(banks[0]).replace('term0', String.raw`\u0074erm0`))
        }
        const source = sourcesFor(changed)
        source[0].signature = (source[0].signature ^ 1) >>> 0
        const preloaded = await inflateCompressedTermBankSourcesWasm(source, options, true)
        const originalParse = preloaded.wasm.parse_and_encode_term_bank_token_binary_dedup
        const originalAllocate = preloaded.wasm.wasm_alloc
        if (mode === 'native-throw') {
            preloaded.wasm.parse_and_encode_term_bank_token_binary_dedup = () => { throw new WebAssembly.RuntimeError('injected trap') }
        }
        if (mode === 'allocation-failure') { preloaded.wasm.wasm_alloc = () => 0 }
        try {
            await expect(parse(preloaded, {experimentalSkipFusedParse: mode === 'skip-fused'})).rejects.toBeInstanceOf(DictionarySourceIntegrityError)
        } finally {
            preloaded.wasm.parse_and_encode_term_bank_token_binary_dedup = originalParse
            preloaded.wasm.wasm_alloc = originalAllocate
        }
    })

    test('verifies a valid escaped-key fallback before its heap reset', async () => {
        const changed = [...banks]
        changed[0] = encoder.encode(new TextDecoder().decode(banks[0]).replace('term0', String.raw`\u0074erm0`))
        const preloaded = await inflateCompressedTermBankSourcesWasm(sourcesFor(changed), options, true)
        const result = await parse(preloaded)
        expect(result.profile?.fusedParseFallbacks).toBe(1)
        expect(preloaded.crcVerified).toBe(true)
        expect(preloaded.crcReusedBytes).toBe(0)
        expect(result.rows).toBe(1600)
    })

    test('keeps verifier traps sticky without retrying a partially consumed witness array', async () => {
        const preloaded = await inflateCompressedTermBankSourcesWasm(sourcesFor(), options, true)
        const original = preloaded.wasm.verify_term_bank_source_crcs
        const failure = new WebAssembly.RuntimeError('injected CRC trap')
        const verify = vi.fn(() => { throw failure })
        preloaded.wasm.verify_term_bank_source_crcs = verify
        try {
            await expect(parse(preloaded)).rejects.toBe(failure)
            expect(() => verifyTermBankSourceCrc(preloaded)).toThrow(failure)
            expect(verify).toHaveBeenCalledTimes(1)
        } finally {
            preloaded.wasm.verify_term_bank_source_crcs = original
        }
    })

    test.each(['wrapper-first', 'crc-first-wrapper', 'deflate-first', 'crc-first-deflate', 'bom-first'])('preserves ordinary multi-bank failure order for %s', async (mode) => {
        const source = sourcesFor()
        const firstFailure = mode.endsWith('first') || mode === 'bom-first' ? 0 : 2
        const crcFailure = firstFailure === 0 ? 2 : 0
        source[crcFailure].signature = (source[crcFailure].signature ^ 1) >>> 0
        if (mode.includes('deflate')) {
            const bytes = source[firstFailure].bytes.slice(0, 1)
            source[firstFailure] = {...source[firstFailure], bytes, compressedSize: bytes.length}
        } else {
            const original = banks[firstFailure]
            const invalid = new Uint8Array(original.length + (mode === 'bom-first' ? 3 : 0))
            invalid.set(original, mode === 'bom-first' ? 3 : 0)
            if (mode === 'bom-first') {
                invalid.set([0xef, 0xbb, 0xbf])
            } else {
                invalid[0] = 0x7b
            }
            source[firstFailure] = sourcesFor([invalid])[0]
        }
        let expected
        try {
            await inflateCompressedTermBankSourcesWasm(source, options)
        } catch (error) {
            expected = error
        }
        expect(expected).toBeInstanceOf(Error)
        await expect(inflateCompressedTermBankSourcesWasm(source, options, true)).rejects.toThrow(/** @type {Error} */ (expected).message)
    })
})
