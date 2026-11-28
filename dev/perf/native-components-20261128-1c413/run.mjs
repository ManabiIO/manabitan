/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'
import os from 'node:os'
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js'
import {getImageMediaTypeFromFileName} from '../../../ext/js/media/media-util.js'
import {kitIdentity, plan, readJson, repo, sha256, verifyDesign, verifyRuntime, writeJson} from './common.mjs'

assert.ok(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === '--verify-only'),
    'Usage: node --expose-gc run.mjs PREPARED_DIRECTORY ARCHIVE_PATH [--verify-only]')
verifyDesign()
const verifyOnly = process.argv[4] === '--verify-only'
const prepared = path.resolve(process.argv[2])
const archivePath = path.resolve(process.argv[3])
const output = path.join(prepared, verifyOnly ? 'verification' : 'screen')
await mkdir(output, {recursive: false})
const preparation = await readJson(path.join(prepared, 'preparation.json'))
assert.equal(preparation.complete, true)
assert.equal(preparation.baseline, plan.baseline)
assert.deepEqual(await verifyRuntime(), preparation.runtimeIdentity)
assert.deepEqual(await kitIdentity(), preparation.kitIdentity)
const affinity = (await readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
let affinityReceipt = null
if (!verifyOnly) {
    affinityReceipt = await readJson(path.join(prepared, 'affinity.json'))
    assert.deepEqual(affinityReceipt.activeCpus, [affinityReceipt.selectedCpu])
    assert.equal(affinityReceipt.selectedCpu, affinityReceipt.initialAllowedCpus[affinityReceipt.initialAllowedCpus.length > 1 ? 1 : 0])
    assert.equal(affinity, String(affinityReceipt.selectedCpu))
}
const acquisition = {complete: false, mode: verifyOnly ? 'untimed full-output portability verification' : 'fixed component screen',
    frozenPlan: plan, preparationHead: preparation.head, kitIdentity: preparation.kitIdentity,
    runtimeSourceDigest: preparation.runtimeIdentity.digest, node: process.version,
    host: {platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus(), totalMemory: os.totalmem()},
    affinity, affinityReceipt, startedAt: new Date().toISOString(), initialMemory: process.memoryUsage()}
await writeJson(path.join(output, 'acquisition.json'), acquisition)
await writeFile(path.join(output, 'host-before.txt'), await readFile('/proc/meminfo'))

// This is the unchanged byte-balancing algorithm from the source-bound replay
// named in plan.json. It models the policy's groups, not worker concurrency.
function partition(entries, groupsPerWorker) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const groupCount = Math.min(entries.length, Math.max(plan.grouping.parserWorkers * groupsPerWorker, Math.ceil(total / plan.grouping.targetBytes)))
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
            if (Math.abs(nextBytes - target) > Math.abs(bytes - target)) break
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

const archive = await readFile(archivePath)
assert.equal(archive.byteLength, plan.fixture.sizeBytes)
assert.equal(sha256(archive), plan.fixture.sha256)
assert.equal(sha256(await readFile(path.join(repo, plan.grouping.reference))), plan.grouping.referenceSha256)
const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)), {useWebWorkers: false})
const groups = []
let hasArchiveImages
try {
    const allEntries = await reader.getEntries()
    hasArchiveImages = allEntries.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null)
    assert.equal(hasArchiveImages, false, 'The locked JMdict archive has no image entries')
    assert.equal(plan.options.mediaHintFastScan, hasArchiveImages)
    const indexEntries = allEntries.filter((entry) => entry.filename === 'index.json')
    assert.equal(indexEntries.length, 1)
    const index = JSON.parse(new TextDecoder().decode(await indexEntries[0].getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})))
    assert.equal(index.title, plan.fixture.expectedTitle)
    assert.equal(index.revision, plan.fixture.revision)
    assert.equal(index.format, 3)
    const entries = allEntries.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    assert.equal(entries.length, plan.termBankCount)
    for (let i = 0; i < entries.length; i++) assert.equal(entries[i].filename, `term_bank_${i + 1}.json`)
    const groupsPerWorker = hasArchiveImages ? plan.grouping.mediaGroupsPerWorker : plan.grouping.plainGroupsPerWorker
    for (const entriesInGroup of partition(entries, groupsPerWorker)) {
        const sources = []
        const identities = []
        for (const entry of entriesInGroup) {
            const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
            assert.equal(bytes.byteLength, entry.uncompressedSize)
            sources.push(bytes)
            identities.push({name: entry.filename, bytes: bytes.byteLength, sha256: sha256(bytes)})
        }
        groups.push({sources, identities})
    }
    assert.equal(groups.length, plan.grouping.expectedGroupCount)
    acquisition.input = {archiveSha256: plan.fixture.sha256, archiveBytes: archive.byteLength, index,
        hasArchiveImages, groupsPerWorker, groups: groups.map(({identities}) => identities)}
    await writeJson(path.join(output, 'acquisition.json'), acquisition)
} finally { await reader.close() }

