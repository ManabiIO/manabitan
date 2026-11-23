import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {extractImportResult} from '../benchmark-support.js'
import {compare, schedule, sourceFiles, verifyStudy} from './verify.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const jsonDigest = (value) => digest(JSON.stringify(value))
const save = (root, name, value) => {
  const file = path.join(root, name)
  mkdirSync(path.dirname(file), {recursive: true})
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
const load = (root, name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))

function fixtureDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'import-study-verifier-'))
  const config = {schemaVersion: 1, stage: 'discovery', baseline: 'a'.repeat(40), candidate: 'b'.repeat(40), expectedPackageDifferences: ['js/dictionary/term-record-opfs-store.js'], dictionaries: ['jmdict', 'jitendex', 'vndb'], confirmationOf: null}
  const fixture = JSON.parse(readFileSync(path.join(repository, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.jmdict
  const hashes = {}
  for (const name of sourceFiles) {
    const bytes = name.endsWith('/config.json') ? Buffer.from(`${JSON.stringify(config, null, 2)}\n`) : readFileSync(path.join(repository, name))
    const target = path.join(root, 'source', name)
    mkdirSync(path.dirname(target), {recursive: true})
    writeFileSync(target, bytes)
    hashes[name] = digest(bytes)
  }
  save(root, 'plan.json', {schemaVersion: 1, config, dictionary: 'jmdict', replication: 1, fixture, nodeVersion: 'v22.22.0', harnessSha: 'c'.repeat(40), sourceFiles: hashes, schedule: schedule('discovery', 1)})
  save(root, 'media-reference.json', null)
  save(root, 'package-differences.json', config.expectedPackageDifferences)
  for (const arm of ['A', 'B']) {
    save(root, `${arm}-identity.json`, {sha: arm === 'A' ? config.baseline : config.candidate, packageSha256: arm.toLowerCase().repeat(64), statusWithHarnessOverlay: ''})
    save(root, `${arm}-package-entries.json`, {'js/dictionary/term-record-opfs-store.js': arm.repeat(64)})
  }
  const probeTerms = Array.from({length: 12}, (_, index) => `term-${index}`)
  const semanticProbes = probeTerms.map((term) => ({term, result: {dictionaryEntries: [{headwords: [{term}], definitions: [{entries: ['original definition']}]}], dictionaryAvailability: []}}))
  const physicalProbes = probeTerms.map((term, index) => ({term, probes: [{term, totalLength: -1, rowSampleCount: 1, inBoundsRowCount: 0, outOfBoundsRowCount: 0, glossaryReadyRowCount: 1, readablePreviewRowCount: 0, rowSample: [{rawEntryContentOffset: index * 16, rawEntryContentLength: 10, glossaryLength: 1, rawContentPreview: '<read-null>'}]}]}))
  const state = {title: fixture.expectedTitle, revision: fixture.revision, termRows: fixture.termRows, mediaRows: 0, contentReadable: true, probeCount: 12}
  const validation = {...state, probeTerms, semanticProbes, physicalProbes, semanticProbeEntryCount: 12, outputDigestSha256: jsonDigest(physicalProbes), semanticDigestSha256: jsonDigest(semanticProbes), mediaBeforeRestart: null, mediaAfterRestart: null, restart: state}
  const readback = {physicalProbes, semanticProbes, physicalDigestSha256: validation.outputDigestSha256, semanticDigestSha256: validation.semanticDigestSha256}
  for (const observation of schedule('discovery', 1)) {
    const arm = observation.arm === 'B' ? 'B' : 'A'
    const duration = arm === 'B' ? 90 : 100
    const debug = {hasResult: true, resultTitle: fixture.expectedTitle, errorCount: 0, addSettingsErrorCount: 0, usesFallbackStorage: false, importerPhaseTimings: [{phase: 'bulk-finalization', elapsedMs: 20, details: {termRecordEndImportSessionCloseWritableMs: 10}}]}
    const report = {status: 'success', skippedVerification: false, buildTarget: 'chrome', browserVersion: '153.test', packageSha256: arm.toLowerCase().repeat(64), benchmark: {dictionary: 'jmdict', pinnedDictionaries: true, productionImportDefaults: true, authoritativeTiming: true, traceEnabled: false, phaseProfiling: false, phaseScreenshots: false, processSampling: false, importFlags: null, validation, readbackDiagnostics: {preRestart: readback, postRestart: readback}}, phases: [
      {name: 'Import JMdict via file input', startMs: 100, endMs: 101},
      {name: 'JMdict: total import', startMs: 100, endMs: 100 + duration, durationMs: duration, data: {kind: 'dictionary-import', dictionary: 'JMdict', browserTiming: {startedAtMs: 100, completedAtMs: 100 + duration, trigger: 'file-input-change', errorCount: 0, sequence: 1, sequenceBefore: 0}, importDebug: debug}}
    ]}
    const result = {index: 1, packageSha256: report.packageSha256, browserVersion: report.browserVersion, ...extractImportResult(report, 'jmdict', fixture, false, null)}
    const summary = {gitSha: arm === 'A' ? config.baseline : config.candidate, source: {gitSha: arm === 'A' ? config.baseline : config.candidate, sha256: {...hashes, 'builds/manabitan-chrome.zip': report.packageSha256}}, dictionary: 'jmdict', fixture, buildTarget: 'chrome', authoritativeTiming: true, traceEnabled: false, importFlags: null, browserVersion: report.browserVersion, runs: [result]}
    save(root, `${observation.name}/summary.json`, summary)
    save(root, `${observation.name}/run-1.json`, report)
    save(root, `${observation.name}/acquisition.json`, {...observation, startedEpochSeconds: 1, endedEpochSeconds: 2})
    for (const stage of ['before', 'after']) save(root, `${observation.name}/host-${stage}.json`, {nodeVersion: 'v22.22.0', loadAverage: [0, 0, 0]})
  }
  return root
}

function withFixture(callback) {
  const root = fixtureDirectory()
  try { callback(root) } finally { rmSync(root, {recursive: true, force: true}) }
}

function alter(root, name, callback) {
  const value = load(root, name)
  callback(value)
  save(root, name, value)
}

test('fixed schedules balance each arm in each position and retain reverse confirmation', () => {
  assert.equal(schedule('discovery', 1).length, 12)
  for (const replication of [1, 2]) {
    const measured = schedule('confirmation', replication).filter((value) => value.kind === 'measured')
    assert.equal(measured.length, 18)
    for (const arm of 'ABC') for (let position = 0; position < 3; ++position) assert.equal(measured.filter((value, index) => value.arm === arm && index % 3 === position).length, 2)
  }
})

test('valid full study verifies all warmups, controls, complete responses and timing', () => withFixture((root) => {
  const result = verifyStudy(root)
  assert.equal(result.measuredImports, 9)
  assert.equal(result.meetsMaterialityAndDirectionThreshold, true)
  assert.ok(Math.abs(result.comparisons.totalImportMs.candidateVersusA.medianPairedChangePercent + 10) < 1e-10)
}))

for (const [name, file, change] of [
  ['missing browser identity', 'A1/run-1.json', (value) => { value.browserVersion = '' }],
  ['changed source SHA', 'B1/summary.json', (value) => { value.gitSha = 'd'.repeat(40) }],
  ['package provenance mismatch', 'C1/summary.json', (value) => { value.source.sha256['builds/manabitan-chrome.zip'] = 'd'.repeat(64) }],
  ['mismatched fixture', 'A1/summary.json', (value) => { value.fixture.termRows += 1 }],
  ['trace timing', 'B1/run-1.json', (value) => { value.benchmark.traceEnabled = true }],
  ['skipped verification', 'B1/run-1.json', (value) => { value.skippedVerification = true }],
  ['fallback storage', 'B1/run-1.json', (value) => { value.phases[1].data.importDebug.usesFallbackStorage = true }],
  ['mismatched monotonic timing', 'B1/run-1.json', (value) => { value.phases[1].data.browserTiming.completedAtMs += 1 }],
  ['missing restart diagnostics', 'B1/run-1.json', (value) => { delete value.benchmark.readbackDiagnostics.postRestart }],
  ['altered frozen schedule', 'plan.json', (value) => { value.schedule.reverse() }],
  ['undeclared packaged mutation', 'B-package-entries.json', (value) => { value['js/extra.js'] = 'd'.repeat(64) }]
]) test(`rejects ${name}`, () => withFixture((root) => {
  alter(root, file, change)
  assert.throws(() => verifyStudy(root))
}))

test('rejects missing observations without filling them or recomputing a shorter schedule', () => withFixture((root) => {
  rmSync(path.join(root, 'B3'), {recursive: true})
  assert.throws(() => verifyStudy(root))
}))

test('rejects self-consistent changed full glossary responses across arms', () => withFixture((root) => {
  for (const observation of schedule('discovery', 1).filter((value) => value.arm === 'B')) {
    const report = load(root, `${observation.name}/run-1.json`)
    const validation = report.benchmark.validation
    validation.semanticProbes[0].result.dictionaryEntries[0].definitions[0].entries[0] = 'corrupted definition'
    validation.semanticDigestSha256 = jsonDigest(validation.semanticProbes)
    for (const state of Object.values(report.benchmark.readbackDiagnostics)) {
      state.semanticProbes = validation.semanticProbes
      state.semanticDigestSha256 = validation.semanticDigestSha256
    }
    save(root, `${observation.name}/run-1.json`, report)
    alter(root, `${observation.name}/summary.json`, (value) => { value.runs[0].validation = validation })
  }
  assert.throws(() => verifyStudy(root), /complete public lookup changed/)
}))

test('permits stable reference-layout changes with identical complete semantic results', () => withFixture((root) => {
  for (const observation of schedule('discovery', 1).filter((value) => value.arm === 'B')) {
    const report = load(root, `${observation.name}/run-1.json`)
    const validation = report.benchmark.validation
    const probe = validation.physicalProbes[0].probes[0]
    probe.rowSample[0].rawEntryContentOffset += 24
    probe.rowSample[0].rawContentPreview = 'MBC2'
    probe.readablePreviewRowCount = 1
    validation.outputDigestSha256 = jsonDigest(validation.physicalProbes)
    for (const state of Object.values(report.benchmark.readbackDiagnostics)) {
      state.physicalProbes = validation.physicalProbes
      state.physicalDigestSha256 = validation.outputDigestSha256
    }
    save(root, `${observation.name}/run-1.json`, report)
    alter(root, `${observation.name}/summary.json`, (value) => { value.runs[0].validation = validation })
  }
  assert.equal(verifyStudy(root).layoutDifferences.length, 3)
  alter(root, 'B1/run-1.json', (value) => { value.benchmark.readbackDiagnostics.postRestart.physicalProbes[0].probes[0].readablePreviewRowCount = 0 })
  assert.throws(() => verifyStudy(root))
}))

test('optional phase metrics retain missing pairs and zero-valued candidates', () => {
  const triplets = [{A: {metrics: {phase: 10}}, B: {metrics: {phase: 0}}}, {A: {metrics: {phase: null}}, B: {metrics: {phase: 1}}}]
  const result = compare(triplets, 'B', 'A', 'phase')
  assert.equal(result.measuredPairs, 1)
  assert.equal(result.missingOrZeroBaselinePairs, 1)
  assert.equal(result.medianPairedChangePercent, -100)
  assert.equal(result.pairs[1].changePercent, null)
})
