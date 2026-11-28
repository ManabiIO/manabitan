/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {gunzipSync} from 'node:zlib'
import {deserialize} from 'node:v8'
import os from 'node:os'

const [sourceArgument, captureArgument, outputPath, mode = 'cold'] = process.argv.slice(2)
assert(sourceArgument && captureArgument && outputPath)
assert(mode === 'cold' || mode === 'warm')
assert.equal(typeof globalThis.gc, 'function', 'Use --expose-gc')
const sourceRoot = resolve(sourceArgument)
const captureRoot = resolve(captureArgument)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const report = JSON.parse(await readFile(join(captureRoot, 'report.json'), 'utf8'))
assert.equal(report.complete, true)
assert.equal(report.dictionary, 'jmdict')
assert.equal(report.fixture.sha256, '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f')
assert.equal(report.summary.rows, 528299)
assert.equal(report.summary.cacheRows, 362032)
assert.equal(report.groups.length, 12)
assert.equal(hash(await readFile(join(sourceRoot, 'test/perf/dictionaries.lock.json'))), report.lockSha256)
assert.equal(hash(await readFile(join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))), report.parserWasmSha256)
const sourceSha256 = hash(await readFile(join(sourceRoot, 'ext/js/dictionary/dictionary-database.js')))
const {DictionaryDatabase} = await import(pathToFileURL(join(sourceRoot, 'ext/js/dictionary/dictionary-database.js')))
const {registerOwnedTermContent} = await import(pathToFileURL(join(sourceRoot, 'ext/js/dictionary/term-content-ownership.js')))
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})

// Detach every deserialized view from its serialized payload. Restore the
// production source buffer kind; registration below establishes ownership.
const fixtures = []
for (const group of report.groups) {
    const compressed = await readFile(join(captureRoot, group.cacheFile))
    if (typeof group.cacheSha256 === 'string') { assert.equal(hash(compressed), group.cacheSha256) }
    const serialized = gunzipSync(compressed)
    if (typeof group.serializedSha256 === 'string') { assert.equal(hash(serialized), group.serializedSha256) }
    const value = deserialize(serialized)
    assert.equal(value.shared, true)
    assert.equal(value.owned, true)
    const source = new Uint8Array(new SharedArrayBuffer(value.source.byteLength))
    source.set(value.source)
    const fixture = {
        source,
        states: Uint8Array.from(value.states),
        indexes: Int32Array.from(value.indexes),
        offsets: Uint32Array.from(value.offsets),
        lengths: Uint32Array.from(value.lengths),
        hash1s: Uint32Array.from(value.hash1s),
        hash2s: Uint32Array.from(value.hash2s),
        persistedOffsets: Float64Array.from(value.persistedOffsets),
        first: value.first,
        count: value.count,
        stateCapacity: value.stateCapacity,
        retainedBytes: value.retainedBytes,
        captureSha256: hash(compressed),
    }
    assert.equal(fixture.indexes.length, fixture.count)
    assert(fixture.states.every((state) => state === 1))
    assert(fixture.indexes.every((index, i) => index === fixture.first + i))
    fixtures.push(fixture)
}
const capacity = Math.max(...fixtures.map((fixture) => fixture.stateCapacity))
const count = report.summary.cacheRows
const owner = new DictionaryDatabase()
owner._ensureTermEntryContentMetaHashPairCapacity(count)
owner._termEntryContentMetaDenseCount = count
assert.equal(owner._termEntryContentMetaStateTable.length, capacity)
assert.equal(owner._recentTermContentSourceCacheMaxBytes, 96 * 1024 * 1024)
for (const fixture of fixtures) {
    owner._termEntryContentMetaHash1Table.set(fixture.hash1s, fixture.first)
    owner._termEntryContentMetaHash2Table.set(fixture.hash2s, fixture.first)
    owner._termEntryContentMetaLengthTable.set(fixture.lengths, fixture.first)
}
const inputs = fixtures.map((fixture) => ({
    fixture,
    staged: {indexes: fixture.indexes, active: true},
    spans: {buffer: fixture.source, offsets: fixture.offsets, lengths: fixture.lengths},
}))

function reset() {
    owner._termEntryContentMetaStateTable.fill(2, 0, count)
    owner._termEntryContentMetaRecentSourceBatchIdTable.fill(0)
    owner._termEntryContentMetaRecentSourceOffsetTable.fill(0)
    owner._recentTermContentSourceBatches.clear()
    owner._recentTermContentBoundaryBatchId = 0
    owner._recentTermContentSourceBatchBytes = 0
    owner._nextRecentTermContentSourceBatchId = 1
    owner._termEntryContentMetaHashPairCount = 0
    owner._termEntryContentMetaHashPairPendingCount = count
    for (const fixture of fixtures) { assert(registerOwnedTermContent(fixture.source)) }
}