const options = {...plan.options, mediaHintFastScan: hasArchiveImages}
const timedExports = new Set(plan.timedExports)
const moduleStates = new WeakMap()
const realInstantiate = WebAssembly.instantiate.bind(WebAssembly)
WebAssembly.instantiate = async (module, imports) => {
    const instance = await realInstantiate(module, imports)
    const state = moduleStates.get(module)
    if (!state) return instance
    state.instances++
    const exports = {...instance.exports}
    for (const [name, native] of Object.entries(exports)) {
        if (!timedExports.has(name)) continue
        exports[name] = (...args) => {
            if (!state.active) return native(...args)
            const cpuBefore = process.threadCpuUsage()
            const before = performance.now()
            try { return native(...args) } finally {
                const wallMs = performance.now() - before
                const cpu = process.threadCpuUsage(cpuBefore)
                const entry = state.calls[name] ??= {count: 0, wallMs: 0, cpuMs: 0, userCpuMicros: 0, systemCpuMicros: 0}
                entry.count++
                entry.wallMs += wallMs
                entry.cpuMs += (cpu.user + cpu.system) / 1000
                entry.userCpuMicros += cpu.user
                entry.systemCpuMicros += cpu.system
            }
        }
    }
    return {exports}
}

const states = {}
const observations = []
const warmups = []
let expected = null
let currentObservation = null
const hashView = (hash, view) => {
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32LE(view.byteLength)
    hash.update(length)
    hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}
const hashJson = (hash, value) => hashView(hash, Buffer.from(JSON.stringify(value)))

function fingerprintChunk(hash, chunk, result) {
    result.rows += chunk.rowCount
    hashJson(hash, {rowCount: chunk.rowCount, contentRowStart: chunk.contentRowStart ?? null,
        compactMetadata: chunk.contentMetaByUniqueIndex === true})
    for (const view of [chunk.readingEqualsExpressionList, chunk.scoreList, chunk.sequenceList]) hashView(hash, view)
    hashJson(hash, Boolean(chunk.contentUniqueIndexList))
    if (chunk.contentUniqueIndexList) hashView(hash, chunk.contentUniqueIndexList)
    const keyPlan = chunk.termRecordPreinternedPlan
    for (const view of [keyPlan.stringLengths, keyPlan.stringOffsets, keyPlan.stringHashes, keyPlan.stringsBuffer,
        Uint32Array.from(keyPlan.expressionIndexes), Uint32Array.from(keyPlan.readingIndexes)]) {
        assert.ok(view, 'Missing key column')
        hashView(hash, view)
    }
    for (const [key, entry] of chunk.preparedLookupIndexes) {
        hashJson(hash, key)
        hashView(hash, entry.bytes)
        hashJson(hash, Boolean(entry.routeFilter))
        if (entry.routeFilter) hashView(hash, entry.routeFilter)
        result.indexBytes += entry.bytes.byteLength
        const p = entry.preinternedPlan
        for (const view of [p.stringLengths, p.stringOffsets, p.stringHashes, p.stringsBuffer,
            Uint32Array.from(p.expressionIndexes), p.readingIndexes]) {
            hashJson(hash, typeof view !== 'undefined' && view !== null)
            if (view) hashView(hash, view)
        }
    }
    const {contentMetaList, contentBytesBuffer, contentBytesBaseOffset} = chunk
    assert.ok(contentMetaList && contentBytesBuffer && typeof contentBytesBaseOffset === 'number')
    for (let row = 0; row < chunk.rowCount; row++) {
        const contentIndex = chunk.contentMetaByUniqueIndex ? chunk.contentUniqueIndexList[row] : row
        const metaIndex = contentIndex * 4
        const offset = contentBytesBaseOffset + contentMetaList[metaIndex]
        const length = contentMetaList[metaIndex + 1]
        assert.ok(offset >= 0 && length >= 0 && offset + length <= contentBytesBuffer.length)
        hashView(hash, contentBytesBuffer.subarray(offset, offset + length))
        hashView(hash, contentMetaList.subarray(metaIndex + 1, metaIndex + 4))
        result.contentBytes += length
    }
    result.mediaRows += chunk.mediaRows.length
    for (const entry of chunk.mediaRows) {
        const {expressionBytes, readingBytes, glossaryJsonBytes, termEntryContentBytes, ...scalars} = entry.row
        hashJson(hash, {index: entry.index, imagePaths: entry.imagePaths ?? null, ...scalars})
        for (const view of [expressionBytes, readingBytes, glossaryJsonBytes, termEntryContentBytes]) {
            hashJson(hash, typeof view !== 'undefined')
            if (view) hashView(hash, view)
        }
    }
}

