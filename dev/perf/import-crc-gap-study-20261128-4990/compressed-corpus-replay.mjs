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
import {BlobReader, ZipReader} from '@zip.js/zip.js'
import {readDenseZipDirectory} from '../../../ext/js/dictionary/dense-zip-directory.js'
import {hashTermKeyBytes} from '../../../ext/js/dictionary/term-key-hash.js'
import {RawZipPayloadReader} from '../../../ext/js/dictionary/term-bank-source-pipeline.js'
import {getImageMediaTypeFromFileName} from '../../../ext/js/media/media-util.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {values, positionals} = parseArgs({allowPositionals: true,
    options: {
        'baseline-root': {type: 'string'},
        'candidate-root': {type: 'string', default: root},
        'cache-dir': {type: 'string', default: path.join(root, 'builds/e2e-dictionary-cache')},
        'parser-workers': {type: 'string'},
        'pairs': {type: 'string', default: '1'},
        'out': {type: 'string'},
    }})
assert(values['baseline-root'], 'Provide --baseline-root')
const parserWorkers = Number(values['parser-workers'])
assert([2, 3, 5].includes(parserWorkers), 'Provide --parser-workers 2, 3 or 5; the browser selects this policy from hardware and memory hints')
const pairs = Number(values.pairs)
assert(Number.isInteger(pairs) && pairs > 0 && pairs <= 4)
const output = values.out ?? path.join(root, `builds/perf/crc-gap-compressed-parity/workers-${parserWorkers}.json`)
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
    'ext/js/dictionary/term-bank-source-crc.js',
    'ext/js/media/media-util.js',
    'ext/lib/term-bank-parser.wasm',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
]
const sourceIdentity = async (sourceRoot) => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(sourceRoot, file)))])))
const roots = {baseline: path.resolve(values['baseline-root']), candidate: path.resolve(values['candidate-root'])}
const sources = {}
for (const [arm, sourceRoot] of Object.entries(roots)) {
    // A source edit and its packaged module must be one source-bound build
    // before any corpus work starts, even if another build is still running.
    // eslint-disable-next-line no-unsanitized/method
    const nativeArtifacts = await import(pathToFileURL(path.join(sourceRoot, 'dev/dictionary-wasm.js')))
    nativeArtifacts.loadDictionaryWasm()
    const manifest = nativeArtifacts.getDictionaryWasmManifest()
    const moduleBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    assert.equal(sha256(moduleBytes), manifest.targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
    // Explicit local CLI paths, never paths from dictionary contents.
    // eslint-disable-next-line no-unsanitized/method
    const parser = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[0])))
    // eslint-disable-next-line no-unsanitized/method
    const preparation = await import(pathToFileURL(path.join(sourceRoot, sourceFiles[3])))
    parser.setTermBankWasmModule(await WebAssembly.compile(moduleBytes))
    sources[arm] = {parser, preparation, identity: await sourceIdentity(sourceRoot)}
}
assert.notEqual(sources.baseline.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'])
for (const file of sourceFiles.filter((file) => file.endsWith('.js'))) {
    assert.equal(sources.baseline.identity[file], sources.candidate.identity[file], `Unexpected JavaScript difference: ${file}`)
}

// Model lazy byte balancing for an explicitly selected worker count. Actual
// browser selection depends on hardware and memory hints. Plain banks use four
// groups per worker; media-aware banks use three. Execute groups serially: this
// component check does not reproduce browser scheduling or complete imports.
function partition(entries, groupsPerWorker) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const groupCount = Math.min(entries.length, Math.max(parserWorkers * groupsPerWorker, Math.ceil(total / (24 * 1024 * 1024))))
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
    let entries = await readDenseZipDirectory(archive)
    let reader = null
    if (entries === null) {
        reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
        entries = await reader.getEntries()
    }
    const payloads = new RawZipPayloadReader(archive)
    const signal = new AbortController().signal
    return {
        entries: entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5))),
        hasArchiveImages: entries.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null),
        close: async () => { await reader?.close() },
        read: async (entry) => {
            const compressed = await payloads.read(entry, signal)
            const bytes = entry.compressionMethod === 8 ? inflateRawSync(compressed) : compressed
            assert.equal(bytes.byteLength, entry.uncompressedSize)
            assert.equal(crc32(bytes), entry.signature)
            return {
                bytes: compressed,
                compressionMethod: entry.compressionMethod,
                compressedSize: entry.compressedSize,
                uncompressedSize: entry.uncompressedSize,
                signature: entry.signature,
                filename: entry.filename,
            }
        },
    }
}

