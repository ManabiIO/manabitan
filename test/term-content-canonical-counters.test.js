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

/* eslint-disable @stylistic/semi */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test} from 'vitest'
import {CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'

// Exact source-bound artifact at d24b4e56ceb1fe14ad96ef3853f4d397efa6fa26.
// Its unchanged kernel is the independent oracle for partial failure state.
const baselineBytes = await readFile(new URL('data/dictionary-wasm/term-content-canonical-counters-baseline.wasm', import.meta.url))
assert.equal(createHash('sha256').update(baselineBytes).digest('hex'), '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af')
const modules = [
    await WebAssembly.compile(baselineBytes),
    await WebAssembly.compile(await readFile(new URL('../ext/lib/term-content-canonical-scan-v1.wasm', import.meta.url))),
]

/**
 * @typedef {object} Fixture
 * @property {TermContentMetadataArena} arena
 * @property {Uint32Array} config
 * @property {Uint32Array} rows
 * @property {Uint32Array} identities
 * @property {Uint32Array} meta
 * @property {Uint8Array} flags
 */

/**
 * @param {number} count
 * @returns {Fixture}
 */
function createFixture(count) {
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(16, count * 2)))
    const arena = new TermContentMetadataArena(capacity, capacity * 2)
    const buffer = arena.memory.buffer
    const config = new Uint32Array(buffer, 1088, 22)
    const first = 7
    const rowStart = 100
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
        first,
        first + count,
        0,
        rowStart,
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
        rows[i] = rowStart + i
        identities[i] = first + i
        meta.set([i * 8, 8, i + 1, (i ^ 0x9e3779b9) >>> 0], i * 4)
        signatures.set([i, i + 1, i + 2], i * 3)
    }
    return {arena, config, rows, identities, meta, flags}
}

/**
 * @param {number} hash1
 * @param {number} hash2
 * @param {number} mask
 * @returns {number}
 */
function hashSlot(hash1, hash2, mask) {
    const hash = hash1 ^ Math.imul(hash2, 0x9e3779b1)
    return (hash ^ (hash >>> 16)) & mask
}

/**
 * @param {Fixture} fixture
 * @param {number} row
 * @param {number} state
 */
function seedExisting({arena, config, meta}, row, state) {
    const index = config[11]++
    const hash1 = meta[row * 4 + 2]
    const hash2 = meta[row * 4 + 3]
    const mask = arena.slots.length - 1
    let slot = hashSlot(hash1, hash2, mask)
    while (arena.slots[slot] !== 0) { slot = (slot + 1) & mask }
    arena.slots[slot] = index + 1
    arena.hash1[index] = hash1
    arena.hash2[index] = hash2
    arena.length[index] = 8
    arena.state[index] = state
}

