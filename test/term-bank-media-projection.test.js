/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test, vi} from 'vitest'
import {tryCollectGlossaryImagePaths} from '../ext/js/dictionary/dictionary-image-references.js'
import {lendNativeMediaProjectionScratch, projectNativeMediaPaths} from '../ext/js/dictionary/term-bank-media-projection.js'
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} ColumnChunk */
/** @typedef {import('../ext/js/dictionary/term-bank-wasm-parser.js').TermBankWasmExports & {project_term_media_paths: (...args: number[]) => number}} Wasm */
/** @type {Wasm} */
let wasm
const encoder = new TextEncoder()

beforeAll(async () => {
    const module = await WebAssembly.compile(await readFile(new URL('../dev/data/dictionary-wasm/term-bank-parser.wasm', import.meta.url)))
    wasm = /** @type {Wasm} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module, {})).exports))
    setTermBankWasmModule(module)
})

/**
 * Exercise the actual native batch export and its private-memory bridge.
 * @param {Array<string|Uint8Array>} glossaries
 * @param {number} [pathCapacity]
 * @returns {{chunk: ColumnChunk, release: () => void, sourceOffset: number, sourceLength: number, outputPtr: number, outputCapacity: number}}
 */
function batch(glossaries, pathCapacity = glossaries.length * 8) {
    wasm.wasm_reset_heap()
    const sources = glossaries.map((value) => (typeof value === 'string' ? encoder.encode(value) : value))
    const sourceLength = sources.reduce((total, bytes) => total + bytes.length, 0)
    const sourceOffset = wasm.wasm_alloc(sourceLength + 8)
    const outputCapacity = glossaries.length * 16 + pathCapacity * 8
    const outputPtr = wasm.wasm_alloc(outputCapacity + 8)
    const memory = wasm.memory.buffer
    new Uint8Array(memory, outputPtr, outputCapacity + 8).fill(0xa5)
    let cursor = sourceOffset
    const mediaRows = sources.map((bytes, index) => {
        const glossaryJsonBytes = new Uint8Array(memory, cursor, bytes.length)
        glossaryJsonBytes.set(bytes)
        cursor += bytes.length
        return {index, row: {glossaryJson: '', glossaryJsonBytes, termEntryContentBytes: Uint8Array.of(1)}}
    })
    const chunk = /** @type {ColumnChunk} */ (/** @type {unknown} */ ({rowCount: glossaries.length, mediaRows}))
    const release = lendNativeMediaProjectionScratch(chunk, {wasm, sourceOffset, sourceLength, outputPtr, outputCapacity})
    return {chunk, release, sourceOffset, sourceLength, outputPtr, outputCapacity}
}

const semantics = [
    ['top-level image', '[{"type":"image","path":"a.png"}]'],
    ['structured arrays', '[{"type":"structured-content","content":[{"tag":"div","content":["text",{"tag":"img","path":"a.webp"}]},{"tag":"img","path":"b.JPG"}]}]'],
    ['late type and tag', '[{"content":{"path":"a.png","tag":"img"},"type":"structured-content"}]'],
    ['last path wins', '[{"type":"image","path":"a.png","path":"b.webp"}]'],
    ['last path becomes invalid', '[{"type":"image","path":"a.png","path":false}]'],
    ['last tag wins', '[{"type":"structured-content","content":{"tag":"img","path":"wrong.png","content":{"tag":"img","path":"a.png"},"tag":"div"}}]'],
    ['last type wins', '[{"type":"image","path":"wrong.png","content":{"tag":"img","path":"a.png"},"type":"structured-content"}]'],
    ['last content wins', '[{"type":"structured-content","content":{"tag":"img","path":"wrong.png"},"content":[{"tag":"img","path":"a.png"},{"tag":"img","path":"a.png"}]}]'],
    ['last content becomes scalar', '[{"type":"structured-content","content":{"tag":"img","path":"wrong.png"},"content":17}]'],
    ['image suppresses children', '[{"type":"structured-content","content":{"content":{"tag":"img","path":"wrong.png"},"tag":"img","path":"a.png"}}]'],
    ['invalid image path suppresses children', '[{"type":"structured-content","content":{"content":{"tag":"img","path":"wrong.png"},"tag":"img","path":null}}]'],
    ['unrelated data and style', '[{"type":"structured-content","content":{"tag":"a","path":"wrong.png","data":{"tag":"img","path":"wrong.png"},"style":{"content":{"tag":"img","path":"wrong.png"}},"content":"image.png"}}]'],
    ['unknown glossary object', '[{"type":"other","content":{"tag":"img","path":"wrong.png"}}]'],
    ['top-level nested arrays', '[[{"type":"image","path":"wrong.png"}],"{\\"path\\":\\"wrong.png\\"}",{"type":"image","path":"a.png"}]'],
    ['escaped semantic keys', String.raw`[{"ty\u0070e":"image","path":"wrong.png","pa\u0074h":"a.png"}]`],
    ['escaped content alias after valid output', String.raw`[{"type":"structured-content","content":{"tag":"img","path":"wrong.png"},"con\u0074ent":{"tag":"img","path":"a.png"}}]`],
    ['escaped tag value', String.raw`[{"type":"structured-content","content":{"tag":"\u0069mg","path":"a.png"}}]`],
    ['escaped type value', String.raw`[{"type":"im\u0061ge","path":"a.png"}]`],
    ['escaped paths', String.raw`[{"type":"image","path":"img/\u732b\"\\.png"},{"type":"image","path":"\ud800.png"}]`],
    ['BOM and Unicode paths', '[{"type":"image","path":"\ufeff猫😀.png"}]'],
    ['unsupported extension', '[{"type":"image","path":"a.txt"},{"type":"image","path":"a.png/path"}]'],
]

describe('native semantic image-path projection', () => {
    test.each(semantics)('%s matches the existing decoded-object collector', (_name, source) => {
        const {chunk, release, outputPtr, outputCapacity} = batch([source])
        const sourceBefore = new Uint8Array(chunk.mediaRows[0].row.glossaryJsonBytes ?? [])
        try {
            const projected = projectNativeMediaPaths(chunk)
            expect(projected).not.toBeNull()
            const actual = projected?.[0] ?? tryCollectGlossaryImagePaths(source)
            expect(actual).toEqual(tryCollectGlossaryImagePaths(source))
            if (!source.includes('\\u0070') && !source.includes('\\u0074')) { expect(projected?.[0]).not.toBeNull() }
            expect(chunk.mediaRows[0].row.glossaryJsonBytes).toEqual(sourceBefore)
            expect([...new Uint8Array(wasm.memory.buffer, outputPtr + outputCapacity, 8)]).toEqual(new Array(8).fill(0xa5))
        } finally { release() }
    })

    test('rolls back every provisional path on an escaped later key or output exhaustion', () => {
        const sources = [
            String.raw`[{"type":"image","path":"wrong.png"},{"type":"image","pa\u0074h":"a.png"}]`,
            '[{"type":"image","path":"one.png"},{"type":"image","path":"two.png"},{"type":"image","path":"three.png"}]',
            '[{"type":"image","path":"last.png"}]',
        ]
        const {chunk, release} = batch(sources, 2)
        try {
            expect(projectNativeMediaPaths(chunk)).toEqual([null, null, ['last.png']])
        } finally { release() }
    })

    test('rejects malformed or truncated input without publishing a valid prefix', () => {
        const valid = '[{"type":"image","path":"prefix.png"}]'
        const malformed = [valid.slice(0, -1), valid + 'false', valid.replace('}]', '},]'), valid.replace('"path":', '"path" '), valid.replace('prefix.png', 'bad\n.png')]
        const {chunk, release} = batch([...malformed, valid])
        try {
            expect(projectNativeMediaPaths(chunk)).toEqual([...malformed.map(() => null), ['prefix.png']])
        } finally { release() }
    })

    test('retains TextDecoder replacement behavior for invalid path UTF8', () => {
        const prefix = encoder.encode('[{"type":"image","path":"')
        const suffix = encoder.encode('.png"}]')
        const source = new Uint8Array(prefix.length + 3 + suffix.length)
        source.set(prefix)
        source.set([0xe0, 0x80, 0xff], prefix.length)
        source.set(suffix, prefix.length + 3)
        const {chunk, release} = batch([source])
        try {
            expect(projectNativeMediaPaths(chunk)?.[0]).toEqual(tryCollectGlossaryImagePaths(new TextDecoder().decode(source)))
        } finally { release() }
    })

    test('declines aliased, expired, nonnative, and undersized scratch', () => {
        const source = '[{"type":"image","path":"a.png"}]'
        const state = batch([source])
        expect(wasm.project_term_media_paths(state.sourceOffset, state.sourceLength, state.sourceOffset, 1, state.outputPtr + 8, state.outputPtr + 16, 1)).toBe(-1)
        expect(wasm.project_term_media_paths(state.sourceOffset, 0xffffffff, state.outputPtr, 1, state.outputPtr + 8, state.outputPtr + 16, 1)).toBe(-1)
        state.chunk.mediaRows[0].row.glossaryJsonBytes = encoder.encode(source)
        expect(projectNativeMediaPaths(state.chunk)).toBeNull()
        state.release()
        expect(projectNativeMediaPaths(state.chunk)).toBeNull()
        const small = batch([source], 0)
        try {
            expect(projectNativeMediaPaths(small.chunk)).toBeNull()
        } finally { small.release() }
    })

    test('ignores deeply nested unrelated properties and bounds semantic recursion', () => {
        const unrelated = '['.repeat(220) + '{"tag":"img","path":"never.png"}' + ']'.repeat(220)
        const deepContent = '['.repeat(260) + '{"tag":"img","path":"a.png"}' + ']'.repeat(260)
        const sources = [
            `[{"type":"structured-content","content":{"tag":"div","data":${unrelated},"content":{"tag":"img","path":"a.png"}}}]`,
            `[{"type":"structured-content","content":${deepContent}}]`,
            '[{"type":"image","path":"after.png"}]',
        ]
        const {chunk, release} = batch(sources)
        try {
            expect(projectNativeMediaPaths(chunk)).toEqual([['a.png'], null, ['after.png']])
        } finally { release() }
    })

    test('matches the independent collector across generated nested object shapes', () => {
        let seed = 0x4f86a321
        const random = (/** @type {number} */ limit) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed % limit
        }
        /**
         * @param {number} depth
         * @returns {unknown}
         */
        const content = (depth) => {
            if (depth === 0 || random(5) === 0) { return ['text', null, 17][random(3)] }
            if (random(3) === 0) { return [content(depth - 1), content(depth - 1)] }
            return {
                tag: ['img', 'div', 'span', 'a'][random(4)],
                path: ['a.png', 'b.webp', 'ignored.txt', null][random(4)],
                content: content(depth - 1),
                data: {path: 'never.png', content: {tag: 'img', path: 'never.png'}},
            }
        }
        const sources = Array.from({length: 300}, () => JSON.stringify([
            {type: ['image', 'structured-content', 'other'][random(3)], path: ['top.png', null][random(2)], content: content(5)},
            {type: 'structured-content', content: content(5)},
        ]))
        const {chunk, release} = batch(sources, 5000)
        try {
            const projected = projectNativeMediaPaths(chunk)
            expect(projected).toEqual(sources.map((source) => tryCollectGlossaryImagePaths(source)))
        } finally { release() }
    })
})

describe('parser lookup-scratch lease', () => {
    const options = {singleChunk: true, emitTermByteLists: false, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, prepareLookupIndexes: true, projectImagePaths: true, validateGlossaryTypes: true}

    test('batches production projection without decoding whole glossaries or changing owned lookup bytes', async () => {
        const glossary = [{type: 'structured-content', content: [{tag: 'div', content: 'long definition'.repeat(50)}, {tag: 'img', path: 'img/猫.webp'}]}]
        const banks = [
            encoder.encode(JSON.stringify([['画像', '', '', '', 0, glossary, 0, '']])),
            encoder.encode(JSON.stringify([['other', '', '', '', 1, ['ordinary'], 1, '']])),
        ]
        /** @type {ColumnChunk|null} */
        let retained = null
        await parseTermBankWithWasmColumnChunks(banks, 3, async (chunk) => {
            retained = chunk
            if (!(chunk.preparedLookupIndexes instanceof Map)) { throw new Error('Expected native lookup output') }
            const originalIndexes = [...chunk.preparedLookupIndexes.values()].map(({bytes}) => new Uint8Array(bytes))
            const originalSource = chunk.mediaRows.map(({row}) => new Uint8Array(row.glossaryJsonBytes ?? []))
            await Promise.resolve()
            const decode = vi.spyOn(TextDecoder.prototype, 'decode')
            try {
                const copied = copyWasmBackedColumnChunk(chunk, true, true)
                expect(copied.mediaRows[0].imagePaths).toEqual(['img/猫.webp'])
                expect(decode.mock.calls.every(([bytes]) => !(bytes instanceof Uint8Array) || bytes.length < 50)).toBe(true)
                expect([...chunk.preparedLookupIndexes.values()].map(({bytes}) => bytes)).toEqual(originalIndexes)
                expect(chunk.mediaRows.map(({row}) => row.glossaryJsonBytes)).toEqual(originalSource)
            } finally { decode.mockRestore() }
            await Promise.resolve()
            expect(projectNativeMediaPaths(chunk)?.[0]).toEqual(['img/猫.webp'])
        }, 2048, options)
        if (retained === null) { throw new Error('Expected parser chunk') }
        expect(projectNativeMediaPaths(retained)).toBeNull()
    })

    test('releases the scratch lease when the chunk callback throws', async () => {
        const banks = [
            encoder.encode(JSON.stringify([['image', '', '', '', 0, [{type: 'image', path: 'a.png'}], 0, '']])),
            encoder.encode(JSON.stringify([['other', '', '', '', 0, ['ordinary'], 1, '']])),
        ]
        /** @type {ColumnChunk|null} */
        let retained = null
        await expect(parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
            retained = chunk
            expect(projectNativeMediaPaths(chunk)?.[0]).toEqual(['a.png'])
            throw new Error('callback failed')
        }, 2048, options)).rejects.toThrow('callback failed')
        if (retained === null) { throw new Error('Expected parser chunk') }
        expect(projectNativeMediaPaths(retained)).toBeNull()
    })
})
