/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {DictionaryImporter} from '../ext/js/dictionary/dictionary-importer.js'
import * as parser from '../ext/js/dictionary/term-bank-wasm-parser.js'
import {DictionaryImporterMediaLoader} from './mocks/dictionary-importer-media-loader.js'

/** @typedef {Parameters<typeof parser.copyWasmBackedColumnChunk>[0]} ColumnChunk */

const encoder = new TextEncoder()
const nativeParse = parser.parseTermBankWithWasmColumnChunks

beforeAll(async () => {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})
afterEach(() => { vi.restoreAllMocks() })

/**
 * Exercise the actual native parser and the worker's owned-result projection.
 * Only worker transport is replaced so ownership and diagnostic behavior can
 * be observed without spawning a browser for this unit test.
 * @param {unknown[]} rows
 * @param {(chunk: ColumnChunk) => void} [inspect]
 * @returns {Promise<{importer: DictionaryImporter, requirements: import('dictionary-importer').ImportRequirement[]}>}
 */
async function collectReferences(rows, inspect = () => {}) {
    vi.spyOn(parser, 'parseTermBankWithWasmColumnChunks').mockImplementation(async (source, version, onChunk, size, options) => {
        return await nativeParse(source, version, async (chunk, progress) => {
            const projected = parser.copyWasmBackedColumnChunk(chunk, false, true)
            inspect(projected)
            await onChunk(projected, progress)
        }, size, options)
    })
    const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
    Reflect.set(importer, '_skipImageMetadata', true)
    /** @type {import('dictionary-importer').ImportRequirement[]} */
    const requirements = []
    const file = /** @type {import('@zip.js/zip.js').Entry} */ (/** @type {unknown} */ ({filename: 'term_bank_1.json'}))
    const source = encoder.encode(JSON.stringify(rows))
    await importer._readTermBankFileFast(file, 3, 'Media references', false, true, true, 'raw-bytes', (_terms, chunkRequirements) => {
        requirements.push(...(chunkRequirements ?? []))
    }, source)
    return {importer, requirements}
}

