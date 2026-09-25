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
    setTermBankWasmModule(await WebAssembly.compile(await readFile(new URL('../ext/lib/term-bank-parser.wasm', import.meta.url))))
})

/**
 * Check every emitted content hash against the independent scalar JavaScript
 * implementation, including duplicate rows. Inspect canonical payloads only;
 * absolute heap offsets are not part of the persisted identity.
 * @param {unknown[][]} rows
 * @param {boolean} splitBanks
 * @returns {Promise<{bytes: Uint8Array, hash: number[]}[]>}
 */
async function hashRows(rows, splitBanks) {
    const split = Math.max(1, Math.floor(rows.length / 2))
    const banks = splitBanks ? [rows.slice(0, split), rows.slice(split)] : [rows]
    /** @type {{bytes: Uint8Array, hash: number[]}[]} */
    const contents = []
    await parseTermBankWithWasmColumnChunks(
        banks.map((bank) => encoder.encode(JSON.stringify(bank))),
        3,
        (chunk) => {
            const {contentBytesBuffer, contentBytesBaseOffset, contentMetaList} = chunk
            if (!contentBytesBuffer || !contentMetaList || typeof contentBytesBaseOffset !== 'number') {
                throw new Error('Missing native content metadata')
            }
            for (let row = 0; row < chunk.rowCount; ++row) {
                const offset = contentBytesBaseOffset + contentMetaList[row * 4]
                const length = contentMetaList[row * 4 + 1]
                expect(offset + length).toBeLessThanOrEqual(contentBytesBuffer.byteLength)
                const bytes = contentBytesBuffer.slice(offset, offset + length)
                const hash = [contentMetaList[row * 4 + 2], contentMetaList[row * 4 + 3]]
                expect(hash).toEqual(hashTermEntryContentBytesPair(bytes))
                contents.push({bytes, hash})
            }
        },
        2048,
        {singleChunk: true, emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true},
    )
    expect(contents).toHaveLength(rows.length)
    return contents
}

/**
 * @param {unknown} content
 * @param {number} index
 * @returns {unknown[]}
 */
function makeRow(content, index) {
    return [`term${index}`, '', 'n', '', 0, [content], index, '']
}

describe('native content hash identity', () => {
    test.each([false, true])('matches scalar hashes at every short tail and alignment; split banks=%s', async (splitBanks) => {
        const lengths = [...Array.from({length: 257}, (_, i) => i), 511, 512, 513, 1023, 1024, 1025, 4095, 4096, 4097, 65535, 65536, 65537]
        const rows = lengths.map((length, i) => makeRow('x'.repeat(length), i))
        const contents = await hashRows(rows, splitBanks)
        const residues = new Set(contents.map(({bytes}) => bytes.byteLength % 16))
        expect(residues.size).toBe(16)
        expect(contents.some(({bytes}) => bytes.byteLength < 16)).toBe(true)
    })

    test.each([false, true])('preserves Unicode, escape and structured-content hashes; split banks=%s', async (splitBanks) => {
        const texts = ['漢字かな🙂', 'quote " slash \\ newline\n tab\t', '\u0000\u0001\u001f', 'é é 𠮷', '']
        const rows = []
        for (let length = 0; length < 65; ++length) {
            for (const text of texts) {
                rows.push(makeRow(`${'z'.repeat(length)}${text}`, rows.length))
                rows.push(makeRow({type: 'structured-content', content: {tag: 'span', content: text.repeat(length)}}, rows.length))
            }
        }
        await hashRows(rows, splitBanks)
    })

    test('preserves duplicate identities across banks and repeated invocations', async () => {
        const values = ['small', 'm'.repeat(16), 'long'.repeat(1024), {type: 'structured-content', content: {tag: 'div', content: '日本語'.repeat(30)}}]
        const rows = Array.from({length: 128}, (_, i) => makeRow(values[i % values.length], i))
        const first = await hashRows(rows, true)
        const second = await hashRows(rows, false)
        expect(second).toEqual(first)
        for (let i = values.length; i < first.length; ++i) { expect(first[i]).toEqual(first[i % values.length]) }
    })
})
