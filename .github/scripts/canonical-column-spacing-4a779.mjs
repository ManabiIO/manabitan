import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'

const baselineDirectory = process.env.PERF_BASELINE_DIRECTORY
const candidateDirectory = process.env.PERF_CANDIDATE_DIRECTORY
const zipPath = process.env.PERF_JMDICT_ARCHIVE
assert(baselineDirectory && candidateDirectory && zipPath, 'Missing registered screen paths')
const {parseTermBankWithWasmColumnChunks, setTermBankWasmModule} = await import(pathToFileURL(`${baselineDirectory}/ext/js/dictionary/term-bank-wasm-parser.js`).href)
const {NativeCanonicalScanner} = await import(pathToFileURL(`${baselineDirectory}/ext/js/dictionary/term-content-canonical-scan.js`).href)

const arm = process.argv[2] ?? 'A'
assert(['A', 'B', 'C'].includes(arm))
const repo = arm === 'B' ? candidateDirectory : baselineDirectory
const {TermContentMetadataArena} = await import(pathToFileURL(`${repo}/ext/js/dictionary/term-content-metadata-arena.js`).href)
const arenaSource = readFileSync(`${repo}/ext/js/dictionary/term-content-metadata-arena.js`)
const parserBytes = readFileSync(`${baselineDirectory}/dev/data/dictionary-wasm/term-bank-parser.wasm`)
const kernelBytes = readFileSync(`${baselineDirectory}/dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm`)
setTermBankWasmModule(new WebAssembly.Module(parserBytes))
const kernel = new WebAssembly.Module(kernelBytes)
const python = `import json, struct, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    banks = sorted([x for x in archive.infolist() if x.filename.startswith('term_bank_') and x.filename.endswith('.json')], key=lambda x: int(x.filename[10:-5]))
    if len(sys.argv) == 2:
        print(json.dumps([{'name': x.filename, 'size': x.file_size} for x in banks]))
    else:
        for name in sys.argv[2:]:
            data = archive.read(name)
            sys.stdout.buffer.write(struct.pack('<I', len(data)))
            sys.stdout.buffer.write(data)
`
const bankInfo = JSON.parse(execFileSync('python', ['-c', python, zipPath], {encoding: 'utf8'}))
const groups = []
const totalBytes = bankInfo.reduce((sum, bank) => sum + bank.size, 0)
let start = 0
let consumedBytes = 0
for (let group = 0; group < 11; ++group) {
    const remaining = 12 - group
    const target = (totalBytes - consumedBytes) / remaining
    let end = start + 1
    let bytes = bankInfo[start].size
    while (end < bankInfo.length - (remaining - 1)) {
        const next = bytes + bankInfo[end].size
        if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
        bytes = next
        ++end
    }
    groups.push(bankInfo.slice(start, end))
    start = end
    consumedBytes += bytes
}
groups.push(bankInfo.slice(start))

