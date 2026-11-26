#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
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
        'out': {type: 'string'},
    }})
assert(values['baseline-root'], 'Provide --baseline-root')
const parserWorkers = Number(values['parser-workers'])
assert([2, 3, 5].includes(parserWorkers), 'Provide --parser-workers 2, 3 or 5; the browser selects this policy from hardware and memory hints')
assert.equal(positionals.length, 1, 'Run each corpus in a fresh process so WASM heaps do not carry over')
const dictionaries = positionals
const output = values.out ?? path.join(root, `builds/perf/native-metadata/workers-${parserWorkers}-${positionals[0]}.json`)
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
    'ext/js/media/media-util.js',
    'ext/js/dictionary/term-bank-source-crc.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-lookup-route.js',
    'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
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
    // eslint-disable-next-line no-unsanitized/method
    const route = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-lookup-route.js')))
    // eslint-disable-next-line no-unsanitized/method
    const experiments = await import(pathToFileURL(path.join(sourceRoot, 'ext/js/dictionary/term-bank-experiments.js')))
    const identity = await sourceIdentity(sourceRoot)
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'dev/data/dictionary-wasm/manifest.json')))
    const pinnedWasm = manifest.targets.find((target) => target.name === 'term-bank-parser.wasm').sha256
    assert.equal(identity['ext/lib/term-bank-parser.wasm'], pinnedWasm, `${arm}: runtime WASM must match the manifest`)
    assert.equal(identity['dev/data/dictionary-wasm/term-bank-parser.wasm'], pinnedWasm, `${arm}: checked-in WASM must match the manifest`)
    if (arm === 'baseline') { assert.equal(pinnedWasm, 'b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa', 'Control must retain the exact current-baseline WASM') }
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))))
    const git = (...args) => execFileSync('git', args, {cwd: sourceRoot, encoding: 'utf8'}).trim()
    sources[arm] = {parser, preparation, route, experiments, identity, git: {sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), status: git('status', '--porcelain')}}
}
assert.notEqual(sources.baseline.identity['ext/lib/term-bank-parser.wasm'], sources.candidate.identity['ext/lib/term-bank-parser.wasm'], 'Expected a native candidate')

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
    const selectBanks = (entries) => ({
        entries: entries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5))),
        hasArchiveImages: entries.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null),
    })
    const dense = await readDenseZipDirectory(archive)
    const reader = dense === null ? new ZipReader(new BlobReader(archive), {useWebWorkers: false}) : null
    const entries = dense ?? await reader.getEntries()
    const payloads = new RawZipPayloadReader(archive)
    const signal = new AbortController().signal
    return {...selectBanks(entries),
        close: async () => { await reader?.close() },
        read: async (entry) => {
            const bytes = await payloads.read(entry, signal)
            // Independent zlib/CRC checks bind the native source transaction
            // to the exact complete ZIP payload and central-directory identity.
            const inflated = entry.compressionMethod === 8 ? inflateRawSync(bytes) : bytes
            assert.equal(inflated.byteLength, entry.uncompressedSize)
            assert.equal(crc32(inflated), entry.signature)
            return {bytes,
                compressionMethod: entry.compressionMethod,
                compressedSize: entry.compressedSize,
                uncompressedSize: entry.uncompressedSize,
                signature: entry.signature,
                filename: entry.filename}
        }}
}

