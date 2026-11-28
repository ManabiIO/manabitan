/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {Worker as ThreadWorker} from 'node:worker_threads'

const {values} = parseArgs({options: {
    'project-root': {type: 'string'},
    'build-dir': {type: 'string'},
    fixtures: {type: 'string'},
    output: {type: 'string'},
    dictionary: {type: 'string'},
}})
for (const name of ['project-root', 'build-dir', 'fixtures', 'output', 'dictionary']) assert(values[name], `Missing --${name}`)
const projectRoot = resolve(values['project-root'])
const buildRoot = resolve(values['build-dir'])
const outputRoot = resolve(values.output)
const dictionary = values.dictionary
assert(['jmdict', 'jitendex', 'vndb'].includes(dictionary))
assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc; collection is only outside measured phases')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bindingBytes = await readFile(new URL('./source-binding.json', import.meta.url))
const binding = JSON.parse(bindingBytes)
assert.equal(binding.reversedLimitGuard, true, 'Superseded unguarded count128 sources must not be measured')
const patchBytes = await readFile(new URL('./zstd-count128.patch', import.meta.url))
assert.equal(sha(patchBytes), binding.patchSha256)
const compilerToolingBytes = await readFile(join(buildRoot, '../tooling-sha256.txt'))
const compilerTooling = new Map(compilerToolingBytes.toString('utf8').trim().split('\n').map((line) => {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    assert(match, 'Malformed compiler tooling hash receipt')
    return [match[2], match[1]]
}))
assert.equal(compilerTooling.get('dev/perf/zstd-count128-20261128/source-binding.json'), sha(bindingBytes), 'Compiler artifact used a different source binding')
assert.equal(compilerTooling.get('dev/perf/zstd-count128-20261128/zstd-count128.patch'), sha(patchBytes), 'Compiler artifact used a different candidate patch')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: projectRoot, encoding: 'utf8'}).trim(), binding.sourceHead)
const buildReportBytes = await readFile(join(buildRoot, 'build-report.json'))
const buildReport = JSON.parse(buildReportBytes)
assert.equal(buildReport[0].checkedInWasmEqual, true)
assert.equal(buildReport[0].checkedInJsEqual, true)
const checkedInWasm = await readFile(join(projectRoot, 'dev/data/zstd-simd.wasm'))
const checkedInModuleJs = await readFile(join(projectRoot, 'dev/lib/zstd-simd-module.js'))
assert.equal(buildReport[0].wasmSha256, sha(checkedInWasm))
assert.equal(buildReport[0].jsSha256, sha(checkedInModuleJs))
const runBinding = {
    sourceHead: binding.sourceHead,
    runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    sourceBindingSha256: sha(bindingBytes),
    candidatePatchSha256: sha(patchBytes),
    compilerToolingManifestSha256: sha(compilerToolingBytes),
    buildReportSha256: sha(buildReportBytes),
    checkedInWasmSha256: sha(checkedInWasm),
    checkedInModuleJsSha256: sha(checkedInModuleJs),
    node: process.version,
    v8: process.versions.v8,
}
const localImport = (root, filename) => import(pathToFileURL(join(root, filename)))
const {BlobReader, Uint8ArrayWriter, ZipReader} = await localImport(projectRoot, 'node_modules/@zip.js/zip.js/index.js')
const parser = await localImport(projectRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const pipelineModule = await localImport(projectRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')
const {snapshotTermBankExperiments} = await localImport(projectRoot, 'ext/js/dictionary/term-bank-experiments.js')
const productionExperiments = snapshotTermBankExperiments()
assert.equal(productionExperiments.experimentalGenericSpanCompression, true, 'The pinned ordinary import enables generic span compression')
const {RAW_TERM_CONTENT_TOKEN_DICT_NAME, RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES} = await localImport(projectRoot, 'ext/js/dictionary/raw-term-content.js')
const {TERM_CONTENT_BLOCK_ENVELOPE_BYTES, wrapCompressedTermContentBlock} = await localImport(projectRoot, 'ext/js/dictionary/term-content-block-envelope.js')
assert.equal(typeof RAW_TERM_CONTENT_TOKEN_DICT_NAME, 'string')
assert.equal(TERM_CONTENT_BLOCK_ENVELOPE_BYTES, 12)
assert.equal(RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES, 20)
const fixtureLock = await readFile(join(projectRoot, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(fixtureLock).dictionaries[dictionary]
assert(fixture)
const archivePath = join(resolve(values.fixtures), fixture.cacheFile)
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) archiveHash.update(bytes)
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
const parserWasm = await readFile(join(projectRoot, 'ext/lib/term-bank-parser.wasm'))
assert.equal(sha(parserWasm), sha(await readFile(join(projectRoot, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))), 'Generated parser asset must match the pinned product module')
parser.setTermBankWasmModule(await WebAssembly.compile(parserWasm))
await mkdir(outputRoot)
await mkdir(join(outputRoot, 'corpus'))
await writeFile(join(outputRoot, 'run-binding.json'), JSON.stringify(runBinding, null, 2) + '\n')

const terminationPromises = []
class BrowserWorker extends EventTarget {
    constructor(url) {
        super()
        this.worker = new ThreadWorker(pathToFileURL(join(projectRoot, 'test/fixtures/parser-settlement/worker-node.mjs')), {workerData: {url: url.href}})
        this.worker.on('message', (data) => this.dispatchEvent(new MessageEvent('message', {data})))
        this.worker.on('error', (error) => {
            const event = new Event('error')
            Object.defineProperty(event, 'message', {value: error.message})
            this.dispatchEvent(event)
        })
        this.worker.on('messageerror', () => this.dispatchEvent(new MessageEvent('messageerror')))
    }

    postMessage(data, transfer) { this.worker.postMessage(data, transfer) }

    terminate() { terminationPromises.push(this.worker.terminate()) }
}
globalThis.Worker = BrowserWorker
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})

const reader = new ZipReader(new BlobReader(archive))
const entries = await reader.getEntries()
const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const rawTermBankSourceBytes = termFiles.reduce((total, file) => {
    assert(Number.isSafeInteger(file.uncompressedSize) && file.uncompressedSize >= 0)
    const next = total + file.uncompressedSize
    assert(Number.isSafeInteger(next))
    return next
}, 0)
const importerSource = await readFile(join(projectRoot, 'ext/js/dictionary/dictionary-importer.js'), 'utf8')
assert(importerSource.includes('const MIN_NATIVE_IMAGE_PROJECTION_SOURCE_BYTES = 1024 * 1024 * 1024;'))
const rawReader = new pipelineModule.RawZipPayloadReader(archive)
const sourcePipeline = new pipelineModule.TermBankSourcePipeline({
    termFiles,
    enabled: true,
    read: async (file) => await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}),
    readCompressed: async (file, signal) => await rawReader.read(file, signal),
})
const targetBytes = 1024 * 1024
const databaseSource = await readFile(join(projectRoot, 'ext/js/dictionary/dictionary-database.js'), 'utf8')
assert(databaseSource.includes('const TERM_CONTENT_BLOCK_TARGET_BYTES = 1024 * 1024;'))
const blockStoreSource = await readFile(join(projectRoot, 'ext/js/dictionary/term-content-block-store.js'), 'utf8')
assert(blockStoreSource.includes('const DEFAULT_MIN_INPUT_BYTES = 512 * 1024;'))
assert(blockStoreSource.includes('const DEFAULT_MIN_SAVINGS_RATIO = 0.1;'))
const minBlockInputBytes = 512 * 1024
const minBlockSavingsRatio = 0.1
const globalContents = new Map()
const groups = []
const blocks = []
const sourceDigest = createHash('sha256')
let rows = 0
let hashCollisionCount = 0
let globalHits = 0
let canonicalCount = 0
let canonicalBytes = 0

