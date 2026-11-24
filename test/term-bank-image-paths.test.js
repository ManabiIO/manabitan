/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {beforeAll, describe, expect, test} from 'vitest'
import {loadDictionaryWasm} from '../dev/dictionary-wasm.js'
import {tryCollectGlossaryImagePaths} from '../ext/js/dictionary/dictionary-image-references.js'
import {registerNativeImagePathSource, releaseNativeImagePathSource, tryCollectNativeGlossaryImagePaths} from '../ext/js/dictionary/term-bank-image-paths.js'
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWasmExports} TermBankWasmExports */
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
/** @type {TermBankWasmExports} */
let wasm

beforeAll(async () => {
    const bytes = loadDictionaryWasm().get('term-bank-parser.wasm')
    if (typeof bytes === 'undefined') { throw new Error('Missing checked parser module') }
    const module = await WebAssembly.compile(bytes)
    setTermBankWasmModule(module)
    const instance = await WebAssembly.instantiate(module, {})
    wasm = /** @type {TermBankWasmExports} */ (/** @type {unknown} */ (instance.exports))
})

/**
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function decodeString(bytes, start, length) {
    return /** @type {string} */ (JSON.parse(decoder.decode(Uint8Array.from(bytes.subarray(start, start + length)))))
}

/**
 * @param {string} json
 * @returns {{chunk: object, row: {glossaryJson: string, glossaryJsonBytes: Uint8Array}}}
 */
function borrowedSource(json) {
    wasm.wasm_reset_heap()
    const source = encoder.encode(json)
    const pointer = wasm.wasm_alloc(source.byteLength)
    const bytes = new Uint8Array(wasm.memory.buffer, pointer, source.byteLength)
    bytes.set(source)
    const chunk = {}
    registerNativeImagePathSource(chunk, wasm, bytes)
    return {chunk, row: {glossaryJson: '', glossaryJsonBytes: bytes}}
}

/**
 * @param {string} json
 * @returns {string[]|null}
 */
function project(json) {
    const {chunk, row} = borrowedSource(json)
    try {
        return tryCollectNativeGlossaryImagePaths(chunk, row, decodeString)
    } finally {
        releaseNativeImagePathSource(chunk)
    }
}

