/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {createRecordFieldEncoder} from './prototype.mjs'

const {values} = parseArgs({options: {
    repository: {type: 'string', default: fileURLToPath(new URL('../inflight', import.meta.url))},
    wasm: {type: 'string', default: fileURLToPath(new URL('record-fields.wasm', import.meta.url))},
}})
const {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} = await import(pathToFileURL(path.join(values.repository, 'ext/js/dictionary/term-record-opfs-store.js')))
const {allocationInfo, encodeRecordFields} = createRecordFieldEncoder(await WebAssembly.compile(await readFile(values.wasm)))

const store = new TermRecordOpfsStore()
let checks = 0
function fixture(count = 128) {
    const values = [-256, 255, 256, -257, -2147483648, 2147483647, 0]
    return createArtifactTermRecordChunkWithResolvedContent(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, index) => values[index % values.length])},
        Uint32Array.from({length: count}, (_, index) => (index * 17) % count),
        Float64Array.from({length: count}, (_, index) => 2 ** 40 + index * 19),
        Uint32Array.from({length: count}, (_, index) => index % 31),
    )
}
function compare(chunk, base = 2 ** 40) {
    const expected = store._encodeArtifactRecordFields(chunk, [], [], base)
    const actual = encodeRecordFields(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, base)
    assert(actual)
    assert.deepEqual(actual, expected)
    ++checks
    return actual
}
function rejects(chunk, base = 2 ** 40) {
    assert.equal(encodeRecordFields(chunk.rowCount, chunk.scoreList, chunk.resolvedContentReferences, base), null)
    ++checks
}
const ordinary = fixture()
const retained = compare(ordinary)
for (const value of [-1, 0, -0, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    const chunk = fixture()
    chunk.resolvedContentReferences.offsets.fill(value)
    compare(chunk, value < 0 ? 0 : value)
}
for (const value of [NaN, Infinity, -Infinity, -2, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const chunk = fixture()
    chunk.resolvedContentReferences.offsets[0] = value
    rejects(chunk)
}
for (const value of [0, 65534]) {
    const chunk = fixture()
    chunk.resolvedContentReferences.lengths[0] = value
    compare(chunk)
}
for (const value of [65535, 65536, 0xffffffff]) {
    const chunk = fixture()
    chunk.resolvedContentReferences.lengths[0] = value
    rejects(chunk)
}
for (const delta of [0xfffffffe, 0xffffffff]) {
    const chunk = fixture()
    chunk.resolvedContentReferences.offsets[0] = 2 ** 40 + delta
    if (delta === 0xfffffffe) { compare(chunk) } else { rejects(chunk) }
}
for (const count of [1, 4, 5]) { rejects(fixture(count)) }
const nearCompact = fixture(6)
nearCompact.scoreList.fill(-200)
compare(nearCompact)
for (const count of [1024, 1025]) {
    const chunk = fixture(count * 2)
    chunk.scoreList = Int32Array.from({length: count * 2}, (_, index) => index % count)
    if (count === 1024) { compare(chunk) } else { rejects(chunk) }
}
const invalidIndex = fixture()
invalidIndex.resolvedContentReferences.uniqueIndexList[0] = 0xffffffff
rejects(invalidIndex)
for (const key of ['byteOffset', 'byteLength', 'subarray']) {
    const chunk = fixture()
    for (const column of [chunk.scoreList, ...Object.values(chunk.resolvedContentReferences)]) {
        Object.defineProperty(column, key, {get() { throw new Error(`Unexpected ${key} read`) }})
    }
    compare(chunk)
}
assert.deepEqual(retained, store._encodeArtifactRecordFields(ordinary, [], [], 2 ** 40))
++checks
process.stdout.write(JSON.stringify({checks, allocation: allocationInfo(128, 128)}) + '\n')
