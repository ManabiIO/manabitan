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
    'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
    'parser-workers': {type: 'string', default: '3'},
    pairs: {type: 'string', default: '6'},
    'max-groups': {type: 'string', default: '0'},
    'disable-glossary-reuse': {type: 'boolean', default: false},
    'negative-fixtures': {type: 'boolean', default: false},
    out: {type: 'string'},
}})
assert(values['baseline-root'], 'Provide --baseline-root')
assert(values.out, 'Provide a fresh --out path')
const parserWorkers = Number(values['parser-workers'])
const pairs = Number(values.pairs)
const maxGroups = Number(values['max-groups'])
const experiments = values['disable-glossary-reuse'] ? {experimentalValidatedGlossaryReuse: false} : {}
assert([2, 3, 5].includes(parserWorkers))
assert(Number.isInteger(pairs) && pairs > 0 && pairs <= 12)
assert(Number.isInteger(maxGroups) && maxGroups >= 0)
assert(!values['negative-fixtures'] || (!values['disable-glossary-reuse'] && positionals.length === 0), 'Synthetic negatives require enabled reuse and no corpus positional argument')
const dictionaries = values['negative-fixtures'] ? negativeCases : (positionals.length > 0 ? positionals : ['jmdict', 'jitendex', 'vndb'])
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
const roots = {baseline: path.resolve(values['baseline-root']), candidate: path.resolve(values['candidate-root'])}
const sources = {}
for (const [arm, sourceRoot] of Object.entries({...roots, control: roots.baseline})) {
    // Explicit local CLI paths, never paths from dictionary contents.
    // eslint-disable-next-line no-unsanitized/method
    const artifacts = await import(pathToFileURL(path.join(sourceRoot, 'dev/dictionary-wasm.js')))
    artifacts.loadDictionaryWasm()
    const manifest = artifacts.getDictionaryWasmManifest()
    const moduleBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    assert.equal(sha256(moduleBytes), manifest.targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
    const url = pathToFileURL(path.join(sourceRoot, sourceFiles[0]))
    url.searchParams.set('component-arm', arm)
    // Each arm has its own parser heap; control executes identical baseline code.
    // eslint-disable-next-line no-unsanitized/method
    const parser = await import(url)
    // eslint-disable-next-line no-unsanitized/method
    const preparation = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[3])))
    const compileStart = performance.now()
    const module = await WebAssembly.compile(moduleBytes)
    const compileMs = performance.now() - compileStart
    parser.setTermBankWasmModule(module)
    sources[arm] = {parser, preparation, identity: await sourceIdentity(sourceRoot), compileMs, moduleBytes: moduleBytes.byteLength}
}
assert.notEqual(sources.baseline.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'])
assert.deepEqual(sources.control.identity, sources.baseline.identity)
for (const file of sourceFiles.filter((file) => file.endsWith('.js'))) {
    assert.equal(sources.baseline.identity[file], sources.candidate.identity[file], `Unexpected JavaScript difference: ${file}`)
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
    const started = performance.now()
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(banks, experiments, true)
    const inflated = performance.now()
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        assert.equal(owned, undefined, 'Expected one complete group')
        owned = parser.copyWasmBackedColumnChunk(chunk)
    }, 2048, {singleChunk: true, maxPendingChunks: 1, emitTermByteLists: false, computeContentHashes: true,
        emitContentSlab: true, emitTokenBinaryContent: true, compactContentMetadata: true,
        mediaHintFastScan, validateGlossaryTypes: true, prepareLookupIndexes: true, preloadedSource, ...experiments})
    assert(owned, 'Parser omitted group')
    owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
    assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
    const completed = performance.now()
    const profile = parser.consumeLastTermBankWasmParseProfile()
    // Complete equality checks run after the timer, before another parse can
    // reset an arena. Score and sequence constructors are never coerced.
    return {totalMs: completed - started, inflateMs: inflated - started, parseCopyLookupMs: completed - inflated,
        rows: owned.rowCount, digest: digestChunk(owned), scoreType: owned.scoreList.constructor.name,
        sequenceType: owned.sequenceList.constructor.name,
        profile: {...profile, sourceInflateMs: preloadedSource.inflateMs, sourceCrcMs: preloadedSource.crcMs ?? 0,
            sourceCrcScannedBytes: preloadedSource.crcScannedBytes ?? 0, sourceCrcReusedBytes: preloadedSource.crcReusedBytes ?? 0,
            sourceCrcReusedGlossaryCount: preloadedSource.crcReusedGlossaryCount ?? 0}}
}

