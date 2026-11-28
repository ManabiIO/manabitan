#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {crc32, inflateRawSync} from 'node:zlib'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'
import {readDenseZipDirectory} from '../../../ext/js/dictionary/dense-zip-directory.js'
import {RawZipPayloadReader} from '../../../ext/js/dictionary/term-bank-source-pipeline.js'
import * as parser from '../../../ext/js/dictionary/term-bank-wasm-parser.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'baseline-js': {type: 'string'},
        'baseline-wasm': {type: 'string'},
        'candidate-js': {type: 'string'},
        'candidate-wasm': {type: 'string'},
        'parser-wasm': {type: 'string', default: path.join(root, 'ext/lib/term-bank-parser.wasm')},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'pairs': {type: 'string', default: '8'},
        'out': {type: 'string'},
        'fuzz-only': {type: 'boolean', default: false},
    }})
for (const key of ['baseline-js', 'baseline-wasm', 'candidate-js', 'candidate-wasm', 'out']) {
    assert(values[key], `Provide --${key}`)
}
const pairs = Number(values.pairs)
assert(Number.isSafeInteger(pairs) && pairs > 0 && pairs <= 30)
const output = path.resolve(values.out)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (filename) => {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filename)) { hash.update(chunk) }
    return hash.digest('hex')
}
const dictionary = await readFile(path.join(root, 'dev/data/zstd-dicts/jmdict.zdict'))
const maxBlockBytes = 4 * 1024 * 1024
const arms = {}
for (const name of ['baseline', 'candidate']) {
    const js = path.resolve(values[`${name}-js`])
    const wasm = await readFile(path.resolve(values[`${name}-wasm`]))
    // Explicit CLI tool paths; no path comes from dictionary content.
    // eslint-disable-next-line no-unsanitized/method
    const {default: createModule} = await import(pathToFileURL(js))
    const module = await createModule({wasmBinary: wasm})
    const capacity = module._ZSTD_compressBound(maxBlockBytes)
    const source = module._malloc(maxBlockBytes + 64)
    const destination = module._malloc(capacity + 12 + 32)
    const decoded = module._malloc(maxBlockBytes)
    const dict = module._malloc(dictionary.byteLength)
    assert(source && destination && decoded && dict)
    module.HEAPU8.set(dictionary, dict)
    const context = module._ZSTD_createCCtx()
    const decoder = module._ZSTD_createDCtx()
    assert(context && decoder)
    arms[name] = {module,
        source,
        destination,
        capacity,
        decoded,
        dict,
        context,
        decoder,
        identity: {js, jsSha256: await hashFile(js), wasmSha256: sha256(wasm), wasmBytes: wasm.byteLength}}
}
const check = (arm, value) => {
    assert.equal(arm.module._ZSTD_isError(value), 0, `Zstd failure: ${value}`)
    return value
}
function compress(arm, length, selected, level, offset = 0) {
    return check(arm, arm.module._ZSTD_compress_usingDict(
        arm.context,
        arm.destination + 12,
        arm.capacity,
        arm.source + offset,
        length,
selected ? arm.dict : 0,
selected ? dictionary.byteLength : 0,
level,
    ))
}
function validate(bytes, selected, level, offset = 0) {
    const encoded = []
    for (const arm of Object.values(arms)) {
        arm.module.HEAPU8.set(bytes, arm.source + offset)
        const length = compress(arm, bytes.byteLength, selected, level, offset)
        assert.equal(arm.module._manabitan_write_block_envelope(arm.destination, 12 + length), 1)
        const frame = arm.module.HEAPU8.slice(arm.destination, arm.destination + 12 + length)
        encoded.push(frame)
        const decoded = check(arm, arm.module._ZSTD_decompress_usingDict(
            arm.decoder,
            arm.decoded,
            maxBlockBytes,
            arm.destination + 12,
            length,
selected ? arm.dict : 0,
selected ? dictionary.byteLength : 0,
        ))
        assert.equal(decoded, bytes.byteLength)
        assert.deepEqual(arm.module.HEAPU8.subarray(arm.decoded, arm.decoded + decoded), new Uint8Array(bytes))
    }
    assert.deepEqual(encoded[1], encoded[0], 'Compressed frame or integrity envelope differs')
    return encoded[0]
}


