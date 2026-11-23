import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

// Usage: node verify-receipts.mjs [archivedReceiptDirectory] [reproducedReceipt ...]
const [directoryArgument, ...reproductions] = process.argv.slice(2)
const directory = path.resolve(directoryArgument ?? path.dirname(fileURLToPath(import.meta.url)))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const readJson = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))
const sum = (values) => values.reduce((total, value) => total + value, 0)
const provenance = await readJson('provenance.json')
const summary = await readJson('plan-scratch-comparison.json')

for (const [name, expected] of Object.entries(provenance.originalFiles)) {
    const bytes = await readFile(path.join(directory, name))
    assert.equal(bytes.byteLength, expected.bytes, `${name}: original byte length`)
    assert.equal(hash(bytes), expected.sha256, `${name}: original SHA-256`)
}
assert.equal(summary.scriptSha256, provenance.originalFiles['plan-scratch-receipt.mjs'].sha256)
assert.equal(summary.baselineCommit, provenance.baselineCommit)
assert(provenance.measuredLocalCandidateCommit.startsWith(summary.candidateCommit))
assert.equal(summary.canonicalWasmSha256, provenance.wasmHashes['term-content-canonical-scan-v1.wasm'])
assert.equal(hash(await readFile(path.join(directory, 'portable-runner.mjs'))), provenance.portableRunnerSha256)

function verifyReceipt(receipt, arm) {
    const {records} = receipt
    assert.equal(records.length, receipt.groups)
    assert.equal(sum(records.map(({rowCount}) => rowCount)), receipt.rows)
    assert.equal(sum(records.map(({banks}) => banks.length)), receipt.sourceBanks)
    assert.equal(receipt.hardwareConcurrency, 9)
    assert.equal(receipt.plannerWorkerCount, 5)
    assert.equal(receipt.wasmSha256, provenance.wasmHashes['term-bank-parser.wasm'])
    assert.deepEqual(receipt.sourceHashes, provenance.sourceHashes[arm])
    for (const kind of ['parser', 'canonical']) {
        const amounts = records.map((record) => sum(Object.values(record[`${kind}ScratchBytes`])))
        assert.equal(sum(amounts), receipt[`${kind}ScratchBytes`])
        assert.equal(Math.max(...amounts), receipt[`maximum${kind[0].toUpperCase()}${kind.slice(1)}ScratchBytesPerGroup`])
        assert.equal(hash(records.map((record) => record[`${kind}Digest`]).join('\n')), receipt[`${kind}Digest`])
    }
    const fields = ['pendingEpochs', 'pendingIndexes', 'pendingSpanOffsetsScratch', 'pendingSpanLengthsScratch']
    for (const record of records) {
        const {uniqueCount, rowCount} = record
        assert(Number.isSafeInteger(uniqueCount) && uniqueCount > 0 && uniqueCount <= rowCount)
        assert(Number.isSafeInteger(rowCount) && rowCount > 0)
        const before = arm === 'baseline' ? [4 * uniqueCount, 4 * uniqueCount, 4 * rowCount, 4 * rowCount] : [0, 0, 0, 0]
        const after = arm === 'baseline' ? before : [0, 0, 4 * uniqueCount, 4 * uniqueCount]
        assert.deepEqual(fields.map((field) => record.parserScratchBytes[field]), before)
        assert.deepEqual(fields.map((field) => record.canonicalScratchBytes[field]), after)
        assert.equal(record.nativeCalls, 1)
        assert.equal(record.nativeFallbacks, 0)
    }
}

