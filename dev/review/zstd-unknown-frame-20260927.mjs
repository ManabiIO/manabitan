/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {decompress, init} from '../lib/zstd-wasm.js'

const file = process.argv[2]
assert.ok(file)
const compressed = new Uint8Array(await readFile(file))
await init(new URL('../data/zstd-simd.wasm', import.meta.url).pathname)

const expected = new TextEncoder().encode('unknown-size-zstd-frame\n'.repeat(4096))
const result = decompress(compressed, {
    defaultHeapSize: expected.byteLength,
    maxOutputSize: expected.byteLength,
})
assert.deepEqual(result, expected)
console.log(JSON.stringify({compressedBytes: compressed.byteLength, decodedBytes: result.byteLength}))
