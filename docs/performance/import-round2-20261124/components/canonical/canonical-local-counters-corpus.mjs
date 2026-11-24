import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {inflateRawSync, crc32} from 'node:zlib'
import {execFileSync} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'

// Derived from dev/perf/canonical-journal-20261123/native-parity-runner.mjs.txt
// at 8282d596809d76ca2960f926719d94877925489e; this v1 experiment compares
// the complete journal byte-for-byte and leaves the ABI unchanged.
const workspace = process.env.MANABITAN_COMPONENT_WORKSPACE ?? path.dirname(fileURLToPath(import.meta.url))
const root = process.env.MANABITAN_COMPONENT_CANDIDATE ?? path.join(workspace, 'canonical-local-counters')
const baseline = process.env.MANABITAN_COMPONENT_BASELINE ?? path.join(workspace, 'manabitan')
const cache = process.env.MANABITAN_COMPONENT_CACHE ?? path.join(baseline, 'builds/e2e-dictionary-cache')
const mode = process.argv[2] ?? 'parity'
const dictionaries = process.argv.slice(3)
if (dictionaries.length === 0) { dictionaries.push('jmdict', 'jitendex', 'vndb') }
const output = path.join(workspace, `canonical-local-counters-${mode}-${dictionaries.join('-')}.json`)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const baselineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: baseline, encoding: 'utf8'}).trim()
assert.equal(baselineCommit, 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26')
const candidatePaths = [
    'ext/js/dictionary/wasm/term-content-canonical-scan-v1.c',
    'ext/js/dictionary/term-content-canonical-scan.js',
    'ext/js/dictionary/term-content-canonical-layout.js',
    'dev/data/dictionary-wasm/manifest.json',
    'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
]
const candidateHashes = Object.fromEntries(await Promise.all(candidatePaths.map(async (name) => [name, sha256(await readFile(path.join(root, name)))])))
const locks = JSON.parse(await readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8'))
const {ZipReader, Uint8ArrayReader} = await import(pathToFileURL(path.join(root, 'node_modules/@zip.js/zip.js/index.js')))
const parser = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const {DictionaryDatabase} = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/dictionary-database.js')))
const {NativeCanonicalScanner} = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/term-content-canonical-scan.js')))
const {CANONICAL_SCAN_LAYOUT: layout} = await import(pathToFileURL(path.join(baseline, 'ext/js/dictionary/term-content-canonical-layout.js')))
const baselineWasm = await readFile(path.join(baseline, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm'))
const candidateWasm = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm'))
const modules = {A: await WebAssembly.compile(baselineWasm), B: await WebAssembly.compile(candidateWasm)}
modules.C = modules.A
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))))
const options = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
}
const schedule = mode === 'bench' ? [
    ...Array.from({length: 2}, () => ({warmup: true, order: ['A', 'B', 'C']})),
    ...Array.from({length: 2}, () => [
        ['A', 'B', 'C'], ['B', 'C', 'A'], ['C', 'A', 'B'],
        ['C', 'B', 'A'], ['A', 'C', 'B'], ['B', 'A', 'C'],
    ]).flat().map((order) => ({warmup: false, order})),
] : [{warmup: false, order: ['A', 'B']}]
const report = {
    schema: 1,
    mode,
    complete: false,
    node: process.version,
    v8: process.versions.v8,
    host: {cpu: os.cpus()[0].model, availableParallelism: os.availableParallelism(), startLoad: os.loadavg(), totalMemory: os.totalmem()},
    limitations: 'Local component timings can overlap concurrent validation on this shared host. They are exploratory, not an isolated hosted whole-import result or a memory measurement.',
    scope: 'Native canonical scan only. Production parser output and metadata-owner state captured at the pre-call hook, with four-bank component partitions. Each arm resets an independent memory to the complete identical snapshot outside timing. All source banks are included; ZIP inflation, parser, copy/adoption, byte-exact matching, compression, storage and UI are outside the timed kernel. This is not a whole-import benchmark.',
    sources: {
        baselineCommit,
        baselineWasm: sha256(baselineWasm),
        candidateWasm: sha256(candidateWasm),
        candidateC: sha256(await readFile(path.join(root, 'ext/js/dictionary/wasm/term-content-canonical-scan-v1.c'))),
        candidateHashes,
        harness: sha256(await readFile(new URL(import.meta.url))),
    },
    schedule,
    dictionaries: [],
}
let replayArms = {}
function replay(memory, item) {
    const snapshot = new Uint8Array(memory.buffer).slice()
    const config = new Uint32Array(snapshot.buffer, 1088, 22)
    const entry = {
        inputSha256: sha256(snapshot),
        memoryBytes: snapshot.byteLength,
        rows: config[12],
        first: config[13],
        last: config[14],
        cursor: config[15],
        rounds: [],
    }
    item.calls.push(entry)
    const pages = snapshot.byteLength / 65536
    for (const id of new Set(schedule.flatMap(({order}) => order))) {
        if (replayArms[id]?.bytes.byteLength === snapshot.byteLength) { continue }
        const armMemory = new WebAssembly.Memory({initial: pages, maximum: pages})
        const instance = new WebAssembly.Instance(modules[id], {env: {memory: armMemory}})
        assert.equal(instance.exports.canonical_abi_version(), 1)
        replayArms[id] = {bytes: new Uint8Array(armMemory.buffer), run: instance.exports.scan_canonical}
    }
    for (const {warmup, order} of schedule) {
        const round = {warmup, order, timings: {}, cpuMicros: {}}
        entry.rounds.push(round)
        let expectedResult = null
        for (const id of order) {
            const arm = replayArms[id]
            arm.bytes.set(snapshot)
            const cpuStarted = process.cpuUsage()
            const started = performance.now()
            const result = arm.run()
            round.timings[id] = performance.now() - started
            const cpu = process.cpuUsage(cpuStarted)
            round.cpuMicros[id] = cpu.user + cpu.system
            assert.ok(result === 0 || result === 1)
            if (expectedResult === null) { expectedResult = result }
            assert.equal(result, expectedResult)
        }
        const expected = replayArms.A.bytes
        for (const id of order.filter((value) => value !== 'A')) {
            const actual = replayArms[id].bytes
            // The compiler's private stack may differ. Compare all seven
            // header words and every input, output, journal (including tails),
            // exact descriptor and authoritative table byte without rewriting.
            assert.deepEqual(actual.subarray(1024, 1052), expected.subarray(1024, 1052))
            assert.equal(Buffer.compare(actual.subarray(1088, 1176), expected.subarray(1088, 1176)), 0)
            assert.equal(Buffer.compare(actual.subarray(layout.META), expected.subarray(layout.META)), 0)
        }
        entry.returnCode = expectedResult
    }
    const final = replayArms.A.bytes
    entry.header = [...new Uint32Array(final.buffer, 1024, 7)]
    entry.outputSha256 = sha256(final.subarray(layout.META))
}