async function consume(chunk) {
    const plan = chunk.contentDedupPlan
    assert(plan && chunk.contentUniqueIndexList && chunk.contentMetaList && chunk.contentBytesBuffer)
    assert.equal(chunk.contentRowStart ?? 0, 0, 'The whole-group oracle requires unsliced native chunks')
    const source = chunk.contentBytesBuffer
    const base = chunk.contentBytesBaseOffset ?? 0
    const newContents = []
    let groupHits = 0
    let groupBytes = 0
    for (let i = 0; i < plan.uniqueCount; ++i) {
        const meta = (chunk.contentMetaByUniqueIndex ? i : plan.uniqueRowIndexes[i]) * 4
        const offset = base + chunk.contentMetaList[meta]
        const length = chunk.contentMetaList[meta + 1]
        assert(offset >= 0 && length >= 0 && offset + length <= source.byteLength)
        const bytes = Buffer.from(source.buffer, source.byteOffset + offset, length)
        const key = `${RAW_TERM_CONTENT_TOKEN_DICT_NAME}:${chunk.contentMetaList[meta + 2]}:${chunk.contentMetaList[meta + 3]}`
        const prior = globalContents.get(key)
        if (prior && prior.some((entry) => entry.equals(bytes))) {
            ++globalHits
            ++groupHits
            continue
        }
        if (prior) ++hashCollisionCount
        const owned = Buffer.from(bytes)
        if (prior) prior.push(owned)
        else globalContents.set(key, [owned])
        newContents.push(owned)
        groupBytes += length
        ++canonicalCount
        canonicalBytes += length
    }
    // Distinct hash collisions are safe for this exact-byte oracle, but can
    // change native deferred-candidate order. Stop rather than mislabel packing.
    assert.equal(hashCollisionCount, 0, 'A distinct native hash collision needs the production pending-order replay')
    const group = {group: groups.length, rows: chunk.rowCount, localUnique: plan.uniqueCount, globalHits: groupHits, canonicalCount: newContents.length, canonicalBytes: groupBytes,
        sourceBacking: source.buffer instanceof SharedArrayBuffer ? 'shared' : 'private', blocks: []}
    for (let start = 0; start < newContents.length;) {
        let length = 0
        let end = start
        while (end < newContents.length) {
            const next = newContents[end].byteLength
            if (length > 0 && length + next > targetBytes && next > 0) break
            length += next
            ++end
        }
        assert(length > 0)
        const bytes = Buffer.concat(newContents.slice(start, end), length)
        const filename = `${String(blocks.length).padStart(6, '0')}.bin`
        await writeFile(join(outputRoot, 'corpus', filename), bytes, {flag: 'wx'})
        sourceDigest.update(bytes)
        const block = {index: blocks.length, group: groups.length, spans: end - start, bytes: length, sha256: sha(bytes), filename}
        blocks.push(block)
        group.blocks.push(block.index)
        start = end
    }
    groups.push(group)
    rows += chunk.rowCount
}

