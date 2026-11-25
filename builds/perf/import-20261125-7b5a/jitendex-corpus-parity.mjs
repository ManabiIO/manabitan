import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {BlobReader, Uint8ArrayWriter, ZipReader} from './manabitan/node_modules/@zip.js/zip.js/index.js'

const workspace = path.dirname(new URL(import.meta.url).pathname)
const roots = [path.join(workspace, 'manabitan'), path.join(workspace, 'combined')]
const cache = path.join(roots[0], 'builds/e2e-dictionary-cache')
const output = path.join(workspace, 'combined-corpus-parity.json')
const filesPerGroup = {jmdict: 7, jitendex: 10, vndb: 8}
const lockPath = path.join(roots[0], 'test/perf/dictionaries.lock.json')
const lockBytes = await readFile(lockPath)
const lock = JSON.parse(lockBytes)
const skippedKeys = new Set(['preparedLookupIndexEncodeMs'])
const options = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    experimentalNativeEscapedKeys: true,
    experimentalNativeSegmentedLookup: true,
    compactContentMetadata: true,
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hashFile = async (file) => {
    const hash = createHash('sha256')
    for await (const data of createReadStream(file)) { hash.update(data) }
    return hash.digest('hex')
}
const paths = ['ext/js/dictionary/wasm/term-bank-parser.c', 'ext/lib/term-bank-parser.wasm', 'dev/data/dictionary-wasm/manifest.json', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-lookup-index-preparation.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-record-preinterned-plan.js', 'ext/js/dictionary/term-lookup-index.js', 'ext/js/dictionary/term-lookup-scratch.js']
const modules = []
const sources = []
for (const root of roots) {
    const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    const preparation = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-lookup-index-preparation.js')))
    await parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))))
    modules.push({parser, preparation})
    const hashes = {}
    for (const file of paths) { hashes[file] = await hashFile(path.join(root, file)) }
    sources.push({root, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), hashes})
}
const addValue = (hash, value) => {
    if (ArrayBuffer.isView(value)) {
        hash.update(JSON.stringify(['view', value.constructor.name, value.byteLength]) + '\n')
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof Map) {
        hash.update(JSON.stringify(['map', value.size]) + '\n')
        for (const [key, item] of value) { addValue(hash, key); addValue(hash, item) }
    } else if (Array.isArray(value)) {
        hash.update(JSON.stringify(['array', value.length]) + '\n')
        for (const item of value) { addValue(hash, item) }
    } else if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => !skippedKeys.has(key)).sort()
        hash.update(JSON.stringify(['object', keys]) + '\n')
        for (const key of keys) { addValue(hash, value[key]) }
    } else {
        assert.notEqual(typeof value, 'function')
        hash.update(JSON.stringify([typeof value, value]) + '\n')
    }
}
const report = {kind: 'complete bounded parser/lookup/media byte parity; no performance claim', node: process.version, execArgv: process.execArgv, runnerSha256: await hashFile(new URL(import.meta.url)), lockSha256: sha256(lockBytes), sources, options, filesPerGroup, skippedTimingKeys: [...skippedKeys], counterNotes: {segmentedKeyBytes: 'Sum of stringsBuffer.byteLength over each natively prepared segment. Candidate avoids one encoder key memcpy for exactly this many bytes.', scratchBytes: 'Retired scratch address reservations; not a resident-process memory measurement.', wasmHeapBytes: 'WASM linear memory capacity sampled after each group; both instances persist across corpora.'}, corpora: [], complete: false}
await writeFile(output, JSON.stringify(report, null, 2))
for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const spec = lock.dictionaries[dictionary]
    const archivePath = path.join(cache, spec.cacheFile)
    assert.equal(await hashFile(archivePath), spec.sha256, `${dictionary} source identity`)
    const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), {useWebWorkers: false})
    const entries = []
    try {
        for await (const entry of reader.getEntriesGenerator()) {
            if (/^term_bank_\d+\.json$/.test(entry.filename)) { entries.push(entry) }
        }
        entries.sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const arms = roots.map((root, arm) => ({root, nativeSegments: 0, segmentedKeyBytes: 0, encoderKeyMemcpyBytesAvoided: 0, nativeSegmentedFallbacks: 0, fusedParseFallbacks: 0, scratchReuseGroups: 0, scratchReuseMisses: 0, sumRetiredScratchReservedBytes: 0, peakRetiredScratchReservedBytes: 0, peakWasmHeapBytes: 0, peakMetaAllocatedBytes: 0, peakContentCapacity: 0, arm}))
        const corpus = {dictionary, archiveSha256: spec.sha256, banks: entries.length, filesPerGroup: filesPerGroup[dictionary], groups: [], rows: 0, arms, maxInputBytes: 0, digest: null, complete: false}
        report.corpora.push(corpus)
        const corpusHash = createHash('sha256')
        for (let start = 0; start < entries.length; start += filesPerGroup[dictionary]) {
            const banks = entries.slice(start, start + filesPerGroup[dictionary])
            const bytes = []
            for (const bank of banks) { bytes.push(await bank.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})) }
            corpus.maxInputBytes = Math.max(corpus.maxInputBytes, bytes.reduce((total, value) => total + value.byteLength, 0))
            const results = []
            for (let arm = 0; arm < modules.length; ++arm) {
                const {parser, preparation} = modules[arm]
                const hash = createHash('sha256')
                let rows = 0
                let nativePreparedKeyBytes = 0
                await parser.parseTermBankWithWasmColumnChunks(bytes, 3, (chunk) => {
                    if (chunk.preparedLookupIndexes instanceof Map) {
                        for (const prepared of chunk.preparedLookupIndexes.values()) { nativePreparedKeyBytes += prepared.preinternedPlan.stringsBuffer.byteLength }
                    }
                    if (!chunk.preparedLookupIndexes) {
                        const prepared = preparation.prepareTermLookupIndexesFromPreinternedPlan(chunk)
                        assert(prepared, 'Missing completed lookup indexes')
                        chunk.preparedLookupIndexes = prepared.indexes
                    }
                    assert(preparation.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount))
                    const stable = parser.copyWasmBackedColumnChunk(chunk, true, true, true)
                    rows += stable.rowCount
                    addValue(hash, stable)
                }, 2048, options)
                const profile = parser.consumeLastTermBankWasmParseProfile()
                assert(profile)
                assert.equal(profile.rowCount, rows)
                const counters = {nativeSegments: profile.nativeSegmentedLookupSegments ?? 0, segmentedKeyBytes: profile.nativeSegmentedLookupSegments > 0 ? nativePreparedKeyBytes : 0, nativeSegmentedFallbacks: profile.nativeSegmentedLookupFallbacks ?? 0, fusedParseFallbacks: profile.fusedParseFallbacks ?? 0, scratchReuseGroups: profile.nativeLookupScratchReuseGroups ?? 0, scratchReuseMisses: profile.nativeLookupScratchReuseMisses ?? 0, retiredScratchReservedBytes: profile.nativeLookupScratchReusedBytes ?? 0, wasmHeapBytes: profile.maxWasmHeapBytes ?? 0, metaAllocatedBytes: profile.metaAllocatedBytes ?? 0, contentCapacity: profile.contentCapacity ?? 0}
                const totals = arms[arm]
                for (const name of ['nativeSegments', 'segmentedKeyBytes', 'nativeSegmentedFallbacks', 'fusedParseFallbacks', 'scratchReuseGroups', 'scratchReuseMisses']) { totals[name] += counters[name] }
                totals.encoderKeyMemcpyBytesAvoided += arm === 1 ? counters.segmentedKeyBytes : 0
                totals.sumRetiredScratchReservedBytes += counters.retiredScratchReservedBytes
                totals.peakRetiredScratchReservedBytes = Math.max(totals.peakRetiredScratchReservedBytes, counters.retiredScratchReservedBytes)
                totals.peakWasmHeapBytes = Math.max(totals.peakWasmHeapBytes, counters.wasmHeapBytes)
                totals.peakMetaAllocatedBytes = Math.max(totals.peakMetaAllocatedBytes, counters.metaAllocatedBytes)
                totals.peakContentCapacity = Math.max(totals.peakContentCapacity, counters.contentCapacity)
                results.push({rows, digest: hash.digest('hex'), counters})
            }
            assert.equal(results[0].rows, results[1].rows, `${dictionary} group ${start / filesPerGroup[dictionary]} row parity`)
            assert.equal(results[0].digest, results[1].digest, `${dictionary} group ${start / filesPerGroup[dictionary]} complete output parity`)
            corpus.rows += results[0].rows
            corpusHash.update(results[0].digest)
            corpus.groups.push({start: banks[0].filename, end: banks.at(-1).filename, rows: results[0].rows, digest: results[0].digest, counters: results.map((result) => result.counters)})
            if (corpus.groups.length % 16 === 0) {
                console.log(`${dictionary}: ${corpus.rows} rows / ${corpus.groups.length} groups match`)
                await writeFile(output, JSON.stringify(report, null, 2))
                globalThis.gc?.()
            }
            globalThis.gc?.()
        }
        assert.equal(corpus.rows, spec.termRows)
        corpus.digest = corpusHash.digest('hex')
        corpus.complete = true
        await writeFile(output, JSON.stringify(report, null, 2))
        console.log(`${dictionary}: ${corpus.rows} rows, ${corpus.groups.length} groups, complete output equality`)
    } finally { await reader.close() }
}
for (const {root, hashes} of sources) {
    for (const [file, digest] of Object.entries(hashes)) {
        assert.equal(await hashFile(path.join(root, file)), digest, `Source changed: ${root}/${file}`)
    }
}
report.complete = true
await writeFile(output, JSON.stringify(report, null, 2))
console.log(output)
