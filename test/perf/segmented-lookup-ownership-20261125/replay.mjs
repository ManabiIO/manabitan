#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {crc32, inflateRawSync} from 'node:zlib'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'
import {readDenseZipDirectory} from '../../../ext/js/dictionary/dense-zip-directory.js'
import {hashTermKeyBytes} from '../../../ext/js/dictionary/term-key-hash.js'
import {RawZipPayloadReader} from '../../../ext/js/dictionary/term-bank-source-pipeline.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'baseline-root': {type: 'string'},
        'candidate-root': {type: 'string', default: root},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'out': {type: 'string', default: path.join(root, 'builds/perf/segmented-lookup-ownership.json')},
    }})
assert(values['baseline-root'], 'Provide --baseline-root')
const dictionaries = positionals.length > 0 ? positionals : ['jmdict', 'jitendex', 'vndb']
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
const fixtures = JSON.parse(lockBytes).dictionaries
for (const id of dictionaries) { assert(fixtures[id], `Unknown dictionary: ${id}`) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const viewBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const sourceFiles = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/lib/term-bank-parser.wasm',
]
const sourceIdentity = async (sourceRoot) => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(sourceRoot, file)))])))
const roots = {baseline: path.resolve(values['baseline-root']), candidate: path.resolve(values['candidate-root'])}
const sources = {}
for (const [arm, sourceRoot] of Object.entries(roots)) {
    // Explicit local CLI paths, never paths from dictionary contents.
    // eslint-disable-next-line no-unsanitized/method
    const parser = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[0])))
    // eslint-disable-next-line no-unsanitized/method
    const preparation = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[3])))
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))))
    sources[arm] = {parser, preparation, identity: await sourceIdentity(sourceRoot)}
}
assert.equal(sources.baseline.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'], 'This JS ownership replay requires identical native binaries')

// Reproduce byte-balanced lazy source grouping for the default two-worker
// policy with media hints (six groups minimum, 24 MiB target). Execute groups
// serially to bound memory and avoid creating concurrent benchmark workers.
// This models source partitioning only; it is not a browser import benchmark.
function partition(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const groupCount = Math.min(entries.length, Math.max(6, Math.ceil(total / (24 * 1024 * 1024))))
    const groups = []
    let start = 0
    let consumed = 0
    for (let index = 0; index < groupCount - 1; ++index) {
        const remaining = groupCount - index
        const target = (total - consumed) / remaining
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
    return groups
}

function digestPlan(digest, plan) {
    // Compare semantic columns even when the candidate omits optional offsets.
    const offsets = plan.stringOffsets ?? new Uint32Array(plan.stringLengths.length)
    const hashes = plan.stringHashes ?? new Uint32Array(plan.stringLengths.length)
    if (!plan.stringOffsets || !plan.stringHashes) {
        let offset = 0
        for (let key = 0; key < plan.stringLengths.length; ++key) {
            const end = offset + plan.stringLengths[key]
            if (!plan.stringOffsets) { offsets[key] = offset }
            if (!plan.stringHashes) { hashes[key] = hashTermKeyBytes(plan.stringsBuffer.subarray(offset, end)) }
            offset = end
        }
        assert.equal(offset, plan.stringsBuffer.byteLength)
    }
    for (const view of [plan.stringLengths, offsets, hashes, plan.stringsBuffer, plan.expressionIndexes, plan.readingIndexes]) { digest.update(viewBytes(view)) }
}

async function openTermBanks(archivePath) {
    const archive = await openAsBlob(archivePath)
    const selectBanks = (entries) => entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    const dense = await readDenseZipDirectory(archive)
    if (dense !== null) {
        const payloads = new RawZipPayloadReader(archive)
        const signal = new AbortController().signal
        return {entries: selectBanks(dense),
            close: async () => {},
            read: async (entry) => {
                const compressed = await payloads.read(entry, signal)
                const bytes = entry.compressionMethod === 8 ? inflateRawSync(compressed) : compressed
                assert.equal(bytes.byteLength, entry.uncompressedSize)
                assert.equal(crc32(bytes), entry.signature)
                return bytes
            }}
    }
    const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
    return {entries: selectBanks(await reader.getEntries()),
        close: () => reader.close(),
        read: (entry) => entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})}
}