function validateCapacity(bytes, selected, level, capacity, offset) {
    const results = []
    const guard = new Uint8Array(32).fill(0x9d)
    for (const arm of Object.values(arms)) {
        arm.module.HEAPU8.set(bytes, arm.source + offset)
        const end = arm.destination + 12 + capacity
        arm.module.HEAPU8.set(guard, end)
        const result = arm.module._ZSTD_compress_usingDict(
            arm.context,
            arm.destination + 12,
            capacity,
            arm.source + offset,
            bytes.byteLength,
            selected ? arm.dict : 0,
            selected ? dictionary.byteLength : 0,
            level,
        )
        assert.deepEqual(arm.module.HEAPU8.subarray(end, end + guard.length), guard, 'Compression wrote past destination capacity')
        const error = arm.module._ZSTD_isError(result)
        results.push({result, error, bytes: error ? null : arm.module.HEAPU8.slice(arm.destination + 12, arm.destination + 12 + result)})
    }
    assert.deepEqual(results[1], results[0], 'Bounded compression result differs')
}

let random = 0x8731a4f9
function nextRandom() {
    random ^= random << 13
    random ^= random >>> 17
    random ^= random << 5
    return random >>> 0
}
let fuzzCases = 0
let fuzzCapacityCases = 0
const boundaries = [0,
    1,
    2,
    3,
    4,
    7,
    8,
    9,
    15,
    16,
    17,
    31,
    32,
    33,
    63,
    64,
    65,
    127,
    128,
    129,
    255,
    256,
    257,
    1023,
    1024,
    1025,
    4095,
    4096,
    4097,
    16383,
    16384,
    16385,
    65535,
    65536,
    65537,
    131071,
    131072,
    131073]
