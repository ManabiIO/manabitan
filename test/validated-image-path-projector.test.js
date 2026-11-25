/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker} from 'node:worker_threads'
import {crc32, deflateRawSync} from 'node:zlib'
import {afterEach, beforeAll, describe, expect, test, vi} from 'vitest'
import {tryCollectGlossaryImagePaths} from '../ext/js/dictionary/dictionary-image-references.js'
import {ValidatedImagePathProjector} from '../ext/js/dictionary/validated-image-path-projector.js'
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
const projector = new ValidatedImagePathProjector()

beforeAll(async () => {
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})
afterEach(() => { vi.restoreAllMocks() })

/**
 * @param {string} text
 * @param {boolean} shared
 * @returns {Uint8Array}
 */
function source(text, shared) {
    const encoded = encoder.encode(text)
    const backing = shared ? new SharedArrayBuffer(encoded.length + 48) : new ArrayBuffer(encoded.length + 48)
    const bytes = new Uint8Array(backing, 17, encoded.length)
    bytes.set(encoded)
    return bytes
}

describe.each([false, true])('validated single image projection: shared=%s', (shared) => {
    test.each([
        'img/a.png',
        'img/猫😀.webp',
        'img/"name".jpg',
        'img/slash\\name.png',
        'img/line\nname.png',
        'img/\tname.svg',
        'img/\ud800.png',
        'img/\udfff.png',
        'img/upper.PNG',
        'mdict-media/img/a.png',
    ])('preserves JSON string decoding for %j', (path) => {
        const text = JSON.stringify([{type: 'image', path}])
        const bytes = source(text, shared)
        const result = projector.project(bytes)
        expect(result).toEqual(tryCollectGlossaryImagePaths(text))
        expect(result).toEqual([path])
        expect(Reflect.get(projector, '_bytes').length).toBe(0)
        bytes.fill(0)
        expect(result).toEqual([path])
    })

    test.each([
        '[{"type":"image","path":"a.png","content":{"tag":"img","path":"ignored.png"}}]',
        '[{"content":{"tag":"img","path":"ignored.png"},"path":"a.png","type":"image"}]',
        '[{"type":"structured-content","content":[{"tag":"div","style":{"content":{"tag":"img","path":"ignored.png"}},"content":"text"},{"tag":"img","path":"a.png"}]}]',
        '[{"content":[null,true,3,[],"text",{"content":[{"path":"a.png","tag":"img"}],"tag":"span"}],"type":"structured-content"}]',
        '[{"type":"structured-content","content":{"type":"image","path":"ignored.png","content":{"tag":"img","path":"a.png"}}}]',
        '[{"type":"structured-content","content":{"tag":null,"content":{"tag":"img","path":"a.png"}}}]',
        '[{"type":"structured-content","content":{"content":{"tag":"img","path":"a.png"}}}]',
        '["ignored",[{"type":"image","path":"ignored.png"}],null,5,{"type":"image","path":"a.png"}]',
        '[{"type":"image","path":"a.png","ignored":{"type":"image","path":"ignored.png"},"tag":"div"}]',
        ' \n[ { "path" \t: "a.png", "type" : "image" } ]\r',
        '[{"type":"structured-content","content":{"tag":"img","path":"a.png","content":{"tag":"img","path":"ignored.png"}}}]',
        '[{"type":"structured-content","content":{"path":"a.png","content":{"tag":"img","path":"ignored.png"},"tag":"img"}}]',
    ])('follows only collector content edges: %s', (text) => {
        expect(projector.project(source(text, shared))).toEqual(['a.png'])
        expect(projector.project(source(text, shared))).toEqual(tryCollectGlossaryImagePaths(text))
    })

    test.each([
        '[{"type":"image","type":"text","path":"a.png"}]',
        '[{"type":"text","type":"image","path":"a.png"}]',
        '[{"type":"image","path":"old.png","path":"a.png"}]',
        '[{"type":"image","path":"a.png","path":false}]',
        '[{"type":"structured-content","content":{"tag":"img","path":"old.png"},"content":{"tag":"img","path":"a.png"}}]',
        '[{"type":"structured-content","content":{"tag":"img","tag":"div","path":"old.png","content":{"tag":"img","path":"a.png"}}}]',
        String.raw`[{"ty\u0070e":"image","path":"a.png"}]`,
        String.raw`[{"type":"im\u0061ge","path":"a.png"}]`,
        String.raw`[{"type":"structured-content","content":{"tag":"\u0069mg","path":"a.png"}}]`,
        String.raw`[{"type":"image","pa\u0074h":"a.png"}]`,
        String.raw`[{"type":"image","path":"old.png","pa\u0074h":"a.png"}]`,
        '[{"type":"image","path":"first.png"},{"type":"image","path":"second.png"}]',
        '[{"type":"structured-content","content":[{"tag":"img","path":"a.png"},{"tag":"img","path":"a.png"}]}]',
        '[{"type":"image","path":"not-an-image"}]',
        '[{"type":"image","path":""}]',
        '[{"type":"image","path":null}]',
        '[{"type":"image","path":42}]',
        '[{"type":"image"}]',
        '[{"type":"text","path":"a.png"}]',
        '[]',
    ])('falls back for unsupported shapes without changing paths/order: %s', (text) => {
        const result = projector.project(source(text, shared))
        expect(result).toBeNull()
        expect(result ?? tryCollectGlossaryImagePaths(text)).toEqual(tryCollectGlossaryImagePaths(text))
        expect(Reflect.get(projector, '_bytes').length).toBe(0)
    })

    test('keeps quoted delimiters and backslash runs inside ignored strings', () => {
        for (let count = 0; count < 16; ++count) {
            const text = JSON.stringify([{type: 'structured-content',
                content: [
                    {tag: 'span', content: '}]' + '\\'.repeat(count) + '"[{', style: {unknown: ['[}', '\\"[}']}},
                    {tag: 'img', path: 'a.png'},
                ]}])
            expect(projector.project(source(text, shared))).toEqual(tryCollectGlossaryImagePaths(text))
        }
    })

    test('bounds recursion and resets after a fallback', () => {
        /** @type {unknown} */
        let content = {tag: 'img', path: 'a.png'}
        for (let i = 0; i < 300; ++i) { content = {content} }
        expect(projector.project(source(JSON.stringify([{type: 'structured-content', content}]), shared))).toBeNull()
        expect(projector.project(source('[{"type":"image","path":"next.png"}]', shared))).toEqual(['next.png'])
    })
})