async function execute(state, measured) {
    state.calls = {}
    const result = {rows: 0, indexBytes: 0, contentBytes: 0, mediaRows: 0,
        nativeSegments: 0, fusedParseAttempts: 0, fusedParseFallbacks: 0, maxWasmHeapBytes: 0}
    const hash = createHash('sha256')
    let parserWallMs = 0
    for (const [groupIndex, group] of groups.entries()) {
        let chunk = null
        const before = measured ? performance.now() : 0
        state.active = measured
        try {
            await state.parser.parseTermBankWithWasmColumnChunks(group.sources, 3, (value) => {
                assert.equal(chunk, null, 'Expected one complete group')
                chunk = value
                if (!chunk.preparedLookupIndexes) {
                    const preparedIndexes = state.preparation.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, {})
                    assert.ok(preparedIndexes, 'Missing prepared lookup')
                    chunk.preparedLookupIndexes = preparedIndexes.indexes
                }
            }, plan.rowChunkSize, options)
        } finally { state.active = false }
        if (measured) parserWallMs += performance.now() - before
        assert.ok(chunk)
        assert.ok(state.preparation.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount))
        const profile = state.parser.consumeLastTermBankWasmParseProfile()
        assert.ok(profile)
        result.nativeSegments += profile.nativeSegmentedLookupSegments ?? 0
        result.fusedParseAttempts += profile.fusedParseAttempts ?? 0
        result.fusedParseFallbacks += profile.fusedParseFallbacks ?? 0
        result.maxWasmHeapBytes = Math.max(result.maxWasmHeapBytes, profile.maxWasmHeapBytes ?? 0)
        hashJson(hash, {groupIndex, banks: group.identities.map((entry) => entry.name)})
        fingerprintChunk(hash, chunk, result)
    }
    assert.equal(result.rows, plan.fixture.termRows)
    assert.equal(state.instances, 1, `Expected one independent native instance for ${state.arm}`)
    result.digest = hash.digest('hex')
    const {maxWasmHeapBytes, ...semanticResult} = result
    if (expected === null) {
        assert.equal(state.arm, 'A', 'Establish the oracle from baseline A')
        expected = semanticResult
    }
    assert.deepEqual(semanticResult, expected, `Full output differs for ${state.arm}`)
    if (measured) {
        assert.ok(state.calls[plan.primaryExport]?.count > 0, 'Fused native parser was not timed')
        return {...result, nativeCalls: state.calls, parserWallMs, memory: process.memoryUsage()}
    }
    return result
}

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}
function contrasts(metric) {
    const pairs = [['C', 'A']]
    for (const arm of Object.keys(plan.arms)) if (arm !== 'A' && arm !== 'C') pairs.push([arm, 'A'], [arm, 'C'])
    const results = {}
    for (const [candidate, control] of pairs) {
        const changes = []
        let candidateSum = 0
        let controlSum = 0
        for (let block = 1; block <= plan.schedule.length; block++) {
            const candidateValue = metric(observations.find((row) => row.block === block && row.arm === candidate).result)
            const controlValue = metric(observations.find((row) => row.block === block && row.arm === control).result)
            assert.ok(candidateValue > 0 && controlValue > 0)
            candidateSum += candidateValue
            controlSum += controlValue
            changes.push(100 * (candidateValue / controlValue - 1))
        }
        results[`${candidate}/${control}`] = {pairedChangesPercent: changes, medianPairedChangePercent: median(changes),
            equalWorkChangePercent: 100 * (candidateSum / controlSum - 1), fasterPairs: changes.filter((value) => value < 0).length,
            candidateMeanMs: candidateSum / changes.length, controlMeanMs: controlSum / changes.length}
    }
    return results
}

