import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

const [root, mode = 'normal'] = process.argv.slice(2)
const moduleUrl = (name) => pathToFileURL(`${root}/ext/js/dictionary/${name}`)
const {readDenseZipDirectory} = await import(moduleUrl('dense-zip-directory.js'))
const {RawZipPayloadReader, RAW_ZIP_BATCH_MAX_FILES, RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES} = await import(moduleUrl('term-bank-source-pipeline.js'))
const {preparePackedSourceZipMedia} = await import(moduleUrl('source-zip-media-pack.js'))
const {createGenerationMediaIndex} = await import(moduleUrl('dictionary-generation-media-store.js'))
const {initializeTermBankWasmParser} = await import(moduleUrl('term-bank-wasm-parser.js'))
const {getImageMediaTypeFromFileName} = await import(pathToFileURL(`${root}/ext/js/media/media-util.js`))
const nativeFetch = globalThis.fetch
globalThis.fetch = async (resource, options) => {
    const url = resource instanceof URL ? resource : new URL(String(resource))
    if (url.protocol !== 'file:') return await nativeFetch(resource, options)
    const filename = url.pathname.split('/').at(-1)
    return new Response(await readFile(`/workspace/scratch/71149a79699f/manabitan/ext/lib/${filename}`), {headers: {'content-type': 'application/wasm'}})
}

const archive = await openAsBlob('/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip')
const entries = await readDenseZipDirectory(archive)
if (entries === null) throw new Error('Dense ZIP fixture rejected')
const fileMap = new Map()
const requirements = []
for (const file of entries) {
    if (getImageMediaTypeFromFileName(file.filename) === null) continue
    fileMap.set(file.filename, file)
    requirements.push({type: 'image', source: {path: file.filename}})
}
await initializeTermBankWasmParser()
if (mode === 'crc-error') {
    const file = fileMap.get(requirements[Math.floor(requirements.length / 2)].source.path)
    file.signature = (file.signature ^ 1) >>> 0
}
const startedAt = performance.now()
let packed
try {
    packed = await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {})
} catch (error) {
    if (mode !== 'crc-error') throw error
    console.log(JSON.stringify({root, mode, elapsedMs: performance.now() - startedAt, maxFiles: RAW_ZIP_BATCH_MAX_FILES, errorName: error.name, error: error.message}))
    process.exit(0)
}
const elapsedMs = performance.now() - startedAt
if (packed === null || mode !== 'normal') throw new Error('Unexpected media preparation result')
const indexStart = performance.now()
const plan = createGenerationMediaIndex(packed.records, packed.blob.size)
const indexMs = performance.now() - indexStart
if (plan === null) throw new Error('Generation media index rejected')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const recordsSha256 = hash(JSON.stringify(packed.records.map(({path, packedOffset, packedLength, compressionMethod, uncompressedLength, signature}) => ({path, packedOffset, packedLength, compressionMethod, uncompressedLength, signature}))))
const blobSha256 = hash(Buffer.from(await packed.blob.arrayBuffer()))
console.log(JSON.stringify({
    root, mode, elapsedMs, indexMs,
    maxFiles: RAW_ZIP_BATCH_MAX_FILES,
    maxPayloadBytes: RAW_ZIP_BATCH_MAX_PAYLOAD_BYTES,
    records: packed.records.length,
    readMs: packed.readMs,
    validationMs: packed.validationMs,
    rangeReadCount: packed.rangeReadCount,
    rangeReadBytes: packed.rangeReadBytes,
    compressedBytes: packed.compressedBytes,
    uncompressedBytes: packed.uncompressedBytes,
    blobBytes: packed.blob.size,
    descriptor: plan.descriptor,
    indexSha256: hash(plan.index), recordsSha256, blobSha256,
}))