function parserOptions(mediaHintFastScan) {
    return {
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
    }
}

async function replayGroup(source, banks, mediaHintFastScan) {
    const {parser, preparation} = source
    const options = parserOptions(mediaHintFastScan)
    // This is the unchanged version-3 strict worker request, not a forced CRC
    // flag. The native helper keeps its ordinary ratio/size admission checks.
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(banks, options, true)
    const deferred = (preloadedSource.crcSignaturesPtr ?? 0) > 0
    let result
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        if (deferred) { assert.equal(preloadedSource.crcVerified, true) }
        assert.equal(result, undefined, 'Expected one complete group')
        const owned = parser.copyWasmBackedColumnChunk(chunk)
        owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
        assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
        const digest = createHash('sha256')
        const native = chunk.preparedLookupIndexes instanceof Map
        let keys = 0
        let nativeIndexCount = 0
        let outputBytes = 0
        let initializationBytesAvoided = 0
        for (const [key, {bytes, preinternedPlan: plan}] of owned.preparedLookupIndexes) {
            digest.update(key)
            digest.update(bytes)
            digestPlan(digest, plan)
            keys += plan.stringLengths.length
            if (native) {
                ++nativeIndexCount
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                const baseLength = view.getUint32(8, true)
                const derivedLength = view.getUint32(12, true)
                const rows = view.getUint32(16, true)
                const keyCount = view.getUint32(20, true)
                const stringLength = view.getUint32(24, true)
                const sequenceKeys = view.getUint32(32, true)
                const derived = 16 + baseLength
                const keySlots = view.getUint32(derived + 8, true)
                const sequenceSlots = view.getUint32(derived + 12, true)
                const readingPostings = view.getUint32(derived + 16, true)
                const sequencePostings = view.getUint32(derived + 24, true)
                const alignedStringLength = Math.ceil(stringLength / 4) * 4
                const baseColumns = (keyCount + 3 * rows) * 2
                const derivedColumns = (keySlots + keyCount + 2 * (keyCount + 1) + rows + readingPostings +
                sequenceSlots + sequenceKeys + sequenceKeys + 1 + sequencePostings) * 2
                assert.equal(16 + baseLength + derivedLength, bytes.byteLength)
                assert.equal(baseLength, 32 + alignedStringLength + Math.ceil(baseColumns / 4) * 4 + sequenceKeys * 4)
                assert.equal(derivedLength, 32 + Math.ceil(derivedColumns / 4) * 4)
                const requiredZeroBytes = 8 + alignedStringLength - stringLength +
                Math.ceil(baseColumns / 4) * 4 - baseColumns + derivedLength - 32 - derivedColumns +
                4 * (keyCount + 1) + 2 * (sequenceKeys + 1)
                initializationBytesAvoided += bytes.byteLength + 2 * (keyCount + sequenceKeys) -
                requiredZeroBytes
                outputBytes += bytes.byteLength
            }
        }
        digestPlan(digest, owned.termRecordPreinternedPlan)
        for (const view of [owned.readingEqualsExpressionList, owned.scoreList, owned.sequenceList]) { digest.update(viewBytes(view)) }
        assert(owned.contentBytesBuffer && owned.contentMetaList && typeof owned.contentBytesBaseOffset === 'number')
        // The complete owned slab plus every row's descriptor and unique ID
        // proves the same content mapping without rehashing aliased content
        // millions of times. All views are captured before parser reuse.
        digest.update(owned.contentBytesBuffer)
        digest.update(viewBytes(owned.contentMetaList))
        if (owned.contentUniqueIndexList !== null) { digest.update(viewBytes(owned.contentUniqueIndexList)) }
        digest.update(JSON.stringify(owned.mediaRows))
        result = {rows: owned.rowCount,
            keys,
            nativeIndexCount,
            outputBytes,
            initializationBytesAvoided,
            digest: digest.digest('hex')}
    }, 2048, {...options, preloadedSource})
    assert(result, 'Parser omitted group')
    const profile = parser.consumeLastTermBankWasmParseProfile()
    if (deferred) {
        assert.equal(preloadedSource.crcVerified, true)
        assert.equal(preloadedSource.crcScannedBytes + preloadedSource.crcReusedBytes, preloadedSource.uncompressedBytes)
    }
    return {...result,
        sourceCrcDeferred: deferred,
        sourceCrcVerified: !deferred || preloadedSource.crcVerified === true,
        sourceCrcScannedBytes: deferred ? preloadedSource.crcScannedBytes : preloadedSource.uncompressedBytes,
        sourceCrcReusedBytes: preloadedSource.crcReusedBytes ?? 0,
        sourceCrcReusedGlossaries: preloadedSource.crcReusedGlossaryCount ?? 0,
        sourceCrcMs: preloadedSource.crcMs ?? 0,
        lookupIndexPrepareMs: profile.lookupIndexPrepareMs ?? 0,
        nativeSegments: profile.nativeSegmentedLookupSegments ?? 0,
        nativeFallbacks: profile.nativeSegmentedLookupFallbacks ?? 0}
}

