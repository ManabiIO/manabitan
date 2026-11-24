import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'

const workspace = process.env.MANABITAN_CRC_WORKSPACE ?? '/workspace/scratch/0a1757ac2970'
const baselineRoot = process.env.MANABITAN_CRC_BASELINE ?? path.join(workspace, 'manabitan')
const candidateRoot = process.env.MANABITAN_CRC_CANDIDATE ?? path.join(workspace, 'crc-shift-powers')
const outputRoot = process.env.MANABITAN_CRC_OUTPUT ?? path.dirname(fileURLToPath(import.meta.url))
const outputPath = path.join(outputRoot, 'source-crc-corpus-parity-vndb.json')
const baselineCommit = 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26'
const banksPerGroup = 4
const hash = (value) => createHash('sha256').update(value).digest('hex')
const viewBytes = (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim()
const frozenPaths = [
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-source-crc.js',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
    'dev/data/dictionary-wasm/manifest.json',
]
const options = {
    singleChunk: true,
    compactContentMetadata: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    projectImagePaths: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
}
const lockBytes = await readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries.vndb
const receipt = {
    schemaVersion: 1,
    scope: 'Full locked VNDB compressed-source component parity, with sequential fixed four-bank groups. The production inflate/fused parser/verifier paths execute unchanged. A JS-held native-export wrapper observes verifier inputs and outputs. This is not browser scheduling, compression, persistence, a timing experiment, or a process peak-memory measurement. Counts are actual verifier calls and source-derived work for this declared grouping.',
    workModel: {
        operatorBuilds: 'One per change of positive glossary byte length, including the first row of each verifier call. Last-length reuse carries across banks within the call.',
        baselineSquaringCalls: 'Sum of bitLength(length) at those transitions: one crc32_multiply_mod(power, power) per original exponent-loop iteration.',
        candidateSquaringCalls: 0,
        retainedFactorMultiplyCalls: 'Sum of popcount(length) at the same transitions.',
        retainedShiftTableWrites: '128 uint32 entries per operator build; basis construction, applying operators, gap scans and glossary CRC/witness work remain.',
        limitation: 'These are deterministic executions implied by the frozen source and observed valid inputs, not hardware instruction counts or the complete source-CRC phase as a saving.',
    },
    baselineCommit,
    banksPerGroup,
    options,
    fixture,
    lockSha256: hash(lockBytes),
    scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    node: process.version,
    sourceIdentities: {},
    groups: [],
}
const states = {}

for (const [arm, root] of [['baseline', baselineRoot], ['candidate', candidateRoot]]) {
    const identity = {root, head: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'), files: {}}
    if (arm === 'baseline') { assert.equal(identity.head, baselineCommit) }
    for (const relative of frozenPaths) { identity.files[relative] = hash(await readFile(path.join(root, relative))) }
    const parserSource = await readFile(path.join(root, 'ext/js/dictionary/wasm/term-bank-parser.c'), 'utf8')
    const metadata = parserSource.match(/typedef struct \{\s*uint32_t expression_start;([\s\S]*?)\} TermRowMeta;/)
    assert(metadata)
    const fields = ['expression_start', ...metadata[1].matchAll(/uint32_t ([a-z_]+);/g)].map((value) => typeof value === 'string' ? value : value[1])
    assert.equal(fields.length, 17)
    assert.equal(fields[9], 'glossary_start')
    assert.equal(fields[10], 'glossary_length')
    const moduleBytes = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
    const module = await WebAssembly.compile(moduleBytes)
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    parser.setTermBankWasmModule(module)
    states[arm] = {root, parser, nativeCalls: []}
    receipt.sourceIdentities[arm] = identity
}
for (const relative of ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-source-crc.js']) {
    assert.equal(receipt.sourceIdentities.baseline.files[relative], receipt.sourceIdentities.candidate.files[relative])
}

const readonlyHash = (wasm, spans) => {
    const digest = createHash('sha256')
    for (const [name, pointer, length] of spans) {
        digest.update(`${name}:${length}:`)
        digest.update(new Uint8Array(wasm.memory.buffer, pointer, length))
    }
    return digest.digest('hex')
}
const popcount = (value) => {
    let count = 0
    for (; value !== 0; value = (value & (value - 1)) >>> 0) { ++count }
    return count
}

function observeVerifier(wasm, original, groupIndex, calls, args) {
    const [jsonPtr, jsonLength, bankSpansPtr, bankCount, signaturesPtr, metasPtr, rowCount, witnessesPtr, statsPtr] = args
    assert(jsonPtr > 0 && bankSpansPtr > 0 && bankCount > 0 && signaturesPtr > 0 && statsPtr > 0)
    const source = new Uint8Array(wasm.memory.buffer, jsonPtr, jsonLength)
    const spans = new Uint32Array(wasm.memory.buffer, bankSpansPtr, bankCount * 2)
    const signatures = new Uint32Array(wasm.memory.buffer, signaturesPtr, bankCount)
    const metas = new Uint32Array(wasm.memory.buffer, metasPtr, rowCount * 17)
    const inputWitnesses = new Uint32Array(wasm.memory.buffer, witnessesPtr, rowCount).slice()
    const expectedWitnessCrcs = new Uint32Array(rowCount)
    const readonlySpans = [
        ['source', jsonPtr, jsonLength],
        ['bankSpans', bankSpansPtr, bankCount * 8],
        ['signatures', signaturesPtr, bankCount * 4],
        ['metas', metasPtr, rowCount * 17 * 4],
    ]
    const immutableBefore = readonlyHash(wasm, readonlySpans)
    const work = {rows: rowCount, reusedGlossaries: 0, reusedBytes: 0, freshGlossaryCrcs: 0, operatorBuilds: 0, baselineSquaringCalls: 0, retainedFactorMultiplyCalls: 0}
    const transitions = new Map()
    let bankEnd = 0
    for (let bank = 0; bank < bankCount; ++bank) {
        const start = spans[bank * 2]
        const length = spans[bank * 2 + 1]
        assert.equal(start, bankEnd)
        assert(start + length <= jsonLength)
        assert.equal(crc32(source.subarray(start, start + length)), signatures[bank])
        bankEnd = start + length
    }
    assert.equal(bankEnd, jsonLength)
    let lastLength = 0xffffffff
    let bank = 0
    let cursor = spans[0]
    for (let row = 0; row < rowCount; ++row) {
        const start = metas[row * 17 + 9]
        const length = metas[row * 17 + 10]
        while (bank < bankCount && start >= spans[bank * 2] + spans[bank * 2 + 1]) {
            ++bank
            cursor = spans[bank * 2]
        }
        assert(bank < bankCount)
        assert(start >= cursor && length > 0 && start + length <= spans[bank * 2] + spans[bank * 2 + 1])
        const witness = inputWitnesses[row]
        if (witness === 0xffffffff) {
            expectedWitnessCrcs[row] = crc32(source.subarray(start, start + length))
            ++work.freshGlossaryCrcs
        } else {
            assert(witness < row)
            const witnessStart = metas[witness * 17 + 9]
            const witnessLength = metas[witness * 17 + 10]
            assert.equal(witnessLength, length)
            assert.equal(Buffer.compare(source.subarray(start, start + length), source.subarray(witnessStart, witnessStart + length)), 0)
            expectedWitnessCrcs[row] = expectedWitnessCrcs[witness]
            ++work.reusedGlossaries
            work.reusedBytes += length
        }
        if (lastLength !== length) {
            ++work.operatorBuilds
            work.baselineSquaringCalls += 32 - Math.clz32(length)
            work.retainedFactorMultiplyCalls += popcount(length)
            transitions.set(length, (transitions.get(length) ?? 0) + 1)
            lastLength = length
        }
        cursor = start + length
    }
    const status = original(...args)
    assert.equal(status, 0)
    assert.equal(readonlyHash(wasm, readonlySpans), immutableBefore)
    const actualWitnessCrcs = new Uint32Array(wasm.memory.buffer, witnessesPtr, rowCount)
    assert.deepEqual(actualWitnessCrcs, expectedWitnessCrcs)
    const stats = [...new Uint32Array(wasm.memory.buffer, statsPtr, 3)]
    assert.deepEqual(stats, [jsonLength - work.reusedBytes, work.reusedBytes, work.reusedGlossaries])
    const call = {
        groupIndex, bankCount, jsonLength, rowCount, status,
        inputStateSha256: immutableBefore,
        inputWitnessSha256: hash(viewBytes(inputWitnesses)),
        outputWitnessSha256: hash(viewBytes(actualWitnessCrcs)),
        stats,
        work: {...work, candidateSquaringCalls: 0, retainedShiftTableWrites: work.operatorBuilds * 128},
        lengthTransitions: [...transitions].sort((a, b) => a[0] - b[0]),
    }
    calls.push(call)
    return status
}

function compareView(a, b, label, digest) {
    assert.equal(a.constructor.name, b.constructor.name, `${label}: type`)
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

function checkChunk(a, b, expectedRows, digest) {
    assert.equal(a.rowCount, expectedRows.length)
    assert.equal(b.rowCount, expectedRows.length)
    for (const name of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentBytesBuffer', 'contentMetaList', 'contentHash1List', 'contentHash2List', 'contentUniqueIndexList']) {
        assert.equal(a[name] == null, b[name] == null, `${name}: presence`)
        if (a[name] != null) { compareView(a[name], b[name], name, digest) }
    }
    assert.equal(a.contentMetaByUniqueIndex, b.contentMetaByUniqueIndex)
    assert.equal(a.contentBytesLength, b.contentBytesLength)
    comparePlans(a.termRecordPreinternedPlan, b.termRecordPreinternedPlan, 'plan', digest)
    assert.equal(a.contentDedupPlan?.uniqueCount, b.contentDedupPlan?.uniqueCount)
    for (const name of ['uniqueRowIndexes', 'uniqueSignatures']) {
        assert.equal(a.contentDedupPlan?.[name] == null, b.contentDedupPlan?.[name] == null)
        if (a.contentDedupPlan?.[name] != null) { compareView(a.contentDedupPlan[name], b.contentDedupPlan[name], `dedup.${name}`, digest) }
    }
    assert(a.preparedLookupIndexes instanceof Map)
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
    for (let row = 0; row < expectedRows.length; ++row) {
        const [expression, reading, score, sequence] = expectedRows[row]
        assert.equal(strings[plan.expressionIndexes[row]], expression, `expression row ${row}`)
        assert.equal(strings[plan.readingIndexes[row]], reading, `reading row ${row}`)
        assert(Object.is(b.scoreList[row], score), `score row ${row}`)
        assert.equal(b.sequenceList[row] < 0 ? -1 : b.sequenceList[row], sequence, `sequence row ${row}`)
    }
    return {indexBytes, mediaRows: a.mediaRows.length, indexes: a.preparedLookupIndexes.size}
}

const archivePath = process.env.MANABITAN_CRC_FIXTURE ?? path.join(baselineRoot, 'builds/e2e-dictionary-cache', fixture.cacheFile)
const archiveDigest = createHash('sha256')
let archiveBytes = 0
for await (const bytes of createReadStream(archivePath)) {
    archiveBytes += bytes.length
    archiveDigest.update(bytes)
}
assert.equal(archiveBytes, fixture.sizeBytes)
assert.equal(archiveDigest.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
const {readDenseZipDirectory} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/dense-zip-directory.js')))
const {RawZipPayloadReader} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')))
const entries = await readDenseZipDirectory(archive)
assert(entries)
const banks = entries.filter(({filename}) => /^term_bank_\d+[.]json$/.test(filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
assert.equal(banks.length, 665)
const rawReader = new RawZipPayloadReader(archive)
const controller = new AbortController()
const outputDigest = createHash('sha256')
const totals = {banks: 0, rows: 0, groups: 0, deferredGroups: 0, immediateGroups: 0, nativeCalls: 0, fusedVerifierCalls: 0, fallbackVerifierCalls: 0, verifierRows: 0, sourceBytes: 0, crcScannedBytes: 0, crcReusedBytes: 0, crcReusedGlossaries: 0, freshGlossaryCrcs: 0, operatorBuilds: 0, baselineSquaringCalls: 0, candidateSquaringCalls: 0, retainedFactorMultiplyCalls: 0, retainedShiftTableWrites: 0, indexBytes: 0, mediaRows: 0}
await mkdir(outputRoot, {recursive: true})

for (let start = 0; start < banks.length; start += banksPerGroup) {
    const group = banks.slice(start, start + banksPerGroup)
    const groupIndex = receipt.groups.length
    const sources = []
    const expectedRows = []
    const bankReceipts = []
    for (const entry of group) {
        const bytes = await rawReader.read(entry, controller.signal)
        const raw = entry.compressionMethod === 8 ? inflateRawSync(bytes) : bytes
        assert.equal(raw.byteLength, entry.uncompressedSize)
        assert.equal(crc32(raw), entry.signature)
        const decodedRows = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw))
        for (const row of decodedRows) {
            expectedRows.push([row[0], row[1] || row[0], row[4], row[6] == null || row[6] < 0 ? -1 : row[6]])
        }
        sources.push({bytes, compressionMethod: entry.compressionMethod, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize, signature: entry.signature, filename: entry.filename})
        bankReceipts.push({filename: entry.filename, rows: decodedRows.length, compressedBytes: bytes.byteLength, sourceBytes: raw.byteLength, signature: entry.signature, sourceSha256: hash(raw)})
    }
    const chunks = {}
    const arms = {}
    for (const [arm, state] of Object.entries(states)) {
        const {parser} = state
        const preloaded = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true)
        const deferred = preloaded.crcSignaturesPtr > 0
        const nativeStart = state.nativeCalls.length
        const original = preloaded.wasm.verify_term_bank_source_crcs
        assert.equal(typeof original, 'function')
        preloaded.wasm.verify_term_bank_source_crcs = (...args) => observeVerifier(preloaded.wasm, original, groupIndex, state.nativeCalls, args)
        let callbacks = 0
        try {
            await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
                if (deferred) { assert.equal(preloaded.crcVerified, true) }
                ++callbacks
                chunks[arm] = parser.copyWasmBackedColumnChunk(chunk, false, true)
            }, 2048, {...options, preloadedSource: preloaded})
        } finally {
            preloaded.wasm.verify_term_bank_source_crcs = original
        }
        assert.equal(callbacks, 1)
        parser.consumeLastTermBankWasmParseProfile()
        const calls = state.nativeCalls.slice(nativeStart)
        assert.equal(calls.length, deferred ? 1 : 0)
        arms[arm] = {
            deferred,
            sourceCount: preloaded.sourceCount,
            jsonLength: preloaded.jsonLength,
            compressedBytes: preloaded.compressedBytes,
            uncompressedBytes: preloaded.uncompressedBytes,
            crcVerified: preloaded.crcVerified === true,
            crcScannedBytes: preloaded.crcScannedBytes ?? preloaded.uncompressedBytes,
            crcReusedBytes: preloaded.crcReusedBytes ?? 0,
            crcReusedGlossaryCount: preloaded.crcReusedGlossaryCount ?? 0,
            nativeCalls: calls,
        }
    }
    assert.deepEqual(arms.baseline, arms.candidate, `verifier group ${groupIndex}`)
    const output = checkChunk(chunks.baseline, chunks.candidate, expectedRows, outputDigest)
    receipt.groups.push({groupIndex, banks: bankReceipts, rows: expectedRows.length, verifier: arms.baseline, output})
    totals.banks += group.length
    totals.rows += expectedRows.length
    ++totals.groups
    ++totals[arms.baseline.deferred ? 'deferredGroups' : 'immediateGroups']
    totals.sourceBytes += arms.baseline.uncompressedBytes
    totals.crcScannedBytes += arms.baseline.crcScannedBytes
    totals.crcReusedBytes += arms.baseline.crcReusedBytes
    totals.crcReusedGlossaries += arms.baseline.crcReusedGlossaryCount
    totals.indexBytes += output.indexBytes
    totals.mediaRows += output.mediaRows
    for (const call of arms.baseline.nativeCalls) {
        ++totals.nativeCalls
        ++totals[call.rowCount > 0 ? 'fusedVerifierCalls' : 'fallbackVerifierCalls']
        totals.verifierRows += call.rowCount
        for (const name of ['freshGlossaryCrcs', 'operatorBuilds', 'baselineSquaringCalls', 'candidateSquaringCalls', 'retainedFactorMultiplyCalls', 'retainedShiftTableWrites']) {
            totals[name] += call.work[name]
        }
    }
    if ((groupIndex + 1) % 10 === 0 || start + banksPerGroup >= banks.length) {
        process.stdout.write(JSON.stringify({groups: totals.groups, banks: totals.banks, rows: totals.rows, verifierRows: totals.verifierRows, operatorBuilds: totals.operatorBuilds, removedSquarings: totals.baselineSquaringCalls}) + '\n')
    }
}

assert.equal(totals.banks, 665)
assert.equal(totals.rows, fixture.termRows)
assert.equal(totals.sourceBytes, totals.crcScannedBytes + totals.crcReusedBytes)
assert(totals.deferredGroups > 0 && totals.fusedVerifierCalls > 0 && totals.operatorBuilds > 0)
for (const [arm, state] of Object.entries(states)) {
    for (const relative of frozenPaths) {
        assert.equal(hash(await readFile(path.join(state.root, relative))), receipt.sourceIdentities[arm].files[relative], `source changed during replay: ${arm}/${relative}`)
    }
}
receipt.outputSha256 = outputDigest.digest('hex')
receipt.totals = totals
receipt.status = 'passed'
await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify({status: receipt.status, totals, outputSha256: receipt.outputSha256, outputPath}) + '\n')
