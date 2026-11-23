import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)))
const candidateSourceRoot = process.argv[3]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2
}
const captureHash = hash(await readFile(path.join(directory, 'prepare-inputs.mjs')))
const runnerHash = hash(await readFile(path.join(directory, 'compare-validation.mjs')))
const measuredSourceHashes = new Set()
const summaries = []
for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const manifestBytes = await readFile(path.join(directory, dictionary, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    const receipt = JSON.parse(await readFile(path.join(directory, `${dictionary}-comparison.json`), 'utf8'))
    assert.equal(manifest.dictionary, dictionary)
    assert.equal(receipt.dictionary, dictionary)
    assert.equal(manifest.runnerSha256, captureHash)
    assert.equal(receipt.runnerSha256, runnerHash)
    assert.equal(receipt.inputManifestSha256, hash(manifestBytes))
    assert.equal(receipt.archiveSha256, manifest.archiveSha256)
    assert.equal(receipt.rows, manifest.groups.reduce((sum, group) => sum + group.rowCount, 0))
    assert.equal(receipt.contentRuns, manifest.groups.reduce((sum, group) => sum + group.contentRuns, 0))
    assert.equal(receipt.repeatedValidationsRemoved, receipt.rows - receipt.contentRuns)
    assert.equal(receipt.repeatedValidationsRemoved, manifest.repeatedValidationsRemoved)
    assert.deepEqual(receipt.oracles.baseline, receipt.oracles.candidate)
    assert.equal(receipt.oracles.baseline.rows, receipt.rows)
    assert.equal(receipt.oracles.baseline.segments, manifest.groups.reduce((sum, group) => sum + group.preparedLookupKeys.length, 0))
    assert.equal(receipt.observations.length, 24)
    for (const metric of ['validationMs', 'planningWallMs']) {
        const baseline = []
        const candidate = []
        const deltas = []
        for (let pair = 0; pair < 12; pair++) {
            const observations = receipt.observations.filter((item) => item.pair === pair)
            assert.deepEqual(observations.map((item) => item.label), pair % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
            assert(observations.every((item) => item.repetitions === 5 && Number.isFinite(item[metric]) && item[metric] > 0))
            const a = observations.find((item) => item.label === 'baseline')[metric]
            const b = observations.find((item) => item.label === 'candidate')[metric]
            baseline.push(a)
            candidate.push(b)
            deltas.push((b / a - 1) * 100)
        }
        assert.deepEqual(receipt.summary[metric], {
            baselineMedian: median(baseline), candidateMedian: median(candidate), pairMedianChangePercent: median(deltas),
            candidateFasterPairs: deltas.filter((value) => value < 0).length, pairCount: deltas.length,
            baselineRange: [Math.min(...baseline), Math.max(...baseline)], candidateRange: [Math.min(...candidate), Math.max(...candidate)],
        })
    }
    measuredSourceHashes.add(receipt.sourceHashes.candidate)
    summaries.push({dictionary, rows: receipt.rows, validationsRemoved: receipt.repeatedValidationsRemoved,
        oracleDigest: receipt.oracles.baseline.digest, validation: receipt.summary.validationMs})
}
assert.equal(measuredSourceHashes.size, 1)
if (candidateSourceRoot) {
    const currentHash = hash(await readFile(path.resolve(candidateSourceRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
    assert(measuredSourceHashes.has(currentHash), 'Candidate source does not match the measured runtime file')
}
console.log(JSON.stringify({verified: true, measuredCandidateSourceSha256: [...measuredSourceHashes][0], summaries}, null, 2))