const references = new Map()
const results = []
for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const baseline = await readJson(`plan-scratch-${dictionary}-baseline.json`)
    const candidate = await readJson(`plan-scratch-${dictionary}-candidate.json`)
    verifyReceipt(baseline, 'baseline')
    verifyReceipt(candidate, 'candidate')
    for (const key of ['dictionary', 'archiveSha256', 'archiveBytes', 'sourceBanks', 'sourceBytes', 'rows', 'groups', 'parserDigest', 'canonicalDigest']) {
        assert.deepEqual(candidate[key], baseline[key], `${dictionary}: ${key}`)
    }
    assert.equal(candidate.dictionary, dictionary)
    for (let index = 0; index < baseline.records.length; ++index) {
        const before = baseline.records[index]
        const after = candidate.records[index]
        for (const key of ['group', 'banks', 'rowCount', 'uniqueCount', 'parserDigest', 'canonicalDigest', 'nativeCalls', 'nativeFallbacks']) {
            assert.deepEqual(after[key], before[key], `${dictionary}: group ${index + 1} ${key}`)
        }
    }
    const result = {
        dictionary,
        rows: candidate.rows,
        groups: candidate.groups,
        parserOutputBytesRemoved: baseline.parserScratchBytes,
        maximumParserOutputBytesRemovedPerGroup: baseline.maximumParserScratchBytesPerGroup,
        baselineCanonicalScratchBytes: baseline.canonicalScratchBytes,
        candidateCanonicalScratchBytes: candidate.canonicalScratchBytes,
        canonicalScratchAllocationBytesRemoved: baseline.canonicalScratchBytes - candidate.canonicalScratchBytes,
        baselineMaximumCanonicalScratchBytesPerGroup: baseline.maximumCanonicalScratchBytesPerGroup,
        candidateMaximumCanonicalScratchBytesPerGroup: candidate.maximumCanonicalScratchBytesPerGroup,
        nativeCalls: sum(candidate.records.map((record) => record.nativeCalls)),
        nativeFallbacks: sum(candidate.records.map((record) => record.nativeFallbacks)),
        parserDigest: candidate.parserDigest,
        canonicalDigest: candidate.canonicalDigest,
    }
    assert.equal(result.canonicalScratchAllocationBytesRemoved, 8 * candidate.rows)
    assert.deepEqual(result, summary.results.find((entry) => entry.dictionary === dictionary))
    results.push(result)
    references.set(`${dictionary}:baseline`, baseline)
    references.set(`${dictionary}:candidate`, candidate)
}

const verifiedReproductions = []
for (const filename of reproductions) {
    const receipt = JSON.parse(await readFile(filename, 'utf8'))
    const arm = receipt.parserScratchBytes === 0 ? 'candidate' : 'baseline'
    const reference = references.get(`${receipt.dictionary}:${arm}`)
    assert(reference, `${filename}: unknown dictionary`)
    verifyReceipt(receipt, arm)
    for (const key of ['archiveSha256', 'archiveBytes', 'sourceBanks', 'sourceBytes', 'rows', 'groups', 'parserDigest', 'canonicalDigest', 'records']) {
        assert.deepEqual(receipt[key], reference[key], `${filename}: ${key}`)
    }
    assert.deepEqual(receipt.plannerProfile, {hardwareConcurrency: 9, deviceMemory: null})
    assert.equal(receipt.fixtureLockSha256, provenance.fixtureLockSha256)
    assert.equal(receipt.canonicalWasmSha256, provenance.wasmHashes['term-content-canonical-scan-v1.wasm'])
    assert.equal(receipt.runnerSha256, provenance.portableRunnerSha256)
    verifiedReproductions.push({file: filename, dictionary: receipt.dictionary, arm})
}

console.log(JSON.stringify({
    status: 'verified',
    originalFiles: Object.keys(provenance.originalFiles).length,
    rows: sum(results.map((result) => result.rows)),
    groups: sum(results.map((result) => result.groups)),
    parserScratchBuffersRemoved: 4 * sum(results.map((result) => result.groups)),
    parserOutputBytesRemoved: sum(results.map((result) => result.parserOutputBytesRemoved)),
    canonicalScratchAllocationBytesRemoved: sum(results.map((result) => result.canonicalScratchAllocationBytesRemoved)),
    results,
    verifiedReproductions,
}, null, 2))
