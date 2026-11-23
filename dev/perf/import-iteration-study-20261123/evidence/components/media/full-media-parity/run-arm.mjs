import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {openAsBlob} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {deserialize} from 'node:v8'
import {pathToFileURL} from 'node:url'

const [root, expectedType, fixturePath, capturePath, wasmPath] = process.argv.slice(2)
assert.ok(['structured-content-image', 'image-reference'].includes(expectedType))
const hash = (data) => createHash('sha256').update(data).digest('hex')
const expected = {
    'structured-content-image': {
        'ext/js/dictionary/dictionary-importer.js': 'eccfbaebb28478dbfee87fb472a6169cfc3275d1c91e1f8611ec3160b0de3488',
        'ext/js/dictionary/source-zip-media-pack.js': '33bbd6315276a8b264da36ef3442eb4bda174da3be3f89c14d48fa2cb9cefb0d',
        'types/ext/dictionary-importer.d.ts': '255594d42f07afedd204e55fa24bef468d80f98b20285518a772387d5c9b2f0c',
    },
    'image-reference': {
        'ext/js/dictionary/dictionary-importer.js': '734f8c162846258451451acff2fcd87f3981b4f6a5bde94322437e7d2b8c7edc',
        'ext/js/dictionary/source-zip-media-pack.js': '8e9f213cb2c9d616b1f276cacc7fe097a1134b5d7623c32f588f571d125adbef',
        'types/ext/dictionary-importer.d.ts': '41acb104ab0a7f80a6eb4c931e73e6e3c95bf2646c1e3b6c0bdd330d366e9714',
    },
}
const sourceHashes = {}
for (const path of [
    ...Object.keys(expected[expectedType]),
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
]) {
    sourceHashes[path] = hash(await readFile(`${root}/${path}`))
    if (path in expected[expectedType]) assert.equal(sourceHashes[path], expected[expectedType][path])
}

let captureBytes = await readFile(capturePath)
const captureSha256 = hash(captureBytes)
assert.equal(captureSha256, '9344108f0b5728772d15ce5fc7b4e1872e7324b9a689d174785f7fc2218a4ee1')
const {banks, chunks} = deserialize(captureBytes)
captureBytes = null
// Restore the owned key geometry recorded at the production worker boundary.
for (const chunk of chunks) {
    for (const {row} of chunk.mediaRows) {
        for (const key of ['expressionBytes', 'readingBytes']) {
            if (row[key] instanceof Uint8Array) row[key] = Uint8Array.from(row[key])
        }
    }
}
const capturedMediaRows = chunks.reduce((sum, chunk) => sum + chunk.mediaRows.length, 0)
const byFirstSource = new Map(chunks.map((chunk) => [chunk.firstSource, chunk]))
class ReplayWorker extends EventTarget {
    postMessage(data) {
        if (data.type === 'initialize') {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {type: 'ready'}})))
        } else if (data.type === 'parse') {
            const chunk = byFirstSource.get(data.sourceMetadata[0].filename)
            assert.ok(chunk, 'Unexpected replay source group')
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {
                type: 'result', id: data.id, rowCount: chunk.rowCount,
                resultSentEpochMs: Date.now(), borrowsWorkerMemory: false, ownsContentBytes: false,
                chunk, profile: {rowCount: chunk.rowCount},
            }})))
        }
    }
    terminate() {}
}
globalThis.Worker = ReplayWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})
const moduleUrl = (name) => pathToFileURL(`${root}/ext/js/dictionary/${name}`)
const {DictionaryImporter} = await import(moduleUrl('dictionary-importer.js'))
const parser = await import(moduleUrl('term-bank-wasm-parser.js'))
const {readDenseZipDirectory} = await import(moduleUrl('dense-zip-directory.js'))
const {RawZipPayloadReader, RAW_ZIP_BATCH_MAX_FILES, RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES} = await import(moduleUrl('term-bank-source-pipeline.js'))
const {preparePackedSourceZipMedia} = await import(moduleUrl('source-zip-media-pack.js'))
const {createGenerationMediaIndex, computeGenerationMediaCrc} = await import(moduleUrl('dictionary-generation-media-store.js'))
const {getImageMediaTypeFromFileName} = await import(pathToFileURL(`${root}/ext/js/media/media-util.js`))
assert.equal(RAW_ZIP_BATCH_MAX_FILES, 1024)
assert.equal(RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES, 4 * 1024 * 1024)
const wasmBytes = await readFile(wasmPath)
const wasmSha256 = hash(wasmBytes)
assert.equal(wasmSha256, 'cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f')
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
await parser.initializeTermBankWasmParser()
const importer = new DictionaryImporter({getImageDetails: async () => { throw new Error('Unexpected image decoding') }})
importer._skipImageMetadata = true
const source = {
    compressed: true,
    estimatedByteLengths: banks.map(({uncompressedSize}) => uncompressedSize),
    loaders: banks.map((file) => async () => ({...file, compressedSize: 0, bytes: new Uint8Array(0)})),
}
const requirements = []
const seen = new Set()
let totalRequirements = 0
await importer._readTermBankFileFast(banks[0], 3, 'VNDB Characters by Bee', false, true, true, 'raw-bytes', (_columns, incoming) => {
    for (const requirement of incoming) {
        ++totalRequirements
        assert.equal(requirement.type, expectedType)
        importer._assignRequirementNoMetadata(requirement)
        if (seen.has(requirement.source.path)) continue
        seen.add(requirement.source.path)
        requirements.push(importer._createDeferredMediaRequirement(requirement))
    }
}, source)
await parser.disposeParallelTermBankParser()
byFirstSource.clear()
chunks.length = 0
assert.equal(requirements.length, 146570)
const pathsSha256 = hash(JSON.stringify(requirements.map(({source: {path}}) => path)))