async function replayGroup(source, banks, policy) {
    const {parser, preparation, route, experiments} = source
    const options = {...experiments.snapshotTermBankExperiments({experimentalNativeEscapedKeys: policy.projectImagePaths}), ...policy}
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(banks, options, true)
    let result
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        assert.equal(result, undefined, 'Expected one complete group')
        const nativePrepared = chunk.preparedLookupIndexes instanceof Map
        const owned = parser.copyWasmBackedColumnChunk(chunk, false, policy.projectImagePaths, policy.prepareLookupRoute, preloadedSource)
        owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
        assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
        const digest = createHash('sha256')
        const buffers = new Set()
        let keys = 0
        let aliasedLengthKeys = 0
        let omittedOffsetKeys = 0
        for (const [key, prepared] of owned.preparedLookupIndexes) {
            const {bytes, preinternedPlan: plan} = prepared
            if (policy.prepareLookupRoute) { prepared.routeFilter ??= route.buildTermLookupFilter(plan.stringHashes) }
            digest.update(key)
            digest.update(bytes)
            digest.update(prepared.routeFilter === null || typeof prepared.routeFilter === 'undefined' ? 'no-route-filter' : viewBytes(prepared.routeFilter))
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
            const meta = (owned.contentMetaByUniqueIndex ? owned.contentUniqueIndexList[row] : row) * 4
            const offset = owned.contentBytesBaseOffset + owned.contentMetaList[meta]
            digest.update(owned.contentBytesBuffer.subarray(offset, offset + owned.contentMetaList[meta + 1]))
            digest.update(viewBytes(owned.contentMetaList.subarray(meta + 1, meta + 4)))
        }
        if (owned.contentUniqueIndexList !== null) { digest.update(viewBytes(owned.contentUniqueIndexList)) }
        if (owned.contentDedupPlan !== null) {
            digest.update(JSON.stringify([owned.contentDedupPlan.uniqueCount, owned.contentDedupPlan.sourceRowCount]))
            for (const field of ['uniqueRowIndexes', 'uniqueSignatures']) {
                const view = owned.contentDedupPlan[field]
                if (ArrayBuffer.isView(view)) { digest.update(viewBytes(view)) }
            }
        }
        digest.update(JSON.stringify(owned.mediaRows))
        result = {rows: owned.rowCount,
            nativePrepared,
            stringBytes: owned.termRecordPreinternedPlan.stringsBuffer.byteLength,
            mediaRows: owned.mediaRows.length,
            keys,
            aliasedLengthKeys,
            omittedOffsetKeys,
            preparedBuffers: buffers.size,
            preparedBufferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
            digest: digest.digest('hex')}
    }, 2048, {
        ...options,
        preloadedSource,
        compactContentMetadata: true,
        maxPendingChunks: 1,
        singleChunk: true,
        emitTermByteLists: false,
        computeContentHashes: true,
        emitContentSlab: true,
        emitTokenBinaryContent: true,
        mediaHintFastScan: policy.mediaHintFastScan,
        validateGlossaryTypes: true,
        prepareLookupIndexes: true,
    })
    assert(result, 'Parser omitted group')
    const profile = parser.consumeLastTermBankWasmParseProfile()
    if (preloadedSource.crcSignaturesPtr) { assert.equal(preloadedSource.crcVerified, true, 'Deferred source CRC transaction must complete before publication') }
    return {...result,
        nativeSegments: profile.nativeSegmentedLookupSegments ?? 0,
        nativeFallbacks: profile.nativeSegmentedLookupFallbacks ?? 0,
        scratchReuseGroups: profile.nativeLookupScratchReuseGroups ?? 0,
        scratchReuseBytes: profile.nativeLookupScratchReusedBytes ?? 0,
        scratchReuseMisses: profile.nativeLookupScratchReuseMisses ?? 0,
        fusedAttempts: profile.fusedParseAttempts ?? 0,
        fusedFallbacks: profile.fusedParseFallbacks ?? 0,
        heapBytes: profile.maxWasmHeapBytes ?? 0,
        metadataBytes: profile.metaAllocatedBytes,
        metaCapacity: profile.metaCapacity,
        encodedContentBytes: profile.encodedContentBytes,
        contentCapacity: profile.contentCapacity,
        crcScannedBytes: preloadedSource.crcScannedBytes ?? 0,
        crcReusedBytes: preloadedSource.crcReusedBytes ?? 0,
        crcReusedGlossaries: preloadedSource.crcReusedGlossaryCount ?? 0}
}

