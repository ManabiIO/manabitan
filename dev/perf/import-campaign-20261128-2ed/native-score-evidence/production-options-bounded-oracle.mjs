#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

// Independent correctness oracle with effective importer/worker route settings.
// The original conservative oracle and its receipts remain unchanged.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

const {values, positionals} = parseArgs({allowPositionals: true, options: {
    'baseline-root': {type: 'string'},
    'candidate-root': {type: 'string'},
    'cache-dir': {type: 'string'},
    'parser-workers': {type: 'string', default: '3'},
    'max-groups': {type: 'string', default: '0'},
    'group-start': {type: 'string', default: '0'},
    'group-count': {type: 'string', default: '0'},
    'group-manifest': {type: 'string'},
    'require-plan': {type: 'boolean', default: false},
    'out': {type: 'string'},
}})
assert(values['baseline-root'] && values['candidate-root'] && values.out, 'Provide explicit roots and --out')
const roots = {baseline: path.resolve(values['baseline-root']), candidate: path.resolve(values['candidate-root'])}
assert.notEqual(roots.baseline, roots.candidate)
const parserWorkers = Number(values['parser-workers'])
assert([2, 3, 5].includes(parserWorkers))
const maxGroups = Number(values['max-groups'])
assert(Number.isInteger(maxGroups) && maxGroups >= 0)
const groupStart = Number(values['group-start'])
const groupCount = Number(values['group-count'])
assert(Number.isInteger(groupStart) && groupStart >= 0)
assert(Number.isInteger(groupCount) && groupCount >= 0)
assert(maxGroups === 0, 'Bounded final coverage uses explicit group ranges, not smoke limits')
assert(values['group-manifest'], 'Provide the exact locked-corpus group manifest')
const groupManifestBytes = await readFile(path.resolve(values['group-manifest']))
const groupManifest = JSON.parse(groupManifestBytes)
const output = path.resolve(values.out)
const cacheDir = path.resolve(values['cache-dir'] ?? path.join(roots.baseline, 'builds/e2e-dictionary-cache'))
const dictionaries = positionals.length ? positionals : ['jmdict', 'jitendex', 'vndb']
const require = createRequire(path.join(roots.baseline, 'package.json'))
const {BlobReader, Uint8ArrayWriter, ZipReader} = await import(pathToFileURL(require.resolve('@zip.js/zip.js')))
const load = (sourceRoot, file) => import(pathToFileURL(path.join(sourceRoot, file)))
const {readDenseZipFileMap} = await load(roots.baseline, 'ext/js/dictionary/dense-zip-directory.js')
const {hashTermKeyBytes} = await load(roots.baseline, 'ext/js/dictionary/term-key-hash.js')
const {RawZipPayloadReader, TermBankSourcePipeline} = await load(roots.baseline, 'ext/js/dictionary/term-bank-source-pipeline.js')
const {getImageMediaTypeFromFileName} = await load(roots.baseline, 'ext/js/media/media-util.js')
const lockBytes = await readFile(path.join(roots.baseline, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(await readFile(path.join(roots.candidate, 'test/perf/dictionaries.lock.json')), lockBytes)
const fixtures = JSON.parse(lockBytes).dictionaries
for (const id of dictionaries) { assert(fixtures[id], `Unknown dictionary: ${id}`) }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
assert.equal(groupManifest.lockSha256, sha256(lockBytes))
assert.equal(groupManifest.grouping.parserWorkers, parserWorkers)
const viewBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const sourceFiles = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/term-score-plan.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-lookup-route.js',
    'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/term-record-opfs-store.js',
    'ext/js/dictionary/dictionary-database.js',
    'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dense-zip-file-map.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/media/media-util.js',
    'ext/lib/term-bank-parser.wasm',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
]
async function sourceIdentity(sourceRoot) {
    return Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => {
        try { return [file, sha256(await readFile(path.join(sourceRoot, file)))] }
        catch (error) {
            if (error.code === 'ENOENT' && file.endsWith('/term-score-plan.js')) { return [file, null] }
            throw error
        }
    })))
}
const sources = {}
for (const [arm, sourceRoot] of Object.entries(roots)) {
    const nativeArtifacts = await load(sourceRoot, 'dev/dictionary-wasm.js')
    nativeArtifacts.loadDictionaryWasm()
    const manifest = nativeArtifacts.getDictionaryWasmManifest()
    const moduleBytes = await readFile(path.join(sourceRoot, 'ext/lib/term-bank-parser.wasm'))
    assert.equal(sha256(moduleBytes), manifest.targets.find(({name}) => name === 'term-bank-parser.wasm').sha256)
    const parser = await load(sourceRoot, sourceFiles[0])
    const preparation = await load(sourceRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')
    const records = await load(sourceRoot, 'ext/js/dictionary/term-record-opfs-store.js')
    const importer = await load(sourceRoot, 'ext/js/dictionary/dictionary-importer.js')
    const route = await load(sourceRoot, 'ext/js/dictionary/term-lookup-route.js')
    const ownership = await load(sourceRoot, 'ext/js/dictionary/term-content-ownership.js')
    const experiments = await load(sourceRoot, 'ext/js/dictionary/term-bank-experiments.js')
    parser.setTermBankWasmModule(await WebAssembly.compile(moduleBytes))
    sources[arm] = {parser, preparation, records, importer, route, ownership, experiments, identity: await sourceIdentity(sourceRoot),
        revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        retainedPlan: null}
}
if (values['require-plan']) { assert.equal(typeof sources.candidate.parser.copyWasmBackedWorkerColumnChunk, 'function') }

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
    let zipReader = null
    let fallbackEntries = null
    const readFallbackEntries = async () => {
        zipReader ??= new ZipReader(new BlobReader(archive), {useWebWorkers: false})
        fallbackEntries ??= zipReader.getEntries()
        return fallbackEntries
    }
    // Use the production dense file-map factory so getData-backed source
    // entries satisfy the actual source-pipeline admission contract.
    const denseMap = await readDenseZipFileMap(archive, async function (writer, options = {}) {
        const entry = (await readFallbackEntries()).find((candidate) => candidate.filename === this.filename)
        assert(entry)
        return entry.getData(writer, options)
    })
    const selected = selectBanks(denseMap === null ? await readFallbackEntries() : [...denseMap.values()])
    const payloads = RawZipPayloadReader.supportsArchive(archive) ? new RawZipPayloadReader(archive) : null
    const readInflated = (entry, signal) => entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true, signal})
    const pipeline = new TermBankSourcePipeline({termFiles: selected.entries, enabled: true,
        read: readInflated,
        ...(payloads === null ? {} : {readCompressed: (entry, signal) => payloads.read(entry, signal, true)})})
    const compressedPlan = pipeline.createCompressedImportRunPlan(0)
    const compressedLoaders = compressedPlan === null ? null : new Map(compressedPlan.files.map((file, index) => [file, compressedPlan.loaders[index]]))
    if (compressedPlan !== null) { assert.equal(compressedPlan.files.length, selected.entries.length) }
    const signal = new AbortController().signal
    return {...selected, compressed: compressedPlan !== null,
        catalog: denseMap === null ? 'zip-js' : 'dense-file-map',
        close: async () => {
            await pipeline.dispose()
            await zipReader?.close()
        },
        release: (entries) => pipeline.releaseBatch(entries),
        readSource: (entry) => compressedLoaders === null ? readInflated(entry, signal) : compressedLoaders.get(entry)()}
}

