import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'

const baseRoot = '/workspace/scratch/f0f7782e255e/manabitan-base'
const candidateRoot = '/workspace/scratch/f0f7782e255e/jmdict'
const outputRoot = '/workspace/scratch/f0f7782e255e'
const dictionary = process.argv[2] ?? 'jmdict'
const workerCounts = (process.argv[3] ?? '2,3,5').split(',').map(Number)
const mediaHintFastScan = dictionary !== 'jmdict'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const load = (root, name) => import(pathToFileURL(`${root}/${name}`).href)
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await load(candidateRoot, 'node_modules/@zip.js/zip.js/index.js')
const parser = await load(baseRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')
const preparation = await load(baseRoot, 'ext/js/dictionary/term-lookup-index-preparation.js')
const baseline = await load(baseRoot, 'ext/js/dictionary/term-record-opfs-store.js')
const candidate = await load(candidateRoot, 'ext/js/dictionary/term-record-opfs-store.js')
const lockBytes = await readFile(`${baseRoot}/test/perf/dictionaries.lock.json`)
const spec = JSON.parse(lockBytes).dictionaries[dictionary]
assert.ok(spec)
const archive = await readFile(`${baseRoot}/builds/e2e-dictionary-cache/${spec.cacheFile}`)
assert.equal(sha256(archive), spec.sha256)
const moduleBytes = await readFile(`${baseRoot}/ext/lib/term-bank-parser.wasm`)
parser.setTermBankWasmModule(await WebAssembly.compile(moduleBytes))
const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)))
const entries = (await zip.getEntries()).filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const sourceBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0)

// Exact develop byte-balancing algorithm and existing lazy-planner policy.
// This replay executes each planned group sequentially; it measures no latency.
function partitionSources(requestedGroupCount) {
    const groupCount = Math.min(requestedGroupCount, entries.length)
    const groups = []
    let start = 0
    let consumedBytes = 0
    for (let groupIndex = 0; groupIndex < groupCount - 1; ++groupIndex) {
        const remainingGroups = groupCount - groupIndex
        const targetBytes = (sourceBytes - consumedBytes) / remainingGroups
        let end = start + 1
        let bytes = entries[start].uncompressedSize
        const maxEnd = entries.length - (remainingGroups - 1)
        while (end < maxEnd) {
            const nextBytes = bytes + entries[end].uncompressedSize
            if (Math.abs(nextBytes - targetBytes) > Math.abs(bytes - targetBytes)) { break }
            bytes = nextBytes
            ++end
        }
        groups.push(entries.slice(start, end))
        start = end
        consumedBytes += bytes
    }
    groups.push(entries.slice(start))
    return groups
}

async function encode(api, copied, firstId, contentBase) {
    const count = copied.rowCount
    const uniqueRows = copied.contentDedupPlan.uniqueRowIndexes
    const offsets = new Float64Array(uniqueRows.length)
    const lengths = new Uint32Array(uniqueRows.length)
    for (let index = 0; index < uniqueRows.length; ++index) {
        const meta = uniqueRows[index] * 4
        offsets[index] = contentBase + copied.contentMetaList[meta]
        lengths[index] = copied.contentMetaList[meta + 1]
    }
    const chunk = api.createArtifactTermRecordChunkWithResolvedContent(
        {...copied, dictionary: spec.expectedTitle, dictionaryTotalRows: spec.termRows},
        copied.contentUniqueIndexList, offsets, lengths, copied.preparedLookupIndexes,
    )
    const store = new api.TermRecordOpfsStore()
    const fieldEncoder = store._encodeArtifactRecordFields.bind(store)
    const staging = {uint32CopyBytes: 0, uint16CopyBytes: 0}
    store._encodeArtifactRecordFields = (...args) => {
        const set32 = Uint32Array.prototype.set
        const set16 = Uint16Array.prototype.set
        Uint32Array.prototype.set = function (values, offset) {
            staging.uint32CopyBytes += values.length * 4
            return set32.call(this, values, offset)
        }
        Uint16Array.prototype.set = function (values, offset) {
            staging.uint16CopyBytes += values.length * 2
            return set16.call(this, values, offset)
        }
        try { return fieldEncoder(...args) } finally {
            Uint32Array.prototype.set = set32
            Uint16Array.prototype.set = set16
        }
    }
    const outputs = []
    store._appendEncodedChunk = async (state, id, rows, name, base, lookup, fields, format) => {
        const envelope = store._createLookupIndexChunk(id, rows, base, lookup, fields, format)
        outputs.push({id, rows, name, base, format, envelope})
    }
    await store._encodeAndAppendArtifactChunkForState(
        {}, chunk, firstId, [], [], chunk.termRecordPreinternedPlan, 'raw', chunk.preparedLookupIndexes ?? null,
    )
    assert.equal(outputs.reduce((total, output) => total + output.rows, 0), count)
    return {outputs, staging}
}

