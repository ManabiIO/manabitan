import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const read = (name) => readFile(path.join(root, name))
const json = async (name) => JSON.parse(await read(name))
const manifestBytes = await read('jmdict/manifest.json')
const manifest = JSON.parse(manifestBytes)
const identity = await json('source-identity.json')
const comparison = await json('comparison-1.json')
const firstParity = await json('full-parity.json')
const proxyParity = await json('full-parity-proxy-guard.json')
const parity = await json('full-parity-final.json')
assert.equal(manifest.dictionary, 'jmdict')
assert.equal(manifest.archiveSha256, '7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a')
assert.equal(manifest.rows, 526942)
assert.equal(manifest.uniqueCount, 365184)
assert.equal(manifest.groups.length, 20)
assert.equal(manifest.sourceBanks, 53)
assert.equal(manifest.runnerSha256, sha(await read('prepare-inputs.mjs')))
assert.equal(comparison.runnerSha256, sha(await read('compare.mjs')))
assert.equal(parity.runnerSha256, sha(await read('verify-parity.mjs')))
assert.equal(firstParity.runnerSha256, parity.runnerSha256)
assert.equal(proxyParity.runnerSha256, parity.runnerSha256)
for (const receipt of [comparison, firstParity, proxyParity, parity]) {
    assert.equal(receipt.inputManifestSha256, sha(manifestBytes))
    assert.equal(receipt.archiveSha256, manifest.archiveSha256)
    assert.equal(receipt.identities.A.sourceSha256, identity.baselineSourceSha256)
    assert.equal(receipt.identities.A.digest, receipt.identities.B.digest)
    for (const arm of ['A', 'B']) {
        assert.equal(receipt.identities[arm].rows, manifest.rows)
        assert.equal(receipt.identities[arm].uniqueCount, manifest.uniqueCount)
        assert.equal(receipt.identities[arm].groups, manifest.groups.length)
    }
}
assert.equal(comparison.identities.B.sourceSha256, identity.measuredSourceSha256)
assert.equal(firstParity.identities.B.sourceSha256, identity.lintCheckedSourceSha256)
assert.equal(proxyParity.identities.B.sourceSha256, identity.proxyGuardSourceSha256)
assert.equal(parity.identities.B.sourceSha256, identity.checkedSourceSha256)
for (const [name, expected] of Object.entries(identity.patches)) assert.equal(sha(await read(name)), expected)
assert.equal(comparison.passesPerObservation, 20)
assert.equal(comparison.observations.length, 24)
assert.equal(comparison.comparisons.length, 10)
for (const [index, observation] of comparison.observations.entries()) {
    assert.equal(observation.index, index)
    assert(observation.elapsedMs > 0 && observation.userMs >= 0 && observation.systemMs >= 0)
    if (index < 4) {
        assert.equal(observation.kind, 'warmup')
        assert.equal(observation.arm, index % 2 === 0 ? 'A' : 'B')
    }
}
for (const [index, pair] of comparison.comparisons.entries()) {
    assert.equal(pair.pair, index)
    assert.equal(pair.control, index === 0 || index === 5)
    const expectedOrder = pair.control ? ['A', 'A'] : index % 2 === 0 ? ['A', 'B'] : ['B', 'A']
    assert.deepEqual(pair.order, expectedOrder)
    assert.deepEqual(pair.observations, [4 + index * 2, 5 + index * 2])
    const observations = pair.observations.map((i) => comparison.observations[i])
    for (const [slot, observation] of observations.entries()) {
        assert.equal(observation.pair, pair.pair)
        assert.equal(observation.slot, slot)
        assert.equal(observation.arm, expectedOrder[slot])
        assert.equal(observation.kind, pair.control ? 'control' : 'candidate')
    }
    const a = pair.control ? observations[0] : observations.find(({arm}) => arm === 'A')
    const b = pair.control ? observations[1] : observations.find(({arm}) => arm === 'B')
    assert.equal(pair.elapsedChangePercent, (b.elapsedMs / a.elapsedMs - 1) * 100)
    assert.equal(pair.cpuChangePercent, ((b.userMs + b.systemMs) / (a.userMs + a.systemMs) - 1) * 100)
}
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
const candidates = comparison.comparisons.filter(({control}) => !control)
assert.equal(comparison.medianElapsedChangePercent, median(candidates.map(({elapsedChangePercent}) => elapsedChangePercent)))
assert.equal(comparison.medianCpuChangePercent, median(candidates.map(({cpuChangePercent}) => cpuChangePercent)))
assert.equal(comparison.fasterPairs, candidates.filter(({elapsedChangePercent}) => elapsedChangePercent < 0).length)
assert.equal(comparison.integerCheckCounts.A, manifest.uniqueCount * 3)
assert.equal(comparison.integerCheckCounts.B, manifest.uniqueCount)
assert.deepEqual(parity.modes.map(({name}) => name), ['baseline-generic', 'candidate-fast', 'candidate-unmarked-generic'])
for (const receipt of [firstParity, proxyParity, parity]) {
    for (const mode of receipt.modes) {
        assert.equal(mode.checkedRows, manifest.uniqueCount)
        assert.equal(mode.integerChecks, manifest.uniqueCount * (mode.name === 'candidate-fast' ? 1 : 3))
        assert.equal(mode.fullLookupDigest, parity.modes[0].fullLookupDigest)
        assert.equal(mode.checkedBytes, parity.modes[0].checkedBytes)
    }
}
const gates = await json('gates-final.json')
assert.equal(gates.sourceHashes[identity.runtimeFile], identity.checkedSourceSha256)
assert.deepEqual(gates.gates.map(({name}) => name), ['lint', 'types-main', 'types-test', 'scoped-tests', 'build-dry-run'])
for (const gate of gates.gates) {
    assert.equal(gate.exitCode, 0)
    assert.equal(sha(await read(gate.log)), gate.logSha256)
}
console.log(JSON.stringify({verified: true, observations: comparison.observations.length, candidatePairs: candidates.length,
    componentMedianElapsedChangePercent: comparison.medianElapsedChangePercent,
    completeLookupModes: parity.modes.length, uniqueDefinitionsPerMode: manifest.uniqueCount,
    status: 'Component work reduction supported; whole-import performance remains unqualified.'}))
