import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {deserialize} from 'node:v8'
import {pathToFileURL} from 'node:url'

const root = process.argv[2]
const {banks, chunks} = deserialize(await readFile(new URL('native-media-chunks.bin', import.meta.url)))
// V8 serialization may combine typed-array storage. Restore the exact owned
// buffer geometry emitted by the production worker before either arm runs.
for (const chunk of chunks) {
    for (const {row} of chunk.mediaRows) {
        for (const key of ['expressionBytes', 'readingBytes']) {
            if (row[key] instanceof Uint8Array) row[key] = Uint8Array.from(row[key])
        }
    }
}
const byFirstSource = new Map(chunks.map((chunk) => [chunk.firstSource, chunk]))
class ReplayWorker extends EventTarget {
    postMessage(data) {
        if (data.type === 'initialize') {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {type: 'ready'}})))
        } else if (data.type === 'parse') {
            const chunk = byFirstSource.get(data.sourceMetadata[0].filename)
            if (!chunk) throw new Error('Unexpected source grouping during replay')
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
const {DictionaryImporter} = await import(pathToFileURL(`${root}/ext/js/dictionary/dictionary-importer.js`))
const parser = await import(pathToFileURL(`${root}/ext/js/dictionary/term-bank-wasm-parser.js`))
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile('/workspace/scratch/71149a79699f/manabitan/ext/lib/term-bank-parser.wasm')))
await parser.initializeTermBankWasmParser()
const importer = new DictionaryImporter({getImageDetails: async () => { throw new Error('Unexpected image decoding') }})
importer._skipImageMetadata = true
const source = {
    compressed: true,
    estimatedByteLengths: banks.map(({uncompressedSize}) => uncompressedSize),
    loaders: banks.map((file) => async () => ({...file, compressedSize: 0, bytes: new Uint8Array(0)})),
}
const references = []
const seen = new Set()
const nativeDecode = TextDecoder.prototype.decode
let decoderCalls = 0
TextDecoder.prototype.decode = function (...args) {
    ++decoderCalls
    return nativeDecode.apply(this, args)
}
const start = performance.now()
await importer._readTermBankFileFast(banks[0], 3, 'VNDB Characters by Bee', false, true, true, 'raw-bytes', (_columns, requirements) => {
    for (const requirement of requirements) {
        importer._assignRequirementNoMetadata(requirement)
        if (seen.has(requirement.source.path)) continue
        seen.add(requirement.source.path)
        references.push(importer._createDeferredMediaRequirement(requirement))
    }
}, source)
const elapsedMs = performance.now() - start
TextDecoder.prototype.decode = nativeDecode
await parser.disposeParallelTermBankParser()
const buffers = new Set()
const arenas = new Set()
let retainedKeyBufferBytes = 0
let retainedSpanBufferBytes = 0
for (const reference of references) {
    if ('diagnosticKeys' in reference) {
        arenas.add(reference.diagnosticKeys)
    } else {
        for (const key of [reference.expression, reference.reading]) {
            if (key instanceof Uint8Array) buffers.add(key.buffer)
        }
    }
}
for (const arena of arenas) {
    retainedKeyBufferBytes += arena.bytes.buffer.byteLength
    retainedSpanBufferBytes += arena.spans.buffer.byteLength
    buffers.add(arena.bytes.buffer)
    buffers.add(arena.spans.buffer)
}
if (arenas.size === 0) retainedKeyBufferBytes = [...buffers].reduce((sum, bytes) => sum + bytes.byteLength, 0)
let retainedProcessMemory = null
if (typeof globalThis.gc === 'function') {
    byFirstSource.clear()
    chunks.length = 0
    for (let i = 0; i < 3; ++i) {
        await new Promise((resolve) => setImmediate(resolve))
        globalThis.gc()
    }
    retainedProcessMemory = process.memoryUsage()
}
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const text = (value) => typeof value === 'string' ? value : decoder.decode(value)
const semanticReferences = references.map((reference) => {
    const {source, dictionary} = reference
    if ('diagnosticKeys' in reference) {
        const {bytes, spans, decodedKeys} = reference.diagnosticKeys
        const index = reference.diagnosticIndex * 4
        return {
            path: source.path, dictionary,
            expression: decodedKeys?.get(index / 2) ?? decoder.decode(bytes.subarray(spans[index], spans[index] + spans[index + 1])),
            reading: decodedKeys?.get(index / 2 + 1) ?? decoder.decode(bytes.subarray(spans[index + 2], spans[index + 2] + spans[index + 3])),
        }
    }
    return {path: source.path, dictionary, expression: text(reference.expression), reading: text(reference.reading)}
})
const referencesSha256 = createHash('sha256').update(JSON.stringify(semanticReferences)).digest('hex')
const diagnosticSamples = []
for (const index of [0, Math.floor(references.length / 2), references.length - 1]) {
    try {
        await importer._getImageMedia({fileMap: new Map(), media: new Map()}, references[index].source.path, references[index])
        throw new Error('Missing media unexpectedly resolved')
    } catch (error) {
        diagnosticSamples.push(error.message)
    }
}
console.log(JSON.stringify({
    root, elapsedMs, decoderCalls,
    references: references.length,
    retainedKeyBuffers: buffers.size,
    retainedDiagnosticArenas: arenas.size,
    retainedKeyBufferBytes, retainedSpanBufferBytes,
    retainedProcessMemory,
    referencesSha256, diagnosticSamples,
    scope: 'Native VNDB media results replayed at worker transport; production importer materialization and compaction only. No archive reading, parsing, database writes, image payload work, or full-import timing.'
}))
