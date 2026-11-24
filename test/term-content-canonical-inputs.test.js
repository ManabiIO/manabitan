/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test} from 'vitest'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'

// Exact checked module from bbccabd520972cc351a65d9f545bd5369b6e9747.
// Preserve partial failure/trap state as well as ordinary successful results.
const baseline = await readFile(new URL('data/dictionary-wasm/term-content-canonical-v1-baseline.wasm', import.meta.url))
assert.equal(createHash('sha256').update(baseline).digest('hex'), '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af')
const modules = await Promise.all([
    WebAssembly.compile(baseline),
    WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url))),
])

/**
 * @param {number} count
 * @returns {{arena: TermContentMetadataArena, config: Uint32Array, rows: Uint32Array, identities: Uint32Array, meta: Uint32Array, flags: Uint8Array}}
 */
function fixture(count) {
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(16, count * 2)))
    const arena = new TermContentMetadataArena(capacity, capacity * 2)
    const buffer = arena.memory.buffer
    const config = new Uint32Array(buffer, 1088, 22)
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
        arena.state.length,
        0,
        count,
        7,
        count + 7,
        0,
        100,
        0,
        count * 8,
        1,
        1,
        0,
    ])
    new Uint32Array(buffer, 1024, 7).fill(0xdeadbeef)
    const rows = new Uint32Array(buffer, layout.ROWS, count)
    const identities = new Uint32Array(buffer, layout.IDENT, count)
    const meta = new Uint32Array(buffer, layout.META, count * 4)
    const flags = new Uint8Array(buffer, layout.FLAGS, count)
    const signatures = new Uint32Array(buffer, layout.SIGS, count * 3)
    for (let i = 0; i < count; ++i) {
        rows[i] = 100 + i
        identities[i] = 7 + i
        meta.set([i * 8, 8, i + 1, (i ^ 0x9e3779b9) >>> 0], i * 4)
        signatures.set([i, i + 1, i + 2], i * 3)
    }
    return {arena, config, rows, identities, meta, flags}
}

/**
 * @param {ReturnType<typeof fixture>} input
 * @param {number} row
 * @param {number} state
 */
function seedExisting({arena, config, meta}, row, state) {
    const index = config[11]++
    const hash1 = meta[row * 4 + 2]
    const hash2 = meta[row * 4 + 3]
    const hash = hash1 ^ Math.imul(hash2, 0x9e3779b1)
    let slot = (hash ^ (hash >>> 16)) & (arena.slots.length - 1)
    while (arena.slots[slot] !== 0) { slot = (slot + 1) & (arena.slots.length - 1) }
    arena.slots[slot] = index + 1
    arena.hash1[index] = hash1
    arena.hash2[index] = hash2
    arena.length[index] = 8
    arena.state[index] = state
}

/**
 * @param {Uint8Array} input
 * @returns {Array<{memory: WebAssembly.Memory, run: () => number}>}
 */
function createArms(input) {
    return modules.map((module) => {
        const pages = input.byteLength / 65536
        const memory = new WebAssembly.Memory({initial: pages, maximum: pages})
        new Uint8Array(memory.buffer).set(input)
        const instance = new WebAssembly.Instance(module, {env: {memory}})
        return {memory, run: /** @type {() => number} */ (instance.exports.scan_canonical)}
    })
}

/**
 * @param {ReturnType<typeof createArms>} arms
 * @param {number|'trap'} expected
 */
function compare(arms, expected) {
    for (const arm of arms) {
        if (expected === 'trap') {
            assert.throws(arm.run, WebAssembly.RuntimeError)
        } else {
            assert.equal(arm.run(), expected)
        }
    }
    const [a, b] = arms.map(({memory}) => new Uint8Array(memory.buffer))
    // Exclude only compiler-owned stack. All inputs, outputs, journals, exact
    // descriptors, authoritative tables and seven volatile words must match.
    assert.equal(Buffer.compare(a.subarray(1024, 1052), b.subarray(1024, 1052)), 0, 'volatile progress')
    assert.equal(Buffer.compare(a.subarray(1088, 1176), b.subarray(1088, 1176)), 0, 'configuration')
    assert.equal(Buffer.compare(a.subarray(layout.META), b.subarray(layout.META)), 0, 'all input/output/table bytes')
}

