import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {installRecordFieldExport} from './export-hook.mjs'
import {NativeRecordFields} from './native-wrapper.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const sourceRoot = resolve(here, '../../manabitan')
const binding = JSON.parse(readFileSync(resolve(here, 'capture-binding.json')))
const hook = installRecordFieldExport(sourceRoot, binding.recordEncoderSha256)
const current = await import(pathToFileURL(resolve(sourceRoot, binding.recordEncoderSource)).href)
hook.finish()
const stock = (chunk, offsets, lengths, base) => current.TermRecordOpfsStore.prototype._encodeArtifactRecordFields.call(null, chunk, offsets, lengths, base)
const wasmBytes = readFileSync(resolve(here, 'record-fields.wasm'))
const create = (options = {}) => new NativeRecordFields({wasmBytes, privateReferences: current.diagnosticRecordFieldReferences, stockEncode: stock, ...options})
const input = (count = 64, score = (i) => [0, -2147483648, 2147483647, -10100301, 1999800][i % 5]) => {
    const indexes = Uint32Array.from({length: count}, (_, i) => i % 8)
    const offsets = Float64Array.from({length: 8}, (_, i) => 1000 + i * 10)
    const lengths = Uint32Array.from({length: 8}, (_, i) => i)
    const scores = Int32Array.from({length: count}, (_, i) => score(i))
    const chunk = current.createArtifactTermRecordChunkWithResolvedContent({rowCount: count, scoreList: scores}, indexes, offsets, lengths)
    return {chunk, offsets: new Float64Array(0), lengths: new Uint32Array(0), base: 1000}
}
const snapshots = (value) => [value.chunk.scoreList, value.chunk.resolvedContentReferences?.uniqueIndexList, value.chunk.resolvedContentReferences?.offsets, value.chunk.resolvedContentReferences?.lengths].filter((column) => ArrayBuffer.isView(column)).map((column) => {
    const bytes = new Uint8Array(column.buffer, column.byteOffset, column.byteLength)
    return [bytes, Buffer.from(bytes)]
})
const call = (fn, value) => {
    try { return {bytes: fn(value.chunk, value.offsets, value.lengths, value.base)} } catch (error) { return {error} }
}
const attempts = resolve(here, 'test-attempts')
mkdirSync(attempts, {recursive: true})
const attempt = resolve(attempts, String(readdirSync(attempts).length + 1).padStart(3, '0'))
mkdirSync(attempt)
const results = []
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = Object.fromEntries(['record-fields.c', 'record-fields.wasm', 'native-wrapper.mjs', 'test-helper.mjs', 'export-hook.mjs'].map((name) => [name, sha256(readFileSync(resolve(here, name)))]))
function test(name, run) {
    try { run(); results.push({name, pass: true}) } catch (error) { results.push({name, pass: false, error: String(error), stack: error.stack}) }
    writeFileSync(resolve(attempt, 'report.json'), JSON.stringify({complete: false, timingAcquisition: false, sourceHashes, results}, null, 2) + '\n')
}
function compare(make, nativeExpected, options) {
    const expected = call(stock, make())
    const actualInput = make()
    const helper = create(options)
    const actual = call(helper.encode.bind(helper), actualInput)
    if (expected.error) {
        assert(actual.error)
        assert.equal(actual.error.name, expected.error.name)
        assert.equal(actual.error.message, expected.error.message)
    } else {
        if (actual.error) throw actual.error
        assert.deepEqual(actual.bytes, expected.bytes)
    }
    if (nativeExpected !== undefined) assert.equal(helper.lastStats.native, nativeExpected, JSON.stringify(helper.lastStats))
    return {helper, actual, actualInput}
}
const mutate = (change, count = 64) => () => { const value = input(count); change(value); return value }