const report = {schema: 1,
    complete: false,
    boundary: 'Sequential compressed-source native parser, production image projection and completed lookup/route construction with owned output. All locked term banks; independent zlib/CRC checks, canonical row content, metadata, media rows, every lookup byte and semantic key-plan columns compared. Fresh process per corpus/policy; no browser scheduling, storage, media payload import, performance or process peak-memory claim.',
    grouping: {kind: 'component model of lazy byte balancing with an explicit worker count', parserWorkers, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    node: process.version,
    lockSha256: sha256(lockBytes),
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm, {root: roots[arm], hashes: source.identity, git: source.git}])),
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
        const totalSourceBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
        const policy = {mediaHintFastScan, projectImagePaths: mediaHintFastScan && totalSourceBytes >= 1024 * 1024 * 1024, prepareLookupRoute: totalSourceBytes >= 128 * 1024 * 1024}
        const groupsPerWorker = mediaHintFastScan ? 3 : 4
        const groups = partition(entries, groupsPerWorker)
        const result = {dictionary,
            archiveSha256: fixture.sha256,
            policy,
            totalSourceBytes,
            groupsPerWorker,
            minimumGroups: parserWorkers * groupsPerWorker,
            banks: entries.length,
            rows: 0,
            nativeSegments: 0,
            nativeFallbacks: 0,
            baseline: {scratchReuseGroups: 0, scratchReuseBytes: 0, scratchReuseMisses: 0, fusedAttempts: 0, fusedFallbacks: 0, maxHeapBytes: 0, metadataBytes: 0},
            candidate: {scratchReuseGroups: 0, scratchReuseBytes: 0, scratchReuseMisses: 0, fusedAttempts: 0, fusedFallbacks: 0, maxHeapBytes: 0, metadataBytes: 0},
            groups: []}
        report.dictionaries.push(result)
        for (const [index, group] of groups.entries()) {
            const banks = []
            for (const entry of group) { banks.push(await reader.read(entry)) }
            const baseline = await replayGroup(sources.baseline, banks, policy)
            const candidate = await replayGroup(sources.candidate, banks, policy)
            const observation = {firstBank: group[0].filename,
                lastBank: group.at(-1).filename,
                sourceBytes: banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0),
                baseline,
                candidate}
            result.groups.push(observation)
            await save()
            assert.equal(candidate.digest, baseline.digest, `${dictionary} group ${index}: output mismatch`)
            assert.equal(candidate.rows, baseline.rows)
            assert.equal(candidate.nativeSegments, baseline.nativeSegments)
            assert.equal(candidate.nativeFallbacks, baseline.nativeFallbacks)
            assert.equal(candidate.keys, baseline.keys)
            for (const key of ['nativePrepared', 'scratchReuseGroups', 'scratchReuseMisses', 'fusedAttempts', 'fusedFallbacks', 'crcScannedBytes', 'crcReusedBytes', 'crcReusedGlossaries', 'mediaRows']) {
                assert.equal(candidate[key], baseline[key], `${dictionary} group ${index}: ${key}`)
            }
            assert.equal(candidate.scratchReuseMisses, 0, 'Compacted metadata must retain native lookup scratch capacity')
            for (const [arm, value] of Object.entries({baseline, candidate})) {
                for (const key of ['scratchReuseGroups', 'scratchReuseBytes', 'scratchReuseMisses', 'fusedAttempts', 'fusedFallbacks', 'metadataBytes']) { result[arm][key] += value[key] }
                result[arm].maxHeapBytes = Math.max(result[arm].maxHeapBytes, value.heapBytes)
            }
            result.rows += candidate.rows
            result.nativeSegments += candidate.nativeSegments
            result.nativeFallbacks += candidate.nativeFallbacks
            await save()
            if (index === 0 || index + 1 === groups.length || (index + 1) % 20 === 0) { console.log(`${dictionary} ${index + 1}/${groups.length}: ${candidate.rows} rows, scratch misses ${candidate.scratchReuseMisses}, exact output/CRC/route parity`) }
            globalThis.gc?.()
        }
        assert.equal(result.rows, fixture.termRows)
    } finally { await reader.close() }
}
for (const [arm, sourceRoot] of Object.entries(roots)) { assert.deepEqual(await sourceIdentity(sourceRoot), sources[arm].identity, `${arm} changed during replay`) }
report.complete = true
await save()
