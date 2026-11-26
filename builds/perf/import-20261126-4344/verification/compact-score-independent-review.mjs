import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const [baselineArgument, candidateArgument, outputArgument] = process.argv.slice(2)
if (!baselineArgument || !candidateArgument || !outputArgument) {
    throw new Error('Usage: node compact-score-independent-review.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON')
}
const baselineRoot = path.resolve(baselineArgument)
const candidateRoot = path.resolve(candidateArgument)
const sourcePath = 'ext/js/dictionary/term-record-opfs-store.js'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const source = async (root) => ({
    root,
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    storeSha256: hash(await readFile(path.join(root, sourcePath))),
    lookupSha256: hash(await readFile(path.join(root, 'ext/js/dictionary/term-lookup-index.js'))),
})
const baselineSource = await source(baselineRoot)
const candidateSource = await source(candidateRoot)
const {TermRecordOpfsStore: Baseline} = await import(pathToFileURL(path.join(baselineRoot, sourcePath)))
const {TermRecordOpfsStore: Candidate} = await import(pathToFileURL(path.join(candidateRoot, sourcePath)))
const {encodePersistedTermLookupIndex} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-lookup-index.js')))
const baselineStore = new Baseline()
const candidateStore = new Candidate()
const cases = []

function fixture(count) {
    const base = 2 ** 40
    const values = Int32Array.of(-2147483648, 7, 2147483647)
    const fields = baselineStore._encodeArtifactRecordFields(
        {rowCount: count, scoreList: Int32Array.from({length: count}, (_, index) => values[index % values.length])},
        Float64Array.from({length: count}, (_, index) => base + index * 13),
        new Uint32Array(count).fill(8),
        base,
    )
    const header = new DataView(fields.buffer, fields.byteOffset, fields.byteLength)
    assert.equal(header.getUint32(0, true), 0x3246524d)
    assert.equal(header.getUint32(12, true), 2)
    const scoreCount = header.getUint32(8, true)
    const encoder = new TextEncoder()
    const payload = encodePersistedTermLookupIndex(Array.from({length: count}, (_, index) => ({
        expressionBytes: encoder.encode(`term-${index}`),
        readingBytes: null,
        sequence: index,
    })))
    return {fields, payload, count, base, scoreCount, scoreKeysOffset: 16 + scoreCount * 4 + count * 6}
}
function move(bytes, shared, offset) {
    const length = offset + bytes.byteLength + 12
    const buffer = shared ? new SharedArrayBuffer(length) : new ArrayBuffer(length)
    new Uint8Array(buffer).fill(0xa5)
    const fields = new Uint8Array(buffer, offset, bytes.byteLength)
    fields.set(bytes)
    return fields
}
function encode(store, data, fields) {
    return store._createLookupIndexChunk(37, data.count, data.base, data.payload, fields, 2)
}
function errorFor(store, data, fields) {
    try {
        encode(store, data, fields)
    } catch (error) {
        return {name: error.name, message: error.message}
    }
    throw new Error('Expected invalid record fields to throw')
}
function invalidCase(name, data, fields, message) {
    const before = new Uint8Array(fields.buffer).slice()
    const expected = errorFor(baselineStore, data, fields)
    assert.equal(expected.message, message)
    assert.deepEqual(errorFor(candidateStore, data, fields), expected)
    assert.deepEqual(new Uint8Array(fields.buffer), before)
    cases.push({name, error: expected})
}

for (const count of [9, 10]) {
    const data = fixture(count)
    const expected = encode(baselineStore, data, data.fields)
    for (const shared of [false, true]) {
        for (const offset of [0, 4, 12]) {
            const fields = move(data.fields, shared, offset)
            const before = new Uint8Array(fields.buffer).slice()
            const actual = encode(candidateStore, data, fields)
            assert.deepEqual(actual, expected)
            assert.deepEqual(new Uint8Array(fields.buffer), before)
            cases.push({name: `valid-${count}-shared-${shared}-offset-${offset}`, sidecarSha256: hash(actual), bytes: actual.byteLength})
        }
        for (const index of [0, Math.floor(count / 2), count - 1]) {
            for (const key of [data.scoreCount, 0xffff]) {
                const fields = move(data.fields, shared, 12)
                new DataView(fields.buffer, fields.byteOffset, fields.byteLength).setUint16(data.scoreKeysOffset + index * 2, key, true)
                invalidCase(`invalid-key-${count}-${index}-${key}-shared-${shared}`, data, fields, 'Compact term-record score key is invalid')
            }
        }
    }
}
const data = fixture(9)
for (const count of [0, 0xffff]) {
    const fields = move(data.fields, true, 4)
    new DataView(fields.buffer, fields.byteOffset, fields.byteLength).setUint32(8, count, true)
    invalidCase(`invalid-score-count-${count}`, data, fields, 'Invalid compact term-record fields dimensions')
}
const badCount = data.fields.slice()
new DataView(badCount.buffer).setUint32(4, data.count + 1, true)
invalidCase('invalid-row-count', data, badCount, 'Invalid compact term-record fields dimensions')
invalidCase('short-header', data, data.fields.subarray(0, 15), 'Invalid compact term-record fields header')
invalidCase('truncated-key', data, data.fields.subarray(0, -1), 'Invalid authoritative term-record fields')
const oversized = new Uint8Array(data.fields.byteLength + 1)
oversized.set(data.fields)
invalidCase('extra-byte', data, oversized, 'Invalid authoritative term-record fields')

const baselineAfter = await source(baselineRoot)
const candidateAfter = await source(candidateRoot)
for (const [before, after] of [[baselineSource, baselineAfter], [candidateSource, candidateAfter]]) {
    assert.equal(after.storeSha256, before.storeSha256)
    assert.equal(after.lookupSha256, before.lookupSha256)
}
const receipt = {
    purpose: 'Single-process independent correctness replay; not a Vitest execution, corpus replay or timing comparison',
    node: process.version,
    runnerSha256: hash(await readFile(new URL(import.meta.url))),
    baselineSource,
    candidateSource,
    baselineCommitAfter: baselineAfter.commit,
    candidateCommitAfter: candidateAfter.commit,
    passed: cases.length,
    cases,
}
await writeFile(outputArgument, JSON.stringify(receipt, null, 2) + '\n')
console.log(`Passed ${cases.length} exact sidecar and rejection-parity cases`)
