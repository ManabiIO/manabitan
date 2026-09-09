/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {beforeAll, describe, expect, test} from 'vitest'
import {hashTermEntryContentBytesPair} from '../ext/js/dictionary/term-entry-content-hash.js'
import {parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../ext/js/dictionary/term-bank-wasm-parser.js'

const encoder = new TextEncoder()
beforeAll(async () => {
    const bytes = await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))
    setTermBankWasmModule(await WebAssembly.compile(bytes))
})

/**
 * @param {unknown[]} glossaries
 * @param {boolean} binary
 */
async function checkHashes(glossaries, binary) {
    const rows = glossaries.map((glossary, i) => [`term-${i}`, '', '', '', 0, glossary, i, ''])
    let checked = 0
    const alignments = new Set()
    await parseTermBankWithWasmColumnChunks(encoder.encode(JSON.stringify(rows)), 3, (chunk) => {
        const meta = chunk.contentMetaList
        const content = chunk.contentBytesBuffer
        if (!(meta instanceof Uint32Array) || !(content instanceof Uint8Array)) {
            throw new Error('Expected native content slab and metadata')
        }
        const base = chunk.contentBytesBaseOffset ?? 0
        for (let i = 0; i < meta.length; i += 4) {
            const offset = base + meta[i]
            const length = meta[i + 1]
            const bytes = content.subarray(offset, offset + length)
            expect(bytes.byteLength).toBe(length)
            expect([meta[i + 2], meta[i + 3]]).toEqual(hashTermEntryContentBytesPair(bytes))
            alignments.add(offset % 16)
            ++checked
        }
    }, rows.length + 1, {
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: binary,
        singleChunk: true,
    })
    expect(checked).toBe(rows.length)
    return alignments
}

describe('paired content-hash SIMD stripes', () => {
    test.each([false, true])('matches scalar JavaScript for short boundaries and every alignment; binary=%s', async (binary) => {
        const glossaries = Array.from({length: 512}, (_, n) => [`${String.fromCharCode(33 + n % 80).repeat(n)}-${n}`])
        const alignments = await checkHashes(glossaries, binary)
        expect(alignments.size).toBe(16)
    })

    test.each([false, true])('preserves hashes for structured Unicode, escapes, and long values; binary=%s', async (binary) => {
        const glossaries = [
            [], [''], ['日本語'], ['emoji 😀🙂 and combining é'],
            ['quote " backslash \\ newline\n tab\t'],
            [{tag: 'span', content: ['日本語', {tag: 'b', content: 'nested'}]}],
            [{type: 'text', text: 'plain text object'}],
            ['x'.repeat(65535)], ['x'.repeat(65536)], ['x'.repeat(65537)],
            ['long 日本語😀 '.repeat(4096)],
        ]
        await checkHashes(glossaries, binary)
    })

    test('matches scalar hashes over deterministic variable-size definitions', async () => {
        let seed = 0x54e371c9
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed
        }
        const alphabet = ['a', 'Z', ' ', '漢', '字', '😀', '"', '\\', '\n', '\t']
        const glossaries = Array.from({length: 1024}, () => {
            let text = ''
            const length = random() % 2048
            for (let i = 0; i < length; ++i) { text += alphabet[random() % alphabet.length] }
            return [text]
        })
        await checkHashes(glossaries, true)
    })
})
