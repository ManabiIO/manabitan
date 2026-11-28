/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {crc32, deflateRawSync} from 'node:zlib'
import {hashTermKeyBytes} from '../../../ext/js/dictionary/term-key-hash.js'

export const negativeCases = ['unique-prefixes', 'common-prefix-unique-middles', 'short-unique', 'nonlocal-reuse']

export function openNegativeBanks(id) {
    assert(negativeCases.includes(id))
    const encoder = new TextEncoder()
    const structured = {type: 'structured-content', content: Array.from({length: 8}, (_, i) => ({tag: 'span', content: `definition ${i} ${'payload '.repeat(8)}`}))}
    const repeated = []
    const occupied = new Set()
    for (let i = 0; repeated.length < 17; ++i) {
        const glossary = [`nonlocal-${String(i).padStart(6, '0')}-${'body '.repeat(30)}`, structured]
        const slot = hashTermKeyBytes(encoder.encode(JSON.stringify(glossary)).subarray(0, 64)) & 255
        if (occupied.has(slot)) { continue }
        occupied.add(slot)
        repeated.push(glossary)
    }
    const sources = []
    const sourceDigest = createHash('sha256')
    for (let bank = 0; bank < 2; ++bank) {
        const rows = Array.from({length: 5000}, (_, row) => {
            const index = bank * 5000 + row
            const key = String(index).padStart(6, '0')
            let glossary
            switch (id) {
                case 'unique-prefixes':
                    glossary = [`unique-${key}-${'body '.repeat(30)}`, structured]
                    break
                case 'common-prefix-unique-middles':
                    glossary = [`${'prefix '.repeat(20)}${key}${'suffix '.repeat(20)}`, structured]
                    break
                case 'short-unique':
                    glossary = [`u${key}`]
                    break
                case 'nonlocal-reuse':
                    glossary = repeated[index % repeated.length]
                    break
                default: throw new Error(`Unknown negative fixture: ${id}`)
            }
            return [`term-${key}`, '', '', '', 0, glossary, index, '']
        })
        const raw = encoder.encode(JSON.stringify(rows))
        sourceDigest.update(raw)
        const bytes = new Uint8Array(deflateRawSync(raw))
        sources.push({filename: `term_bank_${bank + 1}.json`, bytes, compressionMethod: 8,
            compressedSize: bytes.length, uncompressedSize: raw.length, signature: crc32(raw)})
    }
    return {entries: sources, mediaHintFastScan: false,
        sourceSha256: sourceDigest.digest('hex'), termRows: 10000,
        spec: 'Fixed two-bank source, 5000 rows per bank. Enabled-reuse negatives with unique prefixes, shared prefixes and tails, or short unique glossaries; nonlocal positive uses 17 distinct native prefix slots. Not a real dictionary or production group-policy claim.',
        close: async () => {}, read: async (entry) => entry}
}