function effectiveRoutePolicy(source, reader) {
    const totalSourceBytes = reader.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const projectImagePaths = reader.hasArchiveImages && source.importer.isNativeImageProjectionSourceSizeEligible(totalSourceBytes)
    // This is the existing ParallelTermBankPipelineRun policy, not a new limit.
    const largeProjectedImport = projectImagePaths && totalSourceBytes >= 512 * 1024 * 1024
    const policy = {totalSourceBytes, hasArchiveImages: reader.hasArchiveImages,
        sourceRoute: reader.compressed ? 'native-inflate-crc-preloaded' : 'validated-inflated-banks',
        projectImagePaths, ownContentBytes: largeProjectedImport,
        prepareLookupRoute: totalSourceBytes >= source.route.MIN_EXACT_LOOKUP_SOURCE_BYTES,
        experiments: source.experiments.snapshotTermBankExperiments({experimentalNativeEscapedKeys: largeProjectedImport})}
    return policy
}

function snapshotScores(chunk) {
    const count = chunk.rowCount
    if (chunk.scoreList !== null) {
        assert(chunk.scoreList instanceof Int32Array || chunk.scoreList instanceof Float64Array)
        assert.equal(chunk.scoreList.length, count)
        return {scores: chunk.scoreList.slice(), transport: 'raw', ownedBytes: chunk.scoreList.byteLength,
            dictionaryCount: null, bytesAvoided: 0}
    }
    const {values: dictionary, keys} = chunk.scorePlan
    assert.equal(Object.getPrototypeOf(dictionary), Int32Array.prototype)
    assert.equal(Object.getPrototypeOf(keys), Uint16Array.prototype)
    assert(dictionary.buffer instanceof ArrayBuffer)
    assert.equal(dictionary.buffer.resizable, false)
    assert.equal(dictionary.buffer, keys.buffer)
    assert.equal(dictionary.byteOffset, 0)
    assert.equal(keys.byteOffset, dictionary.byteLength)
    assert.equal(keys.length, count)
    assert.equal(dictionary.buffer.byteLength, dictionary.byteLength + keys.byteLength)
    assert(dictionary.length > 0 && dictionary.length < 0xffff)
    assert(dictionary.buffer.byteLength <= count * 4)
    const scores = new Int32Array(count)
    const byScore = new Map()
    for (let row = 0; row < count; ++row) {
        const key = keys[row]
        assert(key < dictionary.length, `Out-of-bounds native score key at row ${row}`)
        const score = dictionary[key]
        if (!byScore.has(score)) { byScore.set(score, byScore.size) }
        assert.equal(key, byScore.get(score), `Noncanonical native score key at row ${row}`)
        scores[row] = score
    }
    assert.equal(byScore.size, dictionary.length, 'Duplicate or unused score dictionary entry')
    return {scores, transport: 'plan', ownedBytes: dictionary.buffer.byteLength,
        dictionaryCount: dictionary.length, bytesAvoided: count * 4 - dictionary.buffer.byteLength}
}