/** @type {Array<{name: string, count?: number, edit?: (input: ReturnType<typeof fixture>) => void, result: number|'trap'}>} */
const cases = [
    {name: 'empty', count: 0, result: 0},
    {name: 'pending rows', result: 0},
    {name: 'maximum segment', count: layout.MAX, result: 0},
    {name: 'nonzero cursor', edit: ({config}) => { config[15] = 5 }, result: 0},
    {name: 'reservation disabled', edit: ({config}) => { config[20] = 0 }, result: 0},
    {name: 'all resolved', edit: ({flags}) => { flags.fill(1) }, result: 0},
    {name: 'lookup disabled', edit: (input) => { seedExisting(input, 4, 1); input.config[19] = 0 }, result: 0},
    {name: 'existing pending pair', edit: (input) => { seedExisting(input, 4, 2) }, result: 0},
    {name: 'existing published pair', edit: (input) => { seedExisting(input, 4, 1) }, result: 0},
    {name: 'source count too large', edit: ({config}) => { config[12] = layout.MAX + 1 }, result: -1},
    {name: 'cursor beyond range', edit: ({config}) => { config[15] = 24 }, result: -1},
    {name: 'reversed range', edit: ({config}) => { config[14] = config[13] - 1 }, result: -1},
    {name: 'invalid slot count', edit: ({config}) => { config[1] = 3 }, result: -1},
    {name: 'oversized dense count', edit: ({config}) => { config[11] = config[10] + 1 }, result: -1},
    {name: 'capacity exhausted', edit: ({config}) => { config[10] = 5 }, result: -5},
    {name: 'occupied dense tail', edit: ({arena}) => { arena.state[5] = 1 }, result: -5},
    {name: 'aliased authoritative hash columns', edit: ({config}) => { config[3] = config[2] }, result: 0},
    {name: 'aliased authoritative length and hash', edit: ({config}) => { config[5] = config[2] }, result: 0},
    {name: 'wide offset addition', edit: ({config}) => { config[17] = 0xffffffff; config[18] = 0xffffffff }, result: -3},
    {name: 'null length after inserts',
        edit: ({config, meta}) => {
            config[18] = 0xffffffff
            meta[5 * 4] = 0
            meta[5 * 4 + 1] = 0xffffffff
        },
        result: -5},
]
for (const pointer of [0, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const address of [1024, 1088, layout.META, layout.OUT, layout.PREFIX - 4]) {
        cases.push({name: `reject table ${pointer} alias of immutable prefix ${address}`,
            edit: ({config}) => { config[pointer] = address },
            result: -1})
    }
}
for (const row of [0, 5, 22]) {
    cases.push(
        {name: `bad source row ${row}`, edit: ({rows}) => { rows[row] = 99 }, result: -2},
        {name: `bad identity ${row}`, edit: ({identities}) => { identities[row] = 0 }, result: -2},
        {name: `bad source extent ${row}`, edit: ({meta}) => { meta[row * 4] = 0xffffffff }, result: -3},
        {name: `trap after insertion ${row + 1}`, edit: ({config}) => { config[21] = row + 1 }, result: 'trap'},
    )
}

test.each(cases)('canonical input snapshots preserve native state: $name', ({count = 23, edit, result}) => {
    const input = fixture(count)
    edit?.(input)
    compare(createArms(new Uint8Array(input.arena.memory.buffer)), result)
})

test('fresh snapshots observe changed configuration and source bytes at an exact-match continuation', () => {
    const input = fixture(4097)
    for (let row = 0; row < 4096; ++row) { seedExisting(input, row, 1) }
    const arms = createArms(new Uint8Array(input.arena.memory.buffer))
    compare(arms, 1)
    for (const {memory} of arms) {
        const config = new Uint32Array(memory.buffer, 1088, 22)
        config[15] = new Uint32Array(memory.buffer, 1024, 7)[1]
        config[17] = 32
        config[18] += 32
        config[20] = 0
        new Uint32Array(memory.buffer, layout.META, 4097 * 4).set([0, 4, 0x1234, 0x5678], 4096 * 4)
    }
    compare(arms, 0)
})

test('canonical kernel has no reentrant imports and rejects concurrently writable shared memory', () => {
    for (const module of modules) {
        assert.deepEqual(WebAssembly.Module.imports(module), [{module: 'env', name: 'memory', kind: 'memory'}])
        const memory = new WebAssembly.Memory({initial: 256, maximum: 256, shared: true})
        assert.throws(() => new WebAssembly.Instance(module, {env: {memory}}), WebAssembly.LinkError)
    }
})
