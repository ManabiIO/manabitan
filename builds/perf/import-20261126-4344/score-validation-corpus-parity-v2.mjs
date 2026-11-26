/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'

// Bounded component follow-up after the parallel harness was killed before
// output. Parse one complete source bank at a time without workers. Actual
// record encoders and sidecar builder use deterministic native-content spans,
// not compressed physical offsets. This runner collects correctness only.
const [parentPath, candidatePath, cachePath, outputPath, dictionary = 'jmdict'] = process.argv.slice(2)
assert(parentPath && candidatePath && cachePath && outputPath)
const parentRoot = resolve(parentPath)
const candidateRoot = resolve(candidatePath)
// The CLI explicitly selects the two local source trees to compare.
// eslint-disable-next-line no-unsanitized/method
const localImport = (root, filename) => import(pathToFileURL(join(root, filename)))
const parser = await localImport(candidateRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const parentSourceBeforeImport = shaFile(await readFile(join(parentRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
const candidateSourceBeforeImport = shaFile(await readFile(join(candidateRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
const parents = await localImport(parentRoot, 'ext/js/dictionary/term-record-opfs-store.js')
const candidates = await localImport(candidateRoot, 'ext/js/dictionary/term-record-opfs-store.js')
function shaFile(bytes) { return createHash('sha256').update(bytes).digest('hex') }
const sha = shaFile
const lockBytes = await readFile(join(candidateRoot, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(lockBytes, await readFile(join(parentRoot, 'test/perf/dictionaries.lock.json')))
const fixture = JSON.parse(lockBytes).dictionaries[dictionary]
assert(fixture)
const archivePath = join(cachePath, fixture.cacheFile)
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
const wasm = await readFile(join(candidateRoot, 'ext/lib/term-bank-parser.wasm'))
assert.deepEqual(wasm, await readFile(join(parentRoot, 'ext/lib/term-bank-parser.wasm')))
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))

const sourceGroups = []
const sourceHashes = {}
for (const [name, sourceRoot] of [['parent', parentRoot], ['candidate', candidateRoot]]) {
    sourceHashes[name] = sha(await readFile(join(sourceRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
}
assert.equal(sourceHashes.parent, parentSourceBeforeImport)
assert.equal(sourceHashes.candidate, candidateSourceBeforeImport)
assert.equal(sourceHashes.parent, 'dad0317f3fd6e84866d2b2a6db65676f94f4e3d23d5b29f0c73a793586634bd1')
assert.equal(sourceHashes.candidate, 'a7b080fa3d7fd3f6c38d81f04d95bfe22d105af12b21c98812cdccba736fa315')
const runnerSha256 = sha(await readFile(new URL(import.meta.url)))
console.log(JSON.stringify({phase: 'start', startedAt: new Date().toISOString(), parentRoot, candidateRoot, sourceHashes, runnerSha256, fixture, node: process.version}))
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 1, deviceMemory: 4}})

const reader = new ZipReader(new BlobReader(archive))
const entries = await reader.getEntries()
const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const groups = []
const profiles = []
const fullDigest = createHash('sha256')
let rowCount = 0
let contentBase = 2 ** 40

async function encode(module, chunk, offsets, lengths) {
    const store = new module.TermRecordOpfsStore()
    const writes = []
    const envelopes = []
    store._appendEncodedChunk = async (...args) => {
        writes.push(args.slice(1, 8))
        envelopes.push(store._createLookupIndexChunk(...args.slice(1, 3), ...args.slice(4, 8)))
    }
    const recordChunk = module.createArtifactTermRecordChunkWithResolvedContent(
        {...chunk, dictionary: fixture.expectedTitle},
        chunk.contentUniqueIndexList,
        offsets,
        lengths,
        chunk.preparedLookupIndexes,
    )
    await store._encodeAndAppendArtifactChunkForState({}, recordChunk, rowCount + 1, new Float64Array(0), new Uint32Array(0), chunk.termRecordPreinternedPlan, 'raw', chunk.preparedLookupIndexes)
    return {writes, envelopes}
}

async function consume(chunk) {
    const plan = chunk.contentDedupPlan
    assert(plan && chunk.contentUniqueIndexList && chunk.contentMetaList)
    const offsets = new Float64Array(plan.uniqueCount)
    const lengths = new Uint32Array(plan.uniqueCount)
    for (let i = 0; i < plan.uniqueCount; ++i) {
        const meta = (chunk.contentMetaByUniqueIndex ? i : plan.uniqueRowIndexes[i]) * 4
        offsets[i] = contentBase + chunk.contentMetaList[meta]
        lengths[i] = chunk.contentMetaList[meta + 1]
    }
    const before = await encode(parents, chunk, offsets, lengths)
    const after = await encode(candidates, chunk, offsets, lengths)
    assert.deepEqual(after.writes, before.writes)
    assert.deepEqual(after.envelopes, before.envelopes)
    for (const envelope of after.envelopes) { fullDigest.update(envelope) }
    const compactScoreEntries = after.writes.reduce((sum, args) => sum + (args[6] === 2 ? args[1] : 0), 0)
    groups.push({rows: chunk.rowCount, prepared: [...chunk.preparedLookupIndexes.keys()], runRows: after.writes.map((args) => args[1]), compactScoreEntries})
    rowCount += chunk.rowCount
    contentBase += chunk.contentBytesLength ?? chunk.contentBytesBuffer.byteLength
    process.stderr.write(`${dictionary}: ${rowCount}/${fixture.termRows} rows\n`)
}

const media = fixture.mediaFiles > 0
const options = {
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: media,
    projectImagePaths: media,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    maxPendingChunks: 2,
}
let complete = false
let error = null
try {
    for (const file of termFiles) {
        const bytes = await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
        sourceGroups.push({files: [file.filename], bytes: [bytes.byteLength]})
        await parser.parseTermBankWithWasmColumnChunks(bytes, 3, consume, 2048, {...options, singleChunk: true})
        profiles.push(parser.consumeLastTermBankWasmParseProfile())
    }
    assert.equal(rowCount, fixture.termRows)
    assert.equal(sha(await readFile(join(parentRoot, 'ext/js/dictionary/term-record-opfs-store.js'))), sourceHashes.parent)
    assert.equal(sha(await readFile(join(candidateRoot, 'ext/js/dictionary/term-record-opfs-store.js'))), sourceHashes.candidate)
    assert.equal(sha(await readFile(new URL(import.meta.url))), runnerSha256)
    complete = true
} catch (failure) {
    error = String(failure)
    throw failure
} finally {
    await parser.disposeParallelTermBankParser()
    await reader.close()
    const summary = {rows: 0, runs: 0, compactScoreEntries: 0}
    for (const group of groups) {
        summary.rows += group.rows
        summary.runs += group.runRows.length
        summary.compactScoreEntries += group.compactScoreEntries
    }
    const timing = null // Correctness-only acquisition; no timing phase.
    const report = {
        complete,
        error,
        node: process.version,
        dictionary,
        hardwareConcurrency: 1,
        deviceMemory: 4,
        fixture,
        lockSha256: sha(lockBytes),
        parserWasmSha256: sha(wasm),
        parentSourceSha256: sourceHashes.parent,
        candidateSourceSha256: sourceHashes.candidate,
        scope: 'Sequential one-bank native parser output through record encoders and sidecar envelope builder (bounded component fixture grouping; no production worker or grouping claim), with deterministic native-content spans and intercepted persistence. Correctness only, without compression, OPFS, browser/IPC, UI, or import completion coverage.',
        summary,
        timing,
        runnerSha256,
        encodedByteSha256: fullDigest.digest('hex'),
        groups,
        sourceGroups,
        profiles,
    }
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'})
    console.log(JSON.stringify({complete, error, ...summary}))
}