const archive = await openAsBlob(fixturePath)
assert.equal(archive.size, 291705969)
const fixtureHasher = createHash('sha256')
for await (const chunk of archive.stream()) fixtureHasher.update(chunk)
const fixtureSha256 = fixtureHasher.digest('hex')
assert.equal(fixtureSha256, 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792')
const entries = await readDenseZipDirectory(archive)
assert.notEqual(entries, null)
const fileMap = new Map(entries.map((file) => [file.filename, file]))
const imagePaths = entries.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null).map(({filename}) => filename)
assert.equal(imagePaths.length, requirements.length)
assert.ok(imagePaths.every((path) => seen.has(path)), 'Captured requirements must cover every real image')

const packed = await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {})
assert.notEqual(packed, null, 'Production source packing must admit the real requirement type')
assert.equal(packed.records.length, requirements.length)
assert.deepEqual(packed.records.map(({path}) => path), requirements.map(({source: {path}}) => path))
const plan = createGenerationMediaIndex(packed.records, packed.blob.size)
assert.notEqual(plan, null)
const records = packed.records.map(({path, mediaType, packedOffset, packedLength, compressionMethod, uncompressedLength, signature}) => ({
    path, mediaType, packedOffset, packedLength, compressionMethod, uncompressedLength, signature,
}))
const blobBytes = new Uint8Array(await packed.blob.arrayBuffer())
const blobSha256 = hash(blobBytes)
const imagePayloadHasher = createHash('sha256')
const byId = new Map()
const methods = {}
for (const record of records) {
    const {path, packedOffset, packedLength, compressionMethod} = record
    imagePayloadHasher.update(JSON.stringify([path, hash(blobBytes.subarray(packedOffset, packedOffset + packedLength))]) + '\n')
    const id = Number(path.slice(plan.descriptor.prefix.length, -plan.descriptor.suffix.length))
    assert.ok(!byId.has(id))
    byId.set(id, record)
    methods[compressionMethod] = (methods[compressionMethod] ?? 0) + 1
}
// Check every occupied entry and every hole, not only the index digest.
const indexView = new DataView(plan.index.buffer, plan.index.byteOffset, plan.index.byteLength)
let occupied = 0
let holes = 0
for (let slot = 0; slot < plan.descriptor.slotCount; ++slot) {
    const row = slot * 24
    const id = plan.descriptor.firstId + slot
    assert.equal(indexView.getUint32(row + 16, true), id)
    assert.equal(indexView.getUint32(row + 20, true), computeGenerationMediaCrc(plan.index, row, row + 20))
    const record = byId.get(id)
    if (record) {
        ++occupied
        assert.equal(indexView.getUint32(row, true), record.packedOffset + 1)
        assert.equal(indexView.getUint32(row + 4, true), (record.packedLength | (record.compressionMethod === 8 ? 0x80000000 : 0)) >>> 0)
        assert.equal(indexView.getUint32(row + 8, true), record.uncompressedLength)
        assert.equal(indexView.getUint32(row + 12, true), record.signature)
    } else {
        ++holes
        assert.equal(indexView.getUint32(row, true), 0)
        assert.equal(indexView.getUint32(row + 4, true), 0)
        assert.equal(indexView.getUint32(row + 8, true), 0)
        assert.equal(indexView.getUint32(row + 12, true), 0)
    }
}
assert.equal(occupied, requirements.length)

