import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'

export const here = fileURLToPath(new URL('.', import.meta.url))
export const repository = resolve(here, '../../..')
export const plan = JSON.parse(readFileSync(resolve(here, 'plan.json')))
export const captureDirectory = resolve(here, 'evidence/stage1/run')
export const capture = JSON.parse(readFileSync(resolve(captureDirectory, 'record-field-calls.json')))
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const git = (...args) => execFileSync('git', args, {cwd: repository, encoding: 'utf8'}).trim()
export const median = (values) => {
    assert(values.length > 0)
    const ordered = [...values].sort((a, b) => a - b)
    const middle = Math.floor(ordered.length / 2)
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

export function verifyPlan() {
    assert.equal(plan.schemaVersion, 1)
    assert.equal(plan.baseline, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2')
    assert.equal(plan.nodeVersion, 'v22.22.0')
    assert.deepEqual(Object.keys(plan.arms), ['A', 'B', 'C'])
    assert.deepEqual(plan.warmupCycles, ['ABC', 'CBA'])
    assert.deepEqual(plan.blocks, ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA', 'ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'])
    assert.equal(plan.measuredObservations, 36)
    assert.equal(plan.warmupObservations, 6)
    assert.equal(plan.callsPerObservation, 12)
    assert.equal(plan.expectedCalls.length, 12)
    assert.equal(capture.complete, true)
    assert.equal(capture.stockOutputsConsumed, true)
    assert.equal(capture.calls.length, 12)
    assert.equal(capture.calls.reduce((sum, call) => sum + call.rowCount, 0), 528299)
    const positions = {A: [0, 0, 0], B: [0, 0, 0], C: [0, 0, 0]}
    const transitions = {AB: 0, AC: 0, BA: 0, BC: 0, CA: 0, CB: 0}
    for (const block of plan.blocks) {
        for (let i = 0; i < 3; ++i) {
            ++positions[block[i]][i]
            if (i > 0) ++transitions[block.slice(i - 1, i + 1)]
        }
    }
    for (const counts of Object.values(positions)) assert.deepEqual(counts, [4, 4, 4])
    for (const count of Object.values(transitions)) assert.equal(count, 4)
    assert.deepEqual(plan.nominationGate, {minimumMedianPairedCpuReductionPercent: 20, minimumMedianPairedCpuSavingMs: 5, minimumFasterPairsAgainstEachControl: 9, pairsPerControl: 12, maximumAbsoluteControlMedianPercent: 3, maximumAbsoluteControlEqualWorkPercent: 3, allOutputAndWorkIdentitiesMustPass: true, componentOnly: true, independentWholeBrowserQualificationRequired: true})
    return {positions, withinBlockTransitions: transitions}
}

export function verifySources({requireCommit = true} = {}) {
    const source = JSON.parse(readFileSync(resolve(here, 'source.json')))
    assert.equal(source.baseline, plan.baseline)
    assert.equal(source.kitPath, 'dev/perf/native-record-fields-20261128-1c413')
    assert.equal(source.workflow.path, '.github/workflows/native-record-fields-1c413.yml')
    assert.equal(sha256(source.files.map((file) => `${file.path}\0${file.sha256}\n`).join('')), source.kitDigest)
    for (const file of source.files) {
        const bytes = readFileSync(resolve(here, file.path))
        assert.equal(bytes.byteLength, file.bytes, file.path)
        assert.equal(sha256(bytes), file.sha256, file.path)
    }
    assert.equal(sha256(readFileSync(resolve(repository, source.workflow.path))), source.workflow.sha256)
    const runtime = JSON.parse(readFileSync(resolve(here, 'runtime-identity.json')))
    assert.equal(runtime.digest, plan.runtimeDigest)
    assert.equal(runtime.count, plan.runtimeFiles)
    for (const [name, digest] of Object.entries(runtime.files)) assert.equal(sha256(readFileSync(resolve(repository, name))), digest, name)
    assert.equal(sha256(readFileSync(resolve(here, 'record-fields.c'))), plan.native.cSha256)
    assert.equal(sha256(readFileSync(resolve(here, 'record-fields.wasm'))), plan.native.wasmSha256)
    assert.equal(sha256(readFileSync(resolve(here, 'native-wrapper.mjs'))), plan.native.wrapperSha256)
    const head = git('rev-parse', 'HEAD')
    if (process.env.GITHUB_ACTIONS === 'true') assert.equal(head, process.env.GITHUB_SHA)
    if (requireCommit) {
        assert.equal(git('rev-parse', 'HEAD^'), plan.baseline)
        const actual = git('diff', '--name-only', plan.baseline, head).split('\n').filter(Boolean).sort()
        const prefix = source.kitPath + '/'
        const expected = [...source.files.map((file) => prefix + file.path), prefix + 'source.json', source.workflow.path].sort()
        assert.deepEqual(actual, expected, 'Only the exact frozen kit and workflow differ from baseline')
        assert.equal(git('diff', '--name-only', 'HEAD'), '', 'No tracked source changes')
    }
    return {head, tree: git('rev-parse', 'HEAD^{tree}'), kitDigest: source.kitDigest, checkedFiles: source.files.length, runtimeDigest: runtime.digest, runtimeFiles: runtime.count}
}

export function contrast(observations, candidate, control, metric) {
    const pairs = []
    for (let block = 0; block < plan.blocks.length; ++block) {
        const a = observations.find((item) => item.phase === 'measured' && item.block === block && item.arm === control)
        const b = observations.find((item) => item.phase === 'measured' && item.block === block && item.arm === candidate)
        assert(a && b)
        assert(a.timing[metric] > 0 && b.timing[metric] > 0)
        pairs.push({block, candidate: b.timing[metric], control: a.timing[metric], percent: 100 * (b.timing[metric] / a.timing[metric] - 1), saving: a.timing[metric] - b.timing[metric]})
    }
    const sum = (name) => pairs.reduce((total, pair) => total + pair[name], 0)
    return {candidate, control, metric, pairs, medianPercent: median(pairs.map((pair) => pair.percent)), medianSaving: median(pairs.map((pair) => pair.saving)), equalWorkPercent: 100 * (sum('candidate') / sum('control') - 1), fasterPairs: pairs.filter((pair) => pair.candidate < pair.control).length}
}
