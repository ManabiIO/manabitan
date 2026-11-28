// Research-only probe. No runtime source is modified or imported by production.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {deflateRawSync, crc32, constants} from 'node:zlib'
import {pathToFileURL} from 'node:url'

const root = '/workspace/scratch/beb5caac0497/manabitan'
const out = process.argv[2] ?? '/workspace/scratch/beb5caac0497/results/decompression-stream-node-conformance.json'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const parser = await import(pathToFileURL(`${root}/ext/js/dictionary/term-bank-wasm-parser.js`))
const moduleBytes = await readFile(`${root}/ext/lib/term-bank-parser.wasm`)
parser.setTermBankWasmModule(await WebAssembly.compile(moduleBytes))
const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255)
const join = (...parts) => Buffer.concat(parts.map((part) => Array.isArray(part) ? Uint8Array.from(part) : part))
function footer(signature, length) {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, signature, true)
    view.setUint32(4, length >>> 0, true)
    return bytes
}
function source(raw, options = {}) {
    const compressed = deflateRawSync(raw, options)
    return {bytes: new Uint8Array(compressed), compressionMethod: 8, compressedSize: compressed.length,
        uncompressedSize: raw.length, signature: crc32(raw)}
}
const inputs = [
    ['empty-array', Buffer.from('[]')],
    ['one-row', Buffer.from('[["a","","","",0,["x"],1,""]]')],
    ['whitespace-array', Buffer.from(' \t\r\n[[]] \t\r\n')],
    ['repeated-array', Buffer.from(JSON.stringify(Array.from({length: 4096}, (_, i) => [String(i % 7), '', '', '', 0, ['repeated glossary '.repeat(8)], i, ''])))],
]
const methods = [['default', {}], ['fixed', {strategy: constants.Z_FIXED}], ['stored-blocks', {level: 0}]]
const mutations = [
    ['valid', (s) => s],
    ['crc-wrong', (s) => ({...s, signature: (s.signature + 1) >>> 0})],
    ['size-too-large', (s) => ({...s, uncompressedSize: s.uncompressedSize + 1})],
    ['size-too-small', (s) => ({...s, uncompressedSize: s.uncompressedSize - 1})],
    ['truncated-one', (s) => ({...s, bytes: s.bytes.slice(0, -1), compressedSize: s.compressedSize - 1})],
    ['truncated-half', (s) => ({...s, bytes: s.bytes.slice(0, Math.floor(s.bytes.length / 2)), compressedSize: Math.floor(s.bytes.length / 2)})],
    ['trailing-zero', (s) => ({...s, bytes: join(s.bytes, [0]), compressedSize: s.compressedSize + 1})],
    ['trailing-garbage', (s) => ({...s, bytes: join(s.bytes, [0xde, 0xad]), compressedSize: s.compressedSize + 2})],
    ['concatenated-raw-stream', (s) => ({...s, bytes: join(s.bytes, s.bytes), compressedSize: s.compressedSize * 2})],
    ['invalid-block-type', (s) => ({...s, bytes: Uint8Array.of(7), compressedSize: 1})],
]

async function consume(parts, format, limit) {
    let next = 0
    const input = new ReadableStream({pull(controller) {
        if (next < parts.length) { controller.enqueue(parts[next++]) } else { controller.close() }
    }})
    const reader = input.pipeThrough(new DecompressionStream(format)).getReader()
    const output = new Uint8Array(limit)
    let count = 0
    let chunks = 0
    try {
        while (true) {
            const {value, done} = await reader.read()
            if (done) { break }
            ++chunks
            if (!(value instanceof Uint8Array) || value.length > limit - count) { throw new Error('decoded-size bound exceeded') }
            output.set(value, count)
            count += value.length
        }
        return {accepted: true, bytes: output.subarray(0, count), count, chunks}
    } catch (error) {
        try { await reader.cancel(error) } catch {}
        return {accepted: false, count, chunks, error: {name: error.name, message: error.message}}
    } finally { reader.releaseLock() }
}

