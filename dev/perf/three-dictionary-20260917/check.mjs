import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {crc32, deflateRawSync, constants} from 'node:zlib'
const root = process.cwd()
const load = p => import(pathToFileURL(path.join(root, p)).href)
const {copyStableImportBytes} = await load('ext/js/core/import-byte-copy.js')
const {snapshotTermBankExperiments} = await load('ext/js/dictionary/term-bank-experiments.js')
let copies = 0, frames = 0, inflations = 0, rejections = 0
for (const key of ['experimentalLibdeflate', 'experimentalAlignedImportCopies']) {
    assert.equal(snapshotTermBankExperiments()[key], false)
    for (const value of [false, 0, 1, null, undefined, 'true', {}]) assert.equal(snapshotTermBankExperiments({[key]: value})[key], false)
    assert.equal(snapshotTermBankExperiments({[key]: true})[key], true)
}
for (const shared of [false, true]) for (let sourceOffset = 0; sourceOffset < 8; sourceOffset++) for (let destinationOffset = 0; destinationOffset < 8; destinationOffset++) {
    for (const length of [0, 1, 7, 8, 31, 1023, 1024, 1025, 2049, 16000]) {
        const source = new Uint8Array(shared ? new SharedArrayBuffer(sourceOffset + length) : new ArrayBuffer(sourceOffset + length), sourceOffset, length)
        for (let i = 0; i < source.length; i++) source[i] = (i * 71 + 31) & 255
        const before = source.slice()
        const actual = new Uint8Array(length + 32).fill(0xa7)
        const expected = actual.slice()
        expected.subarray(3).set(source, destinationOffset)
        copyStableImportBytes(actual.subarray(3), source, destinationOffset)
        assert.deepEqual(actual, expected)
        assert.deepEqual(source, before)
        copies++
    }
}
for (const offset of [-1, 0.5, NaN, Infinity, 100]) {
    const destination = new Uint8Array(8).fill(9)
    assert.throws(() => copyStableImportBytes(destination, new Uint8Array(2), offset), RangeError)
    assert.deepEqual(destination, new Uint8Array(8).fill(9))
}
for (let offset = 0; offset < 8; offset++) {
    const actual = Uint8Array.from({length: 2000}, (_, i) => i & 255)
    const expected = actual.slice()
    expected.set(expected.subarray(8, 1800), offset)
    copyStableImportBytes(actual, actual.subarray(8, 1800), offset)
    assert.deepEqual(actual, expected)
    const shared = new Uint8Array(new SharedArrayBuffer(2000))
    shared.set(actual)
    expected.set(actual)
    expected.set(expected.subarray(0, 1800), offset)
    copyStableImportBytes(shared, shared.subarray(0, 1800), offset)
    assert.deepEqual(shared, expected)
}
const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js')
const wasmBytes = readFileSync('ext/lib/term-bank-parser.wasm')
const module = await WebAssembly.compile(wasmBytes)
assert.deepEqual(WebAssembly.Module.imports(module), [])
parser.setTermBankWasmModule(module)
const encode = text => new TextEncoder().encode(text)
const source = (data, options = {}) => {
    const bytes = new Uint8Array(deflateRawSync(data, options))
    return {bytes, compressionMethod: 8, compressedSize: bytes.length, uncompressedSize: data.length, signature: crc32(data)}
}
const decode = async (sources, flag, spans = false) => {
    const value = await parser.inflateCompressedTermBankSourcesWasm(sources, {experimentalLibdeflate: flag, experimentalTermBankSpans: spans})
    return new Uint8Array(value.wasm.memory.buffer, value.jsonPtr, value.jsonLength).slice()
}
const modes = [{level: 0}, {level: 1}, {level: 6}, {level: 9}, {strategy: constants.Z_FIXED}, {strategy: constants.Z_HUFFMAN_ONLY}]
for (const length of [0, 1, 15, 16, 31, 1023, 1024, 4097, 32768, 131073]) for (const mode of modes) {
    const data = encode(JSON.stringify([['head', '', '', '', 0, ['x'.repeat(length)], 0, '']]))
    const compressed = source(data, mode)
    for (const spans of [false, true]) {
        const a = await decode([compressed], false, spans)
        const b = await decode([compressed], true, spans)
        assert.deepEqual(b, a)
        assert.deepEqual(JSON.parse(new TextDecoder().decode(b)), JSON.parse(new TextDecoder().decode(data)))
        inflations++
    }
    for (const corrupt of [
        {...compressed, signature: (compressed.signature ^ 1) >>> 0},
        {...compressed, uncompressedSize: data.length + 1},
        {...compressed, uncompressedSize: data.length - 1},
        {...compressed, bytes: Uint8Array.from([...compressed.bytes, 0]), compressedSize: compressed.bytes.length + 1},
        {...compressed, bytes: compressed.bytes.slice(0, -1), compressedSize: compressed.bytes.length - 1},
    ]) for (const flag of [false, true]) {
        await assert.rejects(decode([corrupt], flag))
        assert.deepEqual(await decode([compressed], flag), await decode([compressed], false))
        rejections++
    }
}
for (let iteration = 0; iteration < 100; iteration++) {
    const data = encode(JSON.stringify(['日本語', iteration, 'é', '\\', '😀']))
    const entries = [source(data), {bytes: data, compressionMethod: 0, compressedSize: data.length, uncompressedSize: data.length, signature: crc32(data)}]
    for (const spans of [false, true]) assert.deepEqual(await decode(entries, true, spans), await decode(entries, false, spans))
    inflations += 2
}
const zstd = await load('ext/lib/zstd-wasm.js')
await zstd.init(path.join(root, 'ext/lib/zstd.wasm'))
const cctx = zstd.createCCtx(), dctx = zstd.createDCtx()
try {
    for (const dictionary of [new Uint8Array(0), encode('dictionary repeated values English 日本語 prefix structured content')]) for (let alignment = 0; alignment < 8; alignment++) {
        for (const length of [1023, 1024, 1025, 16000]) {
            const sourceBytes = new Uint8Array(new SharedArrayBuffer(40000 + alignment), alignment)
            for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = ((i * 71) ^ (i >>> 4)) & 255
            const offsets = new Uint32Array([3, 3 + length, 33000, 5])
            const lengths = new Uint32Array([length, 7, 1000, 32])
            const total = lengths.reduce((a, b) => a + b, 0)
            const owned = new Uint8Array(total)
            let position = 0
            for (let i = 0; i < offsets.length; i++) { owned.set(sourceBytes.subarray(offsets[i], offsets[i] + lengths[i]), position); position += lengths[i] }
            const a = zstd.finishPreparedSpanCompression(zstd.prepareSpanCompression(cctx, sourceBytes, offsets, lengths, total, dictionary, 12, -1, true, false))
            const prepared = zstd.prepareSpanCompression(cctx, sourceBytes, offsets, lengths, total, dictionary, 12, -1, true, true)
            sourceBytes.fill(0)
            const b = zstd.finishPreparedSpanCompression(prepared)
            assert.deepEqual(b, a)
            assert.deepEqual(zstd.decompressUsingDict(dctx, b.subarray(12), dictionary), owned)
            frames++
        }
    }
} finally { zstd.freeCCtx(cctx); zstd.freeDCtx(dctx) }
const receipt = {status: 'success', copies, frames, inflations, rejections, note: 'Actual WASM miniz/libdeflate and actual Zstd frames; no monkey patches. Source copy tested before release and decompressed after source overwrite.'}
writeFileSync(process.env.THREE_CHECK_OUTPUT ?? 'builds/three-check.json', JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
