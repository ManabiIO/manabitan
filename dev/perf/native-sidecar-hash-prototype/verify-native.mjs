/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'

const [wasmPath, outputPath] = process.argv.slice(2)
assert(wasmPath && outputPath, 'usage: node verify-native-xxhash.mjs module.wasm output.json')
const vectorPath = new URL('./independent-vectors.json', import.meta.url)
const vectorBytes = await readFile(vectorPath)
const reference = JSON.parse(vectorBytes)
const wasmBytes = await readFile(wasmPath)
const {instance} = await WebAssembly.instantiate(wasmBytes)
const native = instance.exports
const scratchPointer = native.xxh32_scratch_ptr()
const capacity = native.xxh32_scratch_capacity()
assert.equal(capacity, 61440)
assert.equal(native.memory.buffer.byteLength, 65536)
const initialMemory = native.memory.buffer
const scratch = new Uint8Array(initialMemory, scratchPointer, capacity)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const baseline = await import('../../../ext/js/dictionary/term-key-hash.js')
const payloads = new Map()
let comparisons = 0
let rejectedUpdateChecks = 0

function payload(length) {
    if (payloads.has(length)) { return payloads.get(length) }
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; ++i) { bytes[i] = ((i * 131) ^ ((i >>> 7) * 17) ^ length) & 0xff }
    payloads.set(length, bytes)
    return bytes
}

function update(bytes, start, count) {
    assert(count <= capacity)
    scratch.set(new Uint8Array(bytes.buffer, bytes.byteOffset + start, count))
    assert.equal(native.xxh32_update(count), 1)
}

function compare(bytes, seed, expected, sizes) {
    native.xxh32_init(seed)
    assert.equal(native.xxh32_update(0), 1)
    let cursor = 0
    let part = 0
    while (cursor < bytes.byteLength) {
        const count = Math.min(sizes[part++ % sizes.length], bytes.byteLength - cursor)
        update(bytes, cursor, count)
        cursor += count
    }
    assert.equal(native.xxh32_finish() >>> 0, expected, `length=${bytes.byteLength} seed=${seed} partitions=${sizes}`)
    assert.equal(native.xxh32_finish() >>> 0, expected, 'finish must not mutate the state')
    assert.equal(native.memory.buffer, initialMemory, 'fixed memory must not grow')
    ++comparisons
}

for (const vector of reference.vectors) {
    const {length, seed, expected} = vector
    const bytes = payload(length)
    compare(bytes, seed, expected, [capacity])
    compare(bytes, seed, expected, [capacity - 1, 1, 17, 15, 31, 16])
    compare(bytes, seed, expected, length <= 4097 ? [1, 15, 1, 17, 31, 16, 63] : [655, 1023, 4097, 16381])
    if (length <= 129) { compare(bytes, seed, expected, [1]) }
    if (length <= 65) {
        for (let split = 0; split <= length; ++split) {
            native.xxh32_init(seed)
            update(bytes, 0, split)
            const partial = native.xxh32_finish() >>> 0
            assert.equal(native.xxh32_finish() >>> 0, partial)
            update(bytes, split, length - split)
            assert.equal(native.xxh32_finish() >>> 0, expected, `split=${split} length=${length} seed=${seed}`)
            ++comparisons
        }
    }
    if (seed === 0x811c9dc5) {
        assert.equal(baseline.hashTermKeyBytes(bytes), expected)
        ++comparisons
    }
}

// Refused updates are state-preserving and leave both a partial stripe and a
// previously processed stripe usable. Large unsigned inputs must be refused.
for (const prefixLength of [0, 1, 15, 16, 17, 31, 32]) {
    const bytes = payload(80)
    native.xxh32_init(0x811c9dc5)
    update(bytes, 0, prefixLength)
    const previous = native.xxh32_finish() >>> 0
    for (const invalidLength of [capacity + 1, 0x7fffffff, 0xffffffff, -1]) {
        assert.equal(native.xxh32_update(invalidLength), 0)
        assert.equal(native.xxh32_finish() >>> 0, previous)
        ++rejectedUpdateChecks
    }
    update(bytes, prefixLength, bytes.byteLength - prefixLength)
    assert.equal(native.xxh32_finish() >>> 0, baseline.hashTermKeyBytes(bytes))
    ++comparisons
}

// A new stream must discard a previous stream's pending bytes and long-input
// flag. These transitions include long -> empty and a partial stripe -> short.
for (const prior of [1, 15, 16, 17, 65537]) {
    const bytes = payload(prior)
    compare(bytes, 0, reference.vectors.find((entry) => entry.length === prior && entry.seed === 0).expected, [capacity])
    for (const next of [0, 1, 15, 16, 17]) {
        const vector = reference.vectors.find((entry) => entry.length === next && entry.seed === 0x811c9dc5)
        compare(payload(next), vector.seed, vector.expected, [1, 15])
    }
}

const report = {
    complete: true,
    node: process.version,
    oracle: reference.oracle,
    oracleVersion: reference.version,
    vectors: reference.vectors.length,
    comparisons,
    rejectedUpdateChecks,
    wasmPath,
    wasmSha256: sha256(wasmBytes),
    vectorsSha256: sha256(vectorBytes),
    scratchPointer,
    capacity,
    wasmMemoryBytes: initialMemory.byteLength,
    notes: 'Correctness only. Uses pinned upstream vectors and current JS comparator; no browser latency or whole-import gain claim.',
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
process.stdout.write(`${JSON.stringify(report)}\n`)
