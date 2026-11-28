/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'

const [wasmPath, outputPath] = process.argv.slice(2)
assert(wasmPath && outputPath)
const vectorBytes = await readFile(new URL('../native-sidecar-hash-prototype/independent-vectors.json', import.meta.url))
const reference = JSON.parse(vectorBytes)
const wasmBytes = await readFile(wasmPath)
const {instance} = await WebAssembly.instantiate(wasmBytes)
const n = instance.exports
const pointer = n.xxh32_scratch_ptr()
const capacity = n.xxh32_scratch_capacity()
const memory = n.memory.buffer
assert.equal(capacity, 20480)
assert.equal(memory.byteLength, 65536)
assert(pointer >= 0 && pointer + 3 * capacity <= memory.byteLength)
const windows = [0, 1, 2].map(i => new Uint8Array(memory, pointer + i * capacity, capacity))
const {hashTermKeyBytes} = await import('../../../ext/js/dictionary/term-key-hash.js')
const payloads = new Map()
let comparisons = 0
let refusalChecks = 0
let zeroUpdateChecks = 0

function payload(length) {
  if (payloads.has(length)) return payloads.get(length)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; ++i) bytes[i] = ((i * 131) ^ ((i >>> 7) * 17) ^ length) & 0xff
  payloads.set(length, bytes)
  return bytes
}

function update(bytes, cursors, counts) {
  for (let i = 0; i < 3; ++i) {
    assert(counts[i] <= capacity)
    windows[i].set(new Uint8Array(bytes[i].buffer, bytes[i].byteOffset + cursors[i], counts[i]))
  }
  assert.equal(n.xxh32_update(...counts), 1)
  for (let i = 0; i < 3; ++i) {
    assert.deepEqual(windows[i].subarray(0, counts[i]), bytes[i].subarray(cursors[i], cursors[i] + counts[i]), 'update must not modify scratch input')
    cursors[i] += counts[i]
  }
}

function finish(expected) {
  for (let i = 0; i < 3; ++i) {
    assert.equal(n.xxh32_finish(i) >>> 0, expected[i], `stream ${i}`)
    assert.equal(n.xxh32_finish(i) >>> 0, expected[i], 'finish must be idempotent')
    ++comparisons
  }
  assert.equal(n.memory.buffer, memory)
}

function run(bytes, seed, expected, sizes) {
  n.xxh32_init(seed)
  assert.equal(n.xxh32_update(0, 0, 0), 1)
  ++zeroUpdateChecks
  const cursors = [0, 0, 0]
  let part = 0
  while (cursors.some((cursor, i) => cursor < bytes[i].length)) {
    const counts = cursors.map((cursor, i) => Math.min(sizes[i][part % sizes[i].length], bytes[i].length - cursor))
    update(bytes, cursors, counts)
    if ((part++ & 3) === 0) {
      const before = [0, 1, 2].map(i => n.xxh32_finish(i) >>> 0)
      assert.equal(n.xxh32_update(0, 0, 0), 1)
      finish(before)
      ++zeroUpdateChecks
    }
  }
  finish(expected)
}

const seeds = [...new Set(reference.vectors.map(v => v.seed))]
for (const seed of seeds) {
  const vectors = reference.vectors.filter(v => v.seed === seed)
  for (let index = 0; index < vectors.length; ++index) {
    const selected = [vectors[index], vectors[(index * 13 + 17) % vectors.length], vectors[(index * 41 + 53) % vectors.length]]
    const bytes = selected.map(v => payload(v.length))
    const expected = selected.map(v => v.expected)
    run(bytes, seed, expected, [[capacity], [capacity], [capacity]])
    run(bytes, seed, expected, [[capacity - 1, 1, 17, 15], [31, 16, 4097], [1023, 0, 1, 20479]])
    if (bytes.every(b => b.length <= 129)) run(bytes, seed, expected, [[1], [15, 1], [0, 1, 17]])
  }

  // Exhaust every short first split, with different stream tails/carry states.
  for (let length = 0; length <= 65; ++length) {
    const lengths = [length, (length * 7 + 13) % 66, (length * 11 + 21) % 66]
    const bytes = lengths.map(payload)
    const expected = lengths.map(size => vectors.find(v => v.length === size).expected)
    for (let split = 0; split <= length; ++split) {
      n.xxh32_init(seed)
      const cursors = [0, 0, 0]
      const counts = [split, Math.min(lengths[1], split + 1), Math.min(lengths[2], Math.max(0, split - 1))]
      update(bytes, cursors, counts)
      const partial = [0, 1, 2].map(i => n.xxh32_finish(i) >>> 0)
      finish(partial)
      update(bytes, cursors, lengths.map((size, i) => size - cursors[i]))
      finish(expected)
    }
  }
}

// Equal lengths but independently different contents detect stream routing errors.
for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 255, 20479, 20480, 20481, 65537]) {
  const bytes = [new Uint8Array(length), new Uint8Array(length).fill(255), payload(length)]
  const expected = bytes.map(hashTermKeyBytes)
  run(bytes, 0x811c9dc5, expected, [[capacity], [capacity - 1, 1], [15, 0, 1, 17, 63]])
}

// Any invalid length refuses the entire call, including earlier valid streams.
for (const prefixes of [[0, 1, 15], [16, 17, 31], [32, 0, 7]]) {
  const bytes = [payload(80), payload(79), payload(78)]
  n.xxh32_init(0x811c9dc5)
  const cursors = [0, 0, 0]
  update(bytes, cursors, prefixes)
  const before = [0, 1, 2].map(i => n.xxh32_finish(i) >>> 0)
  for (const invalid of [capacity + 1, 0x7fffffff, 0xffffffff, -1]) {
    for (let index = 0; index < 3; ++index) {
      const lengths = [1, 16, 17]
      lengths[index] = invalid
      assert.equal(n.xxh32_update(...lengths), 0)
      finish(before)
      ++refusalChecks
    }
  }
  update(bytes, cursors, bytes.map((b, i) => b.length - cursors[i]))
  finish(bytes.map(hashTermKeyBytes))
  for (const invalid of [3, 4, 0xffffffff, -1]) {
    assert.equal(n.xxh32_finish(invalid), 0)
    finish(bytes.map(hashTermKeyBytes))
  }
  n.xxh32_init(0)
  finish([0, 1, 2].map(() => reference.vectors.find(v => v.length === 0 && v.seed === 0).expected))
}
assert.throws(() => n.memory.grow(1), RangeError)

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const report = {
  complete: true,
  node: process.version,
  upstreamOracle: reference.oracle,
  upstreamVersion: reference.version,
  upstreamVectors: reference.vectors.length,
  comparisons, refusalChecks, zeroUpdateChecks,
  wasmPath, wasmSha256: sha256(wasmBytes),
  vectorsSha256: sha256(vectorBytes),
  scratchPointer: pointer, streamCapacity: capacity, wasmMemoryBytes: memory.byteLength,
  notes: 'Independent correctness-only check, no performance or browser-import claim. Heterogeneous streams, independently partitioned updates, all short first splits, equal-length differing bytes, reset, finish, zero updates, rejection and input immutability.'
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
process.stdout.write(`${JSON.stringify(report)}\n`)
