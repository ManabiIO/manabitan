#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {BlobReader, ZipReader} from '@zip.js/zip.js'
import {readDenseZipDirectory} from '../../../ext/js/dictionary/dense-zip-directory.js'
import {hashTermKeyBytes} from '../../../ext/js/dictionary/term-key-hash.js'
import {RawZipPayloadReader} from '../../../ext/js/dictionary/term-bank-source-pipeline.js'
import {getImageMediaTypeFromFileName} from '../../../ext/js/media/media-util.js'
import {negativeCases, openNegativeBanks} from './negative-fixtures.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'baseline-root': {type: 'string'},
    'candidate-root': {type: 'string', default: root},
    'prefix-first-root': {type: 'string'},
    'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
    'disable-glossary-reuse': {type: 'boolean', default: false},
    'negative-fixtures': {type: 'boolean', default: false},
    out: {type: 'string'},
}})
assert(values['baseline-root'], 'Provide --baseline-root')
assert(values.out, 'Provide a fresh --out path')
assert(values['prefix-first-root'], 'Provide --prefix-first-root')
const parserWorkers = 3
const experiments = values['disable-glossary-reuse'] ? {experimentalValidatedGlossaryReuse: false} : {}
assert(!values['negative-fixtures'] || (!values['disable-glossary-reuse'] && positionals.length === 0), 'Synthetic negatives require enabled reuse and no corpus positional argument')
const dictionaries = values['negative-fixtures'] ? negativeCases : (positionals.length > 0 ? positionals : ['jmdict'])
const lockBytes = await readFile(path.join(root, 'test/perf/dictionaries.lock.json'))
const fixtures = JSON.parse(lockBytes).dictionaries
if (!values['negative-fixtures']) { for (const id of dictionaries) { assert(fixtures[id], `Unknown dictionary: ${id}`) } }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const sourceFiles = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/media/media-util.js',
    'ext/lib/term-bank-parser.wasm',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
]
const sourceIdentity = async (sourceRoot) => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(sourceRoot, file)))])))
const roots = {baseline: path.resolve(values['baseline-root']), prefixFirst: path.resolve(values['prefix-first-root']), candidate: path.resolve(values['candidate-root'])}
const sources = {}
for (const [arm, sourceRoot] of Object.entries(roots)) {
    // Explicit local CLI paths, never paths from dictionary contents.
    // eslint-disable-next-line no-unsanitized/method
    const artifacts = await import(pathToFileURL(path.join(sourceRoot, 'dev/dictionary-wasm.js')))
    artifacts.loadDictionaryWasm()
    const manifest = artifacts.getDictionaryWasmManifest()
    const moduleBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    assert.equal(sha256(moduleBytes), manifest.targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
    const url = pathToFileURL(path.join(sourceRoot, sourceFiles[0]))
    url.searchParams.set('component-arm', arm)
    // Each frozen source has its own parser heap; no elapsed times are recorded.
    // eslint-disable-next-line no-unsanitized/method
    const parser = await import(url)
    // eslint-disable-next-line no-unsanitized/method
    const preparation = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[3])))
    const module = await WebAssembly.compile(moduleBytes)
    parser.setTermBankWasmModule(module)
    sources[arm] = {parser, preparation, identity: await sourceIdentity(sourceRoot), moduleBytes: moduleBytes.byteLength}
}
assert.notEqual(sources.baseline.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'])
assert.notEqual(sources.prefixFirst.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'])
for (const file of sourceFiles.filter((file) => file.endsWith('.js'))) {
    assert.equal(sources.baseline.identity[file], sources.candidate.identity[file], `Unexpected JavaScript difference: ${file}`)
    assert.equal(sources.baseline.identity[file], sources.prefixFirst.identity[file], `Unexpected prefix-first JavaScript difference: ${file}`)
}

// Reproduce the importer's existing byte-balanced groups for an explicit
// worker policy, then replay one group at a time without worker concurrency.
function partition(entries, groupsPerWorker) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const count = Math.min(entries.length, Math.max(parserWorkers * groupsPerWorker, Math.ceil(total / (24 * 1024 * 1024))))
    const groups = []
    let start = 0
    let consumed = 0
    for (let index = 0; index < count - 1; ++index) {
        const remaining = count - index
        const target = (total - consumed) / remaining
        let end = start + 1
        let bytes = entries[start].uncompressedSize
        const maxEnd = entries.length - (remaining - 1)
        while (end < maxEnd) {
            const next = bytes + entries[end].uncompressedSize
            if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
            bytes = next
            ++end
        }
        groups.push(entries.slice(start, end))
        start = end
        consumed += bytes
    }
    groups.push(entries.slice(start))
    return groups
}

function digestValue(digest, value) {
    if (ArrayBuffer.isView(value)) {
        digest.update(JSON.stringify([value.constructor.name, value.byteLength]))
        digest.update(bytesOf(value))
    } else if (Array.isArray(value)) {
        digest.update(`array:${value.length}[`)
        for (const item of value) { digestValue(digest, item) }
        digest.update(']')
    } else if (value !== null && typeof value === 'object') {
        digest.update('{')
        for (const key of Object.keys(value).sort()) {
            digest.update(JSON.stringify(key))
            digestValue(digest, value[key])
        }
        digest.update('}')
    } else {
        digest.update(typeof value === 'undefined' ? 'undefined' : JSON.stringify(value))
    }
}

function digestPlan(digest, plan) {
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
    for (const view of [plan.stringLengths, offsets, hashes, plan.stringsBuffer, plan.expressionIndexes, plan.readingIndexes]) { digestValue(digest, view) }
}

function digestChunk(chunk) {
    const digest = createHash('sha256')
    for (const key of ['rowCount', 'contentRowStart', 'expressionBytesList', 'readingBytesList', 'readingEqualsExpressionList',
        'scoreList', 'sequenceList', 'contentBytesList', 'contentHash1List', 'contentHash2List', 'contentBytesBuffer',
        'contentBytesBaseOffset', 'contentBytesLength', 'contentMetaList', 'contentMetaByUniqueIndex', 'contentUniqueIndexList',
        'contentDedupPlan', 'useResolvedContentReferences', 'mediaRows']) {
        digestValue(digest, [key, chunk[key]])
    }
    digestPlan(digest, chunk.termRecordPreinternedPlan)
    for (const [key, {bytes, preinternedPlan}] of chunk.preparedLookupIndexes) {
        digestValue(digest, key)
        digestValue(digest, bytes)
        digestPlan(digest, preinternedPlan)
    }
    return digest.digest('hex')
}

async function openTermBanks(archivePath) {
    const archive = await openAsBlob(archivePath)
    const dense = await readDenseZipDirectory(archive)
    const zip = dense === null ? new ZipReader(new BlobReader(archive), {useWebWorkers: false}) : null
    const entries = dense ?? await zip.getEntries()
    const payloads = new RawZipPayloadReader(archive)
    const signal = new AbortController().signal
    return {
        entries: entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5))),
        mediaHintFastScan: entries.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null),
        close: async () => { await zip?.close() },
        read: async (entry) => ({bytes: await payloads.read(entry, signal), compressionMethod: entry.compressionMethod,
            compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, signature: entry.signature, filename: entry.filename}),
    }
}

