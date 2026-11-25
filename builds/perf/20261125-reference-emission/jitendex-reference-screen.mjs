import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const [root, cache, output] = process.argv.slice(2)
const baseline = '7d1643e6147a10cb2165e9744cf0e63b59e46632'
const sourcePath = 'ext/js/dictionary/term-content-block-store.js'
const hash = (v) => createHash('sha256').update(v).digest('hex')
const raw = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/raw-term-content.js')))
const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await import(pathToFileURL(path.join(root, 'node_modules/@zip.js/zip.js/index.js')))
const old = execFileSync('git', ['show', `${baseline}:${sourcePath}`], {cwd: root, encoding: 'utf8'})
const next = await fs.readFile(path.join(root, sourcePath), 'utf8')
function extract(source, name) {
    const start = source.indexOf(`function ${name}(`)
    const end = source.indexOf('\n}', start) + 2
    if (start < 0 || end < start) throw new Error(`Missing helper ${name}`)
    return source.slice(start, end)
}
function load(source, name) {
    return new Function('writeRawTermContentCompactBlockReference', 'RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES', `return (${extract(source, name)})`)(
        raw.writeRawTermContentCompactBlockReference, raw.RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES)
}
const emit = {A: load(old, 'createTermContentReferenceSlabs'), B: load(next, 'createTermContentReferenceSlabs'), C: load(old, 'createTermContentReferenceSlabs')}
const plan = load(old, 'planContentSpansIntoSlabs')
const lock = JSON.parse(await fs.readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.jitendex
const archive = await fs.readFile(path.join(cache, lock.cacheFile))
if (hash(archive) !== lock.sha256) throw new Error('Archive hash mismatch')
const wasm = await fs.readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
const data = []
let rows = 0
let unique = 0
let blocks = 0
let uncompressedBytes = 0
try {
    const entries = (await reader.getEntries()).filter((e) => /^term_bank_\d+\.json$/.test(e.filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    for (let start = 0; start < entries.length; start += 10) {
        const sources = []
        for (const entry of entries.slice(start, start + 10)) {
            sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
        }
        await parser.parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
            if (!(chunk.contentMetaList instanceof Uint32Array) || !chunk.contentDedupPlan) throw new Error('Missing native metadata')
            const count = chunk.contentDedupPlan.uniqueCount
            const lengths = Uint32Array.from({length: count}, (_, i) => chunk.contentMetaList[(chunk.contentMetaByUniqueIndex === true ? i : chunk.contentDedupPlan.uniqueRowIndexes[i]) * 4 + 1])
            const packed = plan(lengths, 1024 * 1024)
            const offsets = Array.from(packed.packedChunkLengths, (_, i) => 2 ** 32 + data.length * 200_000_000 + i * 2_000_000)
            const storedLengths = Array.from(packed.packedChunkLengths, (value) => Math.max(13, Math.floor(value / 2)))
            data.push([packed, packed.packedChunkLengths, lengths, offsets, storedLengths, Math.floor(1024 * 1024 / 20)])
            rows += chunk.rowCount
            unique += count
            blocks += packed.packedChunkLengths.length
            for (const length of lengths) uncompressedBytes += length
        }, 2048, {singleChunk: true, compactContentMetadata: true, emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true, experimentalNativeEscapedKeys: true})
    }
} finally { await reader.close() }
if (rows !== lock.termRows) throw new Error(`Incorrect row count ${rows}`)
const digest = createHash('sha256')
let outputBytes = 0
for (const args of data) {
    const a = emit.A(...args)
    const b = emit.B(...args)
    if (a.length !== b.length || a.some((v, i) => !Buffer.from(v).equals(b[i]))) throw new Error('Reference byte parity failed')
    for (const bytes of a) { digest.update(bytes); outputBytes += bytes.length }
}
const execute = (arm) => {
    let byteCount = 0
    for (const args of data) {
        for (const bytes of emit[arm](...args)) byteCount += bytes.byteLength
    }
    if (byteCount !== outputBytes) throw new Error('Incorrect output size')
}
for (let i = 0; i < 5; ++i) for (const arm of ['A', 'B', 'C']) execute(arm)
const orders = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC']
const observations = []
for (let pair = 0; pair < 12; ++pair) {
    const order = orders[pair % orders.length]
    const result = {pair, order}
    for (const arm of order) {
        globalThis.gc?.()
        const beforeCpu = process.cpuUsage()
        const before = performance.now()
        for (let repeat = 0; repeat < 5; ++repeat) execute(arm)
        const elapsed = performance.now() - before
        const cpu = process.cpuUsage(beforeCpu)
        result[arm] = {elapsedMs: elapsed / 5, cpuMs: (cpu.user + cpu.system) / 5000}
    }
    observations.push(result)
}
const result = {
    baseline, node: process.version, dictionarySha256: lock.sha256, wasmSha256: hash(wasm),
    beforeSourceSha256: hash(old), afterSourceSha256: hash(next), runnerSha256: hash(await fs.readFile(new URL(import.meta.url))),
    scope: 'Exact production reference-emission helpers on native unique lengths from all Jitendex banks grouped by 10. Excludes global content deduplication, ZIP/parser time, compression, actual OPFS, and UI. Synthetic valid 64-bit storage offsets and compressed sizes. Explicit GC before timing; five complete emissions per sample. Identical baseline C retained.',
    rows, unique, groups: data.length, blocks, uncompressedBytes, outputBytes, outputSha256: digest.digest('hex'), allReferenceBytesEqual: true,
    observations
}
await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({rows, unique, groups: data.length, blocks, uncompressedBytes, outputBytes, allReferenceBytesEqual: true, output}))
