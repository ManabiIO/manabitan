/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {crc32, inflateRawSync} from 'node:zlib'
import {createRecordFieldEncoder} from './prototype.mjs'

const {values} = parseArgs({options: {
    repository: {type: 'string', default: fileURLToPath(new URL('../inflight', import.meta.url))},
    'cache-dir': {type: 'string'},
    wasm: {type: 'string', default: fileURLToPath(new URL('record-fields.wasm', import.meta.url))},
    dictionary: {type: 'string', default: 'jmdict'},
    'parser-workers': {type: 'string', default: '3'},
    pairs: {type: 'string', default: '6'},
    repetitions: {type: 'string', default: '8'},
    'bank-limit': {type: 'string', default: '0'},
    'group-limit': {type: 'string', default: '0'},
    out: {type: 'string'},
}})
const root = path.resolve(values.repository)
assert(values['cache-dir'], 'Provide --cache-dir')
const pairs = Number(values.pairs)
const repetitions = Number(values.repetitions)
const parserWorkers = Number(values['parser-workers'])
const bankLimit = Number(values['bank-limit'])
const groupLimit = Number(values['group-limit'])
for (const value of [pairs, repetitions, parserWorkers]) { assert(Number.isSafeInteger(value) && value > 0) }
for (const value of [bankLimit, groupLimit]) { assert(Number.isSafeInteger(value) && value >= 0) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const source = async (file) => import(pathToFileURL(path.join(root, file)))
const {readDenseZipDirectory} = await source('ext/js/dictionary/dense-zip-directory.js')
const {RawZipPayloadReader} = await source('ext/js/dictionary/term-bank-source-pipeline.js')
const {createArtifactTermRecordChunkWithResolvedContent, TermRecordOpfsStore} = await source('ext/js/dictionary/term-record-opfs-store.js')
const parser = await source('ext/js/dictionary/term-bank-wasm-parser.js')
const nativeArtifacts = await source('dev/dictionary-wasm.js')
nativeArtifacts.loadDictionaryWasm()
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries[values.dictionary]
assert(fixture, 'Unknown dictionary')
const archivePath = path.join(values['cache-dir'], fixture.cacheFile)
const fixtureDigest = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) { fixtureDigest.update(bytes) }
assert.equal(fixtureDigest.digest('hex'), fixture.sha256)
const parserBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
assert.equal(sha256(parserBytes), nativeArtifacts.getDictionaryWasmManifest().targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
parser.setTermBankWasmModule(await WebAssembly.compile(parserBytes))
const wasmBytes = await readFile(values.wasm)
const prototypeManifest = JSON.parse(await readFile(path.join(path.dirname(values.wasm), 'manifest.json'), 'utf8'))
assert.equal(sha256(wasmBytes), prototypeManifest.files['record-fields.wasm'])
assert.equal(sha256(await readFile(path.join(path.dirname(values.wasm), 'record-fields.c'))), prototypeManifest.files['record-fields.c'])
assert.equal(sha256(await readFile(new URL('prototype.mjs', import.meta.url))), prototypeManifest.files['prototype.mjs'])
const compileStart = performance.now()
const nativeModule = await WebAssembly.compile(wasmBytes)
const compileMs = performance.now() - compileStart
const instanceStart = performance.now()
const encoder = createRecordFieldEncoder(nativeModule)
const instanceMs = performance.now() - instanceStart
const store = new TermRecordOpfsStore()
const archive = await openAsBlob(archivePath)
let directory = await readDenseZipDirectory(archive)
if (directory === null) {
    const {BlobReader, ZipReader} = await import(pathToFileURL(path.join(root, 'node_modules/@zip.js/zip.js/index.js')))
    const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
    directory = await reader.getEntries()
    await reader.close()
}
let entries = directory.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const totalBanks = entries.length
if (bankLimit) { entries = entries.slice(0, bankLimit) }
const totalBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
const groupsPerWorker = fixture.mediaFiles > 0 ? 3 : 4
const groupCount = Math.min(entries.length, Math.max(parserWorkers * groupsPerWorker, Math.ceil(totalBytes / (24 * 1024 * 1024))))
const groups = []
let start = 0
let consumed = 0
for (let index = 0; index < groupCount - 1; ++index) {
    const remaining = groupCount - index
    const target = (totalBytes - consumed) / remaining
    let end = start + 1
    let bytes = entries[start].uncompressedSize
    const maxEnd = entries.length - (remaining - 1)
    while (end < maxEnd) {
        const nextBytes = bytes + entries[end].uncompressedSize
        if (Math.abs(nextBytes - target) > Math.abs(bytes - target)) { break }
        bytes = nextBytes
        ++end
    }
    groups.push(entries.slice(start, end))
    start = end
    consumed += bytes
}
groups.push(entries.slice(start))
if (groupLimit) { groups.length = Math.min(groups.length, groupLimit) }
const payloads = new RawZipPayloadReader(archive)
const signal = new AbortController().signal
const result = {
    schema: 1,
    kind: 'record-field-component-screen',
    dictionary: values.dictionary,
    fixture: {sha256: fixture.sha256, expectedRows: fixture.termRows, totalBanks},
    sources: {
        prototypeManifest,
        lockSha256: sha256(lockBytes),
        parserWasmSha256: sha256(parserBytes),
        recordStoreSha256: sha256(await readFile(path.join(root, 'ext/js/dictionary/term-record-opfs-store.js'))),
        prototypeSha256: sha256(await readFile(new URL('prototype.mjs', import.meta.url))),
        runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        nativeWasmSha256: sha256(wasmBytes),
    },
    shape: {parserWorkers, groupsPerWorker, groups: groups.length, bankLimit, groupLimit},
    policy: {pairs, repetitions, order: 'AB then BA alternating by pair and group; six same-code controls', warmupsPerArm: 2},
    scope: 'Native parser supplies actual scores, canonical IDs and canonical encoded content lengths. Persisted offsets are reconstructed consecutively above 2^40; compression and global canonical reuse are not reproduced. This is a component screen, not end-to-end import qualification.',
    compileMs,
    instanceMs,
    groups: [],
}
const digest = createHash('sha256')
let absoluteBase = 2 ** 40
let totalRows = 0
let checksum = 0
for (let group = 0; group < groups.length; ++group) {
    let banks = []
    for (const entry of groups[group]) {
        const compressed = await payloads.read(entry, signal)
        const bytes = entry.compressionMethod === 8 ? inflateRawSync(compressed) : compressed
        assert.equal(bytes.byteLength, entry.uncompressedSize)
        assert.equal(crc32(bytes), entry.signature)
        banks.push(bytes)
    }
    let chunk
    const groupBase = absoluteBase
    await parser.parseTermBankWithWasmColumnChunks(banks, 3, (parsed) => {
        assert.equal(chunk, undefined)
        const uniqueCount = parsed.contentDedupPlan.uniqueCount
        const offsets = new Float64Array(uniqueCount)
        const lengths = new Uint32Array(uniqueCount)
        for (let unique = 0; unique < uniqueCount; ++unique) {
            const row = parsed.contentDedupPlan.uniqueRowIndexes[unique]
            const metadataIndex = parsed.contentMetaByUniqueIndex ? unique : row
            lengths[unique] = parsed.contentMetaList[metadataIndex * 4 + 1]
            offsets[unique] = absoluteBase
            absoluteBase += lengths[unique]
        }
        chunk = createArtifactTermRecordChunkWithResolvedContent(
            {rowCount: parsed.rowCount, scoreList: Int32Array.from(parsed.scoreList)},
            Uint32Array.from(parsed.contentUniqueIndexList), offsets, lengths,
        )
    }, 2048, {singleChunk: true, emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
        emitTokenBinaryContent: true, mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true})
    banks = null
    assert(chunk)
    const {rowCount, scoreList, resolvedContentReferences: references} = chunk
    totalRows += rowCount
    const calls = {
        baseline: () => store._encodeArtifactRecordFields(chunk, [], [], groupBase),
        candidate: () => encoder.encodeRecordFields(rowCount, scoreList, references, groupBase) ?? store._encodeArtifactRecordFields(chunk, [], [], groupBase),
    }
    const observations = []
    function measure(arm, iterations, campaign, pair, position) {
        let bytes
        const before = performance.now()
        for (let iteration = 0; iteration < iterations; ++iteration) {
            bytes = calls[arm]()
            checksum = (checksum + bytes.byteLength + bytes[0]) >>> 0
        }
        const elapsedMs = performance.now() - before
        observations.push({campaign, pair, position, arm, iterations, elapsedMs, perCallMs: elapsedMs / iterations})
        return bytes
    }
    const expected = measure('baseline', 1, 'cold-group', 0, 0)
    const coldNative = measure('candidate', 1, 'cold-group', 0, 1)
    assert.deepEqual(coldNative, expected)
    const nativeOnly = encoder.encodeRecordFields(rowCount, scoreList, references, groupBase)
    if (nativeOnly !== null) { assert.deepEqual(nativeOnly, expected) }
    for (let index = 0; index < 2; ++index) { calls.baseline(); calls.candidate() }
    for (let pair = 0; pair < pairs; ++pair) {
        const order = ((pair + group) & 1) === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
        for (let position = 0; position < order.length; ++position) {
            assert.deepEqual(measure(order[position], repetitions, 'candidate', pair, position), expected)
        }
    }
    for (let pair = 0; pair < pairs; ++pair) {
        for (let position = 0; position < 2; ++position) {
            assert.deepEqual(measure('baseline', repetitions, 'same-code-control', pair, position), expected)
        }
    }
    digest.update(expected)
    const record = {
        group, banks: groups[group].map(({filename}) => filename), rows: rowCount, unique: references.offsets.length,
        distinctScores: new Set(scoreList).size, contentOffsetBase: groupBase, outputBytes: expected.byteLength,
        nativeAccepted: nativeOnly !== null, format: expected.byteLength === rowCount * 12 ? 'legacy' : 'compact',
        exactBytesSha256: sha256(expected), allocation: encoder.allocationInfo(rowCount, references.offsets.length), observations,
    }
    result.groups.push(record)
    process.stdout.write(JSON.stringify({group, rows: rowCount, unique: record.unique, accepted: record.nativeAccepted, outputBytes: record.outputBytes}) + '\n')
}
if (!bankLimit && !groupLimit) { assert.equal(totalRows, fixture.termRows) }
result.totalRows = totalRows
result.exactBytesSha256 = digest.digest('hex')
result.checksum = checksum
result.pairs = []
for (let pair = 0; pair < pairs; ++pair) {
    const sum = (campaign, arm, position) => result.groups.reduce((total, group) => total + group.observations
        .filter((observation) => observation.campaign === campaign && observation.pair === pair &&
            (arm === undefined || observation.arm === arm) && (position === undefined || observation.position === position))
        .reduce((subtotal, observation) => subtotal + observation.perCallMs, 0), 0)
    const baselineMs = sum('candidate', 'baseline')
    const candidateMs = sum('candidate', 'candidate')
    result.pairs.push({pair, baselineMs, candidateMs, differenceMs: candidateMs - baselineMs,
        percent: (candidateMs / baselineMs - 1) * 100,
        controlFirstMs: sum('same-code-control', undefined, 0), controlSecondMs: sum('same-code-control', undefined, 1)})
}
const destination = values.out ?? fileURLToPath(new URL(`${values.dictionary}-screen.json`, import.meta.url))
await mkdir(path.dirname(destination), {recursive: true})
await writeFile(destination, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(JSON.stringify({out: destination, totalRows, pairs: result.pairs}) + '\n')
