import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.dirname(new URL(import.meta.url).pathname)
const baseline = path.join(root, 'manabitan')
const candidate = path.join(root, 'vndb-media-bookkeeping')
const archivePath = path.join(baseline, 'builds/e2e-dictionary-cache/vndb_characters_by_bee.zip')
const outputPath = path.join(root, 'vndb-bookkeeping-pack-parity.json')
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hashStream = async (stream) => {
    const hash = createHash('sha256')
    for await (const bytes of stream) { hash.update(bytes) }
    return hash.digest('hex')
}
const git = (cwd, ref) => execFileSync('git', ['rev-parse', ref], {cwd, encoding: 'utf8'}).trim()
const fixtureSha256 = await hashStream(createReadStream(archivePath))
const archive = await openAsBlob(archivePath)
const dictionaryLock = JSON.parse(await readFile(path.join(baseline, 'test/perf/dictionaries.lock.json'), 'utf8'))
const lockText = JSON.stringify(dictionaryLock)
assert(lockText.includes(fixtureSha256), 'Full source archive must match a locked SHA256')
const receipt = {
    scope: 'Node component parity for actual dense archive admission, full native CRC-checked source-media packing, index bytes, and packed Blob bytes. No browser import timing or memory claim.',
    node: process.version,
    source: {path: archivePath, bytes: archive.size, sha256: fixtureSha256},
    baseline: {head: git(baseline, 'HEAD'), tree: git(baseline, 'HEAD^{tree}')},
    candidate: {head: git(candidate, 'HEAD'), tree: git(candidate, 'HEAD^{tree}')},
    outputPath,
    runs: [],
}
let previous = null

for (const [label, checkout] of [['baseline', baseline], ['candidate', candidate]]) {
    const moduleUrl = (relative) => pathToFileURL(path.join(checkout, relative)).href
    const parser = await import(moduleUrl('ext/js/dictionary/term-bank-wasm-parser.js'))
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(checkout, 'ext/lib/term-bank-parser.wasm'))))
    const {DictionaryImporter} = await import(moduleUrl('ext/js/dictionary/dictionary-importer.js'))
    const {RawZipPayloadReader} = await import(moduleUrl('ext/js/dictionary/term-bank-source-pipeline.js'))
    const {preparePackedSourceZipMedia} = await import(moduleUrl('ext/js/dictionary/source-zip-media-pack.js'))
    const {createGenerationMediaIndex} = await import(moduleUrl('ext/js/dictionary/dictionary-generation-media-store.js'))
    const {getImageMediaTypeFromFileName} = await import(moduleUrl('ext/js/media/media-util.js'))
    const {TextWriter} = await import(moduleUrl('ext/lib/zip.js'))
    const importer = new DictionaryImporter({getImageDetails: async () => { throw new Error('Image decoding is outside this component oracle') }})
    const assign = Object.assign
    let denseGetDataTemporaryObjects = 0
    Object.assign = function (target, ...sources) {
        if (typeof target?.filename === 'string' && sources.length === 1 && Object.keys(sources[0]).length === 1 && typeof sources[0].getData === 'function') {
            denseGetDataTemporaryObjects++
        }
        return assign(target, ...sources)
    }
    let opened
    try { opened = await importer._getFilesFromArchive(archive) } finally { Object.assign = assign }
    const {fileMap, zipReader, catalog} = opened
    assert.equal(catalog, 'dense-zip')
    const fields = ['filename', 'offset', 'signature', 'compressionMethod', 'compressedSize', 'uncompressedSize', 'encrypted']
    const catalogHash = createHash('sha256')
    const requirements = []
    const mediaOffsets = []
    let termBanks = 0
    for (const entry of fileMap.values()) {
        const metadata = fields.map((field) => entry[field])
        assert.equal(typeof entry.getData, 'function')
        catalogHash.update(JSON.stringify(metadata) + '\n').update(entry.rawFilename)
        if (/^term_bank_\d+[.]json$/.test(entry.filename)) { termBanks++ }
        if (getImageMediaTypeFromFileName(entry.filename) === null) { continue }
        requirements.push({type: 'image', source: {path: entry.filename}})
        mediaOffsets.push(entry.offset)
    }
    const indexFile = fileMap.get('index.json')
    assert(indexFile)
    const indexText = await importer._getData(indexFile, new TextWriter())
    const monotonic = mediaOffsets.every((value, index) => index === 0 || value >= mediaOffsets[index - 1])
    const sort = Array.prototype.sort
    let mediaOrderSortCalls = 0
    let mediaOrderComparatorCalls = 0
    Array.prototype.sort = function (compare) {
        if (this.length === requirements.length && typeof this[0]?.offset === 'number' && typeof compare === 'function') {
            mediaOrderSortCalls++
            return sort.call(this, (a, b) => {
                mediaOrderComparatorCalls++
                return compare(a, b)
            })
        }
        return sort.call(this, compare)
    }
    let packed
    try {
        packed = await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {})
    } finally {
        Array.prototype.sort = sort
        await zipReader.close()
    }
    assert(packed, 'All selected media should be accepted by the source-media packer')
    assert.equal(packed.records.length, requirements.length)
    const recordsHash = createHash('sha256')
    for (let i = 0; i < packed.records.length; ++i) {
        const {file, ...record} = packed.records[i]
        assert.equal(record.path, requirements[i].source.path)
        assert.equal(file, fileMap.get(record.path))
        recordsHash.update(JSON.stringify(record) + '\n')
    }
    const plan = createGenerationMediaIndex(packed.records, packed.blob.size)
    assert(plan, 'Full source-media index must be admitted')
    const packedBlobSha256 = await hashStream(packed.blob.stream())
    const result = {
        label,
        catalog,
        catalogEntries: fileMap.size,
        termBanks,
        mediaEntries: requirements.length,
        physicalMediaOffsetsNondecreasing: monotonic,
        catalogSha256: catalogHash.digest('hex'),
        sourceIndexJsonSha256: hashBytes(indexText),
        denseGetDataTemporaryObjects,
        mediaOrderSortCalls,
        mediaOrderComparatorCalls,
        mediaRecordSha256: recordsHash.digest('hex'),
        packedBlobBytes: packed.blob.size,
        packedBlobSha256,
        planDescriptor: plan.descriptor,
        planIndexBytes: plan.index.byteLength,
        planIndexSha256: hashBytes(plan.index),
        metrics: Object.fromEntries(Object.entries(packed).filter(([key]) => !['blob', 'records', 'readMs', 'validationMs'].includes(key))),
    }
    if (previous !== null) {
        assert.deepEqual(
            Object.fromEntries(Object.entries(result).filter(([key]) => !['label', 'denseGetDataTemporaryObjects', 'mediaOrderSortCalls', 'mediaOrderComparatorCalls'].includes(key))),
            Object.fromEntries(Object.entries(previous.result).filter(([key]) => !['label', 'denseGetDataTemporaryObjects', 'mediaOrderSortCalls', 'mediaOrderComparatorCalls'].includes(key))),
        )
        assert.deepEqual(plan.index, previous.index)
    }
    previous = {result, index: plan.index}
    receipt.runs.push(result)
    console.log(JSON.stringify(result))
}
receipt.status = 'passed'
await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({status: receipt.status, outputPath}))