async function rejectCorruptGroup(source, banks, mediaHintFastScan) {
    const options = parserOptions(mediaHintFastScan)
    let dispatched = 0
    let phase = 'inflate'
    let deferred = false
    let error
    try {
        const preloadedSource = await source.parser.inflateCompressedTermBankSourcesWasm(banks, options, true)
        deferred = (preloadedSource.crcSignaturesPtr ?? 0) > 0
        phase = 'parse'
        await source.parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3,
            () => { ++dispatched }, 2048, {...options, preloadedSource})
    } catch (caught) {
        error = caught
    }
    assert(error, 'Corrupted compressed group was accepted')
    assert.equal(error.name, 'DictionarySourceIntegrityError')
    assert.equal(dispatched, 0, 'Corruption reached the storage sink')
    return {phase, deferred, name: error.name, message: error.message, dispatched}
}

async function corruptionCases(banks, mediaHintFastScan) {
    const cases = []
    for (const index of [0, banks.length - 1]) {
        for (const fault of ['crc', 'truncate', 'trailing', 'decoded-short', 'decoded-long']) {
            const changed = banks.map((bank) => ({...bank}))
            const source = changed[index]
            if (fault === 'crc') { source.signature = (source.signature ^ 1) >>> 0 }
            if (fault === 'truncate') {
                source.bytes = source.bytes.subarray(0, source.bytes.byteLength - 1)
                source.compressedSize = source.bytes.byteLength
            }
            if (fault === 'trailing') {
                const bytes = new Uint8Array(source.bytes.byteLength + 1)
                bytes.set(source.bytes)
                source.bytes = bytes
                source.compressedSize = bytes.byteLength
            }
            if (fault === 'decoded-short') { --source.uncompressedSize }
            if (fault === 'decoded-long') { ++source.uncompressedSize }
            const baseline = await rejectCorruptGroup(sources.baseline, changed, mediaHintFastScan)
            const candidate = await rejectCorruptGroup(sources.candidate, changed, mediaHintFastScan)
            assert.deepEqual(candidate, baseline)
            cases.push({bank: source.filename, fault, baseline, candidate})
        }
    }
    return cases
}

const report = {schema: 2,
    complete: false,
    boundary: 'Sequential production compressed-source inflation, CRC admission, strict native parser, completed lookup construction and owned output. All locked term banks have independent zlib decoded-size/CRC verification; complete content, metadata, media, lookup and semantic key-plan hashes match. Native source CRC activation/reuse is checked without forcing its admission flags. Inherited initialization-byte counters are unrelated diagnostics. No complete import, browser, storage, media payload import or peak-memory claim.',
    pairs,
    grouping: {kind: 'component model of lazy byte balancing with an explicit worker count', parserWorkers, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    node: process.version,
    lockSha256: sha256(lockBytes),
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, {root: roots[arm], hashes: source.identity}])),
    dictionaries: []}