async function replayGroup(source, banks) {
    const {parser, preparation} = source
    let result
    await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        assert.equal(result, undefined, 'Expected one complete group')
        const owned = parser.copyWasmBackedColumnChunk(chunk)
        owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
        assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
        const digest = createHash('sha256')
        const buffers = new Set()
        let keys = 0
        let aliasedLengthKeys = 0
        let omittedOffsetKeys = 0
        for (const [key, {bytes, preinternedPlan: plan}] of owned.preparedLookupIndexes) {
            digest.update(key)
            digest.update(bytes)
            digestPlan(digest, plan)
            keys += plan.stringLengths.length
            if (plan.stringLengths.buffer === bytes.buffer) { aliasedLengthKeys += plan.stringLengths.length }
            if (typeof plan.stringOffsets === 'undefined') { omittedOffsetKeys += plan.stringLengths.length }
            for (const view of [bytes, ...Object.values(plan)]) {
                if (ArrayBuffer.isView(view)) { buffers.add(view.buffer) }
            }
        }
        digestPlan(digest, owned.termRecordPreinternedPlan)
        for (const view of [owned.readingEqualsExpressionList, owned.scoreList, owned.sequenceList]) { digest.update(viewBytes(view)) }
        assert(owned.contentBytesBuffer && owned.contentMetaList && typeof owned.contentBytesBaseOffset === 'number')
        for (let row = 0; row < owned.rowCount; ++row) {
            const offset = owned.contentBytesBaseOffset + owned.contentMetaList[row * 4]
            digest.update(owned.contentBytesBuffer.subarray(offset, offset + owned.contentMetaList[row * 4 + 1]))
            digest.update(viewBytes(owned.contentMetaList.subarray(row * 4 + 1, row * 4 + 4)))
        }
        digest.update(JSON.stringify(owned.mediaRows))
        result = {rows: owned.rowCount,
            keys,
            aliasedLengthKeys,
            omittedOffsetKeys,
            preparedBuffers: buffers.size,
            preparedBufferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
            digest: digest.digest('hex')}
    }, 2048, {
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: true,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
    })
    assert(result, 'Parser omitted group')
    const profile = parser.consumeLastTermBankWasmParseProfile()
    return {...result,
        nativeSegments: profile.nativeSegmentedLookupSegments ?? 0,
        nativeFallbacks: profile.nativeSegmentedLookupFallbacks ?? 0}
}

const report = {schema: 1,
    complete: false,
    boundary: 'Sequential parser, completed lookup construction and owned output. All locked term banks; canonical row content, metadata, media rows, every lookup byte and all semantic key-plan columns are compared. No storage, media payload import, browser timing or peak-memory claim.',
    grouping: {kind: 'modeled production lazy byte balancing', parserWorkerPolicy: 2, groupsPerWorker: 3, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    node: process.version,
    lockSha256: sha256(lockBytes),
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, {root: roots[arm], hashes: source.identity}])),
    dictionaries: []}
await mkdir(path.dirname(values.out), {recursive: true})
const save = () => writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
await save()
for (const dictionary of dictionaries) {
    const fixture = fixtures[dictionary]
    const archivePath = path.join(values['cache-dir'], fixture.cacheFile)
    const archiveDigest = createHash('sha256')
    let archiveBytes = 0
    for await (const bytes of createReadStream(archivePath)) {
        archiveDigest.update(bytes)
        archiveBytes += bytes.length
    }
    assert.equal(archiveDigest.digest('hex'), fixture.sha256)
    assert.equal(archiveBytes, fixture.sizeBytes)
    const reader = await openTermBanks(archivePath)
    try {
        const entries = reader.entries
        const groups = partition(entries)
        const result = {dictionary,
            archiveSha256: fixture.sha256,
            banks: entries.length,
            rows: 0,
            nativeSegments: 0,
            nativeFallbacks: 0,
            keysWithCopiesRemoved: 0,
            copiedBytesRemoved: 0,
            buffersRemoved: 0,
            groups: []}
        report.dictionaries.push(result)
        for (const [index, group] of groups.entries()) {
            const banks = []
            for (const entry of group) { banks.push(await reader.read(entry)) }
            const baseline = await replayGroup(sources.baseline, banks)
            const candidate = await replayGroup(sources.candidate, banks)
            assert.equal(candidate.digest, baseline.digest, `${dictionary} group ${index}: output mismatch`)
            assert.equal(candidate.rows, baseline.rows)
            assert.equal(candidate.nativeSegments, baseline.nativeSegments)
            assert.equal(candidate.nativeFallbacks, baseline.nativeFallbacks)
            assert.equal(candidate.keys, baseline.keys)
            const removedLengthKeys = candidate.aliasedLengthKeys - baseline.aliasedLengthKeys
            const removedOffsetKeys = candidate.omittedOffsetKeys - baseline.omittedOffsetKeys
            assert.equal(removedLengthKeys, removedOffsetKeys)
            const copiedBytesRemoved = baseline.preparedBufferBytes - candidate.preparedBufferBytes
            const buffersRemoved = baseline.preparedBuffers - candidate.preparedBuffers
            assert.equal(copiedBytesRemoved, removedLengthKeys * 6)
            assert.equal(buffersRemoved, candidate.nativeSegments * 2)
            result.rows += candidate.rows
            result.nativeSegments += candidate.nativeSegments
            result.nativeFallbacks += candidate.nativeFallbacks
            result.keysWithCopiesRemoved += removedLengthKeys
            result.copiedBytesRemoved += copiedBytesRemoved
            result.buffersRemoved += buffersRemoved
            result.groups.push({firstBank: group[0].filename,
                lastBank: group.at(-1).filename,
                sourceBytes: banks.reduce((sum, bank) => sum + bank.byteLength, 0),
                baseline,
                candidate})
            await save()
            console.log(`${dictionary} ${index + 1}/${groups.length}: ${candidate.rows} rows, ${candidate.nativeSegments} native segments, ${copiedBytesRemoved} copied bytes removed`)
            globalThis.gc?.()
        }
        assert.equal(result.rows, fixture.termRows)
    } finally { await reader.close() }
}
for (const [arm, sourceRoot] of Object.entries(roots)) { assert.deepEqual(await sourceIdentity(sourceRoot), sources[arm].identity, `${arm} changed during replay`) }
report.complete = true
await save()