function scorePlanDigest(plan) {
    return createHash('sha256').update(viewBytes(plan.values)).update(viewBytes(plan.keys)).digest('hex')
}

function contentReferences(chunk) {
    assert(chunk.contentMetaList instanceof Uint32Array)
    const indexes = chunk.contentUniqueIndexList ?? Uint32Array.from({length: chunk.rowCount}, (_, index) => index)
    let uniqueCount = 0
    for (const index of indexes) { uniqueCount = Math.max(uniqueCount, index + 1) }
    const offsets = new Float64Array(uniqueCount).fill(-1)
    const lengths = new Uint32Array(uniqueCount)
    for (let row = 0; row < chunk.rowCount; ++row) {
        const unique = indexes[row]
        const metadata = 4 * (chunk.contentMetaByUniqueIndex ? unique : row)
        assert(metadata + 4 <= chunk.contentMetaList.length)
        const offset = 2 ** 40 + chunk.contentMetaList[metadata]
        const length = chunk.contentMetaList[metadata + 1]
        if (offsets[unique] >= 0) {
            assert.equal(offsets[unique], offset)
            assert.equal(lengths[unique], length)
        } else {
            offsets[unique] = offset
            lengths[unique] = length
        }
    }
    return {indexes, offsets, lengths}
}

function inspectScoreInputRange(chunk) {
    if (chunk.scoreList !== null) { return {transport: 'raw', rows: chunk.rowCount} }
    const {values: dictionary, keys} = chunk.scorePlan
    assert.equal(keys.length, chunk.rowCount)
    const firstUse = new Map()
    let canonical = true
    for (let i = 0; i < keys.length; ++i) {
        const key = keys[i]
        assert(key < dictionary.length)
        const score = dictionary[key]
        if (!firstUse.has(score)) { firstUse.set(score, firstUse.size) }
        if (key !== firstUse.get(score)) { canonical = false }
    }
    if (firstUse.size !== dictionary.length) { canonical = false }
    return {transport: 'plan', rows: chunk.rowCount, dictionaryCount: dictionary.length,
        sourceKeyStart: (keys.byteOffset - dictionary.byteLength) / 2,
        canonicalFromCurrentValues: canonical}
}