async function replayGroup(source, banks, mediaHintFastScan) {
    const {parser, preparation} = source
    let owned
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(banks, experiments, true)
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        assert.equal(owned, undefined, 'Expected one complete group')
        owned = parser.copyWasmBackedColumnChunk(chunk)
    }, 2048, {singleChunk: true, maxPendingChunks: 1, emitTermByteLists: false, computeContentHashes: true,
        emitContentSlab: true, emitTokenBinaryContent: true, compactContentMetadata: true,
        mediaHintFastScan, validateGlossaryTypes: true, prepareLookupIndexes: true, preloadedSource, ...experiments})
    assert(owned, 'Parser omitted group')
    owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
    assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
    const profile = parser.consumeLastTermBankWasmParseProfile()
    // Complete equality checks run before another parse can reset an arena.
    // Score/sequence constructors are preserved and timing is not collected.
    return {rows: owned.rowCount, digest: digestChunk(owned), scoreType: owned.scoreList.constructor.name,
        sequenceType: owned.sequenceList.constructor.name,
        profile: {...Object.fromEntries(Object.entries(profile).filter(([key]) => !key.endsWith('Ms'))),
            sourceCrcScannedBytes: preloadedSource.crcScannedBytes ?? 0, sourceCrcReusedBytes: preloadedSource.crcReusedBytes ?? 0,
            sourceCrcReusedGlossaryCount: preloadedSource.crcReusedGlossaryCount ?? 0}}
}

