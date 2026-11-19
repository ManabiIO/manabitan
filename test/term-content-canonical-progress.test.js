/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {describe, expect, test} from 'vitest'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'

const module = await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url)))

/**
 * @param {number} [count]
 * @returns {{arena: TermContentMetadataArena, header: Uint32Array, config: Uint32Array, meta: Uint32Array, identity: Uint32Array, rows: Uint32Array, flags: Uint8Array, scan: () => number}}
 */
function fixture(count = 5) {
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(count, 16)))
    const arena = new TermContentMetadataArena(capacity, capacity * 2)
    const {buffer} = arena.memory
    const header = new Uint32Array(buffer, 1024, 7)
    const config = new Uint32Array(buffer, 1088, 22)
    const meta = new Uint32Array(buffer, layout.META, count * 4)
    const identity = new Uint32Array(buffer, layout.IDENT, count)
    const rows = new Uint32Array(buffer, layout.ROWS, count)
    const signatures = new Uint32Array(buffer, layout.SIGS, count * 3)
    const flags = new Uint8Array(buffer, layout.FLAGS, count)
    for (let i = 0; i < count; ++i) {
        meta.set([i * 4, 4, i + 1, (i ^ 0x9e3779b9) >>> 0], i * 4)
        identity[i] = rows[i] = i
        signatures.set([i, i + 1, i + 2], i * 3)
    }
    config.set([
        arena.slots.byteOffset,
        arena.slots.length,
        arena.hash1.byteOffset,
        arena.hash2.byteOffset,
        arena.state.byteOffset,
        arena.length.byteOffset,
        arena.signaturePresent.byteOffset,
        arena.signature1.byteOffset,
        arena.signature2.byteOffset,
        arena.signature3.byteOffset,
        capacity,
        0,
        count,
        0,
        count,
        0,
        0,
        0,
        count * 4,
        1,
        1,
        0,
    ])
    const exports = new WebAssembly.Instance(module, {env: {memory: arena.memory}}).exports
    const scan = /** @type {() => number} */ (exports.scan_canonical)
    return {arena, header, config, meta, identity, rows, flags, scan}
}

describe('canonical native progress publication', () => {
    test('publishes final pending, resolved and dense progress', () => {
        const {flags, scan, header} = fixture()
        flags[1] = 1
        expect(scan()).toBe(0)
        expect([...header]).toEqual([4, 5, 4, 0, 1, 4, 0])
    })

    test('publishes unreserved rows without changing dense or journal counts', () => {
        const {config, scan, header} = fixture()
        config[20] = 0
        expect(scan()).toBe(0)
        expect([...header]).toEqual([0, 5, 5, 0, 0, 0, 0])
    })

    test.each(['identity', 'row', 'span', 'capacity'])('preserves ordinary error progress after earlier mutations: %s', (fault) => {
        const {identity, rows, meta, config, scan, header} = fixture()
        if (fault === 'identity') { identity[3] = 99 }
        if (fault === 'row') { rows[3] = 99 }
        if (fault === 'span') { meta[12] = 99 }
        if (fault === 'capacity') { config[10] = 3 }
        expect(scan()).toBe(fault === 'span' ? -3 : (fault === 'capacity' ? -5 : -2))
        expect([...header]).toEqual([3, fault === 'span' || fault === 'capacity' ? 4 : 3, 3, 0, 0, 3, 0])
    })

    test('publishes rollback journal progress before a native trap', () => {
        const {config, scan, header, arena} = fixture()
        config[21] = 3
        expect(scan).toThrow(WebAssembly.RuntimeError)
        expect([...header]).toEqual([3, 3, 2, 0, 0, 3, 0])
        const journal = new Uint32Array(arena.memory.buffer, layout.JOURNAL, header[0] * 3)
        for (let i = 0; i < header[0]; ++i) {
            const slot = journal[i * 3]
            const index = journal[i * 3 + 2]
            expect(arena.slots[slot]).toBe(index + 1)
            expect(arena.state[index]).toBe(2)
            expect(journal[i * 3 + 1]).toBe(0)
        }
    })

    test('publishes the exact-match boundary before inspecting a later invalid row', () => {
        const {arena, header, config, meta, rows, scan} = fixture(4097)
        for (let i = 0; i < 4096; ++i) {
            const hash1 = meta[i * 4 + 2]
            const hash2 = meta[i * 4 + 3]
            let hash = hash1 ^ Math.imul(hash2, 0x9e3779b1)
            hash ^= hash >>> 16
            let slot = hash & (arena.slots.length - 1)
            while (arena.slots[slot] !== 0) { slot = (slot + 1) & (arena.slots.length - 1) }
            arena.slots[slot] = i + 1
            arena.hash1[i] = hash1
            arena.hash2[i] = hash2
            arena.state[i] = 1
        }
        config[11] = 4096
        rows[4096] = 9999
        expect(scan()).toBe(1)
        expect([...header]).toEqual([0, 4096, 0, 4096, 0, 4096, 0])
        config[15] = header[1]
        expect(scan()).toBe(-2)
        expect([...header]).toEqual([0, 4096, 0, 0, 0, 4096, 0])
    })
})