const report = {
    dictionary,
    scope: 'Exact byte-balanced lazy-planner groups, parsed sequentially; production record encoder and checksummed envelopes with deterministic source-content span references. No compression, global content deduplication, browser OPFS, UI, elapsed-time or peak-memory claim.',
    base: execFileSync('git', ['-C', baseRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    candidateSourceSha256: sha256(await readFile(`${candidateRoot}/ext/js/dictionary/term-record-opfs-store.js`)),
    lockSha256: sha256(lockBytes),
    archiveSha256: spec.sha256,
    parserWasmSha256: sha256(moduleBytes),
    bankCount: entries.length,
    sourceBytes,
    configurations: [],
}
try {
    for (const workerCount of workerCounts) {
        const requestedGroupCount = Math.max(workerCount * (mediaHintFastScan ? 3 : 4), Math.ceil(sourceBytes / (24 * 1024 * 1024)))
        const groups = partitionSources(requestedGroupCount)
        let firstId = 1
        let contentBase = 0
        const aggregate = {workerCount, groupCount: groups.length, rows: 0, segments: 0, splitGroups: 0, splitRows: 0, baselineStagingCopyBytes: 0, candidateStagingCopyBytes: 0, avoidedStagingCopyBytes: 0, envelopeBytes: 0, groups: []}
        const outputHash = createHash('sha256')
        for (let group = 0; group < groups.length; ++group) {
            const sources = []
            for (const entry of groups[group]) {
                sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
            }
            await parser.parseTermBankWithWasmColumnChunks(sources, 3, async (borrowed) => {
                const copied = parser.copyWasmBackedColumnChunk(borrowed)
                if (!copied.preparedLookupIndexes) {
                    copied.preparedLookupIndexes = preparation.prepareTermLookupIndexesFromPreinternedPlan(copied).indexes
                }
                const a = await encode(baseline, copied, firstId, contentBase)
                const b = await encode(candidate, copied, firstId, contentBase)
                assert.deepStrictEqual(b.outputs, a.outputs)
                const baselineCopyBytes = a.staging.uint32CopyBytes + a.staging.uint16CopyBytes
                const candidateCopyBytes = b.staging.uint32CopyBytes + b.staging.uint16CopyBytes
                const avoidedStagingCopyBytes = baselineCopyBytes - candidateCopyBytes
                const envelopeBytes = a.outputs.reduce((total, {envelope}) => total + envelope.length, 0)
                for (const {envelope} of a.outputs) { outputHash.update(envelope) }
                aggregate.rows += copied.rowCount
                aggregate.segments += a.outputs.length
                aggregate.splitGroups += a.outputs.length > 1 ? 1 : 0
                aggregate.splitRows += a.outputs.length > 1 ? copied.rowCount : 0
                aggregate.baselineStagingCopyBytes += baselineCopyBytes
                aggregate.candidateStagingCopyBytes += candidateCopyBytes
                aggregate.avoidedStagingCopyBytes += avoidedStagingCopyBytes
                aggregate.envelopeBytes += envelopeBytes
                aggregate.groups.push({group, firstBank: groups[group][0].filename, lastBank: groups[group].at(-1).filename, rows: copied.rowCount, segments: a.outputs.map(({rows}) => rows), avoidedStagingCopyBytes})
                firstId += copied.rowCount
                contentBase += copied.contentBytesLength
            }, 2048, {
                singleChunk: true,
                emitTermByteLists: false,
                computeContentHashes: true,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan,
                validateGlossaryTypes: true,
                prepareLookupIndexes: true,
            })
        }
        assert.equal(aggregate.rows, spec.termRows)
        aggregate.envelopeSha256 = outputHash.digest('hex')
        report.configurations.push(aggregate)
        console.log(JSON.stringify({...aggregate, groups: undefined}))
        await writeFile(`${outputRoot}/record-split-${dictionary}-replay.json`, JSON.stringify(report, null, 2) + '\n')
    }
} finally { await zip.close() }