async function encodeRecords(source, owned, totalRows, firstId, scenario, policy) {
    const {TermRecordOpfsStore, createArtifactTermRecordChunkWithResolvedContent} = source.records
    const store = new TermRecordOpfsStore()
    store._nextId = firstId
    store._importSessionActive = scenario !== 'materialized'
    store._rawTermBankSourceBytes = policy.totalSourceBytes
    store._ensureNextIdReadyForAppend = async () => {}
    store._assertShardAcceptsAppend = () => {}
    store._getOrCreateShardState = async () => ({})
    const digest = createHash('sha256')
    const capturedRecords = []
    const chunks = []
    const scoreInputs = []
    const encodeFields = store._encodeArtifactRecordFields
    store._encodeArtifactRecordFields = function (chunk, ...rest) {
        scoreInputs.push(inspectScoreInputRange(chunk))
        return encodeFields.call(this, chunk, ...rest)
    }
    store._cacheAppendedRecord = (record) => {
        capturedRecords.push({id: record.id, score: record.score, sequence: record.sequence,
            expression: Array.from(record.expressionBytes),
            reading: typeof record.readingBytes === 'undefined' ? null : Array.from(record.readingBytes),
            readingEqualsExpression: record.readingEqualsExpression,
            offset: record.entryContentOffset, length: record.entryContentLength,
            dictionary: record.entryContentDictName})
    }
    store._appendEncodedChunk = async (_state, id, count, dictionary, base, lookup, fields, format, routeFilter) => {
        const sidecar = store._createLookupIndexChunk(id, count, base, lookup, fields, format)
        digest.update(JSON.stringify({id, count, dictionary, base, format}))
        digest.update(lookup)
        digest.update(fields)
        digest.update(sidecar)
        digest.update(routeFilter instanceof Uint32Array ? viewBytes(routeFilter) : new Uint8Array(0))
        chunks.push({id, count, dictionary, base, format, lookupBytes: lookup.byteLength,
            fieldBytes: fields.byteLength, sidecarBytes: sidecar.byteLength,
            fieldsSha256: sha256(fields), sidecarSha256: sha256(sidecar),
            routeFilterBytes: routeFilter?.byteLength ?? 0,
            routeFilterSha256: routeFilter instanceof Uint32Array ? sha256(viewBytes(routeFilter)) : null})
    }
    let count = owned.rowCount
    let chunk = {...owned, dictionary: 'score-oracle', dictionaryTotalRows: totalRows}
    let references = contentReferences(owned)
    let names = 'raw'
    if (scenario === 'offset-split') {
        const middle = Math.floor(count / 2)
        references = {indexes: Uint32Array.from({length: count}, (_, index) => index),
            offsets: Float64Array.from({length: count}, (_, index) => 2 ** 40 + index * 8 + (index >= middle ? 2 ** 32 + 100 : 0)),
            lengths: Uint32Array.from({length: count}, (_, index) => references.lengths[references.indexes[index]])}
    } else if (scenario === 'dictionary-split') {
        names = Array.from({length: count}, (_, index) => index < Math.floor(count / 2) ? 'raw' : 'alternate')
    } else if (scenario === 'legacy-length') {
        references.lengths = references.lengths.slice()
        references.lengths[references.indexes[Math.floor(count / 2)]] = 0xffff
    } else if (scenario === 'materialized') {
        count = Math.min(count, 16)
        chunk.rowCount = count
        chunk.dictionaryTotalRows = count
        chunk.preparedLookupIndexes = undefined
        if (owned.scoreList === null) {
            chunk.scorePlan = {values: owned.scorePlan.values, keys: owned.scorePlan.keys.subarray(0, count)}
        } else { chunk.scoreList = owned.scoreList.slice(0, count) }
        references.indexes = references.indexes.subarray(0, count)
    }
    chunk = createArtifactTermRecordChunkWithResolvedContent(chunk, references.indexes,
        references.offsets, references.lengths, chunk.preparedLookupIndexes ?? null)
    await store.appendBatchFromArtifactChunkResolvedContent(chunk, [], [], names)
    assert.equal(chunks.reduce((sum, current) => sum + current.count, 0), count)
    assert.equal(scoreInputs.length, chunks.length)
    if (scenario === 'offset-split' || scenario === 'dictionary-split') { assert.equal(chunks.length, 2) }
    if (scenario === 'materialized') { assert.equal(capturedRecords.length, count) }
    digest.update(JSON.stringify(capturedRecords))
    return {bytes: {digest: digest.digest('hex'), rows: count, chunks, materializedRows: capturedRecords.length}, scoreInputs}
}