const media = fixture.mediaFiles > 0
const nativeImageProjection = media && rawTermBankSourceBytes >= 1024 * 1024 * 1024
const options = {
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: media,
    projectImagePaths: nativeImageProjection,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    maxPendingChunks: 2,
}
try {
    for (let start = 0; start < termFiles.length;) {
        const plan = sourcePipeline.createCompressedImportRunPlan(start)
        if (plan !== null) {
            assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelCompressedLazy(plan.loaders, plan.estimatedByteLengths, 3, consume, options), true)
            sourcePipeline.releaseBatch(plan.files)
            start += plan.files.length
        } else {
            const files = sourcePipeline.getBatch(start)
            const batch = await sourcePipeline.readBatch(files)
            if (batch?.promises) {
                assert.equal(await parser.parseTermBankWithWasmColumnChunksParallelDeferred(batch.promises, batch.estimatedByteLengths, 3, consume, options), true)
            } else {
                await parser.parseTermBankWithWasmColumnChunks(batch, 3, consume, 2048, {...options, singleChunk: true})
            }
            sourcePipeline.releaseBatch(files)
            start += files.length
        }
    }
    assert.equal(rows, fixture.termRows)
} finally {
    await sourcePipeline.dispose()
    await parser.disposeParallelTermBankParser()
    await Promise.all(terminationPromises)
    await reader.close()
}
globalContents.clear()
globalThis.gc()