for (let index = 0; index < 768; ++index) {
    const length = index < boundaries.length ? boundaries[index] : nextRandom() % 8193
    const bytes = new Uint8Array(length)
    const period = 1 + nextRandom() % 97
    for (let i = 0; i < bytes.length; ++i) {
        const family = index % 4
        switch (family) {
            case 0: { bytes[i] = nextRandom() & 255
                break
            }
            case 1: { bytes[i] = i % period
                break
            }
            case 2: { bytes[i] = 97
                break
            }
            default: { bytes[i] = (i % 7 === 0 ? nextRandom() : i) & 255 }
        }
    }
    // Differing bytes near match/word/block tails exercise short remainders.
    if (length) { bytes[Math.max(0, length - 1 - index % 17)] ^= 0x5a }
    for (const selected of [false, true]) {
        for (const level of [-1, 1]) {
            const encoded = validate(bytes, selected, level, index & 15)
            ++fuzzCases
            if (index < boundaries.length) {
                const frameBytes = encoded.byteLength - 12
                for (const capacity of new Set([0, 1, 3, 4, 7, 8, 15, 16, Math.max(0, frameBytes - 1), frameBytes, frameBytes + 1])) {
                    validateCapacity(bytes, selected, level, capacity, index & 15)
                    ++fuzzCapacityCases
                }
            }
        }
    }
}
const lock = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
const fixtures = JSON.parse(lock).dictionaries
const report = {
    scope: 'Warm codec component comparison, not complete-import or browser memory qualification. Actual canonical rows, within-group duplicate offsets omitted, record-aligned 4 MiB blocks. Global deduplication and browser scheduling are not modeled. Input copies, parsing, verification and decompression are outside compression timing.',
    node: process.version,
    execArgv: process.execArgv,
    runnerSha256: await hashFile(fileURLToPath(import.meta.url)),
    pairs,
    source: {lockSha256: sha256(lock), dictionarySha256: sha256(dictionary), parserWasmSha256: await hashFile(values['parser-wasm'])},
    arms: Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, arm.identity])),
    fuzzCases,
    fuzzCapacityCases,
    results: [],
}
async function checkpoint() {
    await mkdir(path.dirname(output), {recursive: true})
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
await checkpoint()
if (!values['fuzz-only']) {
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(values['parser-wasm'])))
    for (const id of positionals.length > 0 ? positionals : ['jmdict', 'jitendex', 'vndb']) {
        const spec = fixtures[id]
        assert(spec, `Unknown dictionary: ${id}`)
        const archivePath = path.join(values['cache-dir'], spec.cacheFile)
        assert.equal(await hashFile(archivePath), spec.sha256)
        const archive = await openAsBlob(archivePath)
        const dense = await readDenseZipDirectory(archive)
        const zip = dense === null ? new ZipReader(new BlobReader(archive), {useWebWorkers: false}) : null
        const payloads = dense === null ? null : new RawZipPayloadReader(archive)
        const signal = new AbortController().signal
        const entries = (dense ?? await zip.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const read = async (entry) => {
            if (payloads === null) { return await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}) }
            const compressed = await payloads.read(entry, signal)
            const bytes = entry.compressionMethod === 8 ? inflateRawSync(compressed) : compressed
            assert.equal(bytes.byteLength, entry.uncompressedSize)
            assert.equal(crc32(bytes), entry.signature)
            return bytes
        }
        const groupSize = {jmdict: 7, jitendex: 10, vndb: 4}[id]
        assert(groupSize)
        const result = {dictionary: id,
            archiveSha256: spec.sha256,
            rows: 0,
            inputBytes: 0,
            compressedBytes: 0,
            blocks: [],
            pairedTotals: Array.from({length: pairs}, () => ({baseline: 0, candidate: 0, baselineCpuMs: 0, candidateCpuMs: 0}))}
        const inputDigest = createHash('sha256')
        const outputDigest = createHash('sha256')
        for (let start = 0; start < entries.length; start += groupSize) {
            const banks = []
            for (const entry of entries.slice(start, start + groupSize)) { banks.push(await read(entry)) }
            const blocks = []
            await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
                result.rows += chunk.rowCount
                const {contentMetaList: meta, contentBytesBuffer: bytes, contentBytesBaseOffset: base} = chunk
                assert(meta && bytes && typeof base === 'number')
                const seen = new Set()
                let spans = []
                let size = 0
                for (let row = 0; row < chunk.rowCount; ++row) {
                    const offset = meta[row * 4]
                    const length = meta[row * 4 + 1]
                    if (seen.has(offset)) { continue }
                    seen.add(offset)
                    assert(length <= maxBlockBytes)
                    if (size + length > maxBlockBytes && spans.length > 0) {
                        blocks.push(Buffer.concat(spans))
                        spans = []
                        size = 0
                    }
                    spans.push(Buffer.from(bytes.subarray(base + offset, base + offset + length)))
                    size += length
                }
                if (spans.length > 0) { blocks.push(Buffer.concat(spans)) }
            }, 2048, {singleChunk: true,
                emitTermByteLists: false,
                computeContentHashes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan: true,
                validateGlossaryTypes: true})
            for (const bytes of blocks) {
                const selected = id !== 'vndb'
                const level = selected ? -1 : 1
                const encoded = validate(bytes, selected, level)
                inputDigest.update(bytes)
                outputDigest.update(encoded)
                result.inputBytes += bytes.byteLength
                result.compressedBytes += encoded.byteLength
                const block = {inputBytes: bytes.byteLength, compressedBytes: encoded.byteLength, inputSha256: sha256(bytes), baseline: [], candidate: [], baselineCpuMs: [], candidateCpuMs: []}
                for (let warmup = 0; warmup < 2; ++warmup) {
                    for (const arm of Object.values(arms)) { compress(arm, bytes.byteLength, selected, level) }
                }
                for (let pair = 0; pair < pairs; ++pair) {
                    const order = (pair + result.blocks.length) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
                    for (const name of order) {
                        const cpuBefore = process.cpuUsage()
                        const before = performance.now()
                        const length = compress(arms[name], bytes.byteLength, selected, level)
                        const elapsed = performance.now() - before
                        const cpu = process.cpuUsage(cpuBefore)
                        const cpuMs = (cpu.user + cpu.system) / 1000
                        assert.equal(length + 12, encoded.byteLength)
                        block[name].push(elapsed)
                        block[`${name}CpuMs`].push(cpuMs)
                        result.pairedTotals[pair][name] += elapsed
                        result.pairedTotals[pair][`${name}CpuMs`] += cpuMs
                    }
                }
                result.blocks.push(block)
            }
        }
        if (zip !== null) { await zip.close() }
        assert.equal(result.rows, spec.termRows)
        result.inputSha256 = inputDigest.digest('hex')
        result.outputSha256 = outputDigest.digest('hex')
        result.maxWasmHeapBytes = Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, arm.module.HEAPU8.byteLength]))
        report.results.push(result)
        await checkpoint()
        console.log(JSON.stringify({dictionary: id,
            rows: result.rows,
            blocks: result.blocks.length,
            inputBytes: result.inputBytes,
            compressedBytes: result.compressedBytes,
            pairedTotals: result.pairedTotals}))
    }
}
for (const arm of Object.values(arms)) {
    check(arm, arm.module._ZSTD_freeCCtx(arm.context))
    check(arm, arm.module._ZSTD_freeDCtx(arm.decoder))
    for (const pointer of [arm.source, arm.destination, arm.decoded, arm.dict]) { arm.module._free(pointer) }
}
await checkpoint()
console.log(JSON.stringify({output, fuzzCases, fuzzCapacityCases, dictionaries: report.results.length}))