await mkdir(path.dirname(output), {recursive: true})
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
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
        // These pinned fixtures are raw term banks, without artifact media.
        // Match their importer media-hint choice from actual archive filenames.
        const mediaHintFastScan = reader.hasArchiveImages
        const groupsPerWorker = mediaHintFastScan ? 3 : 4
        const groups = partition(entries, groupsPerWorker)
        const result = {dictionary,
            archiveSha256: fixture.sha256,
            mediaHintFastScan,
            groupsPerWorker,
            minimumGroups: parserWorkers * groupsPerWorker,
            banks: entries.length,
            rows: 0,
            nativeSegments: 0,
            nativeFallbacks: 0,
            nativeIndexCount: 0,
            outputBytes: 0,
            initializationBytesAvoided: 0,
            crcDeferredGroups: 0,
            crcScannedBytes: 0,
            crcReusedBytes: 0,
            crcReusedGlossaries: 0,
            corruptionCases: [],
            groups: []}
        report.dictionaries.push(result)
        for (const [index, group] of groups.entries()) {
            const banks = []
            for (const entry of group) { banks.push(await reader.read(entry)) }
            const observations = []
            for (let pair = 0; pair < pairs; ++pair) {
                const order = pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
                const arms = {}
                for (const arm of order) { arms[arm] = await replayGroup(sources[arm], banks, mediaHintFastScan) }
                const {baseline, candidate} = arms
                assert.equal(candidate.digest, baseline.digest, `${dictionary} group ${index}: output mismatch`)
                for (const key of ['rows', 'keys', 'nativeSegments', 'nativeFallbacks', 'nativeIndexCount', 'outputBytes', 'initializationBytesAvoided', 'sourceCrcDeferred', 'sourceCrcVerified', 'sourceCrcScannedBytes', 'sourceCrcReusedBytes', 'sourceCrcReusedGlossaries']) {
                    assert.equal(candidate[key], baseline[key], `${dictionary} group ${index}: ${key}`)
                }
                observations.push({pair, order, baseline, candidate})
            }
            const {candidate} = observations[0]
            result.crcDeferredGroups += Number(candidate.sourceCrcDeferred)
            result.crcScannedBytes += candidate.sourceCrcScannedBytes
            result.crcReusedBytes += candidate.sourceCrcReusedBytes
            result.crcReusedGlossaries += candidate.sourceCrcReusedGlossaries
            result.rows += candidate.rows
            result.nativeSegments += candidate.nativeSegments
            result.nativeFallbacks += candidate.nativeFallbacks
            result.nativeIndexCount += candidate.nativeIndexCount
            result.outputBytes += candidate.outputBytes
            result.initializationBytesAvoided += candidate.initializationBytesAvoided
            result.groups.push({firstBank: group[0].filename,
                lastBank: group.at(-1).filename,
                sourceBytes: banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0),
                compressedBytes: banks.reduce((sum, bank) => sum + bank.compressedSize, 0),
                observations})
            if (index === 0) { result.corruptionCases = await corruptionCases(banks, mediaHintFastScan) }
            await save()
            console.log(`${dictionary} ${index + 1}/${groups.length}: ${candidate.rows} rows, CRC deferred=${candidate.sourceCrcDeferred}, scanned=${candidate.sourceCrcScannedBytes}, reused=${candidate.sourceCrcReusedBytes}`)
            globalThis.gc?.()
        }
        assert.equal(result.rows, fixture.termRows)
        if (dictionary === 'vndb') {
            assert.equal(result.crcDeferredGroups, groups.length)
            assert(result.crcReusedBytes > 0)
            assert(result.crcReusedGlossaries > 0)
        } else {
            assert.equal(result.crcDeferredGroups, 0)
        }
    } finally { await reader.close() }
}
for (const [arm, sourceRoot] of Object.entries(roots)) { assert.deepEqual(await sourceIdentity(sourceRoot), sources[arm].identity, `${arm} changed during replay`) }
report.complete = true
await save()
