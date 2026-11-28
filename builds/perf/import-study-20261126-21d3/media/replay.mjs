import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const [root, archivePath, mode, outputPath, measurement = 'parity'] = process.argv.slice(2)
assert(root && archivePath && outputPath && ['baseline', 'candidate'].includes(mode))
assert(['parity', 'allocation', 'timing'].includes(measurement))
const fromRoot = (relative) => pathToFileURL(path.join(root, relative)).href
const {readDenseZipDirectory} = await import(fromRoot('ext/js/dictionary/dense-zip-directory.js'))
const {getImageMediaTypeFromFileName} = await import(fromRoot('ext/js/media/media-util.js'))
const mediaPack = await import(fromRoot('ext/js/dictionary/source-zip-media-pack.js'))
const {createGenerationMediaIndex} = await import(fromRoot('ext/js/dictionary/dictionary-generation-media-store.js'))
const {RawZipPayloadReader} = await import(fromRoot('ext/js/dictionary/term-bank-source-pipeline.js'))
const {setTermBankWasmModule} = await import(fromRoot('ext/js/dictionary/term-bank-wasm-parser.js'))
const wasmBytes = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
const source = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim()
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, 291705969)
const entries = await readDenseZipDirectory(archive)
assert(entries !== null)
assert.equal(entries.length, 147237)
const files = entries.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null)
assert.equal(files.length, 146570)
const rangeStart = Math.min(...files.slice(0, 1).map(({offset}) => offset))
assert(files.every((file) => file.offset >= rangeStart))
const reader = new RawZipPayloadReader(archive)
let allocation = null
const allocationBoundaryReached = new Error('Requested allocation boundary reached')
if (measurement === 'allocation') {
    assert.equal(typeof globalThis.gc, 'function')
    globalThis.gc()
    globalThis.gc()
    const before = process.memoryUsage()
    reader.readBatch = async () => {
        globalThis.gc()
        globalThis.gc()
        const retained = process.memoryUsage()
        allocation = {
            boundary: 'Before the first media payload read, with catalog, admission and index staging live',
            before,
            retained,
            heapPlusExternalDelta: retained.heapUsed + retained.external - before.heapUsed - before.external,
            heapDelta: retained.heapUsed - before.heapUsed,
            externalDelta: retained.external - before.external,
            arrayBuffersDelta: retained.arrayBuffers - before.arrayBuffers,
        }
        throw allocationBoundaryReached
    }
}
const startedAt = performance.now()
let packed
try {
    packed = mode === 'baseline' ?
        await mediaPack.preparePackedSourceZipMediaEntries(archive, files, reader, () => {}) :
        await mediaPack.preparePackedSourceZipMediaIndex(archive, files, reader, () => {})
} catch (error) {
    if (error !== allocationBoundaryReached) { throw error }
    const result = {
        mode, measurement, source, tree, node: process.version,
        wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
        archiveBytes: archive.size, directoryEntries: entries.length, imageEntries: files.length,
        payloadReadsStarted: 0, allocation,
    }
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify(result))
    process.exit(0)
}
assert(packed !== null)
const plan = mode === 'baseline' ? createGenerationMediaIndex(packed.records, packed.blob.size) : packed.plan
assert(plan !== null)
const prepareMs = performance.now() - startedAt
assert.equal(plan.descriptor.count, files.length)
assert.equal(plan.index.byteLength, 3912816)
assert.equal(packed.blob.size, 195649882)
assert.equal(packed.rangeReadCount, 144)
assert.equal(packed.rangeReadBytes, 195649882)
assert.equal(packed.uncompressedBytes, 188131284)
const indexSha256 = createHash('sha256').update(plan.index).digest('hex')
async function hashBlob(blob) {
    const hash = createHash('sha256')
    for await (const bytes of blob.stream()) { hash.update(bytes) }
    return hash.digest('hex')
}
let payloadSha256 = null
if (measurement === 'parity') {
    payloadSha256 = await hashBlob(packed.blob)
    assert.equal(payloadSha256, await hashBlob(archive.slice(rangeStart, rangeStart + packed.blob.size)))
    await writeFile(outputPath + '.index.bin', plan.index, {flag: 'wx'})
}
const result = {
    mode, measurement, source, tree, node: process.version,
    wasmSha256: createHash('sha256').update(wasmBytes).digest('hex'),
    archiveBytes: archive.size, directoryEntries: entries.length, imageEntries: files.length,
    retainedRecords: 'records' in packed ? packed.records.length : 0,
    descriptor: plan.descriptor,
    indexSha256, payloadSha256, rangeStart, prepareMs,
    rangeReadCount: packed.rangeReadCount, rangeReadBytes: packed.rangeReadBytes,
    compressedBytes: packed.compressedBytes, uncompressedBytes: packed.uncompressedBytes,
    allocation,
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify(result))