describe('native glossary image-path projection', () => {
    test.each([
        '[]',
        '[{"type":"image","path":"img/one.webp"}]',
        '[{"path":"one.png","type":"image"},{"type":"image","path":"one.png"}]',
        '[{"type":"image","path":"old.png","path":"new.webp"}]',
        '[{"type":"image","path":"old.png","path":null}]',
        '[{"type":"image","path":"old.png","path":{"path":"new.png"}}]',
        '[{"type":"image","path":"old.png","type":"text","text":"ignored"}]',
        '[{"type":"text","type":"image","path":"new.webp"}]',
        '[{"type":"image","type":null,"path":"ignored.png"}]',
        '[{"type":"structured-content","content":{"tag":"img","path":"one.png"}}]',
        '[{"type":"structured-content","content":[{"tag":"div","content":["text",{"tag":"img","path":"one.png"}]},{"tag":"img","path":"two.webp"}]}]',
        '[{"type":"structured-content","content":{"tag":"img","path":"one.png","content":{"tag":"img","path":"ignored.png"}}}]',
        '[{"type":"structured-content","content":{"tag":"img","path":null,"content":{"tag":"img","path":"ignored.png"}}}]',
        '[{"type":"structured-content","content":{"tag":"img","tag":"div","path":"ignored.png","content":{"tag":"img","path":"one.png"}}}]',
        '[{"type":"structured-content","content":{"tag":"div","tag":"img","path":"one.png","content":{"tag":"img","path":"ignored.png"}}}]',
        '[{"type":"structured-content","content":{"tag":"img","path":"old.png"},"content":null}]',
        '[{"type":"structured-content","content":{"tag":"img","path":"old.png"},"content":{"tag":"img","path":"new.png"}}]',
        '[{"type":"structured-content","content":{"style":{"tag":"img","path":"ignored.png"},"path":"ignored.png","content":[[{"tag":"img","path":"one.png"}]]}}]',
        '[null,"img",17,[{"type":"image","path":"ignored.png"}],{"tag":"img","path":"ignored.png"}]',
        '[{"type":"image","path":"image.WEBP"},{"type":"image","path":"audio.mp3"},{"type":"image","path":""}]',
        '[{"t\\u0079pe":"struc\\u0074ured-content","cont\\u0065nt":{"t\\u0061g":"i\\u006dg","pa\\u0074h":"img\\/日本語\\u002ewebp"}}]',
        '[{"type":"image","path":"😀\\ud800.png"}]',
        ' \n[ { "type" : "image", "path" : "img/cc1.webp" } ]\r\n',
    ])('matches the established collector: %s', (json) => {
        const paths = project(json)
        expect(paths).not.toBeNull()
        expect(paths).toEqual(tryCollectGlossaryImagePaths(json))
    })

    test('discards partial results when path, depth, or byte bounds require fallback', () => {
        const wide = JSON.stringify(Array.from({length: 33}, (_, index) => ({type: 'image', path: `${index}.png`})))
        const deep = '[{"type":"structured-content","content":' + '['.repeat(40) + '{"tag":"img","path":"deep.png"}' + ']'.repeat(40) + '}]'
        const large = JSON.stringify([{type: 'image', path: 'large.png', ignored: 'x'.repeat(65536)}])
        for (const json of [wide, deep, large]) {
            expect(project(json)).toBeNull()
            expect(tryCollectGlossaryImagePaths(json).length).toBeGreaterThan(0)
        }
    })

    test.each([
        '[{"type":"image","path":"one.png"},]',
        '[{"type":"image","path":"one.png",}]',
        '[{"type":"image","path":"one.png"} true]',
        '[{"type":"image","path":"one.png"}] trailing',
        '[{"type":"image","path":"one.png","ignored":"\\x"}]',
    ])('rejects malformed borrowed bytes after an earlier path: %s', (json) => {
        expect(project(json)).toBeNull()
        expect(tryCollectGlossaryImagePaths(json)).toEqual([])
    })

    test('uses only the original active borrowed chunk and current glossary bytes', () => {
        const {chunk, row} = borrowedSource('[{"type":"image","path":"one.png"}]')
        expect(tryCollectNativeGlossaryImagePaths({...chunk}, row, decodeString)).toBeNull()
        expect(tryCollectNativeGlossaryImagePaths(chunk, {...row, glossaryJson: '[]'}, decodeString)).toBeNull()
        expect(tryCollectNativeGlossaryImagePaths(chunk, {...row, glossaryJsonBytes: Uint8Array.from(row.glossaryJsonBytes)}, decodeString)).toBeNull()
        expect(tryCollectNativeGlossaryImagePaths(chunk, {...row, glossaryJsonBytes: new Uint8Array(wasm.memory.buffer, 0, row.glossaryJsonBytes.byteLength)}, decodeString)).toBeNull()
        expect(tryCollectNativeGlossaryImagePaths(chunk, row, decodeString)).toEqual(['one.png'])
        row.glossaryJsonBytes[row.glossaryJsonBytes.length - 1] = 0x2c
        expect(tryCollectNativeGlossaryImagePaths(chunk, row, decodeString)).toBeNull()
        releaseNativeImagePathSource(chunk)
        expect(tryCollectNativeGlossaryImagePaths(chunk, row, decodeString)).toBeNull()
    })

    test('matches all duplicate-property permutations without changing path order', () => {
        const kinds = ['"img"', '"div"', 'null']
        const paths = ['"first.png"', '"last.webp"', 'null']
        const contents = ['{"tag":"img","path":"nested.png"}', 'null']
        for (const firstKind of kinds) {
            for (const finalKind of kinds) {
                for (const firstPath of paths) {
                    for (const finalPath of paths) {
                        for (const content of contents) {
                            const object = `{"tag":${firstKind},"path":${firstPath},"content":${content},"tag":${finalKind},"path":${finalPath}}`
                            const json = `[{"type":"structured-content","content":[${object},{"tag":"img","path":"tail.png"}]}]`
                            expect(project(json)).toEqual(tryCollectGlossaryImagePaths(json))
                        }
                    }
                }
            }
        }
    })

    test('preserves copied worker rows and independent path strings after the native heap is reused', async () => {
        const glossary = [{type: 'structured-content', content: [{tag: 'img', path: '日本語.webp'}, {tag: 'img', path: 'img/two.png'}]}]
        const rows = [['語', 'ご', '', '', 0, glossary, 1, '']]
        /** @type {ReturnType<typeof copyWasmBackedColumnChunk>|null} */
        let copied = null
        await parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify(rows)), 3, (chunk) => {
            copied = copyWasmBackedColumnChunk(chunk, false, true)
            const foreignCopy = copyWasmBackedColumnChunk({...chunk}, false, true)
            expect(copied.mediaRows).toEqual(foreignCopy.mediaRows)
        }, 0, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, mediaHintFastScan: true})
        await parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify([['別', '', '', '', 0, ['replacement'], 2, '']])), 3, () => {}, 0, {singleChunk: true})
        expect(/** @type {ReturnType<typeof copyWasmBackedColumnChunk>|null} */ (copied)?.mediaRows[0].imagePaths).toEqual(['日本語.webp', 'img/two.png'])
    })

    test.each([false, true])('retires the native capability when the callback settles, rejected %s', async (reject) => {
        const rows = [['image', '', '', '', 0, [{type: 'image', path: 'image.png'}], 1, '']]
        /** @type {Parameters<typeof copyWasmBackedColumnChunk>[0]|null} */
        let retained = null
        const operation = parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify(rows)), 3, async (chunk) => {
            retained = chunk
            expect(tryCollectNativeGlossaryImagePaths(chunk, chunk.mediaRows[0].row, decodeString)).toEqual(['image.png'])
            await Promise.resolve()
            expect(tryCollectNativeGlossaryImagePaths(chunk, chunk.mediaRows[0].row, decodeString)).toEqual(['image.png'])
            if (reject) { throw new Error('Rejected sink') }
        }, 0, {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, mediaHintFastScan: true})
        await (reject ? expect(operation).rejects.toThrow('Rejected sink') : operation)
        const chunk = /** @type {Parameters<typeof copyWasmBackedColumnChunk>[0]|null} */ (retained)
        if (chunk === null) { throw new Error('Missing retained callback chunk') }
        expect(tryCollectNativeGlossaryImagePaths(chunk, chunk.mediaRows[0].row, decodeString)).toBeNull()
    })
})