const report = {schema: 1, complete: false,
    boundary: 'Untimed output and admission coverage only. One complete source group is retained at a time. Baseline, frozen prefix-first and recent-first modules use identical synchronous parser JavaScript and private output copies. This is not the actual worker shared-content, image-projection/native-escaped-key-option or lookup-route path, and its VNDB fallback counts would not be production admission counts. No performance observations are collected.',
    node: process.version, experiments, synthetic: values['negative-fixtures'],
    grouping: {parserWorkers, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    lockSha256: sha256(lockBytes), runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    derivedFromFrozenReplaySha256: '3e529c41120d06edb5226cd1e8f1b82f8c0d638c03c6e157bc8c79488e0a3c35',
    negativeFixtureHelperSha256: sha256(await readFile(new URL('./negative-fixtures.mjs', import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, {root: roots[arm],
        hashes: source.identity, moduleBytes: source.moduleBytes}])), dictionaries: []}
await mkdir(path.dirname(values.out), {recursive: true})
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
const journal = `${values.out}.observations.jsonl`
await writeFile(journal, '', {flag: 'wx'})
const save = () => writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
const retain = (observation) => appendFile(journal, JSON.stringify({context: report.current, observation}) + '\n')
try {
for (const dictionary of dictionaries) {
    let fixture
    let reader
    if (values['negative-fixtures']) {
        reader = openNegativeBanks(dictionary)
        fixture = {termRows: reader.termRows}
    } else {
        fixture = fixtures[dictionary]
        const archivePath = path.join(values['cache-dir'], fixture.cacheFile)
        const archiveDigest = createHash('sha256')
        let archiveBytes = 0
        for await (const bytes of createReadStream(archivePath)) {
            archiveDigest.update(bytes)
            archiveBytes += bytes.length
        }
        assert.equal(archiveDigest.digest('hex'), fixture.sha256)
        assert.equal(archiveBytes, fixture.sizeBytes)
        reader = await openTermBanks(archivePath)
    }
    try {
        const groupsPerWorker = reader.mediaHintFastScan ? 3 : 4
        const groups = values['negative-fixtures'] ? [reader.entries] : partition(reader.entries, groupsPerWorker)
        const result = {dictionary, archiveSha256: fixture.sha256, mediaHintFastScan: reader.mediaHintFastScan,
            groupsPerWorker: values['negative-fixtures'] ? null : groupsPerWorker,
            syntheticSourceSha256: reader.sourceSha256, syntheticSpec: reader.spec,
            banks: reader.entries.length, totalGroups: groups.length, rows: 0, groups: []}
        report.dictionaries.push(result)
        for (const [index, group] of groups.entries()) {
            report.current = {dictionary, group: index, phase: 'read'}
            const banks = []
            for (const entry of group) { banks.push(await reader.read(entry)) }
            const verification = {}
            result.groups.push({firstBank: group[0].filename, lastBank: group.at(-1).filename,
                compressedBytes: banks.reduce((sum, bank) => sum + bank.compressedSize, 0),
                sourceBytes: banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0),
                verification})
            for (const arm of ['baseline', 'prefixFirst', 'candidate']) {
                report.current = {dictionary, group: index, phase: 'verification', arm}
                verification[arm] = await replayGroup(sources[arm], banks, reader.mediaHintFastScan)
                await retain(verification[arm])
            }
            const expected = verification.baseline
            const check = (value) => {
                assert.equal(value.digest, expected.digest, `${dictionary} group ${index}: output mismatch`)
                assert.equal(value.rows, expected.rows)
                assert.equal(value.scoreType, expected.scoreType)
                assert.equal(value.sequenceType, expected.sequenceType)
                if (values['disable-glossary-reuse']) { assert.equal(value.profile.validatedGlossaryReuseCount, 0) }
            }
            check(verification.baseline)
            check(verification.candidate)
            check(verification.prefixFirst)
            if (values['negative-fixtures']) {
                assert.equal(verification.baseline.profile.validatedGlossaryReuseCount, 0)
                if (dictionary === 'nonlocal-reuse') { assert(verification.candidate.profile.validatedGlossaryReuseCount > 9000) }
                else { assert.equal(verification.candidate.profile.validatedGlossaryReuseCount, 0) }
            }
            result.rows += expected.rows
            await save()
            console.log(`${dictionary} ${index + 1}/${groups.length}: ${expected.rows} rows, exact output; witnesses baseline/prefix-first/recent-first ${verification.baseline.profile.validatedGlossaryReuseCount}/${verification.prefixFirst.profile.validatedGlossaryReuseCount}/${verification.candidate.profile.validatedGlossaryReuseCount}`)
            globalThis.gc?.()
        }
        assert.equal(result.rows, fixture.termRows)
    } finally { await reader.close() }
}
for (const [arm, sourceRoot] of Object.entries(roots)) { assert.deepEqual(await sourceIdentity(sourceRoot), sources[arm].identity, `${arm} changed during replay`) }
report.complete = true
delete report.current
await save()
} catch (error) {
    report.failure = {name: error.name, message: error.message, stack: error.stack}
    await save()
    throw error
}