async function replayGroup(source, banks, policy, totalRows, firstId, adversarial) {
    const {parser, preparation} = source
    const preloadedSource = policy.sourceRoute === 'native-inflate-crc-preloaded' ?
        await parser.inflateCompressedTermBankSourcesWasm(banks, policy.experiments, true) : undefined
    let owned
    let rawScoreDigest
    let publicCopyVerified = false
    await parser.parseTermBankWithWasmColumnChunks(preloadedSource === undefined ? banks : new Uint8Array(0), 3, (chunk) => {
        assert.equal(owned, undefined, 'Expected one complete group')
        const privateCopy = parser.copyWasmBackedWorkerColumnChunk
        const ownCacheableContent = policy.ownContentBytes !== true && typeof SharedArrayBuffer === 'function' &&
            source.ownership.shouldOwnTermContentBytes(chunk.contentBytesLength,
                chunk.contentDedupPlan?.uniqueCount, chunk.contentDedupPlan?.sourceRowCount, chunk.rowCount)
        const borrowProjectedContent = policy.ownContentBytes === true && policy.projectImagePaths === true &&
            typeof SharedArrayBuffer === 'function' && chunk.contentBytesBuffer?.buffer instanceof SharedArrayBuffer &&
            source.ownership.shouldBorrowProjectedTermContent(chunk.contentBytesLength,
                chunk.contentDedupPlan?.uniqueCount, chunk.contentDedupPlan?.sourceRowCount, chunk.rowCount)
        const shareContentBytes = policy.ownContentBytes !== true || borrowProjectedContent
        const copy = typeof privateCopy === 'function' ? privateCopy : parser.copyWasmBackedColumnChunk
        owned = copy(chunk, shareContentBytes, policy.projectImagePaths, policy.prepareLookupRoute, preloadedSource)
        if (ownCacheableContent && owned.contentBytesBuffer instanceof Uint8Array &&
            owned.contentBytesBuffer.buffer === chunk.contentBytesBuffer?.buffer) {
            const copy = new Uint8Array(new SharedArrayBuffer(owned.contentBytesBuffer.byteLength))
            copy.set(owned.contentBytesBuffer)
            owned.contentBytesBuffer = copy
        }
        const snapshot = snapshotScores(owned)
        assert.deepEqual(snapshot.scores, chunk.scoreList, 'Compact producer changed native raw score values')
        rawScoreDigest = sha256(viewBytes(chunk.scoreList))
        if (snapshot.transport === 'plan') {
            assert.notEqual(owned.scorePlan.values.buffer, chunk.scoreList.buffer)
            const sender = owned.scorePlan
            const received = structuredClone(sender, {transfer: [sender.values.buffer]})
            assert.equal(sender.values.byteLength, 0)
            assert.equal(sender.keys.byteLength, 0)
            owned.scorePlan = received
            assert.deepEqual(snapshotScores(owned).scores, snapshot.scores)
        }
        if (adversarial && typeof privateCopy === 'function') {
            const publicChunk = parser.copyWasmBackedColumnChunk(chunk)
            assert(publicChunk.scoreList instanceof Int32Array || publicChunk.scoreList instanceof Float64Array)
            assert.equal(publicChunk.scorePlan, undefined)
            assert.deepEqual(publicChunk.scoreList, chunk.scoreList)
            publicCopyVerified = true
        }
    }, 262144, {...policy.experiments, singleChunk: true, maxPendingChunks: 1,
        initialContentBytesPerRow: 48, includeContentMetadata: true, minimalDecode: true,
        reuseExpressionForReadingDecode: true, preallocateChunkRows: true,
        skipTagRuleDecode: policy.hasArchiveImages, lazyGlossaryDecode: true,
        emitTermByteLists: false, computeContentHashes: true,
        emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: policy.hasArchiveImages,
        projectImagePaths: policy.projectImagePaths, ownContentBytes: policy.ownContentBytes,
        prepareLookupRoute: policy.prepareLookupRoute, preloadedSource,
        validateGlossaryTypes: true, prepareLookupIndexes: true, compactContentMetadata: true,
        prepareWorkerScorePlan: true})
    assert(owned, 'Parser omitted group')
    if (source.retainedPlan !== null) {
        assert.equal(scorePlanDigest(source.retainedPlan.plan), source.retainedPlan.digest,
            'A later parse mutated an owned score plan')
    }
    const snapshot = snapshotScores(owned)
    if (snapshot.transport === 'plan') {
        source.retainedPlan = {plan: owned.scorePlan, digest: scorePlanDigest(owned.scorePlan)}
    }
    const profile = parser.consumeLastTermBankWasmParseProfile()
    if (typeof parser.copyWasmBackedWorkerColumnChunk === 'function') {
        assert.equal(profile.nativeScorePlanGroups ?? 0, snapshot.transport === 'plan' ? 1 : 0)
        assert.equal(profile.nativeScorePlanRows ?? 0, snapshot.transport === 'plan' ? owned.rowCount : 0)
        assert.equal(profile.nativeScorePlanBytesAvoided ?? 0, snapshot.bytesAvoided)
    }
    owned.preparedLookupIndexes ??= preparation.prepareTermLookupIndexesFromPreinternedPlan(owned)?.indexes
    assert(preparation.hasCompletePreparedTermLookupIndexes(owned.preparedLookupIndexes, owned.rowCount))
    const digest = createHash('sha256')
    let keys = 0
    let lookupBytes = 0
    for (const [range, {bytes, preinternedPlan: plan, routeFilter}] of owned.preparedLookupIndexes) {
        digest.update(range)
        digest.update(bytes)
        digestPlan(digest, plan)
        if (policy.prepareLookupRoute) {
            assert(routeFilter instanceof Uint32Array)
            digest.update(viewBytes(routeFilter))
        }
        keys += plan.stringLengths.length
        lookupBytes += bytes.byteLength
    }
    digestPlan(digest, owned.termRecordPreinternedPlan)
    for (const view of [owned.readingEqualsExpressionList, snapshot.scores, owned.sequenceList]) {
        digest.update(viewBytes(view))
    }
    assert(owned.contentBytesBuffer && owned.contentMetaList)
    digest.update(owned.contentBytesBuffer)
    digest.update(viewBytes(owned.contentMetaList))
    if (owned.contentUniqueIndexList !== null) { digest.update(viewBytes(owned.contentUniqueIndexList)) }
    digest.update(JSON.stringify(owned.mediaRows))
    const fields = {}
    const fieldScoreInputs = {}
    for (const scenario of ['whole', ...(adversarial ? ['offset-split', 'dictionary-split', 'legacy-length', 'materialized'] : [])]) {
        const result = await encodeRecords(source, owned, totalRows, firstId, scenario, policy)
        fields[scenario] = result.bytes
        fieldScoreInputs[scenario] = result.scoreInputs
    }
    return {rows: owned.rowCount, keys, lookupBytes, nativeSegments: profile.nativeSegmentedLookupSegments ?? 0,
        nativeFallbacks: profile.nativeSegmentedLookupFallbacks ?? 0, digest: digest.digest('hex'), rawScoreDigest,
        transport: snapshot.transport, scoreDictionaryCount: snapshot.dictionaryCount,
        ownedScoreBytes: snapshot.ownedBytes, scoreBytesAvoided: snapshot.bytesAvoided,
        publicCopyVerified, fields, fieldScoreInputs,
        parserRoutes: {
            effectiveExperiments: profile.experiments,
            fusedParseAttempts: profile.fusedParseAttempts ?? 0,
            fusedParseFallbacks: profile.fusedParseFallbacks ?? 0,
            discardedFusedRows: profile.discardedFusedRows ?? 0,
            escapedKeyDecodeCount: profile.escapedKeyDecodeCount ?? 0,
            maxWasmHeapBytes: profile.maxWasmHeapBytes ?? 0,
            nativeScorePlanGroups: profile.nativeScorePlanGroups ?? 0,
            nativeScorePlanRows: profile.nativeScorePlanRows ?? 0,
            nativeScorePlanBytesAvoided: profile.nativeScorePlanBytesAvoided ?? 0,
            sourceCompressedBytes: preloadedSource?.compressedBytes ?? null,
            sourceUncompressedBytes: preloadedSource?.uncompressedBytes ?? null,
            crcVerified: preloadedSource?.crcVerified ?? null,
            crcScannedBytes: preloadedSource?.crcScannedBytes ?? null,
            crcReusedBytes: preloadedSource?.crcReusedBytes ?? null,
        }}
}