function execute() {
    reset()
    const groups = []
    let publicationMs = 0
    let cacheMs = 0
    for (const {fixture, staged, spans} of inputs) {
        const start = performance.now()
        const published = owner._tryPublishContiguousArtifactTermContentMetadata(
            staged, fixture.hash1s, fixture.hash2s, fixture.persistedOffsets, fixture.lengths, 0, true,
        )
        const publishedAt = performance.now()
        const retained = owner._cacheRecentPublishedTermContentSources(staged, spans, null)
        const end = performance.now()
        assert.equal(published, true)
        assert.equal(retained, fixture.retainedBytes)
        publicationMs += publishedAt - start
        cacheMs += end - publishedAt
        groups.push({publicationMs: publishedAt - start, cacheMs: end - publishedAt})
    }
    assert.equal(owner._termEntryContentMetaHashPairCount, count)
    assert.equal(owner._termEntryContentMetaHashPairPendingCount, 0)
    return {elapsedMs: publicationMs + cacheMs, publicationMs, cacheMs, groups}
}

function outputDigest() {
    const digest = createHash('sha256')
    for (const key of [
        '_termEntryContentMetaHash1Table', '_termEntryContentMetaHash2Table',
        '_termEntryContentMetaStateTable', '_termEntryContentMetaLengthTable',
        '_termEntryContentMetaIdTable', '_termEntryContentMetaOffsetTable',
        '_termEntryContentMetaDictNameIdTable', '_termEntryContentMetaRecentSourceBatchIdTable',
        '_termEntryContentMetaRecentSourceOffsetTable',
    ]) {
        const value = owner[key]
        digest.update(key).update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    }
    for (const key of [
        '_termEntryContentMetaHashPairCount', '_termEntryContentMetaHashPairPendingCount',
        '_recentTermContentBoundaryBatchId', '_recentTermContentSourceBatchBytes',
        '_nextRecentTermContentSourceBatchId',
    ]) { digest.update(key).update(String(owner[key])) }
    for (const [id, source] of owner._recentTermContentSourceBatches) {
        assert.equal(source.buffer, fixtures[id - 1].source.buffer, 'Parser source must be adopted')
        digest.update(String(id)).update(source)
    }
    return digest.digest('hex')
}

const warmups = []
const observations = []
const hostBefore = {load: os.loadavg(), memory: process.memoryUsage(), cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model}
if (mode === 'warm') {
    for (let i = 0; i < 4; ++i) { warmups.push(execute()) }
}
globalThis.gc()
const repeatCount = mode === 'cold' ? 1 : 10
for (let i = 0; i < repeatCount; ++i) { observations.push(execute()) }
const result = {
    complete: true,
    scope: 'Component replay of 12 actual JMdict metadata-publication/cache calls. Real DictionaryDatabase owner and fixed native metadata arena; captured pending columns are compact independent arrays. Source decode/setup/reset/GC/verification excluded. Cold mode has no warmup and one corpus pass in a fresh process. Groups are replayed consecutively, unlike browser parsing/compression gaps. Not a browser import or memory qualification.',
    mode, sourceRoot, sourceSha256, node: process.version, v8: process.versions.v8,
    fixtureSha256: report.fixture.sha256, fixtureLockSha256: report.lockSha256,
    parserWasmSha256: report.parserWasmSha256, captureHashes: fixtures.map((fixture) => fixture.captureSha256),
    inputRows: report.summary.rows, publishedRows: count, callsPerCorpus: fixtures.length,
    ownerKind: 'DictionaryDatabase constructor with production TermContentMetadataArena',
    arenaBytes: owner._termContentMetadataArena.memory.buffer.byteLength,
    warmups, observations,
    meanMs: observations.reduce((total, value) => total + value.elapsedMs, 0) / repeatCount,
    meanPublicationMs: observations.reduce((total, value) => total + value.publicationMs, 0) / repeatCount,
    meanCacheMs: observations.reduce((total, value) => total + value.cacheMs, 0) / repeatCount,
    outputDigest: outputDigest(),
    hostBefore, hostAfter: {load: os.loadavg(), memory: process.memoryUsage()},
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
console.log(JSON.stringify({complete: true, mode, sourceSha256, meanMs: result.meanMs, meanCacheMs: result.meanCacheMs, outputDigest: result.outputDigest}))