/** @type {Array<{name: string, count: number, change?: (fixture: Fixture) => void, result: number|'trap', resumeResult?: number}>} */
const cases = [
    {name: 'empty segment', count: 0, result: 0},
    {name: 'fresh pending rows', count: 23, result: 0},
    {name: 'maximum-size pending segment', count: layout.MAX, result: 0},
    {name: 'nonzero starting cursor', count: 23, change: ({config}) => { config[15] = 5 }, result: 0},
    {name: 'no reservation', count: 23, change: ({config}) => { config[20] = 0 }, result: 0},
    {name: 'already resolved rows', count: 23, change: ({flags}) => { flags.fill(1) }, result: 0},
    {name: 'mixed published, pending and resolved rows',
        count: 23,
        change: (fixture) => {
            for (let i = 0; i < 18; i += 3) {
                seedExisting(fixture, i, 1)
                seedExisting(fixture, i + 1, 2)
                fixture.flags[i + 2] = 1
            }
        },
        result: 0},
    {name: 'published hash pair with lookup disabled',
        count: 23,
        change: (fixture) => {
            seedExisting(fixture, 5, 1)
            fixture.config[19] = 0
        },
        result: 0},
    {name: 'exact-batch return precedes invalid later row',
        count: 4097,
        change: (fixture) => {
            for (let i = 0; i < 4096; ++i) { seedExisting(fixture, i, 1) }
            fixture.identities[4096] = 0
        },
        result: 1,
        resumeResult: -2},
    {name: 'invalid source count', count: 23, change: ({config}) => { config[12] = layout.MAX + 1 }, result: -1},
    {name: 'reversed unique range', count: 23, change: ({config}) => { config[14] = config[13] - 1 }, result: -1},
    {name: 'out-of-range cursor', count: 23, change: ({config}) => { config[15] = 24 }, result: -1},
    {name: 'non-power-of-two slots', count: 23, change: ({config}) => { config[1] = 3 }, result: -1},
    {name: 'invalid table pointer', count: 23, change: ({config}) => { config[2] = layout.PREFIX - 4 }, result: -1},
    {name: 'invalid dense count', count: 23, change: ({config}) => { config[11] = config[10] + 1 }, result: -1},
    {name: 'invalid slot index',
        count: 23,
        change: ({arena, meta}) => {
            arena.slots[hashSlot(meta[22 * 4 + 2], meta[22 * 4 + 3], arena.slots.length - 1)] = arena.state.length + 1
        },
        result: -4},
    {name: 'exhausted probe chain',
        count: 23,
        change: ({arena, config}) => {
            arena.slots.fill(1)
            arena.state[0] = 2
            config[11] = 1
        },
        result: -4},
    {name: 'dense capacity exhausted after insertions', count: 23, change: ({config}) => { config[10] = 5 }, result: -5},
    {name: 'occupied dense tail after insertions', count: 23, change: ({arena}) => { arena.state[5] = 1 }, result: -5},
    {name: 'reserved length after insertions',
        count: 23,
        change: ({config, meta}) => {
            config[18] = 0xffffffff
            meta[5 * 4] = 0
            meta[5 * 4 + 1] = 0xffffffff
        },
        result: -5},
]
for (const row of [0, 5, 22]) {
    cases.push(
        {name: `invalid row at ${row}`, count: 23, change: ({rows}) => { rows[row] = 99 }, result: -2},
        {name: `invalid identity at ${row}`, count: 23, change: ({identities}) => { identities[row] = 0 }, result: -2},
        {name: `invalid span at ${row}`, count: 23, change: ({meta}) => { meta[row * 4] = 0xffffffff }, result: -3},
        {name: `trap after insertion ${row + 1}`, count: 23, change: ({config}) => { config[21] = row + 1 }, result: 'trap'},
    )
}

test.each(cases)('canonical counters preserve complete native state: $name', ({count, change, result, resumeResult}) => {
    const fixture = createFixture(count)
    change?.(fixture)
    const input = new Uint8Array(fixture.arena.memory.buffer)
    const arms = modules.map((module) => {
        const pages = input.byteLength / 65536
        const memory = new WebAssembly.Memory({initial: pages, maximum: pages})
        new Uint8Array(memory.buffer).set(input)
        const instance = new WebAssembly.Instance(module, {env: {memory}})
        return {memory, run: /** @type {() => number} */ (instance.exports.scan_canonical)}
    })
    const expectedResults = typeof resumeResult === 'number' ? [result, resumeResult] : [result]
    for (let pass = 0; pass < expectedResults.length; ++pass) {
        for (const arm of arms) {
            if (pass > 0) {
                new Uint32Array(arm.memory.buffer, 1088, 22)[15] = new Uint32Array(arm.memory.buffer, 1024, 7)[1]
            }
            if (expectedResults[pass] === 'trap') {
                assert.throws(arm.run, WebAssembly.RuntimeError)
            } else {
                assert.equal(arm.run(), expectedResults[pass])
            }
        }
        const [baseline, candidate] = arms.map(({memory}) => new Uint8Array(memory.buffer))
        assert.deepEqual(new Uint32Array(candidate.buffer, 1024, 7), new Uint32Array(baseline.buffer, 1024, 7), 'all seven header words')
        // The private compiler stack may differ. Every input, output column,
        // journal word, exact descriptor and authoritative byte must match.
        assert.equal(Buffer.compare(candidate.subarray(layout.META), baseline.subarray(layout.META)), 0)
        assert.equal(Buffer.compare(candidate.subarray(1088, 1176), baseline.subarray(1088, 1176)), 0)
    }
})

/* eslint-enable @stylistic/semi */
