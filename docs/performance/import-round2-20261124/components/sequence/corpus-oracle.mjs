import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const workspace = '/workspace/scratch/0a1757ac2970'
const baselineRoot = path.join(workspace, 'manabitan')
const candidateRoot = path.join(workspace, 'jmdict-sequence')
const evidenceRoot = path.join(workspace, 'sequence-evidence')
const {ZipReader, BlobReader, Uint8ArrayWriter} = await import(pathToFileURL(path.join(baselineRoot, 'node_modules/@zip.js/zip.js/index.js')))
const lockBytes = await readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'))
const locks = JSON.parse(lockBytes).dictionaries
const dictionaryNames = process.argv.slice(2)
const names = dictionaryNames.length ? dictionaryNames : ['jmdict', 'jitendex', 'vndb']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const viewBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const parsers = {}
const modules = new Map()
const nativeCalls = {baseline: [], candidate: []}
let activeGroup = null

for (const [arm, root] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
    const moduleBytes = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
    const compiled = await WebAssembly.compile(moduleBytes)
    const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    parser.setTermBankWasmModule(compiled)
    parsers[arm] = {parser, root, moduleSha256: hash(moduleBytes)}
    modules.set(compiled, arm)
}

const instantiate = WebAssembly.instantiate
WebAssembly.instantiate = async (module, imports) => {
    const instance = await instantiate(module, imports)
    const arm = modules.get(module)
    if (!arm) { return instance }
    const exports = {...instance.exports}
    const encode = exports.encode_term_lookup_index
    exports.encode_term_lookup_index = (...args) => {
        const sequences = new Int32Array(exports.memory.buffer, args[9], args[10])
        let last = -1
        let ordered = true
        let firstDecreaseRow = null
        let nonnegativeRows = 0
        let ordinaryInternerHashes = 0
        let orderedPrefixKeys = 0
        for (let row = 0; row < sequences.length; ++row) {
            const value = sequences[row]
            if (value < 0) { continue }
            ++nonnegativeRows
            if (value !== last) {
                ++ordinaryInternerHashes
                if (ordered) {
                    if (value > last) { ++orderedPrefixKeys } else { ordered = false; firstDecreaseRow = row }
                }
                last = value
            }
        }
        const scratchBefore = hash(new Uint8Array(exports.memory.buffer, args[15], args[16] * 2))
        const status = encode(...args)
        const scratchAfter = hash(new Uint8Array(exports.memory.buffer, args[15], args[16] * 2))
        if (arm === 'candidate' && ordered && status > 0) { assert.equal(scratchBefore, scratchAfter) }
        nativeCalls[arm].push({group: activeGroup, rows: args[10], keyCount: args[5], slotCount: args[16],
            nonnegativeRows, ordinaryInternerHashes, orderedPrefixKeys, firstDecreaseRow, ordered, status,
            sequenceKeyCount: status > 0 ? new DataView(exports.memory.buffer).getUint32(args[11] + 32, true) : null,
            projectedInternerHashesAvoided: status > 0 && ordered ? ordinaryInternerHashes : 0,
            projectedHashScratchClearBytesAvoided: status > 0 && ordered ? args[16] * 2 : 0,
            scratchBytesUnchanged: scratchBefore === scratchAfter})
        return status
    }
    return {exports}
}

function compareView(a, b, label, digest) {
    assert.equal(a.constructor.name, b.constructor.name, `${label}: constructor`)
    assert.equal(a.byteLength, b.byteLength, `${label}: size`)
    assert.equal(Buffer.compare(viewBytes(a), viewBytes(b)), 0, `${label}: bytes`)
    digest.update(`${label}:${a.byteLength}:`)
    digest.update(viewBytes(a))
}

function comparePlans(a, b, label, digest) {
    for (const name of ['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes']) {
        assert.equal(a[name] === undefined, b[name] === undefined, `${label}.${name}: presence`)
        if (a[name] !== undefined) { compareView(a[name], b[name], `${label}.${name}`, digest) }
    }
}