async function native(s) {
    try {
        const result = await parser.inflateCompressedTermBankSourcesWasm([s], {experimentalTermBankSpans: true})
        const output = new Uint8Array(result.wasm.memory.buffer, result.jsonPtr, result.jsonLength)
        return {accepted: true, bytes: output.slice()}
    } catch (error) { return {accepted: false, error: {name: error.name, message: error.message}} }
}

const report = {
    node: process.version, versions: process.versions,
    runnerSha256: sha(await readFile(new URL(import.meta.url))),
    parserSha256: sha(await readFile(`${root}/ext/js/dictionary/term-bank-wasm-parser.js`)),
    wasmSha256: sha(moduleBytes),
    scope: 'Correctness only. Node APIs differ from Chromium. No timing claims. Raw DS receives an independent Node CRC32 check after successful bounded output, solely as a correctness oracle; a browser candidate would use the current native CRC function. Gzip DS receives the ZIP CRC/size as its trailer and no second CRC scan.',
    observations: [], formatConformance: [],
}
for (const [inputName, raw] of inputs) {
    for (const [method, options] of methods) {
        const original = source(raw, options)
        for (const [mutation, mutate] of mutations) {
            const s = mutate(original)
            const reference = await native(s)
            for (const format of ['deflate-raw', 'gzip']) {
                const pieces = format === 'gzip' ? [header, s.bytes, footer(s.signature, s.uncompressedSize)] : [s.bytes]
                for (const chunking of ['single', 'separate-boundaries']) {
                    const parts = chunking === 'single' ? [join(...pieces)] : pieces.flatMap((part) => part.length > 1 ? [part.subarray(0, 1), part.subarray(1, -1), part.subarray(-1)] : [part])
                    const actual = await consume(parts, format, Math.max(0, s.uncompressedSize))
                    if (actual.accepted && actual.count !== s.uncompressedSize) {
                        actual.accepted = false
                        actual.error = {name: 'Error', message: 'decoded-size mismatch'}
                    }
                    if (actual.accepted && format === 'deflate-raw' && crc32(actual.bytes) !== s.signature) {
                        actual.accepted = false
                        actual.error = {name: 'Error', message: 'CRC32 mismatch'}
                    }
                    if (actual.accepted && reference.accepted) { assert.deepEqual(actual.bytes, reference.bytes) }
                    const {bytes, ...receipt} = actual
                    report.observations.push({inputName, method, mutation, format, chunking,
                        nativeAccepted: reference.accepted, nativeError: reference.error,
                        ...receipt, matchesNativeAcceptance: actual.accepted === reference.accepted,
                        outputSha256: bytes ? sha(bytes) : null})
                }
            }
        }
    }
}

const testRaw = Buffer.from('[]')
const raw = deflateRawSync(testRaw)
const gzip = join(header, raw, footer(crc32(testRaw), testRaw.length))
const emptyRaw = deflateRawSync(new Uint8Array())
const emptyGzip = join(header, emptyRaw, footer(0, 0))
for (const format of ['deflate-raw', 'gzip']) {
    const valid = format === 'gzip' ? gzip : raw
    const empty = format === 'gzip' ? emptyGzip : emptyRaw
    for (const [name, trailing] of [['trailing-zero', Uint8Array.of(0)], ['trailing-garbage', Uint8Array.of(0xde, 0xad)], ['extra-empty-member', empty]]) {
        for (const chunking of ['same-chunk', 'later-chunk']) {
            const parts = chunking === 'same-chunk' ? [join(valid, trailing)] : [valid, trailing]
            const {bytes, ...actual} = await consume(parts, format, 16)
            report.formatConformance.push({format, name, chunking, expectedAccepted: false, ...actual, outputSha256: bytes ? sha(bytes) : null})
        }
    }
}
report.summary = {
    sourceComparisons: report.observations.length,
    sourceAcceptanceMismatches: report.observations.filter((o) => !o.matchesNativeAcceptance).length,
    gzipSourceAcceptanceMismatches: report.observations.filter((o) => o.format === 'gzip' && !o.matchesNativeAcceptance).length,
    formatCases: report.formatConformance.length,
    acceptedForbiddenTrailingCases: report.formatConformance.filter((o) => o.accepted).length,
}
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report.summary))