const report = {schema: 1, complete: false,
    boundary: 'Sequential complete native ZIP payload inflation/CRC, parser validation, canonical content, lookup construction and private owned output copy. This does not reproduce worker shared-content transport, image projection or lookup route construction. ZIP directory and payload reads, WASM compile, result digests, storage/media import and browser scheduling are outside the timer. One bounded source group is retained at a time. Each arm owns a separate parser instance. Cold first group per instance is reported separately; each group has verification runs excluded from the warm summary, then the prescribed alternating treatment and source-identical control pairs. No end-to-end import claim.',
    node: process.version, pairs, maxGroups, experiments, synthetic: values['negative-fixtures'],
    grouping: {parserWorkers, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    lockSha256: sha256(lockBytes), runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    negativeFixtureHelperSha256: sha256(await readFile(new URL('./negative-fixtures.mjs', import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, {root: arm === 'control' ? roots.baseline : roots[arm],
        hashes: source.identity, compileMs: source.compileMs, moduleBytes: source.moduleBytes}])), dictionaries: []}
await mkdir(path.dirname(values.out), {recursive: true})
await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
const journal = `${values.out}.observations.jsonl`
await writeFile(journal, '', {flag: 'wx'})
const save = () => writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
const retain = (observation) => appendFile(journal, JSON.stringify({context: report.current, observation}) + '\n')
let firstGroup = true
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
        const allGroups = values['negative-fixtures'] ? [reader.entries] : partition(reader.entries, groupsPerWorker)
        const groups = maxGroups === 0 ? allGroups : allGroups.slice(0, maxGroups)
        const result = {dictionary, archiveSha256: fixture.sha256, mediaHintFastScan: reader.mediaHintFastScan,
            groupsPerWorker: values['negative-fixtures'] ? null : groupsPerWorker,
            syntheticSourceSha256: reader.sourceSha256, syntheticSpec: reader.spec,
            banks: reader.entries.length, totalGroups: allGroups.length, rows: 0, groups: []}
        report.dictionaries.push(result)
        for (const [index, group] of groups.entries()) {
            report.current = {dictionary, group: index, phase: 'read'}
            const banks = []
            for (const entry of group) { banks.push(await reader.read(entry)) }
            const verification = {}
            const observations = []
            result.groups.push({firstBank: group[0].filename, lastBank: group.at(-1).filename,
                compressedBytes: banks.reduce((sum, bank) => sum + bank.compressedSize, 0),
                sourceBytes: banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0),
                firstInvocation: firstGroup, verification, observations})
            for (const arm of ['baseline', 'candidate', 'control']) {
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
            check(verification.control)
            if (values['negative-fixtures']) {
                assert.equal(verification.baseline.profile.validatedGlossaryReuseCount, 0)
                if (dictionary === 'nonlocal-reuse') { assert(verification.candidate.profile.validatedGlossaryReuseCount > 9000) }
                else { assert.equal(verification.candidate.profile.validatedGlossaryReuseCount, 0) }
            }
            for (let pair = 0; pair < pairs; ++pair) {
                for (const comparison of pair % 2 === 0 ? ['treatment', 'control'] : ['control', 'treatment']) {
                    const alternate = comparison === 'treatment' ? 'candidate' : 'control'
                    const order = pair % 2 === 0 ? ['baseline', alternate] : [alternate, 'baseline']
                    const arms = {}
                    observations.push({pair, comparison, order, arms})
                    for (const arm of order) {
                        report.current = {dictionary, group: index, phase: comparison, pair, arm}
                        arms[arm] = await replayGroup(sources[arm], banks, reader.mediaHintFastScan)
                        await retain(arms[arm])
                        check(arms[arm])
                    }
                }
            }
            result.rows += expected.rows
            firstGroup = false
            await save()
            console.log(`${dictionary} ${index + 1}/${groups.length}: ${expected.rows} rows, exact output; glossary witnesses ${verification.baseline.profile.validatedGlossaryReuseCount} -> ${verification.candidate.profile.validatedGlossaryReuseCount}`)
            globalThis.gc?.()
        }
        if (maxGroups === 0 || maxGroups >= allGroups.length) { assert.equal(result.rows, fixture.termRows) }
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