test('arbitrary int32 including extremes and stable first-use order', () => {
    const {helper, actual} = compare(() => input(), true)
    const count = new Uint32Array(actual.bytes.buffer, 0, 4)[2]
    assert.deepEqual([...new Int32Array(actual.bytes.buffer, 16, count)], [0, -2147483648, 2147483647, -10100301, 1999800])
    assert.equal(helper.lastStats.inputCopyCalls, 4)
})
test('null offsets and maximum admitted compact length', () => compare(mutate(({chunk}) => { chunk.resolvedContentReferences.offsets[0] = -1; chunk.resolvedContentReferences.lengths[0] = 65534 }), true))
test('safe large content base and maximum u32 delta', () => compare(mutate((value) => { value.base = 2 ** 52; value.chunk.resolvedContentReferences.offsets.set([value.base, value.base + 4294967294, value.base + 1, value.base + 2, value.base + 3, value.base + 4, value.base + 5, value.base + 6]) }), true))
test('nonzero source view offsets', () => compare(() => {
    const value = input()
    const references = value.chunk.resolvedContentReferences
    for (const [key, Constructor] of [['uniqueIndexList', Uint32Array], ['offsets', Float64Array], ['lengths', Uint32Array]]) {
        const previous = references[key]
        const next = new Constructor(new ArrayBuffer((previous.length + 4) * Constructor.BYTES_PER_ELEMENT), Constructor.BYTES_PER_ELEMENT * 2, previous.length)
        next.set(previous)
        references[key] = next
    }
    const scores = new Int32Array(new ArrayBuffer(280), 8, 64)
    scores.set(value.chunk.scoreList)
    value.chunk.scoreList = scores
    return value
}, true))
test('private aliased input columns preserve logical reads', () => compare(() => {
    const value = input()
    const both = new Uint32Array(64).fill(1)
    value.chunk.resolvedContentReferences.uniqueIndexList = both
    value.chunk.resolvedContentReferences.lengths = both
    value.chunk.resolvedContentReferences.offsets = new Float64Array(64).fill(1000)
    value.chunk.scoreList = new Int32Array(both.buffer)
    return value
}, true))
for (const length of [65535, 0xffffffff]) test(`length ${length} uses unchanged legacy fallback`, () => compare(mutate(({chunk}) => { chunk.resolvedContentReferences.lengths[3] = length }), false))
for (const count of [0, 1, 5]) test(`count ${count} preserves compact-size fallback`, () => compare(() => input(count, () => 0), false))
test('count six chooses compact when strictly smaller', () => compare(() => input(6, () => 0), true))
test('bad unique index preserves error type and message', () => compare(mutate(({chunk}) => { chunk.resolvedContentReferences.uniqueIndexList[7] = 100 }), false))
for (const offset of [NaN, Infinity, -2, 1000.5, Number.MAX_SAFE_INTEGER + 1, 999, 1000 + 4294967295]) test(`unsupported offset ${String(offset)} preserves stock conversion`, () => compare(mutate(({chunk}) => { chunk.resolvedContentReferences.offsets[0] = offset }), false))
test('invalid content base preserves generic behavior', () => compare(mutate((value) => { value.base = NaN }), false))
test('first-occurrence cardinality 65534 remains compact', () => compare(() => input(131068, (i) => (i % 65534) - 32767), true))
for (const cardinality of [65535, 65536]) test(`reserved/excess cardinality ${cardinality} falls back`, () => compare(() => input(cardinality * 2, (i) => i % cardinality), false))
const mix = (value) => { value = Math.imul(value ^ value >>> 16, 0x7feb352d); value = Math.imul(value ^ value >>> 15, 0x846ca68b); return (value ^ value >>> 16) >>> 0 }
test('hash collision chains preserve first-use keys', () => {
    const values = []
    for (let value = 0; values.length < 12; ++value) if ((mix(value) & 127) === 0) values.push(value)
    compare(() => input(64, (i) => values[i % values.length]), true)
})
test('pathological probe budget falls back without an unbounded chain', () => {
    const values = []
    for (let value = 0; values.length < 64; ++value) if ((mix(value) & 511) === 0) values.push(value)
    const {helper} = compare(() => input(256, (i) => values[i % values.length]), false)
    assert.equal(helper.lastStats.fallback, 'unsupported-compact')
})
for (const [key, Original, Forged] of [['scoreList', Uint16Array, Int32Array], ['uniqueIndexList', Uint16Array, Uint32Array], ['offsets', Float32Array, Float64Array], ['lengths', Uint16Array, Uint32Array]]) test(`forged ${Original.name} prototype as ${Forged.name} falls back`, () => compare(mutate(({chunk}) => {
    const owner = key === 'scoreList' ? chunk : chunk.resolvedContentReferences
    const next = Original.from(owner[key])
    Object.setPrototypeOf(next, Forged.prototype)
    owner[key] = next
}), false))
test('shared score storage is excluded', () => compare(mutate(({chunk}) => { const scores = new Int32Array(new SharedArrayBuffer(256)); scores.set(chunk.scoreList); chunk.scoreList = scores }), false))
test('resizable private score storage is excluded', () => compare(mutate(({chunk}) => { const scores = new Int32Array(new ArrayBuffer(256, {maxByteLength: 512})); scores.set(chunk.scoreList); chunk.scoreList = scores }), false))
test('own byteOffset shadow is excluded without reading it', () => compare(mutate(({chunk}) => { Object.defineProperty(chunk.scoreList, 'byteOffset', {get() { throw new Error('must not read shadow') }}) }), false))
test('own forged ArrayBuffer property is excluded', () => compare(mutate(({chunk}) => { Object.defineProperty(chunk.scoreList, 'buffer', {value: Object.create(ArrayBuffer.prototype)}) }), false))
test('own element-kind shadow is excluded', () => compare(mutate(({chunk}) => { Object.defineProperty(chunk.scoreList, Symbol.toStringTag, {value: 'Int32Array'}) }), false))
test('external cloned chunks retain generic route', () => compare(mutate((value) => { value.chunk = {...value.chunk} }), false))
test('proxied private chunk retains generic route', () => compare(mutate((value) => { value.chunk = new Proxy(value.chunk, {}) }), false))
test('accessor row count retains generic route', () => compare(mutate(({chunk}) => { Object.defineProperty(chunk, 'rowCount', {get: () => 64}) }), false))
test('accessor score list retains generic route', () => compare(mutate(({chunk}) => { const scores = chunk.scoreList; Object.defineProperty(chunk, 'scoreList', {get: () => scores}) }), false))
test('fixed content spans retain generic route', () => compare(mutate(({chunk}) => { chunk.fixedContentOffsetBase = 1000; chunk.fixedContentLength = 4 }), false))
test('float, minus-zero and wide scores remain exact', () => compare(mutate(({chunk}) => { chunk.scoreList = Float64Array.from({length: 64}, (_, i) => [1.5, -0, 2 ** 40, Infinity, NaN][i % 5]) }), false))
test('missing and null ordinary scores retain zero defaults', () => compare(mutate(({chunk}) => { chunk.scoreList = Array.from({length: 64}, (_, i) => i % 3 === 0 ? null : i % 3 === 1 ? undefined : -20) }), false))
test('legacy null content arrays remain exact', () => compare(() => ({chunk: {rowCount: 64, scoreList: new Int32Array(64)}, offsets: new Float64Array(64).fill(-1), lengths: new Array(64).fill(-1), base: 0}), false))
test('private memory cap falls back before copying', () => {
    const {helper} = compare(() => input(), false, {maximumPages: 2})
    assert.equal(helper.lastStats.inputCopiedBytes, 0)
})
test('failed module initialization retains stock output', () => compare(() => input(), false, {wasmBytes: new Uint8Array([0])}))
test('native trap/invalid return/header retain stock output', () => {
    for (const fault of ['trap', 'negative', 'too-long', 'fractional', 'header']) {
        const helper = create()
        const original = helper.native
        helper.native = (...args) => {
            if (fault === 'trap') throw new Error('controlled trap')
            if (fault === 'negative') return -99
            if (fault === 'too-long') return 2 ** 31
            if (fault === 'fractional') return 20.5
            const result = original(...args)
            new Uint32Array(helper.memory.buffer, args[11], 4)[0] = 0
            return result
        }
        const value = input()
        const before = snapshots(value)
        assert.deepEqual(helper.encode(value.chunk, value.offsets, value.lengths, value.base), stock(value.chunk, value.offsets, value.lengths, value.base))
        assert.equal(helper.lastStats.native, false)
        for (const [view, bytes] of before) assert.deepEqual(Buffer.from(view), bytes)
    }
})
test('native direct ABI rejects malformed ranges, alignment and overlap', () => {
    const helper = create()
    const value = input()
    helper.encode(value.chunk, value.offsets, value.lengths, value.base)
    const original = helper.lastArguments
    for (const [index, replacement] of [[2, 0], [4, original[4] + 4], [11, original[2]], [0, 0xffffffff], [6, NaN], [8, 3]]) {
        const args = [...original]
        args[index] = replacement
        assert(helper.native(...args) < 0)
    }
})
test('result is independent through later memory reuse and growth', () => {
    const helper = create()
    const first = input()
    const bytes = helper.encode(first.chunk, first.offsets, first.lengths, first.base)
    const saved = Buffer.from(bytes)
    assert.notEqual(bytes.buffer, helper.memory.buffer)
    const second = input(150000, (i) => i % 200)
    helper.encode(second.chunk, second.offsets, second.lengths, second.base)
    assert(helper.lastStats.memoryGrowthBytes > 0)
    new Uint8Array(helper.memory.buffer).fill(123)
    assert.deepEqual(Buffer.from(bytes), saved)
})
const report = {complete: true, timingAcquisition: false, node: process.version, sourceHashes, cases: results.length, passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass).length, results}
writeFileSync(resolve(attempt, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
if (report.failed) process.exitCode = 1