const missingErrors = []
for (const index of [0, Math.floor(requirements.length / 2), requirements.length - 1]) {
    const requirement = requirements[index]
    const path = requirement.source.path
    const file = fileMap.get(path)
    assert.ok(fileMap.delete(path))
    try {
        assert.equal(await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {}), null)
        let missingError = null
        try {
            await importer._getImageMedia({fileMap, media: new Map()}, path, requirement)
        } catch (error) {
            missingError = {path, errorName: error.name, error: error.message}
        }
        assert.ok(missingError)
        assert.match(missingError.error, /^Could not find image at path /)
        missingErrors.push(missingError)
    } finally {
        fileMap.set(path, file)
    }
}

// Flip an actual packed image byte while preserving all ZIP metadata. The
// production native validator must reject the changed payload before publish.
const corruptRecord = [...packed.records].sort((a, b) => a.offset - b.offset)[Math.floor(packed.records.length / 2)]
const rangeStart = packed.records.reduce((start, {offset}) => Math.min(start, offset), Infinity)
const corruptOffset = rangeStart + corruptRecord.packedOffset + Math.floor(corruptRecord.packedLength / 2)
const originalByte = new Uint8Array(await archive.slice(corruptOffset, corruptOffset + 1).arrayBuffer())[0]
const corruptedArchive = new Blob([archive.slice(0, corruptOffset), new Uint8Array([originalByte ^ 1]), archive.slice(corruptOffset + 1)])
assert.equal(corruptedArchive.size, archive.size)
let corruptError = null
try {
    await preparePackedSourceZipMedia(corruptedArchive, requirements, fileMap, new RawZipPayloadReader(corruptedArchive), () => {})
} catch (error) {
    corruptError = {path: corruptRecord.path, offset: corruptOffset, errorName: error.name, error: error.message}
}
assert.ok(corruptError, 'A corrupted real image payload must fail validation')
assert.equal(corruptError.errorName, 'DictionarySourceIntegrityError')

console.log(JSON.stringify({
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    node: process.version, expectedType, sourceHashes,
    fixture: {path: fixturePath, bytes: archive.size, sha256: fixtureSha256},
    capture: {path: capturePath, sha256: captureSha256, mediaRows: capturedMediaRows},
    wasm: {path: wasmPath, sha256: wasmSha256},
    caps: {maxFiles: RAW_ZIP_BATCH_MAX_FILES, maxPayloadBytes: RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES},
    totalRequirements, uniqueRequirements: requirements.length, allArchiveImagesCovered: true,
    pathsSha256, recordsSha256: hash(JSON.stringify(records)), blobSha256,
    perImagePackedPayloadsSha256: imagePayloadHasher.digest('hex'),
    records: packed.records.length, compressedBytes: packed.compressedBytes,
    uncompressedBytes: packed.uncompressedBytes, blobBytes: packed.blob.size,
    rangeReadCount: packed.rangeReadCount, rangeReadBytes: packed.rangeReadBytes,
    compressionMethods: methods,
    descriptor: plan.descriptor, indexSha256: hash(plan.index),
    checkedIndexSlots: plan.descriptor.slotCount, checkedOccupiedIndexEntries: occupied, checkedIndexHoles: holes,
    missingErrors, corruptError,
    scope: 'One full-corpus correctness comparison. Actual importer requirements from captured native projection, actual source ZIP pack/validator and generation index. Complete packed Blob and per-image payload hashes, every index entry/hole, three missing-image fallbacks and one corrupted real image payload. No timing claim and no database publication.'
}))