function checkChunk(a, b, sourceRows, digest) {
    assert.equal(a.rowCount, sourceRows.length)
    assert.equal(b.rowCount, sourceRows.length)
    for (const name of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentBytesBuffer',
        'contentMetaList', 'contentHash1List', 'contentHash2List', 'contentUniqueIndexList']) {
        assert.equal(a[name] == null, b[name] == null, `${name}: presence`)
        if (a[name] != null) { compareView(a[name], b[name], name, digest) }
    }
    assert.equal(a.contentMetaByUniqueIndex, b.contentMetaByUniqueIndex)
    assert.equal(a.contentBytesLength, b.contentBytesLength)
    comparePlans(a.termRecordPreinternedPlan, b.termRecordPreinternedPlan, 'plan', digest)
    assert.equal(a.contentDedupPlan?.uniqueCount, b.contentDedupPlan?.uniqueCount)
    for (const name of ['uniqueRowIndexes', 'uniqueSignatures']) {
        if (a.contentDedupPlan?.[name] != null) { compareView(a.contentDedupPlan[name], b.contentDedupPlan[name], `dedup.${name}`, digest) }
    }
    assert.ok(a.preparedLookupIndexes instanceof Map)
    assert.deepEqual([...a.preparedLookupIndexes.keys()], [...b.preparedLookupIndexes.keys()])
    let indexBytes = 0
    for (const [key, index] of a.preparedLookupIndexes) {
        const other = b.preparedLookupIndexes.get(key)
        compareView(index.bytes, other.bytes, `index.${key}`, digest)
        comparePlans(index.preinternedPlan, other.preinternedPlan, `index.${key}.plan`, digest)
        indexBytes += index.bytes.byteLength
    }
    assert.deepEqual(a.mediaRows, b.mediaRows)
    digest.update(JSON.stringify(a.mediaRows))
    const plan = b.termRecordPreinternedPlan
    const decoder = new TextDecoder('utf-8', {fatal: true})
    const strings = []
    let offset = 0
    for (const length of plan.stringLengths) {
        strings.push(decoder.decode(plan.stringsBuffer.subarray(offset, offset + length)))
        offset += length
    }
    assert.equal(offset, plan.stringsBuffer.length)
    for (let i = 0; i < sourceRows.length; ++i) {
        const row = sourceRows[i]
        assert.equal(strings[plan.expressionIndexes[i]], row[0], `expression row ${i}`)
        assert.equal(strings[plan.readingIndexes[i]], row[1] || row[0], `reading row ${i}`)
        assert.ok(Object.is(b.scoreList[i], row[4]), `score row ${i}`)
        const expectedSequence = row[6] == null || row[6] < 0 ? -1 : row[6]
        assert.equal(b.sequenceList[i] < 0 ? -1 : b.sequenceList[i], expectedSequence, `sequence row ${i}`)
    }
    return {indexBytes, mediaRows: a.mediaRows.length, indexes: a.preparedLookupIndexes.size}
}

const options = {singleChunk: true, emitTermByteLists: false, computeContentHashes: true,
    emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true,
    projectImagePaths: true, validateGlossaryTypes: true, prepareLookupIndexes: true}
const summary = {schemaVersion: 1, baseline: 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26',
    lockSha256: hash(lockBytes), runnerSha256: hash(await readFile(new URL(import.meta.url))),
    node: process.version, modules: Object.fromEntries(Object.entries(parsers).map(([arm, value]) => [arm, value.moduleSha256])),
    scope: 'All source rows and parser/content/key/index/media-projection bytes; sequential fixed four-bank component groups. Excludes compression, persistence, worker scheduling, and complete-import timing. Native admission/work counts are actual calls in this declared component workload, not browser planner claims.',
    dictionaries: []}