const sourceSlabs = []
const sourceStarts = []
const outputs = []
const measurements = []
const sourceOffsets = new Float64Array(524288)
const allocationStart = performance.now()
const arena = new TermContentMetadataArena(524288, 1048576)
const arenaAllocationMs = performance.now() - allocationStart
const arenaNames = ['slots', 'hash1', 'hash2', 'state', 'length', 'signaturePresent', 'signature1', 'signature2', 'signature3']
const arenaLayout = Object.fromEntries(arenaNames.map((key) => [key, {offset: arena[key].byteOffset, length: arena[key].length, pageOffset: arena[key].byteOffset % 4096}]))
const owner = {
    _termEntryContentMetaFreeIndexes: [],
    _termContentMetadataArena: arena,
    _termEntryContentMetaDenseCount: 0,
    _termEntryContentMetaHashPairPendingCount: 0,
    _termEntryContentMetaHashPairCount: 0,
    _ensureTermEntryContentMetaHashPairCapacity() { throw new Error('Unexpected arena replacement') },
    _readTermEntryContentMetaHashPairIndex(index) {
        assert.equal(arena.state[index], 1)
        return {id: 0, offset: sourceOffsets[index], length: arena.length[index], dictName: 'raw-v6', tableIndex: index,
            hash2: arena.hash2[index], signature1: arena.signature1[index], signature2: arena.signature2[index], signature3: arena.signature3[index]}
    },
}
let nativeStarted = 0
let nativeCpuStarted
let nativeWallMs = 0
let nativeCpuMs = 0
const scanner = new NativeCanonicalScanner({loadModule: async () => kernel, hooks: {
    beforeNative() {
        nativeCpuStarted = process.cpuUsage()
        nativeStarted = performance.now()
    },
    beforeOutputView({column}) {
        if (column !== 0) { return }
        nativeWallMs += performance.now() - nativeStarted
        const cpu = process.cpuUsage(nativeCpuStarted)
        nativeCpuMs += (cpu.user + cpu.system) / 1000
    },
}})
let totalSourceBytes = 0
let totalRows = 0
let totalUnique = 0
let totalExact = 0
for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
    const group = groups[groupIndex]
    const raw = execFileSync('python', ['-c', python, zipPath, ...group.map((bank) => bank.name)], {maxBuffer: 32 * 1024 * 1024})
    const banks = []
    for (let offset = 0; offset < raw.length;) {
        const length = raw.readUInt32LE(offset)
        offset += 4
        banks.push(raw.subarray(offset, offset + length))
        offset += length
    }
    let fixture
    await parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
        assert.equal(fixture, undefined)
        const nativePlan = chunk.contentDedupPlan
        assert(nativePlan !== null && nativePlan.uniqueSignatures instanceof Uint32Array)
        const content = new Uint8Array(new SharedArrayBuffer(chunk.contentBytesLength))
        content.set(chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + chunk.contentBytesLength))
        fixture = {
            rowCount: chunk.rowCount,
            uniqueCount: nativePlan.uniqueCount,
            meta: chunk.contentMetaList.slice(),
            identities: chunk.contentUniqueIndexList.slice(),
            rows: nativePlan.uniqueRowIndexes.slice(),
            signatures: nativePlan.uniqueSignatures.slice(),
            content,
        }
    }, undefined, {
        emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false,
        useNativeStringPlan: true, singleChunk: true, validateGlossaryTypes: true,
    })
    assert(fixture)
    totalRows += fixture.rowCount
    totalUnique += fixture.uniqueCount
    const columns = Array.from({length: 6}, () => new Uint32Array(fixture.uniqueCount))
    const plan = {resolvedFlags: new Uint8Array(fixture.uniqueCount), pendingEpochs: null, pendingIndexes: null}
    const exactCandidates = []
    let pendingCount = 0
    let exactCount = 0
    const context = {
        chunk: {rowCount: fixture.rowCount, contentRowStart: 0, contentBytesBaseOffset: 0, contentBytesBuffer: fixture.content,
            contentMetaList: fixture.meta, contentDictNameList: null, uniformContentDictName: 'raw-v6'},
        contentDedupPlan: plan,
        uniqueIndexList: fixture.identities,
        uniqueRowIndexes: fixture.rows,
        uniqueSignatures: fixture.signatures,
        firstUniqueIndex: 0,
        lastUniqueIndex: fixture.uniqueCount,
        persistedLookupRequired: true,
        reserveMetadata: true,
        adoptPendingColumns(batch, complete) {
            for (let i = 0; i < columns.length; ++i) { columns[i].set(batch.columns[i], pendingCount) }
            pendingCount += batch.columns[0].length
            complete()
        },
        getPendingCount: () => pendingCount,
        exactCandidates,
        async resolveExactCandidates() {
            for (const candidate of exactCandidates) {
                const meta = candidate.existingMeta
                let group = sourceStarts.length - 1
                while (sourceStarts[group] > meta.offset) { --group }
                assert(group >= 0)
                const localOffset = meta.offset - sourceStarts[group]
                const previous = sourceSlabs[group]
                assert.equal(meta.length, candidate.contentLength)
                assert(Buffer.from(previous.buffer, localOffset, meta.length).equals(Buffer.from(fixture.content.buffer, candidate.contentOffset, candidate.contentLength)))
                plan.resolvedFlags[candidate.uniqueIndex] = 1
                ++exactCount
            }
            exactCandidates.length = 0
        },
    }
    nativeWallMs = 0
    nativeCpuMs = 0
    const metrics = {}
    const cpuStarted = process.cpuUsage()
    const resourcesBefore = process.resourceUsage()
    const started = performance.now()
    await scanner.scan(owner, context, metrics)
    const totalMs = performance.now() - started
    const cpu = process.cpuUsage(cpuStarted)
    const resourcesAfter = process.resourceUsage()
    assert.equal(scanner.stats.fallbacks, 0)
    assert.equal(pendingCount + exactCount, fixture.uniqueCount)
    totalExact += exactCount
    const beforePublished = owner._termEntryContentMetaHashPairCount
    for (let i = 0; i < pendingCount; ++i) {
        const index = columns[5][i]
        assert.equal(index, beforePublished + i)
        assert.equal(arena.state[index], 2)
        sourceOffsets[index] = totalSourceBytes + columns[0][i]
        arena.state[index] = 1
    }
    owner._termEntryContentMetaHashPairPendingCount -= pendingCount
    owner._termEntryContentMetaHashPairCount += pendingCount
    outputs.push(columns.map((column) => column.subarray(0, pendingCount)))
    measurements.push({group: groupIndex, rows: fixture.rowCount, uniqueCount: fixture.uniqueCount, pendingCount, exactCount, totalMs, nativeMs: nativeWallMs,
        cpuMs: (cpu.user + cpu.system) / 1000, nativeCpuMs,
        voluntaryContextSwitches: resourcesAfter.voluntaryContextSwitches - resourcesBefore.voluntaryContextSwitches,
        involuntaryContextSwitches: resourcesAfter.involuntaryContextSwitches - resourcesBefore.involuntaryContextSwitches,
        minorPageFaults: resourcesAfter.minorPageFault - resourcesBefore.minorPageFault,
        metrics,
    })
    sourceSlabs.push(fixture.content)
    sourceStarts.push(totalSourceBytes)
    totalSourceBytes += fixture.content.byteLength
}
assert.equal(totalRows, 528299)
assert.equal(totalUnique, 366030)
assert.equal(owner._termEntryContentMetaHashPairCount, 362032)
assert.equal(totalExact, 3998)
assert.equal(scanner.stats.calls, 12)
assert.equal(scanner.stats.copiedInputBytes, 16788490)
const digest = createHash('sha256')
for (const key of arenaNames) {
    const view = arena[key]
    digest.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
}
for (const group of outputs) {
    for (const view of group) { digest.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
}
digest.update(new Uint8Array(sourceOffsets.buffer, 0, owner._termEntryContentMetaHashPairCount * 8))
digest.update(JSON.stringify([owner._termEntryContentMetaDenseCount, owner._termEntryContentMetaHashPairPendingCount, owner._termEntryContentMetaHashPairCount, totalExact, scanner.stats]))
const result = {
    arm,
    node: process.version,
    arenaSourceSha256: createHash('sha256').update(arenaSource).digest('hex'),
    parserSha256: createHash('sha256').update(parserBytes).digest('hex'),
    kernelSha256: createHash('sha256').update(kernelBytes).digest('hex'),
    arenaBytes: arena.memory.buffer.byteLength,
    arenaAllocationMs,
    arenaLayout,
    scope: 'Fresh process; actual12-group JMdict scan and exact source-byte verification; unchanged native kernel/ABI and table capacities. Parser and source preparation excluded. Scanner adapter, native call and exact verification measured; publication outside measured interval. Only physical dense-column placement differs. Source hashing deferred until after all groups to avoid touching unused table pages early.',
    totalRows, totalUnique, totalExact, totalSourceBytes,
    publishedCount: owner._termEntryContentMetaHashPairCount,
    outputDigest: digest.digest('hex'),
    totals: Object.fromEntries(['totalMs', 'nativeMs', 'cpuMs', 'nativeCpuMs'].map((key) => [key, measurements.reduce((sum, sample) => sum + sample[key], 0)])),
    stats: scanner.stats,
    measurements,
}
const destination = process.argv[3] ?? `canonical-column-spacing-${arm}.json`
writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({arm, totals: result.totals, arenaBytes: result.arenaBytes, outputDigest: result.outputDigest, stats: result.stats, destination})}\n`)