try {
    const preparationModule = await import(pathToFileURL(path.join(repo, 'ext/js/dictionary/term-lookup-index-preparation.js')).href)
    for (const [arm, variant] of Object.entries(plan.arms)) {
        const bytes = await readFile(path.join(prepared, 'modules', `${variant}.wasm`))
        assert.equal(sha256(bytes), plan.variants[variant].wasmSha256)
        const parserUrl = pathToFileURL(path.join(repo, 'ext/js/dictionary/term-bank-wasm-parser.js'))
        parserUrl.searchParams.set('residentArm', arm)
        const parser = await import(parserUrl.href)
        const module = await WebAssembly.compile(bytes)
        const state = {arm, variant, parser, preparation: preparationModule, module, active: false, calls: {}, instances: 0}
        moduleStates.set(module, state)
        states[arm] = state
        parser.setTermBankWasmModule(module)
    }
    if (verifyOnly) {
        for (const arm of Object.keys(plan.arms)) {
            globalThis.gc()
            const result = await execute(states[arm], false)
            observations.push({arm, result})
            await writeJson(path.join(output, 'observations.json'), {complete: false, observations})
            console.log(`Verified ${arm}: ${result.rows} rows, ${groups.length} groups, digest ${result.digest}`)
        }
    } else {
        for (const [round, order] of plan.warmupOrder.entries()) {
            for (const arm of order) {
                globalThis.gc()
                const result = await execute(states[arm], false)
                warmups.push({round: round + 1, arm, result})
                await writeJson(path.join(output, 'warmups.json'), warmups)
                console.log(`Untimed warmup ${round + 1}: ${arm}, full output verified`)
            }
        }
        for (const [block, order] of plan.schedule.entries()) {
            for (const [position, arm] of [...order].entries()) {
                currentObservation = {block: block + 1, position: position + 1, arm}
                globalThis.gc()
                const result = await execute(states[arm], true)
                observations.push({...currentObservation, result})
                await writeJson(path.join(output, 'observations.json'), {complete: false, expected, observations})
                console.log(`Block ${block + 1}/${plan.schedule.length} ${arm}: native CPU ${result.nativeCalls[plan.primaryExport].cpuMs.toFixed(3)} ms; full output verified`)
                currentObservation = null
            }
        }
        assert.equal(observations.length, 128)
    }
    assert.deepEqual(await verifyRuntime(), preparation.runtimeIdentity)
    assert.deepEqual(await kitIdentity(), preparation.kitIdentity)
    assert.equal((await stat(archivePath)).size, plan.fixture.sizeBytes)
    assert.equal(sha256(await readFile(archivePath)), plan.fixture.sha256)
    for (const [variant, expectedVariant] of Object.entries(plan.variants)) {
        assert.equal(sha256(await readFile(path.join(prepared, 'modules', `${variant}.wasm`))), expectedVariant.wasmSha256)
    }
    const summary = {complete: true, mode: acquisition.mode, expected, observations: observations.length,
        warmups: warmups.length, finalMemory: process.memoryUsage(), lifetimeMaxRssKiB: process.resourceUsage().maxRSS,
        finishedAt: new Date().toISOString(), scope: plan.scope, selectionPolicy: plan.selectionPolicy}
    if (!verifyOnly) {
        summary.nativeCpuContrasts = contrasts((row) => row.nativeCalls[plan.primaryExport].cpuMs)
        summary.nativeWallContrasts = contrasts((row) => row.nativeCalls[plan.primaryExport].wallMs)
        summary.allNativeCpuContrasts = contrasts((row) => Object.values(row.nativeCalls).reduce((sum, call) => sum + call.cpuMs, 0))
        summary.parserWallContrasts = contrasts((row) => row.parserWallMs)
    }
    await writeJson(path.join(output, 'observations.json'), {complete: true, expected, observations})
    await writeJson(path.join(output, 'summary.json'), summary)
    await writeFile(path.join(output, 'host-after.txt'), await readFile('/proc/meminfo'))
    acquisition.complete = true
    acquisition.finishedAt = summary.finishedAt
    await writeJson(path.join(output, 'acquisition.json'), acquisition)
    console.log(JSON.stringify(summary, null, 2))
} catch (error) {
    await writeJson(path.join(output, 'observations.json'), {complete: false, error: String(error.stack ?? error), currentObservation, expected, observations})
    throw error
} finally { WebAssembly.instantiate = realInstantiate }