const report = {schema: 3, complete: false, partComplete: false, correctnessOnly: true,
    boundary: 'Effective importer/worker route settings and eligible raw ZIP native inflate/CRC; complete parser/content/lookup/media projection outputs and record fields/lookup sidecars; synthetic private content offsets; append IO captured; no browser scheduling, canonical persistence, media payload import, timing, or process-memory claim.',
    grouping: {parserWorkers, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    requirePlan: values['require-plan'], maxGroups, node: process.version,
    selection: {groupStart, groupCount}, groupManifestSha256: sha256(groupManifestBytes),
    lockSha256: sha256(lockBytes), runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, source]) => [arm,
        {root: roots[arm], revision: source.revision, hashes: source.identity}])), dictionaries: []}
await mkdir(path.dirname(output), {recursive: true})
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
for (const dictionary of dictionaries) {
    const fixture = fixtures[dictionary]
    const archivePath = path.join(cacheDir, fixture.cacheFile)
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
        const policy = effectiveRoutePolicy(sources.baseline, reader)
        assert.deepEqual(effectiveRoutePolicy(sources.candidate, reader), policy)
        const groups = partition(reader.entries, reader.hasArchiveImages ? 3 : 4)
        const expected = groupManifest.dictionaries[dictionary]
        assert.equal(expected.archiveSha256, fixture.sha256)
        assert.equal(expected.rows, fixture.termRows)
        assert.equal(expected.groups.length, groups.length)
        for (let index = 0; index < groups.length; ++index) {
            const group = groups[index]
            const row = expected.groups[index]
            assert.equal(row.ordinal, index + 1)
            assert.equal(row.firstBank, group[0].filename)
            assert.equal(row.lastBank, group.at(-1).filename)
            assert.equal(row.sourceBytes, group.reduce((sum, entry) => sum + entry.uncompressedSize, 0))
            assert.equal(row.firstId, index === 0 ? 1 : expected.groups[index - 1].firstId + expected.groups[index - 1].rows)
        }
        assert(groupStart < groups.length)
        const selected = groups.slice(groupStart, groupCount > 0 ? groupStart + groupCount : groups.length)
        const result = {dictionary, archiveSha256: fixture.sha256, banks: reader.entries.length, catalog: reader.catalog, policy,
            selectedGroupStart: groupStart, selectedGroupCount: selected.length,
            expectedGroups: groups.length, rows: 0, planGroups: 0, rawGroups: 0, scoreBytesAvoided: 0, groups: []}
        report.dictionaries.push(result)
        for (const [localIndex, group] of selected.entries()) {
            const index = groupStart + localIndex
            const banks = []
            for (const entry of group) { banks.push(await reader.readSource(entry)) }
            const arms = {}
            for (const arm of ['baseline', 'candidate']) {
                arms[arm] = await replayGroup(sources[arm], banks, policy,
                    fixture.termRows, expected.groups[index].firstId, index === 0)
            }
            const {baseline, candidate} = arms
            assert.equal(baseline.rows, expected.groups[index].rows)
            for (const key of ['rows', 'keys', 'lookupBytes', 'nativeSegments', 'nativeFallbacks', 'digest', 'rawScoreDigest']) {
                assert.equal(candidate[key], baseline[key], `${dictionary} group ${index}: ${key}`)
            }
            assert.deepEqual(candidate.fields, baseline.fields, `${dictionary} group ${index}: record bytes`)
            for (const key of ['effectiveExperiments', 'fusedParseAttempts', 'fusedParseFallbacks', 'discardedFusedRows',
                'escapedKeyDecodeCount', 'maxWasmHeapBytes', 'sourceCompressedBytes', 'sourceUncompressedBytes',
                'crcVerified', 'crcScannedBytes', 'crcReusedBytes']) {
                assert.deepEqual(candidate.parserRoutes[key], baseline.parserRoutes[key], `${dictionary} group ${index}: route ${key}`)
            }
            result.rows += candidate.rows
            result[candidate.transport === 'plan' ? 'planGroups' : 'rawGroups']++
            result.scoreBytesAvoided += candidate.scoreBytesAvoided
            result.groups.push({ordinal: index + 1, firstId: expected.groups[index].firstId,
                firstBank: group[0].filename, lastBank: group.at(-1).filename,
                sourceBytes: group.reduce((sum, entry) => sum + entry.uncompressedSize, 0), baseline, candidate})
            reader.release(group)
            await save()
            console.log(`${dictionary} ${index + 1}/${groups.length}: ${candidate.rows} rows; ${candidate.transport}; parser and record bytes equal`)
            globalThis.gc?.()
        }
        if (groupStart === 0 && selected.length === groups.length) { assert.equal(result.rows, fixture.termRows) }
    } finally { await reader.close() }
}
for (const [arm, sourceRoot] of Object.entries(roots)) {
    assert.deepEqual(await sourceIdentity(sourceRoot), sources[arm].identity, `${arm} changed during replay`)
}
if (values['require-plan']) { assert(report.dictionaries.some(({planGroups}) => planGroups > 0), 'No candidate native score plan was exercised') }
report.complete = report.dictionaries.every((dictionary) => dictionary.selectedGroupStart === 0 && dictionary.selectedGroupCount === dictionary.expectedGroups)
report.partComplete = true
await save()