describe('preformatted image references', () => {
    test('keeps exact diagnostic key views in the owned string arena across native reuse', async () => {
        /** @type {Uint8Array[]} */
        const keys = []
        const expected = ['画像', 'がぞう', '別名', '別名'].map((value) => encoder.encode(value))
        await collectReferences([
            ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'first.png'}], 0, ''],
            ['別名', '', '', '', 0, [{type: 'image', path: 'second.png'}], 0, ''],
        ], (chunk) => {
            const arena = chunk.termRecordPreinternedPlan.stringsBuffer
            expect(arena.buffer).toBeInstanceOf(ArrayBuffer)
            for (const {row} of chunk.mediaRows) {
                for (const bytes of [row.expressionBytes, row.readingBytes]) {
                    if (!(bytes instanceof Uint8Array)) { throw new Error('Expected an encoded key') }
                    expect(bytes.buffer).toBe(arena.buffer)
                    expect(bytes.byteLength).toBeLessThan(arena.byteLength)
                    keys.push(bytes)
                }
            }
        })
        expect(keys).toEqual(expected)
        await nativeParse(encoder.encode(JSON.stringify([
            ['replacement'.repeat(100), '', '', '', 0, ['later glossary'], 1, ''],
        ])), 3, () => {})
        expect(keys).toEqual(expected)
    })

    test.each(['bytes', 'offset', 'length', 'string-index', 'row-index'])('copies the original diagnostic key when the plan has a mismatched %s', async (mismatch) => {
        const source = encoder.encode(JSON.stringify([
            ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'image.png'}], 0, ''],
        ]))
        await nativeParse(source, 3, (chunk) => {
            const plan = chunk.termRecordPreinternedPlan
            if (!(plan.stringOffsets instanceof Uint32Array)) { throw new Error('Expected key offsets') }
            const index = plan.expressionIndexes[0]
            switch (mismatch) {
                case 'bytes': {
                    plan.stringsBuffer[plan.stringOffsets[index]] ^= 1

                    break
                }
                case 'offset': {
                    plan.stringOffsets[index] = plan.stringsBuffer.byteLength + 1

                    break
                }
                case 'length': {
                    plan.stringLengths[index] = 0

                    break
                }
                case 'string-index': {
                    plan.expressionIndexes[0] = 0xffffffff

                    break
                }
                default: {
                    chunk.mediaRows[0].index = chunk.rowCount
                }
            }
            const copy = parser.copyWasmBackedColumnChunk(chunk, false, true)
            const row = copy.mediaRows[0].row
            expect(copy.mediaRows[0].imagePaths).toEqual(['image.png'])
            expect(row.expressionBytes).toEqual(encoder.encode('画像'))
            expect(row.expressionBytes?.buffer).not.toBe(copy.termRecordPreinternedPlan.stringsBuffer.buffer)
        }, 2048, {singleChunk: true, emitTermByteLists: false, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true})
    })

    test('decodes an owned exact-length view of a shared glossary before parser storage is reused', async () => {
        const glossary = String.raw`[{"type":"structured-content","content":{"tag":"\u0069mg","pa\u0074h":"img/\u732b.webp"}}]`
        const expected = encoder.encode(glossary)
        const source = encoder.encode(`[["image","reading","","",0,${glossary},1,""]]`)
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        let projectedRows = 0
        await nativeParse(source, 3, (chunk) => {
            const bytes = chunk.mediaRows[0].row.glossaryJsonBytes
            if (!(bytes instanceof Uint8Array)) { throw new Error('Expected a lazy glossary view') }
            expect(bytes.buffer).toBeInstanceOf(SharedArrayBuffer)
            expect(bytes.byteOffset).toBeGreaterThan(0)
            expect(bytes.byteLength).toBeLessThan(bytes.buffer.byteLength)
            expect(bytes).toEqual(expected)

            const result = parser.copyWasmBackedColumnChunk(chunk, false, true)
            expect(result.mediaRows[0].imagePaths).toEqual(['img/猫.webp'])
            const snapshot = decode.mock.calls.find(([input]) => input instanceof Uint8Array && input.byteLength === expected.byteLength && input[0] === 0x5b)?.[0]
            if (!(snapshot instanceof Uint8Array)) { throw new Error('Expected glossary decode input') }
            expect(snapshot.buffer).toBeInstanceOf(ArrayBuffer)
            expect(snapshot.buffer).not.toBe(bytes.buffer)
            expect(snapshot.byteOffset).toBe(0)
            expect(snapshot.byteLength).toBe(expected.byteLength)
            expect(snapshot.buffer.byteLength).toBeLessThanOrEqual(64 * 1024)
            expect(snapshot).toEqual(expected)

            bytes.fill(0)
            expect(snapshot).toEqual(expected)
            expect(result.mediaRows[0].imagePaths).toEqual(['img/猫.webp'])
            projectedRows += result.mediaRows.length
        }, 2048, {
            singleChunk: true,
            emitTermByteLists: false,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            validateGlossaryTypes: true,
        })
        expect(projectedRows).toBe(1)
    })

    test('stores projected image bytes without decoding diagnostic keys or allocating a presentation target', async () => {
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        let decodedBeforeMaterialization = -1
        const {importer, requirements} = await collectReferences([
            ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'image.png', width: 40, title: 'Image'}], 0, ''],
            ['別名', '', '', '', 0, [{type: 'structured-content', content: {tag: 'img', path: 'image.png', height: 60}}], 0, ''],
        ], (chunk) => {
            for (const {imagePaths} of chunk.mediaRows) {
                expect(imagePaths).toEqual(['image.png'])
            }
            decodedBeforeMaterialization = decode.mock.calls.length
        })
        expect(requirements).toHaveLength(2)
        for (const requirement of requirements) {
            expect(requirement.type).toBe('image-reference')
            expect(requirement).not.toHaveProperty('target')
            expect(Object.keys(requirement.entry).sort()).toEqual(['diagnosticIndex', 'diagnosticKeys', 'dictionary'])
        }
        const compact = requirements.map((requirement) => importer._createDeferredMediaRequirement(requirement))
        if (!('diagnosticKeys' in compact[0]) || !('diagnosticKeys' in compact[1])) { throw new Error('Expected encoded diagnostics') }
        expect(compact[0].diagnosticKeys).toBe(compact[1].diagnosticKeys)
        const {bytes: keyBytes, spans} = compact[0].diagnosticKeys
        expect(keyBytes.buffer.byteLength).toBe(keyBytes.byteLength)
        expect(spans).toEqual(new Uint32Array([0, 6, 6, 9, 15, 6, 15, 6]))
        expect(keyBytes).toEqual(encoder.encode('画像がぞう別名'))
        const bytes = Uint8Array.of(7, 17, 255)
        /** @type {import('dictionary-importer').ArchiveFileMap} */
        const files = new Map([['image.png', {filename: 'image.png', bytes}]])
        /** @type {import('dictionary-database').MediaDataArrayBufferContent[]} */
        const written = []
        const count = await importer._importDeferredMediaRequirements(compact, [], files, async (media) => { written.push(...media) })
        expect(count).toBe(1)
        expect(written).toEqual([{dictionary: 'Media references', path: 'image.png', mediaType: 'image/png', width: 0, height: 0, content: bytes.buffer}])
        expect(decode.mock.calls).toHaveLength(decodedBeforeMaterialization)
    })

    test.each([
        ['画像', 'がぞう'],
        ['猫', ''],
        ['same', 'same'],
        ['', 'reading'],
        ['quoted"head', 'escaped\\reading'],
        ['日本😀', 'にほん'],
        ['\ufeff画像', '\ufeffがぞう'],
        ['unpaired\ud800', 'unpaired\udfff'],
    ])('preserves missing-image diagnostics for %s and %s', async (expression, reading) => {
        const {importer, requirements} = await collectReferences([
            [expression, reading, '', '', 0, [{type: 'image', path: 'missing.png'}], 0, ''],
            ['別名', 'べつめい', '', '', 0, [{type: 'image', path: 'missing.png'}], 0, ''],
        ])
        const compact = requirements.map((requirement) => importer._createDeferredMediaRequirement(requirement))
        const expectedReading = reading || expression
        const readingSource = expectedReading.length > 0 ? ` (${expectedReading})` : ''
        await expect(importer._importDeferredMediaRequirements(compact, [], new Map(), async () => {}))
            .rejects.toThrow(`Could not find image at path "missing.png" for ${expression}${readingSource} in Media references`)
    })

    test.each(['source-subview', 'shared-memory'])('copies %s diagnostic keys before the parser reuses their storage', async (storage) => {
        /** @type {Uint8Array[]} */
        const sourceKeys = []
        const {importer, requirements} = await collectReferences([
            ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'missing.png'}], 0, ''],
        ], (chunk) => {
            for (const {row} of chunk.mediaRows) {
                for (const key of /** @type {const} */ (['expressionBytes', 'readingBytes'])) {
                    const bytes = row[key]
                    if (!(bytes instanceof Uint8Array)) { throw new Error('Expected an encoded diagnostic key') }
                    const source = storage === 'shared-memory' ?
                        new Uint8Array(new SharedArrayBuffer(bytes.byteLength)) :
                        new Uint8Array(64 * 1024).subarray(10, 10 + bytes.byteLength)
                    source.set(bytes)
                    sourceKeys.push(source)
                    row[key] = source
                }
            }
        })
        expect(requirements).toHaveLength(1)
        const {entry} = requirements[0]
        if (!('diagnosticKeys' in entry)) { throw new Error('Expected encoded diagnostics') }
        const {bytes, spans} = entry.diagnosticKeys
        expect(sourceKeys).not.toContain(bytes)
        expect(bytes.buffer).toBeInstanceOf(ArrayBuffer)
        expect(bytes.buffer.byteLength).toBe(bytes.byteLength)
        expect(bytes).toEqual(encoder.encode('画像がぞう'))
        expect(spans).toEqual(new Uint32Array([0, 6, 6, 9]))
        for (const key of sourceKeys) { key.fill(0) }
        const compact = requirements.map((requirement) => importer._createDeferredMediaRequirement(requirement))
        await expect(importer._importDeferredMediaRequirements(compact, [], new Map(), async () => {}))
            .rejects.toThrow('Could not find image at path "missing.png" for 画像 (がぞう) in Media references')
    })

    test('keeps diagnostic row indexes aligned after an empty projected image list', async () => {
        const {importer, requirements} = await collectReferences([
            ['先行', 'せんこう', '', '', 0, [{type: 'image', path: 'ignored.png'}], 0, ''],
            ['画像', 'がぞう', '', '', 0, [{type: 'image', path: 'missing.png'}], 0, ''],
        ], (chunk) => { chunk.mediaRows[0].imagePaths = [] })
        expect(requirements).toHaveLength(1)
        expect(requirements[0].entry).toMatchObject({diagnosticIndex: 1})
        const compact = importer._createDeferredMediaRequirement(requirements[0])
        await expect(importer._importDeferredMediaRequirements([compact], [], new Map(), async () => {}))
            .rejects.toThrow('Could not find image at path "missing.png" for 画像 (がぞう) in Media references')
    })
})
