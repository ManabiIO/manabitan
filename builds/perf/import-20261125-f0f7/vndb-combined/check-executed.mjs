import {openAsBlob, createReadStream} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = process.cwd()
const baseline = path.resolve(root, '../manabitan-base')
const moduleAt = (directory, filename) => import(pathToFileURL(path.join(directory, 'ext/js/dictionary', filename)))
const archivePath = path.join(root, 'builds/e2e-dictionary-cache/vndb_characters_by_bee.zip')
const expectedHash = 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'
const hash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) hash.update(bytes)
assert.equal(hash.digest('hex'), expectedHash)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, 291705969)
const arms = []
for (const directory of [baseline, root]) {
    const {readDenseZipDirectory} = await moduleAt(directory, 'dense-zip-directory.js')
    const catalog = await readDenseZipDirectory(archive)
    assert.notEqual(catalog, null)
    assert.equal(catalog.length, 147237)
    const catalogHash = createHash('sha256')
    for (const entry of catalog) {
        catalogHash.update(JSON.stringify([entry.filename, entry.offset, entry.compressedSize, entry.uncompressedSize, entry.compressionMethod, entry.signature, entry.encrypted, entry.directory]))
        catalogHash.update(entry.rawFilename)
    }
    const result = {directory, catalogHash: catalogHash.digest('hex'), catalog}
    arms.push(result)
}
assert.equal(arms[0].catalogHash, arms[1].catalogHash)
const keys = Object.keys(arms[0].catalog[0])
for (let i = 0; i < arms[0].catalog.length; i++) {
    for (const key of keys) assert.deepEqual(arms[1].catalog[i][key], arms[0].catalog[i][key], `${i}:${key}`)
}
for (const arm of arms) {
    const {setTermBankWasmModule} = await moduleAt(arm.directory, 'term-bank-wasm-parser.js')
    setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(arm.directory, 'ext/lib/term-bank-parser.wasm'))))
    const {preparePackedSourceZipMediaEntries} = await moduleAt(arm.directory, 'source-zip-media-pack.js')
    const {RawZipPayloadReader} = await moduleAt(arm.directory, 'term-bank-source-pipeline.js')
    const {getImageMediaTypeFromFileName} = await import(pathToFileURL(path.join(arm.directory, 'ext/js/media/media-util.js')))
    const images = arm.catalog.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null)
    const packed = await preparePackedSourceZipMediaEntries(archive, images, new RawZipPayloadReader(archive), () => {})
    assert.notEqual(packed, null)
    assert.equal(packed.records.length, 146570)
    const {createGenerationMediaIndex} = await moduleAt(arm.directory, 'dictionary-generation-media-store.js')
    const plan = createGenerationMediaIndex(packed.records, packed.blob.size)
    assert.notEqual(plan, null)
    const recordsHash = createHash('sha256')
    for (const record of packed.records) {
        const {file, ...fields} = record
        recordsHash.update(JSON.stringify(fields))
    }
    const sourceHash = createHash('sha256')
    for await (const bytes of packed.blob.stream()) sourceHash.update(bytes)
    arm.media = {
        count: packed.records.length,
        recordsHash: recordsHash.digest('hex'),
        blobBytes: packed.blob.size,
        sourceHash: sourceHash.digest('hex'),
        indexHash: createHash('sha256').update(plan.index).digest('hex'),
        indexBytes: plan.index.byteLength,
        descriptor: plan.descriptor,
        rangeReadCount: packed.rangeReadCount,
        rangeReadBytes: packed.rangeReadBytes,
        compressedBytes: packed.compressedBytes,
        uncompressedBytes: packed.uncompressedBytes,
    }
    arm.catalog = undefined
}
assert.deepEqual(arms[0].media, arms[1].media)
const result = {schemaVersion:1, runtime:process.versions, fixture:{path:archivePath, bytes:archive.size, sha256:expectedHash}, baseline, candidate:root, arms, passed:true, scope:'Complete ZIP catalog metadata and raw-name parity; complete media packing, CRC validation, byte-span and generation-index parity. Not an end-to-end import timing.'}
await writeFile(path.join(root, 'builds/perf/lazy-filename-20261125/parity.json'), JSON.stringify(result, null, 2)+'\n')
console.log(JSON.stringify(result))