for (const name of names) {
    const spec = locks[name]
    assert.ok(spec)
    const archivePath = path.join(baselineRoot, 'builds/e2e-dictionary-cache', spec.cacheFile)
    const archiveHash = createHash('sha256')
    let archiveBytes = 0
    for await (const bytes of createReadStream(archivePath)) { archiveBytes += bytes.length; archiveHash.update(bytes) }
    assert.equal(archiveBytes, spec.sizeBytes)
    assert.equal(archiveHash.digest('hex'), spec.sha256)
    const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), {useWebWorkers: false})
    const digest = createHash('sha256')
    const result = {dictionary: name, archiveSha256: spec.sha256, rows: 0, banks: 0, groups: [], indexBytes: 0, mediaRows: 0}
    const callStarts = Object.fromEntries(Object.keys(parsers).map((arm) => [arm, nativeCalls[arm].length]))
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        for (let start = 0; start < entries.length; start += 4) {
            const group = entries.slice(start, start + 4)
            activeGroup = `${name}:${group[0].filename}`
            const banks = []
            const sourceRows = []
            for (const entry of group) {
                const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
                assert.equal(bytes.length, entry.uncompressedSize)
                banks.push(bytes)
                for (const row of JSON.parse(new TextDecoder().decode(bytes))) { sourceRows.push(row) }
            }
            const chunks = {}
            const profiles = {}
            for (const [arm, {parser}] of Object.entries(parsers)) {
                let callbacks = 0
                await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
                    ++callbacks
                    chunks[arm] = parser.copyWasmBackedColumnChunk(chunk, false, true)
                }, 2048, options)
                assert.equal(callbacks, 1)
                profiles[arm] = parser.consumeLastTermBankWasmParseProfile()
            }
            const checked = checkChunk(chunks.baseline, chunks.candidate, sourceRows, digest)
            const groupResult = {firstBank: group[0].filename, bankCount: group.length, rows: sourceRows.length,
                ...checked, nativeSegments: profiles.candidate.nativeSegmentedLookupSegments ?? 0,
                baselineMaxWasmHeapBytes: profiles.baseline.maxWasmHeapBytes,
                candidateMaxWasmHeapBytes: profiles.candidate.maxWasmHeapBytes}
            assert.equal(groupResult.baselineMaxWasmHeapBytes, groupResult.candidateMaxWasmHeapBytes)
            result.rows += sourceRows.length
            result.banks += group.length
            result.indexBytes += checked.indexBytes
            result.mediaRows += checked.mediaRows
            result.groups.push(groupResult)
            if (start % 40 === 0) { process.stdout.write(`${name}: verified ${result.rows} rows / ${result.banks} banks\n`) }
        }
    } finally { await reader.close() }
    assert.equal(result.rows, spec.termRows)
    result.digest = digest.digest('hex')
    result.nativeCalls = Object.fromEntries(Object.keys(parsers).map((arm) => [arm, nativeCalls[arm].slice(callStarts[arm])]))
    assert.deepEqual(result.nativeCalls.baseline.map(({scratchBytesUnchanged, ...call}) => call), result.nativeCalls.candidate.map(({scratchBytesUnchanged, ...call}) => call))
    result.work = {successfulNativeCalls: 0, nativeRows: 0, orderedCalls: 0, fallbackTableCalls: 0, internerHashesAvoided: 0, hashScratchClearBytesAvoided: 0}
    for (const call of result.nativeCalls.candidate) {
        if (call.status <= 0) { continue }
        ++result.work.successfulNativeCalls
        result.work.nativeRows += call.rows
        if (call.ordered) { ++result.work.orderedCalls } else { ++result.work.fallbackTableCalls }
        result.work.internerHashesAvoided += call.projectedInternerHashesAvoided
        result.work.hashScratchClearBytesAvoided += call.projectedHashScratchClearBytesAvoided
    }
    summary.dictionaries.push(result)
    await writeFile(path.join(evidenceRoot, `oracle-${name}.json`), `${JSON.stringify({...summary, dictionaries: [result]}, null, 2)}\n`)
    process.stdout.write(`${name}: PASS ${result.rows} rows; ${JSON.stringify(result.work)}\n`)
}
await writeFile(path.join(evidenceRoot, 'corpus-oracle.json'), `${JSON.stringify(summary, null, 2)}\n`)