try {
    for (const dictionary of dictionaries) {
        const spec = locks.dictionaries[dictionary]
        const archive = await readFile(path.join(cache, spec.cacheFile))
        assert.equal(archive.byteLength, spec.sizeBytes)
        assert.equal(sha256(archive), spec.sha256)
        const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)), {useWebWorkers: false})
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const item = {dictionary, archiveSha256: spec.sha256, banks: entries.length, rows: 0, uniqueRows: 0, pendingRows: 0, exactRows: 0, fallbackGroups: [], calls: []}
        report.dictionaries.push(item)
        const db = new DictionaryDatabase()
        const blocks = []
        let nextBase = 0
        db._nativeCanonicalScanner = new NativeCanonicalScanner({
            loadModule: async () => modules.A,
            hooks: {beforeNative: ({a}) => replay(a.memory, item)},
        })
        db._readTermEntryContentBytesDetailed = async (offset, length) => {
            const block = blocks.find((value) => offset >= value.base && offset + length <= value.base + value.bytes.byteLength)
            assert.ok(block)
            return {status: 'ok', bytes: block.bytes.subarray(offset - block.base, offset - block.base + length)}
        }
        for (let first = 0; first < entries.length; first += 4) {
            const sources = []
            let expectedRows = 0
            for (const entry of entries.slice(first, first + 4)) {
                const start = entry.offset
                assert.equal(archive.readUInt32LE(start), 0x04034b50)
                assert.equal(archive.readUInt16LE(start + 8), entry.compressionMethod)
                const filenameLength = archive.readUInt16LE(start + 26)
                const extraLength = archive.readUInt16LE(start + 28)
                assert.equal(archive.subarray(start + 30, start + 30 + filenameLength).toString(), entry.filename)
                const payload = archive.subarray(start + 30 + filenameLength + extraLength, start + 30 + filenameLength + extraLength + entry.compressedSize)
                const decoded = entry.compressionMethod === 0 ? payload : inflateRawSync(payload)
                assert.equal(decoded.length, entry.uncompressedSize)
                assert.equal(crc32(decoded), entry.signature)
                expectedRows += JSON.parse(decoded.toString()).length
                sources.push({bytes: payload, compressionMethod: entry.compressionMethod, compressedSize: payload.length, uncompressedSize: decoded.length, signature: entry.signature, filename: entry.filename})
            }
            const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true)
            let groupRows = 0
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, async (borrowed) => {
                const chunk = parser.copyWasmBackedColumnChunk(borrowed)
                chunk.dictionary = spec.expectedTitle
                chunk.dictionaryTotalRows = spec.termRows
                chunk.uniformContentDictName = 'raw'
                chunk.contentDictNameList = null
                chunk.useResolvedContentReferences = true
                const resolved = await db._resolveArtifactTermContentDedup(chunk, true)
                if (resolved.nativeScanMetrics.dedupNativeFallbackCount > 0) {
                    assert.equal(db._nativeCanonicalScanner.stats.fallbackReason, 'eligibility')
                    item.fallbackGroups.push({firstBank: first + 1, rows: chunk.rowCount, reason: db._nativeCanonicalScanner.stats.fallbackReason})
                }
                item.rows += chunk.rowCount
                groupRows += chunk.rowCount
                item.uniqueRows += chunk.contentDedupPlan.uniqueCount
                item.pendingRows += resolved.pendingContentCount
                item.exactRows += resolved.persistedHitCount
                const spans = resolved.pendingContentSpans
                const pendingOffsets = new Float64Array(resolved.pendingContentCount)
                const pendingLengths = new Uint32Array(resolved.pendingContentCount)
                const base = nextBase
                for (let i = 0; i < pendingOffsets.length; ++i) {
                    pendingOffsets[i] = base + spans.offsets[i]
                    pendingLengths[i] = spans.lengths[i]
                }
                blocks.push({base, bytes: spans.buffer})
                nextBase += spans.buffer.byteLength + 1
                db._publishResolvedArtifactTermContentPlan(
                    resolved.contentDedupPlan,
                    resolved.pendingPlanUniqueStart,
                    resolved.pendingPlanUniqueIndexes,
                    pendingOffsets,
                    pendingLengths,
                    'raw',
                )
                db._publishArtifactTermContentMetadata({
                    ...resolved,
                    count: chunk.rowCount,
                    pendingOffsets,
                    pendingLengths,
                    pendingResolvedDictNames: 'raw',
                    contentUniqueIndexList: chunk.contentUniqueIndexList,
                    useResolvedContentReferences: true,
                })
            }, 2048, {...options, preloadedSource})
            assert.equal(groupRows, expectedRows)
            if (first % 40 === 0 || first + 4 >= entries.length) {
                console.log(`${dictionary}: ${Math.min(first + 4, entries.length)}/${entries.length} banks, ${item.rows} rows, ${item.calls.length} identical native calls`)
                await writeFile(output, JSON.stringify(report, null, 2))
            }
        }
        assert.equal(item.rows, spec.termRows)
        await reader.close()
        replayArms = {}
    }
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: baseline, encoding: 'utf8'}).trim(), baselineCommit)
    for (const name of candidatePaths) { assert.equal(sha256(await readFile(path.join(root, name))), candidateHashes[name]) }
    report.complete = true
} catch (error) {
    report.error = error.stack ?? String(error)
    process.exitCode = 1
} finally {
    report.host.endLoad = os.loadavg()
    await writeFile(output, JSON.stringify(report, null, 2))
    console.log(output)
}