describe('native producer integration', () => {
    test('transfers compressed worker results and preserves fallback paths after worker reuse', async () => {
        const sourceTexts = [
            '[{"type":"structured-content","content":[{"tag":"div","content":"text"},{"tag":"img","path":"single.png"}]}]',
            String.raw`[{"type":"structured-content","content":{"tag":"\u0069mg","pa\u0074h":"img/\u732b.webp"}}]`,
            '[{"type":"image","path":"old.png","path":"last.png"}]',
            '[{"type":"image","path":"first.png"},{"type":"image","path":"second.png"}]',
        ]
        const sourceBytes = encoder.encode(`[${sourceTexts.map((glossary, i) => `["key-${i}","reading-${i}","","",0,${glossary},${i},""]`).join(',')}]`)
        const options = {
            singleChunk: true,
            compactContentMetadata: true,
            emitTermByteLists: false,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            validateGlossaryTypes: true,
            prepareLookupIndexes: true,
            projectImagePaths: true,
            ownContentBytes: true,
        }
        /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|undefined} */
        let expected
        await parseTermBankWithWasmColumnChunks(sourceBytes, 3, (chunk) => {
            expected = copyWasmBackedColumnChunk(chunk, false, true)
        }, undefined, options)
        const worker = new Worker(new URL('fixtures/parser-settlement/worker-node.mjs', import.meta.url), {
            workerData: {url: new URL('../ext/js/dictionary/term-bank-wasm-parser-worker.js', import.meta.url).href},
        })
        /**
         * @param {unknown} data
         * @returns {Promise<{type: string, chunk?: ReturnType<typeof copyWasmBackedColumnChunk>, error?: unknown}>}
         */
        const request = (data) => new Promise((resolve, reject) => {
            const onMessage = (/** @type {{type: string, chunk?: ReturnType<typeof copyWasmBackedColumnChunk>, error?: unknown}} */ response) => {
                worker.off('error', onError)
                resolve(response)
            }
            const onError = (/** @type {Error} */ error) => {
                worker.off('message', onMessage)
                reject(error)
            }
            worker.once('message', onMessage)
            worker.once('error', onError)
            worker.postMessage(data)
        })
        try {
            const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url)))
            expect((await request({type: 'initialize', module})).type).toBe('ready')
            const compressed = Uint8Array.from(deflateRawSync(sourceBytes))
            const response = await request({type: 'parse',
                id: 1,
                version: 3,
                options,
                sourceBuffers: [compressed.buffer],
                sourceMetadata: [{compressionMethod: 8, compressedSize: compressed.length, uncompressedSize: sourceBytes.length, signature: crc32(sourceBytes)}]})
            expect(response.type, JSON.stringify(response.error)).toBe('result')
            const {chunk} = response
            if (!chunk || !expected) { throw new Error('Missing worker result') }
            expect(chunk.mediaRows.map(({imagePaths}) => imagePaths)).toEqual(sourceTexts.map(tryCollectGlossaryImagePaths))
            expect(chunk.contentBytesBuffer).toEqual(expected.contentBytesBuffer)
            expect(chunk.contentMetaList).toEqual(expected.contentMetaList)
            expect(chunk.termRecordPreinternedPlan).toEqual(expected.termRecordPreinternedPlan)
            expect(chunk.preparedLookupIndexes).toEqual(expected.preparedLookupIndexes)
            expect(chunk.mediaRows.every(({row}) => row.glossaryJsonBytes === undefined)).toBe(true)
            const snapshots = chunk.mediaRows.map(({row}) => [row.expressionBytes?.slice(), row.readingBytes?.slice()])
            const nextSource = encoder.encode(JSON.stringify([['replacement', '', '', '', 0, ['overwrite'.repeat(200000)], 1, '']]))
            expect((await request({type: 'parse', id: 2, version: 3, options, sourceBuffers: [nextSource.buffer]})).type).toBe('result')
            expect(chunk.mediaRows.map(({imagePaths}) => imagePaths)).toEqual(sourceTexts.map(tryCollectGlossaryImagePaths))
            expect(chunk.mediaRows.map(({row}) => [row.expressionBytes, row.readingBytes])).toEqual(snapshots)
        } finally { await worker.terminate() }
    })

    test('decodes only the path token and keeps owned results after heap reuse', async () => {
        const glossary = [{type: 'structured-content',
            content: [
                {tag: 'div', style: {fontWeight: 'bold'}, content: 'a long unrelated value '.repeat(100)},
                {tag: 'img', path: 'img/猫😀.webp'},
            ]}]
        const glossaryText = JSON.stringify(glossary)
        const bank = encoder.encode(JSON.stringify([['画像', 'がぞう', '', '', 0, glossary, 1, '']]))
        const decode = vi.spyOn(TextDecoder.prototype, 'decode')
        /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|undefined} */
        let owned
        await parseTermBankWithWasmColumnChunks(bank, 3, (chunk) => {
            const bytes = chunk.mediaRows[0].row.glossaryJsonBytes
            expect(bytes?.buffer).toBeInstanceOf(SharedArrayBuffer)
            decode.mockClear()
            owned = copyWasmBackedColumnChunk(chunk, false, true)
            expect(owned.mediaRows[0].imagePaths).toEqual(['img/猫😀.webp'])
            const inputs = decode.mock.calls.map(([input]) => input).filter((input) => input instanceof Uint8Array)
            expect(inputs).toHaveLength(1)
            expect(inputs[0].byteLength).toBe(encoder.encode(JSON.stringify('img/猫😀.webp')).length)
            expect(inputs[0].byteLength).toBeLessThan(encoder.encode(glossaryText).length)
            expect(inputs[0].buffer).toBeInstanceOf(ArrayBuffer)
            expect(inputs[0].buffer).not.toBe(bytes?.buffer)
        }, 2048, {
            singleChunk: true,
            emitTermByteLists: false,
            emitContentSlab: true,
            emitTokenBinaryContent: true,
            mediaHintFastScan: true,
            validateGlossaryTypes: true,
        })
        await parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify([
            ['replacement'.repeat(100), '', '', '', 0, ['other content'.repeat(1000)], 1, ''],
        ])), 3, () => {})
        expect(owned?.mediaRows[0].imagePaths).toEqual(['img/猫😀.webp'])
    })

    test.each([
        '[{"type":"image","path":"a.png","ignored":tru}]',
        '[{"type":"image","path":"a.png","ignored":01}]',
        String.raw`[{"type":"image","path":"a.png","ignored":"\x00"}]`,
        '[{"type":"image","path":"a.png","ignored":{"key":]}}]',
    ])('native grammar checks reject malformed ignored values before projection: %s', async (glossary) => {
        const callback = vi.fn()
        await expect(parseTermBankWithWasmColumnChunks(
            encoder.encode(`[["画像","","","",0,${glossary},1,""]]`),
            3,
            callback,
            2048,
            {emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, validateGlossaryTypes: true},
        )).rejects.toThrow()
        expect(callback).not.toHaveBeenCalled()
    })
})
