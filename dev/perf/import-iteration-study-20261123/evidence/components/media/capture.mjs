import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {serialize} from 'node:v8'
import {Worker as ThreadWorker} from 'node:worker_threads'
import {pathToFileURL} from 'node:url'

const root = '/workspace/scratch/71149a79699f/manabitan'
const directory = new URL('./', import.meta.url)
const {DictionaryImporter} = await import(pathToFileURL(`${root}/ext/js/dictionary/dictionary-importer.js`))
const parser = await import(pathToFileURL(`${root}/ext/js/dictionary/term-bank-wasm-parser.js`))
const {readDenseZipDirectory} = await import(pathToFileURL(`${root}/ext/js/dictionary/dense-zip-directory.js`))
const {RawZipPayloadReader} = await import(pathToFileURL(`${root}/ext/js/dictionary/term-bank-source-pipeline.js`))
const terminations = []
const byFlagColumn = new Map()
const chunks = []
let workers = 0
class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        ++workers
        this.requests = new Map()
        this.worker = new ThreadWorker(pathToFileURL(`${root}/test/fixtures/parser-settlement/worker-node.mjs`), {workerData: {url: url.href}})
        this.worker.on('message', (data) => {
            if (data.type === 'result' && data.chunk !== null) {
                const chunk = data.chunk
                if (chunk.mediaRows.some(({imagePaths}) => !Array.isArray(imagePaths))) throw new Error('Expected native projected image references')
                byFlagColumn.set(chunk.readingEqualsExpressionList, {
                    firstSource: this.requests.get(data.id),
                    rowCount: chunk.rowCount,
                    readingEqualsExpressionList: chunk.readingEqualsExpressionList,
                    expressionBytesList: chunk.expressionBytesList,
                    readingBytesList: chunk.readingBytesList,
                    mediaRows: chunk.mediaRows,
                })
                this.requests.delete(data.id)
            }
            this.dispatchEvent(new MessageEvent('message', {data}))
        })
        this.worker.on('error', (error) => {
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: error.message})
            this.dispatchEvent(event)
        })
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
    }
    postMessage(data, transfer) {
        if (data.type === 'parse') this.requests.set(data.id, data.sourceMetadata[0].filename)
        this.worker.postMessage(data, transfer)
    }
    terminate() { terminations.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})
const wasm = await readFile(`${root}/ext/lib/term-bank-parser.wasm`)
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
const archive = await openAsBlob('/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip')
const entries = await readDenseZipDirectory(archive)
const banks = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.match(/\d+/)[0]) - Number(b.filename.match(/\d+/)[0]))
const reader = new RawZipPayloadReader(archive)
const importer = new DictionaryImporter({getImageDetails: async () => { throw new Error('Unexpected image decoding') }})
importer._skipImageMetadata = true
const bankInputs = banks.map(({filename, compressedSize, uncompressedSize, compressionMethod, signature}) => ({filename, compressedSize, uncompressedSize, compressionMethod, signature}))
const source = {
    compressed: true,
    estimatedByteLengths: banks.map(({uncompressedSize}) => uncompressedSize),
    loaders: banks.map((file) => async () => ({...file, bytes: await reader.read(file, new AbortController().signal)})),
}
try {
    await importer._readTermBankFileFast(banks[0], 3, 'VNDB Characters by Bee', false, true, true, 'raw-bytes', (columns) => {
        const chunk = byFlagColumn.get(columns.readingEqualsExpressionList)
        if (!chunk) throw new Error('Missing captured worker media result')
        byFlagColumn.delete(columns.readingEqualsExpressionList)
        chunks.push(chunk)
    }, source)
} finally {
    await parser.disposeParallelTermBankParser()
    await Promise.all(terminations)
}
const payload = serialize({banks: bankInputs, chunks})
await writeFile(new URL('native-media-chunks.bin', directory), payload)
const keys = new Set()
let mediaRows = 0
for (const chunk of chunks) {
    mediaRows += chunk.mediaRows.length
    for (const {row} of chunk.mediaRows) {
        for (const value of [row.expressionBytes, row.readingBytes]) {
            if (value instanceof Uint8Array) keys.add(value.buffer)
        }
    }
}
const receipt = {
    source: root,
    fixtureBytes: archive.size,
    fixtureSha256: 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792',
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
    payloadBytes: payload.length,
    workers, banks: banks.length, chunks: chunks.length,
    rows: chunks.reduce((sum, chunk) => sum + chunk.rowCount, 0),
    mediaRows,
    ownedKeyBuffers: keys.size,
    ownedKeyBufferBytes: [...keys].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    scope: 'Actual production native parser/worker and importer, with Node worker transport adapter and no database sink. Only media result columns retained for materialization replay.'
}
await writeFile(new URL('capture.json', directory), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