const dictionaryBytes = dictionary === 'vndb' ? Buffer.alloc(0) : await readFile(join(projectRoot, 'dev/data/zstd-dicts/jmdict.zdict'))
const level = dictionary === 'vndb' ? 1 : -1
const ordinaryGenericFallback = dictionary === 'vndb' && productionExperiments.experimentalGenericSpanCompression !== true
const nativeCompressionEntryPoint = ordinaryGenericFallback ? 'ZSTD_compress' : 'ZSTD_compress_usingDict'
const envelopeRoute = ordinaryGenericFallback ? 'wrapCompressedTermContentBlock (JavaScript)' : 'manabitan_write_block_envelope (native)'
const corpus = {
    dictionary, fixture, rows, groups, blocks, globalHits, hashCollisionCount, canonicalCount, canonicalBytes,
    blockTargetBytes: targetBytes,
    contentSha256: sourceDigest.digest('hex'),
    parserWasmSha256: sha(parserWasm),
    fixtureLockSha256: sha(fixtureLock),
    sourceHead: binding.sourceHead,
    compressionDictionarySha256: sha(dictionaryBytes),
    compressionLevel: level,
    nativeCompressionEntryPoint,
    envelopeRoute,
    rawTermBankSourceBytes,
    nativeImageProjection,
    productionExperiments,
    parserSourceBackingCounts: groups.reduce((counts, group) => {
        ++counts[group.sourceBacking]
        return counts
    }, {shared: 0, private: 0}),
    compressionActivationScope: 'Parser shared/private backing is observed. The default generic-span switch is requested policy, not proof of browser worker dispatch or absence of fallback. Native entry-point and envelope counters observe this direct component runner only.',
    scope: 'Unchanged production source planner/native worker output at 4 CPU/8 GiB; per-group native canonical order, independent exact-byte cross-group dedup, and the production 1 MiB packing algorithm. Block-storage admission is pending the baseline framed-output preflight. No persistence or OPFS import timing is performed.',
}
await writeFile(join(outputRoot, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n')
console.log(JSON.stringify({stage: 'corpus', dictionary, rows, groups: groups.length, blocks: blocks.length, globalHits, canonicalBytes}))

const maxSourceBytes = Math.max(...blocks.map((block) => block.bytes), 1024 * 1024 + 17)
const encoderList = []
async function createEncoder(name, arm) {
    const wasmBytes = await readFile(join(buildRoot, arm, 'zstd-simd-module.wasm'))
    const moduleJs = await readFile(join(buildRoot, arm, 'zstd-simd-module.js'))
    assert.equal(sha(wasmBytes), buildReport.find((item) => item.arm === arm).wasmSha256)
    assert.equal(sha(moduleJs), buildReport.find((item) => item.arm === arm).jsSha256)
    const module = await WebAssembly.compile(wasmBytes)
    const factory = (await localImport(join(buildRoot, arm), 'zstd-simd-module.js')).default
    const native = await factory({wasmBinary: wasmBytes})
    const context = native._ZSTD_createCCtx()
    const decoder = native._ZSTD_createDCtx()
    assert(context !== 0 && decoder !== 0)
    const destinationCapacity = native._ZSTD_compressBound(maxSourceBytes) + 12
    const source = native._malloc(maxSourceBytes + 16)
    const destination = native._malloc(destinationCapacity)
    const dictionaryPointer = dictionaryBytes.byteLength === 0 ? 0 : native._malloc(dictionaryBytes.byteLength)
    const decoded = native._malloc(maxSourceBytes)
    assert(source && destination && decoded && (dictionaryPointer || dictionaryBytes.byteLength === 0))
    native.HEAPU8.set(dictionaryBytes, dictionaryPointer)
    let maxHeapBytes = native.HEAPU8.byteLength
    const activation = Object.fromEntries(['corpus', 'synthetic'].map((purpose) => [purpose, {
        ZSTD_compress: 0, ZSTD_compress_usingDict: 0, nativeEnvelope: 0, javascriptEnvelope: 0,
    }]))
    const result = {
        name, arm, native, context, decoder, source, destination, dictionaryPointer, decoded,
        wasmBytes: wasmBytes.byteLength,
        wasmSha256: sha(wasmBytes),
        moduleJsSha256: sha(moduleJs),
        exports: WebAssembly.Module.exports(module),
        imports: WebAssembly.Module.imports(module),
        compress(bytes, alignment = 0, rawDictionary = false, purpose = 'corpus') {
            assert(bytes.byteLength <= maxSourceBytes && alignment >= 0 && alignment < 16)
            assert(Object.hasOwn(activation, purpose))
            native.HEAPU8.set(bytes, source + alignment)
            // The ordinary default enables generic span compression, so VNDB
            // uses the retained empty-dictionary context too. Synthetic raw
            // cases additionally exercise the convenience-export fallback.
            const generic = ordinaryGenericFallback || rawDictionary
            const framePointer = destination + (generic ? 0 : TERM_CONTENT_BLOCK_ENVELOPE_BYTES)
            const frameCapacity = generic ? native._ZSTD_compressBound(bytes.byteLength) : destinationCapacity - TERM_CONTENT_BLOCK_ENVELOPE_BYTES
            const start = performance.now()
            const size = generic ?
                native._ZSTD_compress(framePointer, frameCapacity, source + alignment, bytes.byteLength, 1) :
                native._ZSTD_compress_usingDict(context, framePointer, frameCapacity, source + alignment, bytes.byteLength, dictionaryPointer, dictionaryBytes.byteLength, level)
            const compressedAt = performance.now()
            assert.equal(native._ZSTD_isError(size), 0)
            ++activation[purpose][generic ? 'ZSTD_compress' : 'ZSTD_compress_usingDict']
            let wrapped
            let envelopeMs
            if (generic) {
                // The ordinary generic path copies the frame, then wraps it in
                // JavaScript. Keep both outside native compression timing.
                const frame = native.HEAPU8.slice(framePointer, framePointer + size)
                const envelopeStart = performance.now()
                wrapped = wrapCompressedTermContentBlock(frame)
                envelopeMs = performance.now() - envelopeStart
                ++activation[purpose].javascriptEnvelope
            } else {
                const envelopeStart = performance.now()
                const envelopeResult = native._manabitan_write_block_envelope(destination, size + TERM_CONTENT_BLOCK_ENVELOPE_BYTES)
                envelopeMs = performance.now() - envelopeStart
                assert.equal(envelopeResult, 1)
                ++activation[purpose].nativeEnvelope
                wrapped = native.HEAPU8.subarray(destination, destination + size + TERM_CONTENT_BLOCK_ENVELOPE_BYTES)
            }
            maxHeapBytes = Math.max(maxHeapBytes, native.HEAPU8.byteLength)
            const compressMs = compressedAt - start
            return {size, compressMs, envelopeMs, wrappedMs: compressMs + envelopeMs, bytes: Buffer.from(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength)}
        },
        roundTrip(bytes, expected, rawDictionary = false) {
            native.HEAPU8.set(bytes.subarray(12), destination + 12)
            const size = native._ZSTD_decompress_usingDict(decoder, decoded, maxSourceBytes, destination + 12, bytes.byteLength - 12, rawDictionary ? 0 : dictionaryPointer, rawDictionary ? 0 : dictionaryBytes.byteLength)
            assert.equal(native._ZSTD_isError(size), 0)
            assert.equal(size, expected.byteLength)
            assert(Buffer.from(native.HEAPU8.buffer, decoded, size).equals(expected), `${name}: decoded content mismatch`)
            maxHeapBytes = Math.max(maxHeapBytes, native.HEAPU8.byteLength)
        },
        memory() { return {heapBytes: native.HEAPU8.byteLength, maxHeapBytes, sourceBytes: maxSourceBytes + 16, destinationCapacity, dictionaryBytes: dictionaryBytes.byteLength, decodedBytes: maxSourceBytes} },
        activation() { return structuredClone(activation) },
        dispose() {
            native._free(source)
            native._free(destination)
            native._free(dictionaryPointer)
            native._free(decoded)
            native._ZSTD_freeCCtx(context)
            native._ZSTD_freeDCtx(decoder)
        },
    }
    encoderList.push(result)
    return result
}

const baseline = await createEncoder('A0', 'baseline')
const candidate = await createEncoder('B0', 'count128')
const control = await createEncoder('A1', 'baseline')
assert.deepEqual(baseline.exports, candidate.exports)
assert.deepEqual(baseline.imports, candidate.imports)
const encoders = new Map(encoderList.map((encoder) => [encoder.name, encoder]))
runBinding.modules = Object.fromEntries(encoderList.map((encoder) => [encoder.name, {arm: encoder.arm, wasmSha256: encoder.wasmSha256, moduleJsSha256: encoder.moduleJsSha256}]))
const sweeps = []
let exactComparisons = 0
let roundTrips = 0
let timedBlockIndexes = null

function bindBlockAdmission() {
    let enabled = false
    const admission = []
    for (const group of groups) {
        const framedBytes = group.blocks.reduce((total, index) => total + blocks[index].compressedBytes, 0)
        const referenceBytes = group.canonicalCount * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES
        const passesMinimumInput = group.canonicalBytes >= minBlockInputBytes
        const passesSavings = framedBytes + referenceBytes <= group.canonicalBytes * (1 - minBlockSavingsRatio)
        const attempted = group.canonicalBytes > 0 && (enabled || passesMinimumInput)
        const accepted = attempted && (enabled || passesSavings)
        admission.push({group: group.group, forced: enabled, canonicalBytes: group.canonicalBytes,
            framedBytes, referenceBytes, passesMinimumInput, passesSavings, compressionAttemptExpected: attempted, blockStorageAcceptedExpected: accepted})
        if (accepted) enabled = true
    }
    const first = admission.find((group) => group.canonicalBytes > 0)
    assert(first)
    if (dictionaryBytes.byteLength > 0) {
        assert(first.passesMinimumInput && first.passesSavings,
            `Trained-dictionary first group needs the true production early-reservation replay before warm timing: ${JSON.stringify(first)}`)
    }
    // Claim first-group block admission only after checking the actual framed
    // bytes and unchanged compact-reference overhead. A raw first group stays
    // in the correctness corpus but does not enter subsequent timing sweeps.
    if (first.blockStorageAcceptedExpected) {
        assert(first.passesMinimumInput)
        assert(first.framedBytes + first.referenceBytes <= first.canonicalBytes * (1 - minBlockSavingsRatio))
    }
    timedBlockIndexes = new Set(blocks.filter((block) => admission[block.group].compressionAttemptExpected).map((block) => block.index))
    assert(timedBlockIndexes.size > 0)
    for (const index of timedBlockIndexes) assert(admission[blocks[index].group].compressionAttemptExpected)
    corpus.blockAdmission = {minInputBytes: minBlockInputBytes, minSavingsRatio: minBlockSavingsRatio,
        compactReferenceBytes: RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES, firstNonemptyGroup: first,
        groups: admission, timedBlockIndexes: [...timedBlockIndexes],
        correctnessOnlyBlockIndexes: blocks.filter((block) => !timedBlockIndexes.has(block.index)).map((block) => block.index),
        evidenceScope: 'Admission is replayed from baseline framed output and production policy, not observed OPFS dispatch. The native kernel invocation counters below prove only this component runner execution; browser dispatch and fallback require browser qualification.',
    }
    corpus.scope = 'Component feasibility screen over unchanged production parser content, exact-byte global dedup, and 1 MiB group packing. The baseline preflight validates every potential block. Warm timings include only groups where production would attempt block compression under the recorded minimum-input/forced/savings policy. Raw-only groups remain correctness inputs. No persistence, worker scheduling, fallback incidence, or complete browser import timing is measured.'
}

async function sweep(kind, index, order, cold = false) {
    const observation = {kind, index, order, blockScope: cold ? 'all potential blocks, including admission preflight' : 'production-policy compression inputs', totals: {}, blocks: []}
    for (const name of order) observation.totals[name] = {compressMs: 0, envelopeMs: 0, wrappedMs: 0}
    for (const block of blocks) {
        if (!cold && !timedBlockIndexes.has(block.index)) continue
        const bytes = await readFile(join(outputRoot, 'corpus', block.filename))
        assert.equal(sha(bytes), block.sha256)
        const expectedPath = join(outputRoot, 'corpus', `${block.filename}.zstd`)
        let expected = cold ? null : await readFile(expectedPath)
        const timing = {block: block.index, arms: {}}
        for (const name of order) {
            const encoder = encoders.get(name)
            const result = encoder.compress(bytes)
            if (expected === null) {
                expected = Buffer.from(result.bytes)
                await writeFile(expectedPath, expected, {flag: 'wx'})
                block.compressedBytes = expected.byteLength
                block.compressedSha256 = sha(expected)
            } else {
                assert(result.bytes.equals(expected), `${name} differs at${kind}/${index}/block${block.index}`)
                ++exactComparisons
            }
            if (cold) {
                encoder.roundTrip(expected, bytes)
                ++roundTrips
            }
            timing.arms[name] = {compressMs: result.compressMs, envelopeMs: result.envelopeMs, wrappedMs: result.wrappedMs}
            observation.totals[name].compressMs += result.compressMs
            observation.totals[name].envelopeMs += result.envelopeMs
            observation.totals[name].wrappedMs += result.wrappedMs
        }
        observation.blocks.push(timing)
    }
    observation.memory = Object.fromEntries(encoderList.map((encoder) => [encoder.name, encoder.memory()]))
    sweeps.push(observation)
    await checkpoint('sweeps-in-progress')
    console.log(JSON.stringify({stage: 'sweep', dictionary, kind, index, order, totals: observation.totals}))
}

let syntheticCases = 0
async function checkpoint(status, error = null) {
    const record = {status, runBinding, corpus, buildReport, sweeps, exactComparisons, roundTrips, syntheticCases,
        nativeMemory: Object.fromEntries(encoderList.map((encoder) => [encoder.name, encoder.memory()])),
        nativeActivation: Object.fromEntries(encoderList.map((encoder) => [encoder.name, encoder.activation()])),
        ...(error === null ? {} : {error: {name: error.name, message: error.message, stack: error.stack}}),
    }
    await writeFile(join(outputRoot, 'report.partial.json'), JSON.stringify(record, null, 2) + '\n')
    await writeFile(join(outputRoot, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n')
}

try {
    await sweep('cold-native-compression', 0, ['A0', 'B0', 'A1'], true)
    bindBlockAdmission()
    await checkpoint('block-admission-bound')
    await sweep('fixed-warmup', 0, ['B0', 'A1', 'A0'])
    globalThis.gc()
    for (let pair = 0; pair < 12; ++pair) {
        await sweep('AB', pair, pair % 2 === 0 ? ['A0', 'B0'] : ['B0', 'A0'])
        if (pair % 3 === 2) {
            const controlPair = (pair - 2) / 3
            await sweep('AA', controlPair, controlPair % 2 === 0 ? ['A0', 'A1'] : ['A1', 'A0'])
        }
    }
    let seed = 0x3817abcd
    const lengths = [0, 1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 1023, 1024, 1025, 131071, 131072, 131073, 1048575, 1048576, 1048577]
    for (const rawDictionary of [false, true]) {
        for (const length of lengths) {
            for (const pattern of ['repeated', 'random']) {
                const bytes = Buffer.alloc(length)
                for (let i = 0; i < length; ++i) {
                    seed ^= seed << 13
                    seed ^= seed >>> 17
                    seed ^= seed << 5
                    bytes[i] = pattern === 'repeated' ? i % 19 : seed & 0xff
                }
                let expected = null
                for (let alignment = 0; alignment < 16; ++alignment) {
                    const a = baseline.compress(bytes, alignment, rawDictionary, 'synthetic')
                    if (expected === null) expected = Buffer.from(a.bytes)
                    assert(a.bytes.equals(expected), 'Baseline output differs with source alignment')
                    const b = candidate.compress(bytes, alignment, rawDictionary, 'synthetic')
                    assert(b.bytes.equals(expected), 'Candidate output differs on synthetic boundary input')
                    candidate.roundTrip(expected, bytes, rawDictionary)
                    ++syntheticCases
                    ++roundTrips
                    exactComparisons += 2
                }
            }
        }
    }
    const report = {
        corpus,
        buildReport,
        runBinding,
        protocol: {coldSweeps: 1, warmupSweeps: 1, pairedSweeps: 12, controlSweeps: 4, ordering: 'The selected arm order is interleaved for each block within a sweep; AB/BA alternates between sweeps; an AA pair follows every third AB pair and AA order alternates',
            timer: 'compressMs times only the production native compression entry point recorded in corpus.nativeCompressionEntryPoint. The unchanged default enables generic span compression, so all three dictionaries use retained-context ZSTD_compress_usingDict; VNDB passes an empty dictionary at level 1. envelopeMs separately times the corresponding native writer or JavaScript wrapper; wrappedMs is their sum, not an end-to-end duration. External source/destination allocation, input copy, frame extraction, exact output checks, decompression, disk IO, parser work, and module instantiation are excluded; native context allocation inside the generic convenience fallback and allocation/copy inside the JavaScript envelope helper are included in their respective intervals. Cold denotes first native compression sweep, not cold complete import.',
            syntheticGenericFallback: 'After all timed corpus sweeps, rawDictionary=true cases additionally exercise ZSTD_compress at level 1 plus the production JavaScript envelope helper; these are correctness cases, not ordinary VNDB timing samples.',
            controls: 'A0/A1 are separate same-code module instances and memory owners; they may share engine JIT code. B0 has the candidate binary. All remain in one Node process.',
            gc: 'One explicit collection after corpus acquisition and one after fixed warmup; no collection inside measured sweeps'},
        sweeps,
        exactComparisons,
        roundTrips,
        syntheticCases,
        nativeMemory: Object.fromEntries(encoderList.map((encoder) => [encoder.name, encoder.memory()])),
        nativeActivation: Object.fromEntries(encoderList.map((encoder) => [encoder.name, encoder.activation()])),
        node: process.version,
        processMemory: process.memoryUsage(),
        scope: 'A component feasibility screen. No claim about full browser import, lookup, OPFS persistence, process peak memory, or browser startup follows from these measurements.',
    }
    assert.deepEqual(report.nativeMemory.A0, report.nativeMemory.B0)
    for (const encoder of encoderList) {
        const actual = encoder.activation().corpus
        assert(actual[nativeCompressionEntryPoint] > 0)
        assert.equal(actual[nativeCompressionEntryPoint === 'ZSTD_compress' ? 'ZSTD_compress_usingDict' : 'ZSTD_compress'], 0)
        assert.equal(actual[ordinaryGenericFallback ? 'nativeEnvelope' : 'javascriptEnvelope'], 0)
        assert.equal(actual[ordinaryGenericFallback ? 'javascriptEnvelope' : 'nativeEnvelope'], actual[nativeCompressionEntryPoint])
    }
    await checkpoint('complete')
    await writeFile(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await writeFile(join(outputRoot, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n')
    console.log(JSON.stringify({stage: 'complete', dictionary, blocks: blocks.length, exactComparisons, roundTrips, syntheticCases, nativeMemory: report.nativeMemory}))
} catch (error) {
    await checkpoint('failed', error)
    throw error
} finally {
    for (const encoder of encoderList) encoder.dispose()
}
